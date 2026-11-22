//! Stream-local codec selection. Failed hardware stays disabled for this stream;
//! fallback always starts a self-contained IDR before any dependent frames.
use crate::{
    codec::{Limits, VideoCodec},
    synthetic::SoftwareEncoder,
    traits::EncodedFrame,
    video::{Budget, Frame},
};
#[cfg(any(target_os = "macos", target_os = "linux"))]
use openh264::formats::YUVSource;

#[derive(Clone, Copy)]
pub enum Policy {
    Software,
    Automatic,
}
pub struct Encoder {
    software: SoftwareEncoder,
    codec: VideoCodec,
    policy: Policy,
    #[cfg(target_os = "linux")]
    hardware: Option<crate::platform::linux_encoder::Encoder>,
    #[cfg(target_os = "macos")]
    hardware: Option<crate::platform::macos_encoder::Encoder>,
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    automatic: bool,
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    hardware_failed: bool,
    limits: Limits,
    software_frame_rate: u32,
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    hardware_frame_rate: Option<u32>,
}
impl Encoder {
    pub fn new(
        bitrate: u32,
        limits: Limits,
        min_qp: u8,
        policy: Policy,
        codec: VideoCodec,
    ) -> anyhow::Result<Self> {
        #[cfg(not(any(target_os = "macos", target_os = "linux")))]
        let _ = policy;
        #[cfg(not(any(target_os = "macos", target_os = "linux")))]
        anyhow::ensure!(codec == VideoCodec::H264, "native HEVC unavailable");
        #[cfg(any(target_os = "macos", target_os = "linux"))]
        anyhow::ensure!(
            codec == VideoCodec::H264 || cfg!(target_os = "macos"),
            "native HEVC unavailable"
        );
        anyhow::ensure!(
            codec == VideoCodec::H264 || matches!(policy, Policy::Automatic),
            "HEVC has no software encoder"
        );
        Ok(Self {
            software: SoftwareEncoder::with_quality_at_frame_rate(bitrate, limits, min_qp, 30)?,
            codec,
            policy,
            #[cfg(any(target_os = "macos", target_os = "linux"))]
            hardware: None,
            #[cfg(any(target_os = "macos", target_os = "linux"))]
            automatic: matches!(policy, Policy::Automatic),
            #[cfg(any(target_os = "macos", target_os = "linux"))]
            hardware_failed: false,
            limits,
            software_frame_rate: 30,
            #[cfg(any(target_os = "macos", target_os = "linux"))]
            hardware_frame_rate: None,
        })
    }
    pub fn bitrate(&self) -> u32 {
        self.software.bitrate()
    }
    pub fn min_qp(&self) -> u8 {
        self.software.min_qp()
    }
    pub fn is_software(&self) -> bool {
        #[cfg(any(target_os = "macos", target_os = "linux"))]
        {
            !self.automatic || self.hardware_failed
        }
        #[cfg(not(any(target_os = "macos", target_os = "linux")))]
        {
            true
        }
    }
    pub fn name(&self) -> &'static str {
        #[cfg(target_os = "macos")]
        if self.hardware.is_some() {
            return "videotoolbox";
        }
        #[cfg(target_os = "linux")]
        if self.hardware.is_some() {
            return "vaapi";
        }
        "openh264"
    }
    pub fn codec(&self) -> VideoCodec {
        self.codec
    }
    pub fn reconfigure(
        &mut self,
        bitrate: u32,
        limits: Limits,
        min_qp: u8,
        codec: VideoCodec,
    ) -> anyhow::Result<()> {
        if codec != self.codec {
            let policy = self.policy;
            *self = Self::new(bitrate, limits, min_qp, policy, codec)?;
            return Ok(());
        }
        self.software = SoftwareEncoder::with_quality_at_frame_rate(
            bitrate,
            limits,
            min_qp,
            self.software_frame_rate,
        )?;
        self.limits = limits;
        #[cfg(any(target_os = "macos", target_os = "linux"))]
        {
            self.hardware = None;
            self.hardware_frame_rate = None;
        }
        Ok(())
    }
    pub fn encode(
        &mut self,
        frame: Frame,
        budget: Budget,
        idr: bool,
    ) -> anyhow::Result<Option<EncodedFrame>> {
        #[allow(unused_mut)]
        let mut idr = idr;
        if self.software_frame_rate != budget.fps {
            self.software = SoftwareEncoder::with_quality_at_frame_rate(
                self.bitrate(),
                self.limits,
                self.min_qp(),
                budget.fps,
            )?;
            self.software_frame_rate = budget.fps;
            idr = true;
        }
        #[cfg(any(target_os = "macos", target_os = "linux"))]
        if self.automatic && !self.hardware_failed {
            let result = (|| -> anyhow::Result<EncodedFrame> {
                let size = (budget.width as usize, budget.height as usize);
                if self
                    .hardware
                    .as_ref()
                    .is_none_or(|hardware| hardware.size() != size)
                    || self.hardware_frame_rate != Some(budget.fps)
                {
                    self.hardware = None;
                    self.hardware_frame_rate = None;
                    #[cfg(target_os = "macos")]
                    {
                        self.hardware = Some(crate::platform::macos_encoder::Encoder::new(
                            size.0,
                            size.1,
                            budget.fps,
                            self.bitrate(),
                            self.limits,
                            self.codec,
                        )?);
                    }
                    #[cfg(target_os = "linux")]
                    {
                        self.hardware = Some(crate::platform::linux_encoder::Encoder::new(
                            size.0,
                            size.1,
                            budget.fps,
                            self.bitrate(),
                            self.limits,
                        )?);
                    }
                    self.hardware_frame_rate = Some(budget.fps);
                    idr = true;
                }
                match &frame {
                    Frame::I420(yuv) => {
                        anyhow::ensure!(yuv.dimensions() == size, "encoder geometry changed");
                        #[cfg(target_os = "macos")]
                        {
                            self.hardware.as_mut().unwrap().encode(yuv, idr)
                        }
                        #[cfg(target_os = "linux")]
                        {
                            self.hardware.as_mut().unwrap().encode(yuv, idr)
                        }
                    }
                    #[cfg(target_os = "macos")]
                    Frame::Native420(native) => self
                        .hardware
                        .as_mut()
                        .unwrap()
                        .encode_native(&native.buffer, idr),
                }
            })();
            match result {
                Ok(frame) => return Ok(Some(frame)),
                Err(_) => {
                    if self.codec == VideoCodec::H265 {
                        // A selected HEVC payload cannot be repaired by emitting
                        // H.264 bytes: the receiver would configure the wrong
                        // decoder. Fail the stream visibly and let negotiation
                        // choose H.264 on the next connection.
                        anyhow::bail!("HEVC encoder unavailable");
                    }
                    // Do not expose native encoder descriptions. Never retry a
                    // failed device every frame or carry its GOP into fallback.
                    eprintln!("desktop encoder: hardware unavailable; stream uses OpenH264");
                    self.hardware = None;
                    self.hardware_frame_rate = None;
                    self.hardware_failed = true;
                    idr = true;
                }
            }
        }
        let yuv = frame.into_i420(budget)?;
        self.software.encode(&yuv, idr)
    }
}
