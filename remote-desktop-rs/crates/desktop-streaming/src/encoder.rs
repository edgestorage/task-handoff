//! Stream-local codec selection. Failed hardware stays disabled for this stream;
//! fallback always starts a self-contained IDR before any dependent frames.
use crate::{codec::Limits, synthetic::SoftwareEncoder, traits::EncodedFrame};
use openh264::formats::YUVBuffer;
#[cfg(any(target_os = "macos", target_os = "linux"))]
use openh264::formats::YUVSource;

#[derive(Clone, Copy)]
pub enum Policy {
    Software,
    Automatic,
}
pub struct Encoder {
    software: SoftwareEncoder,
    #[cfg(target_os = "linux")]
    hardware: Option<crate::platform::linux_encoder::Encoder>,
    #[cfg(target_os = "macos")]
    hardware: Option<crate::platform::macos_encoder::Encoder>,
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    automatic: bool,
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    hardware_failed: bool,
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    limits: Limits,
}
impl Encoder {
    pub fn new(bitrate: u32, limits: Limits, min_qp: u8, policy: Policy) -> anyhow::Result<Self> {
        #[cfg(not(any(target_os = "macos", target_os = "linux")))]
        let _ = policy;
        Ok(Self {
            software: SoftwareEncoder::with_quality(bitrate, limits, min_qp)?,
            #[cfg(any(target_os = "macos", target_os = "linux"))]
            hardware: None,
            #[cfg(any(target_os = "macos", target_os = "linux"))]
            automatic: matches!(policy, Policy::Automatic),
            #[cfg(any(target_os = "macos", target_os = "linux"))]
            hardware_failed: false,
            #[cfg(any(target_os = "macos", target_os = "linux"))]
            limits,
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
    pub fn reconfigure(&mut self, bitrate: u32, limits: Limits, min_qp: u8) -> anyhow::Result<()> {
        self.software = SoftwareEncoder::with_quality(bitrate, limits, min_qp)?;
        #[cfg(any(target_os = "macos", target_os = "linux"))]
        {
            self.limits = limits;
            self.hardware = None;
        }
        Ok(())
    }
    pub fn encode(&mut self, yuv: &YUVBuffer, idr: bool) -> anyhow::Result<Option<EncodedFrame>> {
        #[allow(unused_mut)]
        let mut idr = idr;
        #[cfg(any(target_os = "macos", target_os = "linux"))]
        if self.automatic && !self.hardware_failed {
            let result = (|| -> anyhow::Result<EncodedFrame> {
                if self
                    .hardware
                    .as_ref()
                    .is_none_or(|h| h.size() != yuv.dimensions())
                {
                    self.hardware = None;
                    #[cfg(target_os = "macos")]
                    type NativeEncoder = crate::platform::macos_encoder::Encoder;
                    #[cfg(target_os = "linux")]
                    type NativeEncoder = crate::platform::linux_encoder::Encoder;
                    self.hardware = Some(NativeEncoder::new(
                        yuv.dimensions().0,
                        yuv.dimensions().1,
                        self.bitrate(),
                        self.limits,
                    )?);
                    idr = true;
                }
                self.hardware.as_mut().unwrap().encode(yuv, idr)
            })();
            match result {
                Ok(frame) => return Ok(Some(frame)),
                Err(_) => {
                    // Do not expose native encoder descriptions. Never retry a
                    // failed device every frame or carry its GOP into fallback.
                    eprintln!("desktop encoder: hardware unavailable; stream uses OpenH264");
                    self.hardware = None;
                    self.hardware_failed = true;
                    idr = true;
                }
            }
        }
        self.software.encode(yuv, idr)
    }
}
