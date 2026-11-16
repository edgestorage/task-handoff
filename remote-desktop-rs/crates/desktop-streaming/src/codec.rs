//! Sender codec and limits derived from the negotiated video format. These are
//! stream-local values and are never persisted as a second capability document.
use openh264::encoder::Level;
use std::collections::HashMap;

/// Video codecs this sender can produce. Keep the wire names in one place so
/// capability advertisement, SDP selection, the encoder and fallback framing
/// cannot drift apart.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum VideoCodec {
    H264,
    H265,
}

impl VideoCodec {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::H264 => "h264",
            Self::H265 => "h265",
        }
    }

    pub fn mime_type(self) -> &'static str {
        match self {
            Self::H264 => "video/H264",
            Self::H265 => "video/H265",
        }
    }

    pub fn from_mime_type(value: &str) -> Option<Self> {
        if value.eq_ignore_ascii_case(Self::H264.mime_type()) {
            Some(Self::H264)
        } else if value.eq_ignore_ascii_case(Self::H265.mime_type()) {
            Some(Self::H265)
        } else {
            None
        }
    }

    /// RFC 6381 string used by the WebSocket fallback decoder. The compressed
    /// bitstream remains the authority; this tells native/WebCodecs decoders how
    /// to interpret parameter sets and NAL headers.
    pub fn fallback_codec_string(self) -> &'static str {
        match self {
            Self::H264 => "avc1.42E028",
            // Main profile, Main tier, level 4.0, 8-bit. Fallback is capped at
            // 1080p30, so level 4.0 is sufficient for its product envelope.
            Self::H265 => "hvc1.1.6.L120.90",
        }
    }
}

/// Codecs the local native encoder can produce. H.265 is advertised only when
/// VideoToolbox proves hardware HEVC encoding is available; otherwise the
/// MediaEngine and capability document would promise a bitstream we cannot send.
pub fn local_video_codecs() -> Vec<VideoCodec> {
    #[cfg(target_os = "macos")]
    {
        if crate::platform::macos_encoder::hevc_supported() {
            return vec![VideoCodec::H265, VideoCodec::H264];
        }
    }
    vec![VideoCodec::H264]
}

/// Local WebRTC ceiling. A 4K30 H.264 stream fits level 5.1 without exceeding
/// its macroblock rate; receiver SDP constraints may still lower this.
pub const MAX_H264_LEVEL: u8 = 51;
pub const MAX_H264_BITRATE: u32 = 24_000_000;
pub const MAX_H265_BITRATE: u32 = 24_000_000;
const NEGOTIABLE_LEVELS: [u8; 4] = [31, 40, 50, 51];

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
        let fields = parse_fields(fmtp)?;
        let level = offered_level(&fields)?;
        let (level_fs, level_mbps) = level_capacity(level)?;
        Ok(Self {
            level,
            max_fs: explicit_limit(&fields, "max-fs", 1)?
                .unwrap_or(level_fs)
                .min(level_fs),
            max_mbps: explicit_limit(&fields, "max-mbps", 1)?
                .unwrap_or(level_mbps)
                .min(level_mbps),
            max_bitrate: explicit_limit(&fields, "max-br", 1000)?
                .unwrap_or(level_bitrate(level))
                .min(MAX_H264_BITRATE),
        })
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
            32 => Level::Level_3_2,
            40 => Level::Level_4_0,
            41 => Level::Level_4_1,
            42 => Level::Level_4_2,
            50 => Level::Level_5_0,
            51 => Level::Level_5_1,
            _ => Level::Level_5_2,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct H264Negotiation {
    pub answer_fmtp: String,
    pub limits: Limits,
}

/// Derive the local answer level from the receiver's SDP capabilities. Explicit
/// `max-fs`/`max-mbps` take precedence because browsers commonly advertise a
/// lower profile level while declaring a higher receiver capacity. When those
/// limits are absent, only an offer that explicitly allows level asymmetry can
/// use the local ceiling; otherwise stay at the offered level.
pub fn negotiate_h264_offer(sdp: &str) -> anyhow::Result<H264Negotiation> {
    let (_, fmtp) = video_h264_fmtp(sdp)?;
    negotiate_h264_fmtp(&fmtp)
}

