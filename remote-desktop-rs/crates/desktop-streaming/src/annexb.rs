//! Container framing only: native encoders expose AVCC, RTP accepts Annex B.
//! Codec parsing/encoding remains in maintained native/OpenH264 libraries.
use crate::codec::VideoCodec;

const MAX_FRAME: usize = 16 * 1024 * 1024;
pub fn from_avcc(
    data: &[u8],
    length_bytes: usize,
    parameters: &[Vec<u8>],
) -> anyhow::Result<(Vec<u8>, bool)> {
    from_avcc_for(data, length_bytes, parameters, VideoCodec::H264)
}

pub fn from_avcc_for(
    data: &[u8],
    length_bytes: usize,
    parameters: &[Vec<u8>],
    codec: VideoCodec,
) -> anyhow::Result<(Vec<u8>, bool)> {
    anyhow::ensure!(
        [1, 2, 4].contains(&length_bytes) && !data.is_empty() && data.len() <= MAX_FRAME,
        "invalid AVCC frame"
    );
    let mut rest = data;
    let mut payload = Vec::new();
    let mut idr = false;
    while !rest.is_empty() {
        anyhow::ensure!(rest.len() >= length_bytes, "truncated AVCC length");
        let length = rest[..length_bytes]
            .iter()
            .fold(0usize, |n, b| (n << 8) | *b as usize);
        rest = &rest[length_bytes..];
        anyhow::ensure!(
            length > 0 && length <= rest.len(),
            "invalid AVCC NAL length"
        );
        let nal = &rest[..length];
        rest = &rest[length..];
        match codec {
            VideoCodec::H264 => {
                anyhow::ensure!(nal[0] & 0x80 == 0, "invalid H264 NAL header");
                idr |= nal[0] & 0x1f == 5;
            }
            VideoCodec::H265 => {
                anyhow::ensure!(
                    nal.len() >= 2 && nal[0] & 0x80 == 0,
                    "invalid H265 NAL header"
                );
                let layer_id = ((nal[0] as u16 & 1) << 5) | (nal[1] as u16 >> 3);
                anyhow::ensure!(layer_id == 0, "H265 layer unsupported");
                idr |= matches!((nal[0] >> 1) & 0x3f, 16..=21);
            }
        }
        anyhow::ensure!(
            payload.len() + 4 + nal.len() <= MAX_FRAME,
            "AnnexB frame too large"
        );
        payload.extend_from_slice(&[0, 0, 0, 1]);
        payload.extend_from_slice(nal);
    }
    let mut output = Vec::new();
    if idr {
        let required: &[u8] = match codec {
            VideoCodec::H264 => &[7, 8],
            VideoCodec::H265 => &[32, 33, 34],
        };
        anyhow::ensure!(
            parameters.iter().all(|p| !p.is_empty())
                && required.iter().all(|required| parameters.iter().any(|p| {
                    match codec {
                        VideoCodec::H264 => p[0] & 0x1f == *required,
                        VideoCodec::H265 => p.len() >= 2 && (p[0] >> 1) & 0x3f == *required,
                    }
                })),
            "IDR parameters missing"
        );
        for nal in parameters {
            anyhow::ensure!(
                !nal.is_empty() && nal.len() <= 65536,
                "invalid parameter set"
            );
            anyhow::ensure!(
                output.len() + 4 + nal.len() <= MAX_FRAME,
                "parameter sets too large"
            );
            output.extend_from_slice(&[0, 0, 0, 1]);
            output.extend_from_slice(nal);
        }
    }
    anyhow::ensure!(
        output.len() + payload.len() <= MAX_FRAME,
        "AnnexB frame too large"
    );
    output.extend_from_slice(&payload);
    Ok((output, idr))
}
