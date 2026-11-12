//! Local video track that keeps one packetizer per advertised codec.
//!
//! Codec negotiation happens after the track is added, and the maintained
//! stack narrows a multi-codec offer to one encoding. A static sample track
//! would keep the packetizer for the first advertised codec even when the
//! answer selected the other one. This track writes through the codec chosen
//! by the negotiated format so SDP, payload type and RTP payload stay aligned.
use crate::codec::VideoCodec;
use rtc::{
    media::Sample,
    media_stream::{
        MediaStreamId, MediaStreamTrack, MediaStreamTrackId, MediaStreamTrackState,
        MediaTrackCapabilities, MediaTrackConstraints, MediaTrackSettings,
    },
    rtp::{
        self,
        packetizer::{self, Packetizer},
        sequence::{self, Sequencer},
    },
    rtp_transceiver::{
        rtp_sender::{RTCRtpCodec, RTCRtpEncodingParameters, RtpCodecKind},
        PayloadType, RtpStreamId, SSRC,
    },
};
use std::{collections::HashMap, time::Instant};
use tokio::sync::Mutex;
use webrtc::{
    error::{Error, Result},
    media_stream::{
        track_local::{
            static_rtp::TrackLocalStaticRTP, TrackLocal, TrackLocalContext, TrackLocalEvent,
        },
        Track,
    },
    runtime::Receiver,
};

const MTU: usize = 1200;
const VIDEO_CLOCK_RATE: u32 = 90_000;

pub struct DynamicVideoTrack {
    rtp_track: TrackLocalStaticRTP,
    packetizers: HashMap<VideoCodec, Mutex<Box<dyn Packetizer>>>,
    sequencer: Box<dyn Sequencer>,
}

impl DynamicVideoTrack {
    pub fn new(
        now: Instant,
        track: MediaStreamTrack,
        ssrc: SSRC,
        codecs: &[(VideoCodec, RTCRtpCodec)],
    ) -> Result<Self> {
        let sequencer: Box<dyn Sequencer> = Box::new(sequence::new_random_sequencer());
        let mut packetizers = HashMap::with_capacity(codecs.len());
        for (codec, parameters) in codecs {
            let payloader = parameters.payloader()?;
            packetizers.insert(
                *codec,
                Mutex::new(Box::new(packetizer::new_packetizer(
                    now,
                    MTU,
                    0,
                    ssrc,
                    payloader,
                    sequencer.clone(),
                    VIDEO_CLOCK_RATE,
                )) as Box<dyn Packetizer>),
            );
        }
        Ok(Self {
            rtp_track: TrackLocalStaticRTP::new(track),
            packetizers,
            sequencer,
        })
    }

    #[cfg(test)]
    pub(crate) fn supports_codec(&self, codec: VideoCodec) -> bool {
        self.packetizers.contains_key(&codec)
    }

    pub async fn write_sample(
        &self,
        codec: VideoCodec,
        payload_type: PayloadType,
        sample: &Sample,
        extensions: &[rtp::extension::HeaderExtension],
    ) -> Result<()> {
        if sample.prev_dropped_packets > 0 {
            for _ in 0..sample.prev_dropped_packets {
                self.sequencer.next_sequence_number();
            }
        }
        let packetizer = self.packetizers.get(&codec).ok_or(Error::CodecNotFound)?;
        let samples = (sample.duration.as_secs_f64() * VIDEO_CLOCK_RATE as f64) as u32;
        let packets = {
            let mut packetizer = packetizer.lock().await;
            if sample.prev_dropped_packets > 0 {
                packetizer.skip_samples(samples * sample.prev_dropped_packets as u32);
            }
            packetizer.packetize(sample.timestamp, &sample.data, samples)?
        };
        for mut packet in packets {
            packet.header.payload_type = payload_type;
            self.rtp_track
                .write_rtp_with_extensions(packet, extensions)
                .await?;
        }
        Ok(())
    }
}

#[async_trait::async_trait]
impl Track for DynamicVideoTrack {
    async fn stream_id(&self) -> MediaStreamId {
        self.rtp_track.stream_id().await
    }
    async fn track_id(&self) -> MediaStreamTrackId {
        self.rtp_track.track_id().await
    }
    async fn label(&self) -> String {
        self.rtp_track.label().await
    }
    async fn kind(&self) -> RtpCodecKind {
        self.rtp_track.kind().await
    }
    async fn rid(&self, ssrc: SSRC) -> Option<RtpStreamId> {
        self.rtp_track.rid(ssrc).await
    }
    async fn codec(&self, ssrc: SSRC) -> Option<RTCRtpCodec> {
        self.rtp_track.codec(ssrc).await
    }
    async fn ssrcs(&self) -> Vec<SSRC> {
        self.rtp_track.ssrcs().await
    }
    async fn enabled(&self) -> bool {
        self.rtp_track.enabled().await
    }
    async fn set_enabled(&self, enabled: bool) {
        self.rtp_track.set_enabled(enabled).await;
    }
    async fn muted(&self) -> bool {
        self.rtp_track.muted().await
    }
    async fn set_muted(&self, muted: bool) {
        self.rtp_track.set_muted(muted).await;
    }
    async fn ready_state(&self) -> MediaStreamTrackState {
        self.rtp_track.ready_state().await
    }
    async fn stop(&self) {
        self.rtp_track.stop().await;
    }
    async fn get_capabilities(&self) -> MediaTrackCapabilities {
        self.rtp_track.get_capabilities().await
    }
    async fn get_constraints(&self) -> MediaTrackConstraints {
        self.rtp_track.get_constraints().await
    }
    async fn get_settings(&self) -> MediaTrackSettings {
        self.rtp_track.get_settings().await
    }
    async fn apply_constraints(&self, constraints: Option<MediaTrackConstraints>) {
        self.rtp_track.apply_constraints(constraints).await;
    }
    async fn codings(&self) -> Vec<RTCRtpEncodingParameters> {
        self.rtp_track.codings().await
    }
    async fn add_coding(&self, coding: RTCRtpEncodingParameters) {
        self.rtp_track.add_coding(coding).await;
    }
}

#[async_trait::async_trait]
impl TrackLocal for DynamicVideoTrack {
    async fn track(&self) -> MediaStreamTrack {
        self.rtp_track.track().await
    }
    async fn bind(&self, ctx: TrackLocalContext, evt_rx: Receiver<TrackLocalEvent>) {
        self.rtp_track.bind(ctx, evt_rx).await;
    }
    async fn unbind(&self) {
        self.rtp_track.unbind().await;
    }
    async fn write_rtp(&self, packet: rtp::Packet) -> Result<()> {
        self.rtp_track.write_rtp(packet).await
    }
    async fn write_rtcp(&self, packets: Vec<Box<dyn rtc::rtcp::Packet>>) -> Result<()> {
        self.rtp_track.write_rtcp(packets).await
    }
    async fn poll(&self) -> Option<TrackLocalEvent> {
        self.rtp_track.poll().await
    }
}