pub fn negotiate_h264_fmtp(fmtp: &str) -> anyhow::Result<H264Negotiation> {
    let fields = parse_fields(fmtp)?;
    let offered = offered_level(&fields)?;
    let (offered_fs, offered_mbps) = level_capacity(offered)?;
    let explicit_fs = explicit_limit(&fields, "max-fs", 1)?;
    let explicit_mbps = explicit_limit(&fields, "max-mbps", 1)?;
    let requested_fs = explicit_fs.unwrap_or(offered_fs);
    let requested_mbps = explicit_mbps.unwrap_or(offered_mbps);
    let level = if explicit_fs.is_none() && explicit_mbps.is_none() {
        if fields
            .get("level-asymmetry-allowed")
            .is_some_and(|value| value == "1")
        {
            MAX_H264_LEVEL
        } else {
            offered
        }
    } else {
        NEGOTIABLE_LEVELS
            .into_iter()
            .find(|level| {
                level_capacity(*level)
                    .is_ok_and(|(fs, mbps)| fs >= requested_fs && mbps >= requested_mbps)
            })
            .unwrap_or(MAX_H264_LEVEL)
    };
    let (level_fs, level_mbps) = level_capacity(level)?;
    // When the receiver declares only one explicit cap, use the inferred
    // answer level for the other cap. This avoids leaving an absent max-mbps at
    // the lower advertised profile level and accidentally halving the frame rate.
    let max_fs = explicit_fs.unwrap_or(level_fs).min(level_fs);
    let max_mbps = explicit_mbps.unwrap_or(level_mbps).min(level_mbps);
    let max_bitrate = explicit_limit(&fields, "max-br", 1000)?
        .unwrap_or(level_bitrate(level))
        .min(MAX_H264_BITRATE);
    let limits = Limits {
        level,
        max_fs,
        max_mbps,
        max_bitrate,
    };
    Ok(H264Negotiation {
        answer_fmtp: format!(
            "level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e0{level:02x};max-fs={max_fs};max-mbps={max_mbps};max-br={}",
            max_bitrate / 1000
        ),
        limits,
    })
}

/// Replace the H.264 video fmtp line in an answer with the negotiated values.
/// rtc owns codec matching and SDP generation; this only projects the selected
/// resources back into the wire answer so both sides agree on the same ceiling.
pub fn rewrite_h264_answer_fmtp(sdp: &str, answer_fmtp: &str) -> anyhow::Result<String> {
    let (payload_type, _) = video_h264_fmtp(sdp)?;
    rewrite_h264_answer_fmtp_for_payload(sdp, &payload_type, answer_fmtp)
}

