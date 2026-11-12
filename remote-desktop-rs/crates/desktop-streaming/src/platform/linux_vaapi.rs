//! Optional VA-API image: maintained cros-codecs owns prediction/reference state,
//! H.264 syntax and VA lifetimes. No native objects cross its main thread.
use super::linux_encoder::{read_packet, write_packet, Config, MAX_PACKET};
use cros_codecs::{
    backend::vaapi::encoder::VaapiBackend,
    codec::h264::{
        parser::{Level, Nalu, NaluType, Parser, Profile, Sps},
        synthesizer::Synthesizer,
    },
    encoder::{
        h264::EncoderConfig, stateless::h264::StatelessEncoder, FrameMetadata, PredictionStructure,
        RateControl, Tunings, VideoEncoder,
    },
    video_frame::{ReadMapping, VideoFrame, WriteMapping},
    BlockingMode, Fourcc, FrameLayout, PlaneLayout, Resolution,
};
use cros_libva as va;
use std::{io::Cursor, rc::Rc};

#[derive(Debug)]
struct Frame {
    bytes: Vec<u8>,
    size: Resolution,
}
impl VideoFrame for Frame {
    type MemDescriptor = ();
    type NativeHandle = va::Surface<()>;
    fn fourcc(&self) -> Fourcc {
        b"NV12".into()
    }
    fn resolution(&self) -> Resolution {
        self.size
    }
    fn get_plane_size(&self) -> Vec<usize> {
        let n = self.size.width as usize * self.size.height as usize;
        vec![n, n / 2]
    }
    fn get_plane_pitch(&self) -> Vec<usize> {
        vec![self.size.width as usize; 2]
    }
    fn map<'a>(&'a self) -> Result<Box<dyn ReadMapping<'a> + 'a>, String> {
        Err("VA upload-only frame".into())
    }
    fn map_mut<'a>(&'a mut self) -> Result<Box<dyn WriteMapping<'a> + 'a>, String> {
        Err("VA upload-only frame".into())
    }
    fn to_native_handle(&self, display: &Rc<va::Display>) -> Result<va::Surface<()>, String> {
        (|| -> anyhow::Result<_> {
            let (w, h) = (self.size.width as usize, self.size.height as usize);
            let mut surfaces = display.create_surfaces(
                va::VA_RT_FORMAT_YUV420,
                Some(va::VA_FOURCC_NV12),
                self.size.width,
                self.size.height,
                Some(va::UsageHint::USAGE_HINT_ENCODER),
                vec![()],
            )?;
            let surface = surfaces
                .pop()
                .ok_or_else(|| anyhow::anyhow!("VA input allocation failed"))?;
            {
                let mut image =
                    va::Image::derive_from(&surface, (self.size.width, self.size.height))?;
                let layout = *image.image();
                anyhow::ensure!(
                    layout.format.fourcc == va::VA_FOURCC_NV12 && layout.num_planes == 2,
                    "VA input format changed"
                );
                let dst = image.as_mut();
                for (plane, rows, start) in [(0, h, 0), (1, h / 2, w * h)] {
                    let pitch = layout.pitches[plane] as usize;
                    let offset = layout.offsets[plane] as usize;
                    anyhow::ensure!(
                        pitch >= w
                            && pitch <= 8192 * 4
                            && offset
                                .checked_add(pitch * rows)
                                .is_some_and(|end| end <= dst.len()),
                        "invalid VA plane"
                    );
                    for row in 0..rows {
                        dst[offset + row * pitch..offset + row * pitch + w]
                            .copy_from_slice(&self.bytes[start + row * w..start + (row + 1) * w]);
                    }
                }
            }
            Ok(surface)
        })()
        .map_err(|e| e.to_string())
    }
}
#[derive(Default)]
struct Headers {
    sps: Vec<u8>,
    pps: Vec<u8>,
}
impl Headers {
    fn frame(&mut self, bytes: &[u8]) -> anyhow::Result<Vec<u8>> {
        anyhow::ensure!(
            !bytes.is_empty() && bytes.len() < MAX_PACKET,
            "invalid VA bitstream"
        );
        let mut cursor = Cursor::new(bytes);
        let mut payload = Vec::new();
        let mut idr = false;
        let mut count = 0;
        while let Ok(nal) = Nalu::next(&mut cursor) {
            count += 1;
            anyhow::ensure!(count <= 1024, "too many VA NALs");
            match nal.header.type_ {
                NaluType::Sps => {
                    let mut parser = Parser::default();
                    let sps = parser.parse_sps(&nal).map_err(anyhow::Error::msg)?.clone();
                    drop(parser);
                    let mut sps =
                        Rc::try_unwrap(sps).map_err(|_| anyhow::anyhow!("shared VA SPS"))?;
                    // cros-codecs0.0.6 omits colour description and baseline
                    // constraint flags. Use its parser/synthesizer to declare
                    // the actual shared BT709 LIMITED input and negotiated42e0.
                    sps.constraint_set0_flag = true;
                    sps.constraint_set1_flag = true;
                    sps.constraint_set2_flag = true;
                    sps.vui_parameters_present_flag = true;
                    let vui = &mut sps.vui_parameters;
                    vui.video_signal_type_present_flag = true;
                    vui.video_format = 5;
                    vui.video_full_range_flag = false;
                    vui.colour_description_present_flag = true;
                    vui.colour_primaries = 1;
                    vui.transfer_characteristics = 1;
                    vui.matrix_coefficients = 1;
                    self.sps.clear();
                    Synthesizer::<'_, Sps, _>::synthesize(3, &sps, &mut self.sps, false)
                        .map_err(|e| anyhow::anyhow!("{e}"))?;
                }
                NaluType::Pps => {
                    self.pps.clear();
                    self.pps.extend_from_slice(&[0, 0, 0, 1]);
                    self.pps.extend_from_slice(nal.as_ref());
                }
                _ => {
                    idr |= nal.header.type_ == NaluType::SliceIdr;
                    payload.extend_from_slice(&[0, 0, 0, 1]);
                    payload.extend_from_slice(nal.as_ref());
                }
            }
        }
        anyhow::ensure!(!payload.is_empty(), "missing VA frame");
        let mut output = vec![u8::from(idr)];
        if idr {
            anyhow::ensure!(
                !self.sps.is_empty() && !self.pps.is_empty(),
                "missing VA IDR parameters"
            );
            output.extend_from_slice(&self.sps);
            output.extend_from_slice(&self.pps);
        }
        output.extend_from_slice(&payload);
        anyhow::ensure!(output.len() <= MAX_PACKET, "VA frame too large");
        Ok(output)
    }
}
pub fn run() -> anyhow::Result<()> {
    // Native driver waits cannot survive component death. Also validate the
    // parent after installing PDEATHSIG to close the usual exec/startup race.
    let parent = unsafe { libc::getppid() };
    anyhow::ensure!(
        parent > 1 && unsafe { libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL) } == 0,
        "VA parent unavailable"
    );
    anyhow::ensure!(unsafe { libc::getppid() } == parent, "VA parent changed");
    let mut input = std::io::stdin().lock();
    let mut output = std::io::stdout().lock();
    let config: Config = serde_json::from_slice(&read_packet(&mut input)?)?;
    let (w, h) = (config.width, config.height);
    anyhow::ensure!(
        w > 0
            && h > 0
            && w <= 3840
            && h <= 2160
            && w.is_multiple_of(2)
            && h.is_multiple_of(2)
            && config.bitrate > 0,
        "invalid VA configuration"
    );
    let size = Resolution {
        width: w as u32,
        height: h as u32,
    };
    let display = va::Display::open().ok_or_else(|| anyhow::anyhow!("VA device unavailable"))?;
    let entries =
        display.query_config_entrypoints(va::VAProfile::VAProfileH264ConstrainedBaseline)?;
    let low_power = !entries.contains(&va::VAEntrypoint::VAEntrypointEncSlice)
        && entries.contains(&va::VAEntrypoint::VAEntrypointEncSliceLP);
    let mut encoder = StatelessEncoder::<Frame, VaapiBackend<(), va::Surface<()>>>::new_vaapi(
        display,
        EncoderConfig {
            resolution: size,
            profile: Profile::Baseline,
            level: Level::try_from(config.level).map_err(anyhow::Error::msg)?,
            pred_structure: PredictionStructure::LowDelay { limit: 60 },
            initial_tunings: Tunings {
                rate_control: RateControl::ConstantBitrate(config.bitrate.into()),
                framerate: 30,
                min_quality: 0,
                max_quality: 51,
            },
        },
        b"NV12".into(),
        size,
        low_power,
        BlockingMode::Blocking,
    )
    .map_err(|e| anyhow::anyhow!("{e}"))?;
    write_packet(&mut output, b"ready")?;
    let mut timestamp = 0;
    let mut headers = Headers::default();
    loop {
        let packet = match read_packet(&mut input) {
            Ok(p) => p,
            Err(e) if e.kind() == std::io::ErrorKind::UnexpectedEof => break,
            Err(e) => return Err(e.into()),
        };
        anyhow::ensure!(
            packet.len() == 1 + w * h * 3 / 2 && packet[0] <= 1,
            "invalid VA input frame"
        );
        let metadata = FrameMetadata {
            timestamp,
            force_keyframe: packet[0] == 1,
            layout: FrameLayout {
                format: (b"NV12".into(), 0),
                size,
                planes: vec![
                    PlaneLayout {
                        buffer_index: 0,
                        offset: 0,
                        stride: w,
                    },
                    PlaneLayout {
                        buffer_index: 0,
                        offset: w * h,
                        stride: w,
                    },
                ],
            },
        };
        timestamp += 1;
        encoder
            .encode(
                metadata,
                Frame {
                    bytes: packet[1..].to_vec(),
                    size,
                },
            )
            .map_err(|e| anyhow::anyhow!("{e}"))?;
        encoder.drain().map_err(|e| anyhow::anyhow!("{e}"))?;
        let coded = encoder
            .poll()
            .map_err(|e| anyhow::anyhow!("{e}"))?
            .ok_or_else(|| anyhow::anyhow!("VA delayed frame"))?;
        anyhow::ensure!(
            coded.metadata.timestamp == timestamp - 1,
            "VA frame reordered"
        );
        write_packet(&mut output, &headers.frame(&coded.bitstream)?)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        codec::Limits,
        synthetic::{pattern, SoftwareEncoder, SyntheticInput},
    };
    use openh264::formats::YUVSource;
    #[test]
    fn maintained_sps_rewrite_declares_negotiated_profile_and_colour_and_repeats_idr_headers() {
        let mut software = SoftwareEncoder::with_quality(2_000_000, Limits::default(), 0).unwrap();
        let yuv = pattern(0, &SyntheticInput::default());
        let frame = software.encode(&yuv, true).unwrap().unwrap();
        let mut headers = Headers::default();
        let first = headers.frame(&frame.annex_b).unwrap();
        assert_eq!(first[0], 1);
        let mut cursor = Cursor::new(&first[1..]);
        let nal = Nalu::next(&mut cursor).unwrap();
        let mut parser = Parser::default();
        let sps = parser.parse_sps(&nal).unwrap();
        assert!(sps.constraint_set0_flag && sps.constraint_set1_flag && sps.constraint_set2_flag);
        assert_eq!(sps.level_idc, Level::L3_1);
        assert!(sps.vui_parameters.video_signal_type_present_flag);
        assert!(!sps.vui_parameters.video_full_range_flag);
        assert_eq!(sps.vui_parameters.matrix_coefficients, 1);
        assert_eq!(sps.vui_parameters.colour_primaries, 1);
        assert_eq!(sps.vui_parameters.transfer_characteristics, 1);
        let mut only_slices = Vec::new();
        let mut cursor = Cursor::new(&frame.annex_b[..]);
        while let Ok(nal) = Nalu::next(&mut cursor) {
            if nal.header.type_ != NaluType::Sps && nal.header.type_ != NaluType::Pps {
                only_slices.extend_from_slice(&[0, 0, 0, 1]);
                only_slices.extend_from_slice(nal.as_ref());
            }
        }
        for wire in [first, headers.frame(&only_slices).unwrap()] {
            let mut decoder = openh264::decoder::Decoder::new().unwrap();
            assert_eq!(
                decoder.decode(&wire[1..]).unwrap().unwrap().dimensions(),
                (640, 360)
            );
        }
        assert!(Headers::default().frame(&only_slices).is_err());
        assert!(headers.frame(&[]).is_err());
    }
}
