//! Sender limits derived from the negotiated H.264 format, never persisted or
//! projected as a second capability document.
use openh264::encoder::Level;
use std::collections::HashMap;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Limits {
    pub level: u8,
    pub max_fs: u32,
    pub max_mbps: u32,
    pub max_bitrate: u32,
}
impl Default for Limits {
    fn default() -> Self {
        Self {
            level: 31,
            max_fs: 3600,
            max_mbps: 108000,
            max_bitrate: 8_000_000,
        }
    }
}
impl Limits {
    pub fn parse(fmtp: &str) -> anyhow::Result<Self> {
        // rtc0.21.1's FMTP parser is private and only matches the profile bytes;
        // it does not enforce level or receiver resource constraints. Keep the
        // small RFC6184 parameter projection at this sender boundary. The SDP
        // grammar and codec/payload selection remain owned by the maintained stack.
        let mut fields = HashMap::new();
        for item in fmtp.split(';').map(str::trim).filter(|s| !s.is_empty()) {
            let (key, value) = item.split_once('=').unwrap_or((item, ""));
            let key = key.trim().to_ascii_lowercase();
            if !matches!(
                key.as_str(),
                "packetization-mode" | "profile-level-id" | "max-fs" | "max-mbps" | "max-br"
            ) {
                continue;
            }
            anyhow::ensure!(
                fields.insert(key, value.trim()).is_none(),
                "duplicate H264 parameter"
            );
        }
        anyhow::ensure!(
            fields.get("packetization-mode") == Some(&"1"),
            "H264 packetization mode unsupported"
        );
        let profile = fields.get("profile-level-id").copied().unwrap_or("42e01f");
        anyhow::ensure!(
            profile.len() == 6 && profile.is_ascii(),
            "invalid H264 profile"
        );
        let profile = u32::from_str_radix(profile, 16)?;
        anyhow::ensure!(profile >> 8 == 0x42e0, "H264 profile unsupported");
        let offered = (profile & 255) as u8;
        // RFC6184/ITU-T H.264 AnnexA. Higher receive levels can always consume
        // the lower local level. Never send level4 to a level3.1 receiver.
        let (level, max_fs, max_mbps, max_bitrate) = match offered {
            10 => (10, 99, 1485, 64_000),
            11 => (11, 396, 3000, 192_000),
            12 => (12, 396, 6000, 384_000),
            13 => (13, 396, 11880, 768_000),
            20 => (20, 396, 11880, 2_000_000),
            21 => (21, 792, 19800, 4_000_000),
            22 => (22, 1620, 20250, 4_000_000),
            30 => (30, 1620, 40500, 8_000_000),
            31..=39 => (31, 3600, 108000, 8_000_000),
            40.. => (40, 8192, 245760, 8_000_000),
            _ => anyhow::bail!("H264 level unsupported"),
        };
        let mut limits = Self {
            level,
            max_fs,
            max_mbps,
            max_bitrate,
        };
        for (key, limit, factor) in [
            ("max-fs", &mut limits.max_fs, 1u32),
            ("max-mbps", &mut limits.max_mbps, 1),
            ("max-br", &mut limits.max_bitrate, 1000),
        ] {
            if let Some(value) = fields.get(key) {
                let value = value.parse::<u64>()?;
                anyhow::ensure!(value > 0, "invalid H264 limit");
                *limit = (*limit as u64).min(value.saturating_mul(factor as u64)) as u32;
            }
        }
        Ok(limits)
    }
    pub fn encoder_level(self) -> Level {
        match self.level {
            10 => Level::Level_1_0,
            11 => Level::Level_1_1,
            12 => Level::Level_1_2,
            13 => Level::Level_1_3,
            20 => Level::Level_2_0,
            21 => Level::Level_2_1,
            22 => Level::Level_2_2,
            30 => Level::Level_3_0,
            31 => Level::Level_3_1,
            _ => Level::Level_4_0,
        }
    }
}

pub fn promote_h264_level_4_0(sdp: &str) -> String {
    sdp.split_inclusive('\n')
        .map(|line| {
            let ending = if line.ends_with("\r\n") {
                "\r\n"
            } else if line.ends_with('\n') {
                "\n"
            } else {
                ""
            };
            let body = &line[..line.len() - ending.len()];
            let Some(fmtp) = body.strip_prefix("a=fmtp:") else {
                return line.to_owned();
            };
            let Some((payload_type, parameters)) = fmtp.split_once(' ') else {
                return line.to_owned();
            };
            let mut asymmetric = false;
            let mut promoted = false;
            let mut max_fs = false;
            let mut max_mbps = false;
            let mut parameters = parameters
                .split(';')
                .map(|parameter| {
                    let parameter = parameter.trim();
                    if parameter == "level-asymmetry-allowed=1" {
                        asymmetric = true;
                    }
                    if parameter.starts_with("max-fs=") {
                        max_fs = true;
                    }
                    if parameter.starts_with("max-mbps=") {
                        max_mbps = true;
                    }
                    if parameter
                        .strip_prefix("profile-level-id=")
                        .is_some_and(|profile| profile.starts_with("42e0"))
                    {
                        promoted = true;
                        "profile-level-id=42e028".to_owned()
                    } else {
                        parameter.to_owned()
                    }
                })
                .collect::<Vec<_>>();
            if !promoted {
                return line.to_owned();
            }
            if !asymmetric {
                parameters.push("level-asymmetry-allowed=1".to_owned());
            }
            if !max_fs {
                parameters.push("max-fs=8160".to_owned());
            }
            if !max_mbps {
                parameters.push("max-mbps=244800".to_owned());
            }
            format!("a=fmtp:{payload_type} {}{ending}", parameters.join(";"))
        })
        .collect()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Format {
    pub payload_type: u8,
    pub limits: Limits,
}