pub(crate) fn rewrite_h264_answer_fmtp_for_payload(
    sdp: &str,
    payload_type: &str,
    answer_fmtp: &str,
) -> anyhow::Result<String> {
    let mut rewritten = false;
    let output = sdp
        .split_inclusive('\n')
        .map(|line| {
            let ending = if line.ends_with("\r\n") {
                "\r\n"
            } else if line.ends_with('\n') {
                "\n"
            } else {
                ""
            };
            let body = &line[..line.len() - ending.len()];
            let Some(rest) = body.strip_prefix("a=fmtp:") else {
                return line.to_owned();
            };
            let Some((candidate, _)) = rest.split_once(' ') else {
                return line.to_owned();
            };
            if candidate != payload_type {
                return line.to_owned();
            }
            rewritten = true;
            format!("a=fmtp:{payload_type} {answer_fmtp}{ending}")
        })
        .collect::<String>();
    anyhow::ensure!(rewritten, "missing H264 answer fmtp");
    Ok(output)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct H265Negotiation {
    /// The answer preserves rtc's selected H.265 payload and receiver fmtp. This
    /// value is kept for diagnostics/tests, not used to rewrite SDP.
    pub answer_fmtp: String,
    pub limits: Limits,
}

pub fn negotiate_h265_offer(sdp: &str) -> anyhow::Result<H265Negotiation> {
    let fmtp = video_h265_fmtp(sdp)?;
    let limits = negotiate_h265_fmtp(&fmtp)?;
    Ok(H265Negotiation {
        answer_fmtp: fmtp,
        limits,
    })
}

/// Parse the receiver's RFC 7798 HEVC fmtp. We only emit Main profile, Main tier,
/// 8-bit, single-session transport streams; unsupported configurations fail
/// instead of silently producing incompatible HEVC.
pub fn negotiate_h265_fmtp(fmtp: &str) -> anyhow::Result<Limits> {
    let fields = parse_h265_fields(fmtp)?;
    if let Some(profile) = fields.get("profile-id") {
        anyhow::ensure!(profile == "1", "H265 profile unsupported");
    }
    if let Some(tier) = fields.get("tier-flag") {
        anyhow::ensure!(tier == "0", "H265 tier unsupported");
    }
    if let Some(mode) = fields.get("tx-mode") {
        anyhow::ensure!(mode == "SRST", "H265 tx-mode unsupported");
    }
    let level = fields
        .get("level-id")
        .map(|value| value.parse::<u16>())
        .transpose()?
        .unwrap_or(153);
    anyhow::ensure!(level <= u8::MAX as u16, "H265 level unsupported");
    let (level_luma_ps, level_luma_sr) = h265_level_capacity(level as u8)?;
    let level_fs = level_luma_ps / 256;
    let level_mbps = level_luma_sr / 256;
    Ok(Limits {
        level: level as u8,
        max_fs: explicit_limit(&fields, "max-fs", 1)?
            .unwrap_or(level_fs)
            .min(level_fs),
        max_mbps: explicit_limit(&fields, "max-mbps", 1)?
            .unwrap_or(level_mbps)
            .min(level_mbps),
        max_bitrate: explicit_limit(&fields, "max-br", 1000)?
            .unwrap_or_else(|| h265_level_bitrate(level as u8))
            .min(MAX_H265_BITRATE),
    })
}

fn parse_h265_fields(fmtp: &str) -> anyhow::Result<HashMap<String, String>> {
    let mut fields = HashMap::new();
    for item in fmtp.split(';').map(str::trim).filter(|s| !s.is_empty()) {
        let (key, value) = item.split_once('=').unwrap_or((item, ""));
        let key = key.trim().to_ascii_lowercase();
        if !matches!(
            key.as_str(),
            "profile-id" | "tier-flag" | "level-id" | "max-fs" | "max-mbps" | "max-br" | "tx-mode"
        ) {
            continue;
        }
        anyhow::ensure!(
            fields.insert(key, value.trim().to_owned()).is_none(),
            "duplicate H265 parameter"
        );
    }
    Ok(fields)
}

fn h265_level_capacity(level: u8) -> anyhow::Result<(u32, u32)> {
    match level {
        30 => Ok((36_864, 552_960)),
        60 => Ok((122_880, 3_686_400)),
        63 => Ok((245_760, 7_372_800)),
        90 => Ok((552_960, 16_588_800)),
        93 => Ok((983_040, 29_491_200)),
        120 => Ok((2_228_224, 66_846_720)),
        123 => Ok((2_228_224, 133_693_440)),
        150 => Ok((8_912_896, 267_386_880)),
        153 => Ok((8_912_896, 534_773_760)),
        156 => Ok((8_912_896, 1_069_547_520)),
        180 => Ok((35_651_584, 1_069_547_520)),
        183 => Ok((35_651_584, 2_139_095_040)),
        186 => Ok((35_651_584, 4_278_190_080)),
        _ => anyhow::bail!("H265 level unsupported"),
    }
}

fn h265_level_bitrate(level: u8) -> u32 {
    match level {
        0..=93 => 4_000_000,
        94..=123 => 8_000_000,
        _ => MAX_H265_BITRATE,
    }
}

fn parse_fields(fmtp: &str) -> anyhow::Result<HashMap<String, String>> {
    let mut fields = HashMap::new();
    for item in fmtp.split(';').map(str::trim).filter(|s| !s.is_empty()) {
        let (key, value) = item.split_once('=').unwrap_or((item, ""));
        let key = key.trim().to_ascii_lowercase();
        if !matches!(
            key.as_str(),
            "level-asymmetry-allowed"
                | "packetization-mode"
                | "profile-level-id"
                | "max-fs"
                | "max-mbps"
                | "max-br"
        ) {
            continue;
        }
        anyhow::ensure!(
            fields.insert(key, value.trim().to_owned()).is_none(),
            "duplicate H264 parameter"
        );
    }
    anyhow::ensure!(
        fields
            .get("packetization-mode")
            .is_some_and(|value| value == "1"),
        "H264 packetization mode unsupported"
    );
    Ok(fields)
}

fn offered_level(fields: &HashMap<String, String>) -> anyhow::Result<u8> {
    let profile = fields
        .get("profile-level-id")
        .map(String::as_str)
        .unwrap_or("42e01f");
    anyhow::ensure!(
        profile.len() == 6 && profile.is_ascii(),
        "invalid H264 profile"
    );
    let profile = u32::from_str_radix(profile, 16)?;
    anyhow::ensure!(profile >> 8 == 0x42e0, "H264 profile unsupported");
    let level = (profile & 255) as u8;
    level_capacity(level)?;
    Ok(level)
}

fn explicit_limit(
    fields: &HashMap<String, String>,
    key: &str,
    factor: u32,
) -> anyhow::Result<Option<u32>> {
    fields
        .get(key)
        .map(|value| {
            let value = value.parse::<u64>()?;
            anyhow::ensure!(value > 0, "invalid H264 limit");
            Ok((value.saturating_mul(factor as u64)).min(u32::MAX as u64) as u32)
        })
        .transpose()
}

fn level_capacity(level: u8) -> anyhow::Result<(u32, u32)> {
    match level {
        10 => Ok((99, 1_485)),
        11 => Ok((396, 3_000)),
        12 => Ok((396, 6_000)),
        13 => Ok((396, 11_880)),
        20 => Ok((396, 11_880)),
        21 => Ok((792, 19_800)),
        22 => Ok((1_620, 20_250)),
        30 => Ok((1_620, 40_500)),
        31 => Ok((3_600, 108_000)),
        32 => Ok((5_120, 216_000)),
        40 => Ok((8_192, 245_760)),
        41 => Ok((8_192, 491_520)),
        42 => Ok((8_704, 522_240)),
        50 => Ok((22_080, 589_824)),
        51 => Ok((36_864, 983_040)),
        52 => Ok((36_864, 2_073_600)),
        _ => anyhow::bail!("H264 level unsupported"),
    }
}

fn level_bitrate(level: u8) -> u32 {
    match level {
        10 => 64_000,
        11 => 192_000,
        12 => 384_000,
        13 => 768_000,
        20..=22 => 2_000_000,
        30..=32 => 8_000_000,
        _ => MAX_H264_BITRATE,
    }
}

fn video_h264_fmtp(sdp: &str) -> anyhow::Result<(String, String)> {
    let video = sdp
        .lines()
        .find(|line| line.starts_with("m=video "))
        .ok_or_else(|| anyhow::anyhow!("missing video media"))?;
    let payload_types = video.split_whitespace().skip(3).collect::<Vec<_>>();
    for line in sdp.lines().filter(|line| line.starts_with("a=fmtp:")) {
        let Some((payload_type, fmtp)) = line.trim_start_matches("a=fmtp:").split_once(' ') else {
            continue;
        };
        if payload_types.contains(&payload_type) && fmtp.contains("profile-level-id=42e0") {
            return Ok((payload_type.to_owned(), fmtp.to_owned()));
        }
    }
    anyhow::bail!("missing H264 video fmtp")
}

fn video_h265_fmtp(sdp: &str) -> anyhow::Result<String> {
    let video = sdp
        .lines()
        .find(|line| line.starts_with("m=video "))
        .ok_or_else(|| anyhow::anyhow!("missing video media"))?;
    let payload_types = video.split_whitespace().skip(3).collect::<Vec<_>>();
    let h265_payloads = sdp
        .lines()
        .filter_map(|line| line.strip_prefix("a=rtpmap:"))
        .filter_map(|value| value.split_once(' '))
        .filter(|(payload_type, encoding)| {
            payload_types.contains(payload_type)
                && encoding
                    .split_once('/')
                    .is_some_and(|(name, _)| name.eq_ignore_ascii_case("H265"))
        })
        .map(|(payload_type, _)| payload_type)
        .collect::<Vec<_>>();
    anyhow::ensure!(!h265_payloads.is_empty(), "missing H265 video format");
    for line in sdp.lines().filter(|line| line.starts_with("a=fmtp:")) {
        let Some((payload_type, fmtp)) = line.trim_start_matches("a=fmtp:").split_once(' ') else {
            continue;
        };
        if h265_payloads.contains(&payload_type) {
            return Ok(fmtp.to_owned());
        }
    }
    Ok(String::new())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Format {
    pub payload_type: u8,
    pub codec: VideoCodec,
    pub limits: Limits,
}
