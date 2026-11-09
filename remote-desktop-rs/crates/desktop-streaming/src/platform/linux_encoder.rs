//! Optional, owned VA-API helper. Keeping native libraries in a separate image
//! lets the component start and use OpenH264 even without libva/GBM installed.
//! One request/response in flight; pipe I/O has a bounded caller deadline. The
//! maintained cros-codecs backend and its !Send VA objects live in that process.
use crate::{codec::Limits, traits::EncodedFrame};
use openh264::formats::{YUVBuffer, YUVSource};
use serde::{Deserialize, Serialize};
use std::{
    io::{Read, Write},
    process::{Child, Stdio},
    sync::mpsc,
    time::Duration,
};
pub const MAX_PACKET: usize = 16 * 1024 * 1024;
#[derive(Serialize, Deserialize)]
pub struct Config {
    pub width: usize,
    pub height: usize,
    pub bitrate: u32,
    pub level: u8,
}
pub fn write_packet(writer: &mut impl Write, data: &[u8]) -> std::io::Result<()> {
    if data.is_empty() || data.len() > MAX_PACKET {
        return Err(std::io::ErrorKind::InvalidData.into());
    }
    writer.write_all(&(data.len() as u32).to_be_bytes())?;
    writer.write_all(data)?;
    writer.flush()
}
pub fn read_packet(reader: &mut impl Read) -> std::io::Result<Vec<u8>> {
    let mut header = [0; 4];
    reader.read_exact(&mut header)?;
    let size = u32::from_be_bytes(header) as usize;
    if size == 0 || size > MAX_PACKET {
        return Err(std::io::ErrorKind::InvalidData.into());
    }
    let mut data = vec![0; size];
    reader.read_exact(&mut data)?;
    Ok(data)
}
struct Request {
    data: Vec<u8>,
    reply: mpsc::SyncSender<std::io::Result<Vec<u8>>>,
}
pub struct Encoder {
    child: Child,
    tx: Option<mpsc::SyncSender<Request>>,
    size: (usize, usize),
}
impl Encoder {
    pub fn new(width: usize, height: usize, bitrate: u32, limits: Limits) -> anyhow::Result<Self> {
        anyhow::ensure!(
            width > 0
                && height > 0
                && width <= 1920
                && height <= 1080
                && width.is_multiple_of(2)
                && height.is_multiple_of(2),
            "invalid VA dimensions"
        );
        // Resolve only the sibling delivered with this component, never PATH.
        let binary = std::env::current_exe()?.with_file_name("desktop-vaapi-encoder");
        let mut child = std::process::Command::new(binary)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()?;
        let mut stdin = child.stdin.take().unwrap();
        let mut stdout = child.stdout.take().unwrap();
        let (tx, rx) = mpsc::sync_channel::<Request>(1);
        let (ready, wait) = mpsc::sync_channel(1);
        let config = serde_json::to_vec(&Config {
            width,
            height,
            bitrate: bitrate.min(limits.max_bitrate),
            level: limits.level,
        })?;
        std::thread::spawn(move || {
            let started: std::io::Result<()> = (|| {
                write_packet(&mut stdin, &config)?;
                let ack = read_packet(&mut stdout)?;
                if ack != b"ready" {
                    return Err(std::io::ErrorKind::InvalidData.into());
                }
                Ok(())
            })();
            let ok = started.is_ok();
            let _ = ready.send(started);
            if !ok {
                return;
            }
            for r in rx {
                let result = (|| {
                    write_packet(&mut stdin, &r.data)?;
                    read_packet(&mut stdout)
                })();
                let failed = result.is_err();
                let _ = r.reply.send(result);
                if failed {
                    break;
                }
            }
        });
        let encoder = Self {
            child,
            tx: Some(tx),
            size: (width, height),
        };
        wait.recv_timeout(Duration::from_secs(3))??;
        Ok(encoder)
    }
    pub fn size(&self) -> (usize, usize) {
        self.size
    }
    pub fn encode(&mut self, yuv: &YUVBuffer, idr: bool) -> anyhow::Result<EncodedFrame> {
        let (w, h) = yuv.dimensions();
        anyhow::ensure!((w, h) == self.size, "VA geometry changed");
        let mut data = Vec::with_capacity(1 + w * h * 3 / 2);
        data.push(u8::from(idr));
        let (ys, us, vs) = yuv.strides();
        for row in 0..h {
            data.extend_from_slice(&yuv.y()[row * ys..row * ys + w]);
        }
        for row in 0..h / 2 {
            for col in 0..w / 2 {
                data.push(yuv.u()[row * us + col]);
                data.push(yuv.v()[row * vs + col]);
            }
        }
        let (reply, wait) = mpsc::sync_channel(1);
        self.tx
            .as_ref()
            .unwrap()
            .try_send(Request { data, reply })?;
        let data = wait.recv_timeout(Duration::from_secs(2))??;
        anyhow::ensure!(data.len() > 1 && data[0] <= 1, "invalid VA frame");
        Ok(EncodedFrame {
            keyframe: data[0] == 1,
            annex_b: data[1..].to_vec(),
            duration: Duration::from_secs_f64(1.0 / 30.0),
        })
    }
}
impl Drop for Encoder {
    fn drop(&mut self) {
        self.tx.take();
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn native_helper_packets_bound_allocation_and_reject_truncated_payloads() {
        for input in [
            vec![],
            vec![0, 0, 0, 0],
            ((MAX_PACKET + 1) as u32).to_be_bytes().to_vec(),
            vec![0, 0, 0, 2, 1],
        ] {
            assert!(read_packet(&mut &input[..]).is_err());
        }
        let mut wire = Vec::new();
        write_packet(&mut wire, b"ready").unwrap();
        write_packet(&mut wire, b"frame").unwrap();
        let mut reader = &wire[..];
        assert_eq!(read_packet(&mut reader).unwrap(), b"ready");
        assert_eq!(read_packet(&mut reader).unwrap(), b"frame");
        assert!(reader.is_empty());
    }
}
