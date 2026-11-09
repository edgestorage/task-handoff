//! WebRTC boundary for the G1 synthetic vertical slice. No host input/OS capture.
use crate::{
    channel::{Channel, MAX_CLIPBOARD_WIRE, MAX_MESSAGE},
    synthetic::SyntheticInput,
};
use async_trait::async_trait;
use rtc::{
    interceptor::{
        BandwidthEstimator, EstimatorStats, Gcc, Interceptor, Packet, PacketReport, Slot,
        StreamInfo, TaggedPacket,
    },
    media::Sample,
    media_stream::MediaStreamTrack,
    rtp_transceiver::rtp_sender::{
        RTCRtpCodec, RTCRtpCodecParameters, RTCRtpCodingParameters, RTCRtpEncodingParameters,
        RtpCodecKind,
    },
    sansio::Protocol,
};
use std::{
    collections::VecDeque,
    sync::{
        atomic::{AtomicBool, AtomicU64, AtomicU8, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};
use tokio::{
    sync::{mpsc, Notify},
    task::JoinSet,
};
use webrtc::{
    data_channel::{DataChannel, DataChannelEvent, RTCDataChannelInit},
    media_stream::{
        track_local::{static_sample::TrackLocalStaticSample, TrackLocal},
        Track,
    },
    peer_connection::*,
};

pub enum PeerEvent {
    Connected(String),
    Disconnected(String),
    Recovering(String),
    Recovered(String),
    Failed(String),
    GeometryUnstable {
        session: String,
        acknowledged: tokio::sync::oneshot::Sender<()>,
    },
    GeometryChanged {
        session: String,
        geometry: crate::traits::Geometry,
        acknowledged: tokio::sync::oneshot::Sender<bool>,
    },
    BackendFailed {
        session: String,
        cause: crate::error::BackendError,
    },
    Channel {
        session: String,
        kind: Channel,
        channel: Arc<dyn DataChannel>,
    },
    Message {
        session: String,
        kind: Channel,
        bytes: Vec<u8>,
        received: Instant,
    },
}
pub struct MediaControl {
    pub pacing: Arc<crate::pacing::PacingFeedback>,
    pub paused: AtomicBool,
    pub webrtc_ready: AtomicBool,
    pub idr: AtomicBool,
    pub input: Mutex<SyntheticInput>,
    format: Mutex<Option<crate::codec::Format>>,
    resolution: Mutex<Option<(u32, u32)>>,
    frame_rate: Mutex<Option<u32>>,
    pub wake: Notify,
    pub frames_sent: AtomicU64,
    pub frame_budget_drops: AtomicU64,
    pub keyframes_sent: AtomicU64,
    encoder_name: Mutex<Option<&'static str>>,
    fallback: Mutex<Option<mpsc::Sender<remote_desktop_protocol::fallback::EncodedFrame>>>,
}
impl Default for MediaControl {
    fn default() -> Self {
        Self {
            pacing: Arc::new(crate::pacing::PacingFeedback::default()),
            paused: AtomicBool::new(true),
            webrtc_ready: AtomicBool::new(false),
            idr: AtomicBool::new(true),
            input: Mutex::new(SyntheticInput::default()),
            format: Mutex::new(None),
            resolution: Mutex::new(None),
            frame_rate: Mutex::new(None),
            wake: Notify::new(),
            frames_sent: AtomicU64::new(0),
            frame_budget_drops: AtomicU64::new(0),
            keyframes_sent: AtomicU64::new(0),
            encoder_name: Mutex::new(None),
            fallback: Mutex::new(None),
        }
    }
}
impl MediaControl {
    pub fn pause(&self, paused: bool) {
        let previous = self.paused.swap(paused, Ordering::SeqCst);
        self.pacing.paused.store(paused, Ordering::SeqCst);
        if previous && !paused {
            self.idr.store(true, Ordering::SeqCst);
        }
        if previous != paused {
            self.wake.notify_one();
        }
    }
    pub fn set_stream_limits(&self, resolution: Option<(u32, u32)>, frame_rate: Option<u32>) {
        *self.resolution.lock().unwrap() = resolution;
        *self.frame_rate.lock().unwrap() = frame_rate;
        self.idr.store(true, Ordering::SeqCst);
        self.wake.notify_one();
    }
    pub fn resolution_limit(&self) -> Option<(u32, u32)> {
        *self.resolution.lock().unwrap()
    }
    pub fn frame_rate_limit(&self) -> Option<u32> {
        *self.frame_rate.lock().unwrap()
    }
    pub fn set_fallback(
        &self,
        sender: Option<mpsc::Sender<remote_desktop_protocol::fallback::EncodedFrame>>,
    ) {
        *self.fallback.lock().unwrap() = sender;
        self.idr.store(true, Ordering::SeqCst);
        self.wake.notify_one();
    }
    pub fn set_webrtc_ready(&self, ready: bool) {
        self.webrtc_ready.store(ready, Ordering::SeqCst);
    }
    /// Fallback can start before WebRTC finishes negotiation. The encoder loop
    /// still needs a codec budget even though no RTP receiver is attached.
    pub fn ensure_fallback_format(&self) {
        let mut format = self.format.lock().unwrap();
        if format.is_none() {
            *format = Some(crate::codec::Format {
                payload_type: 96,
                limits: crate::video::FALLBACK_LIMITS,
            });
        }
    }
    pub fn fallback_sender(
        &self,
    ) -> Option<mpsc::Sender<remote_desktop_protocol::fallback::EncodedFrame>> {
        self.fallback.lock().unwrap().clone()
    }
}
struct Handler {
    session: String,
    events: mpsc::Sender<PeerEvent>,
    gather: tokio::sync::watch::Sender<u64>,
    tasks: Arc<Mutex<JoinSet<()>>>,
    channels: AtomicU8,
}
#[async_trait]
impl PeerConnectionEventHandler for Handler {
    async fn on_ice_gathering_state_change(&self, state: RTCIceGatheringState) {
        if state == RTCIceGatheringState::Complete {
            self.gather.send_modify(|generation| *generation += 1);
        }
    }
    async fn on_ice_connection_state_change(&self, state: RTCIceConnectionState) {
        let event = match state {
            RTCIceConnectionState::Checking => PeerEvent::Recovering(self.session.clone()),
            RTCIceConnectionState::Connected | RTCIceConnectionState::Completed => {
                PeerEvent::Recovered(self.session.clone())
            }
            _ => return,
        };
        let _ = self.events.send(event).await;
    }
    async fn on_connection_state_change(&self, state: RTCPeerConnectionState) {
        let event = match state {
            RTCPeerConnectionState::Connected => PeerEvent::Connected(self.session.clone()),
            RTCPeerConnectionState::Disconnected => PeerEvent::Disconnected(self.session.clone()),
            RTCPeerConnectionState::Failed => PeerEvent::Failed(self.session.clone()),
            _ => return,
        };
        let _ = self.events.send(event).await;
    }
    async fn on_data_channel(&self, dc: Arc<dyn DataChannel>) {
        let kind = match dc.label().await.as_deref() {
            Ok("control") => Channel::Control,
            Ok("input") => Channel::Input,
            Ok("pointer") => Channel::Pointer,
            Ok("clipboard") => Channel::Clipboard,
            _ => {
                let _ = dc.close().await;
                return;
            }
        };
        let bit = match kind {
            Channel::Control => 1,
            Channel::Input => 2,
            Channel::Pointer => 4,
            Channel::Clipboard => 8,
        };
        let valid = dc.negotiated().await == Ok(true)
            && dc.id() == usize::from(kind.id())
            && dc.ordered().await == Ok(kind.ordered())
            && dc.max_retransmits().await == Ok(kind.max_retransmits())
            && dc.max_packet_life_time().await == Ok(None);
        if !valid || self.channels.fetch_or(bit, Ordering::SeqCst) & bit != 0 {
            eprintln!("synthetic invalid channel configuration: {kind:?}");
            let _ = self
                .events
                .send(PeerEvent::Failed(self.session.clone()))
                .await;
            let _ = dc.close().await;
            return;
        }
        let tx = self.events.clone();
        let session = self.session.clone();
        if tx
            .send(PeerEvent::Channel {
                session: session.clone(),
                kind,
                channel: dc.clone(),
            })
            .await
            .is_err()
        {
            return;
        }
        self.tasks.lock().unwrap().spawn(async move {
            while let Some(event) = dc.poll().await {
                match event {
                    DataChannelEvent::OnMessage(message) => {
                        let limit = if kind == Channel::Clipboard {
                            MAX_CLIPBOARD_WIRE
                        } else {
                            MAX_MESSAGE
                        };
                        if !message.is_string || message.data.len() > limit {
                            eprintln!("synthetic invalid channel wire: {kind:?}");
                            let _ = tx.send(PeerEvent::Failed(session.clone())).await;
                            break;
                        }
                        let event = PeerEvent::Message {
                            session: session.clone(),
                            kind,
                            bytes: message.data.to_vec(),
                            received: Instant::now(),
                        };
                        if tx.try_send(event).is_err() {
                            let _ = tx.send(PeerEvent::Failed(session.clone())).await;
                            break;
                        }
                    }
                    DataChannelEvent::OnClose => {
                        eprintln!("synthetic channel closed: {kind:?}");
                        let _ = tx.send(PeerEvent::Failed(session.clone())).await;
                        break;
                    }
                    _ => {}
                }
            }
        });
    }
}

// Glue around the maintained GCC estimator, publishing its actual feedback-driven
// target. No locally invented bandwidth estimator or retransmission algorithm.
struct ReportingEstimator {
    inner: Gcc,
    target: Arc<AtomicU64>,
}
impl BandwidthEstimator for ReportingEstimator {
    fn on_reports(&mut self, now: Instant, reports: &[PacketReport]) {
        self.inner.on_reports(now, reports);
        self.target
            .store(self.inner.target_bitrate() as u64, Ordering::Relaxed);
    }
    fn target_bitrate(&self) -> f64 {
        self.inner.target_bitrate()
    }
    fn handle_timeout(&mut self, now: Instant) {
        self.inner.handle_timeout(now);
        self.target
            .store(self.inner.target_bitrate() as u64, Ordering::Relaxed);
    }
    fn poll_timeout(&self) -> Option<Instant> {
        self.inner.poll_timeout()
    }
    fn stats(&self) -> EstimatorStats {
        self.inner.stats()
    }
}
// The default chain consumes RTCP. Observe PLI/FIR at the application slot after
// standard interceptors have processed the feedback, without logging its body.
struct KeyframeFeedback {
    read: VecDeque<TaggedPacket>,
    write: VecDeque<TaggedPacket>,
    idr: Arc<MediaControl>,
}
impl Protocol<TaggedPacket, TaggedPacket, ()> for KeyframeFeedback {
    type Rout = TaggedPacket;
    type Wout = TaggedPacket;
    type Eout = ();
    type Error = rtc::shared::error::Error;
    type Time = Instant;
    fn handle_read(&mut self, packet: TaggedPacket) -> Result<(), Self::Error> {
        if let Packet::Rtcp(packets) = &packet.message.packet {
            if packets.iter().any(|p|p.as_any().is::<rtc::rtcp::payload_feedbacks::picture_loss_indication::PictureLossIndication>() || p.as_any().is::<rtc::rtcp::payload_feedbacks::full_intra_request::FullIntraRequest>()) {self.idr.idr.store(true,Ordering::SeqCst);}
        }
        self.read.push_back(packet);
        Ok(())
    }
    fn poll_read(&mut self) -> Option<Self::Rout> {
        self.read.pop_front()
    }
    fn handle_write(&mut self, packet: TaggedPacket) -> Result<(), Self::Error> {
        self.write.push_back(packet);
        Ok(())
    }
    fn poll_write(&mut self) -> Option<Self::Wout> {
        self.write.pop_front()
    }
}
impl Interceptor for KeyframeFeedback {
    fn bind_local_stream(&mut self, _: &StreamInfo) {}
    fn unbind_local_stream(&mut self, _: &StreamInfo) {}
    fn bind_remote_stream(&mut self, _: &StreamInfo) {}
    fn unbind_remote_stream(&mut self, _: &StreamInfo) {}
}

pub struct MediaPeer {
    pc: Arc<dyn PeerConnection>,
    control: Arc<MediaControl>,
    tasks: Arc<Mutex<JoinSet<()>>>,
    gather: tokio::sync::watch::Receiver<u64>,
    track: Arc<TrackLocalStaticSample>,
    target: Arc<AtomicU64>,
    sender: Arc<dyn webrtc::rtp_transceiver::RtpSender>,
    started: bool,
    source: Option<crate::capture::Source>,
}
impl Drop for MediaPeer {
    fn drop(&mut self) {
        self.tasks.lock().unwrap().abort_all();
    }
}
impl MediaPeer {
    pub async fn configure_ice(
        &self,
        servers: &[crate::contract::IceServer],
    ) -> anyhow::Result<()> {
        let configuration = RTCConfigurationBuilder::new()
            .with_ice_servers(
                servers
                    .iter()
                    .map(|s| RTCIceServer {
                        urls: s.urls.clone(),
                        username: s.username.clone(),
                        credential: s.credential.clone(),
                    })
                    .collect(),
            )
            .build();
        self.pc.set_configuration(configuration).await?;
        Ok(())
    }
    pub async fn candidate(&self, candidate: &crate::contract::IceCandidate) -> anyhow::Result<()> {
        self.pc
            .add_ice_candidate(RTCIceCandidateInit {
                candidate: candidate.candidate.clone(),
                url: None,
                sdp_mid: candidate.sdp_mid.clone(),
                sdp_mline_index: candidate.sdp_m_line_index,
                username_fragment: None,
            })
            .await?;
        Ok(())
    }
    pub async fn new(session: String, events: mpsc::Sender<PeerEvent>) -> anyhow::Result<Self> {
        Self::with_source(session, events, crate::capture::Source::Synthetic).await
    }
    pub async fn with_source(
        session: String,
        events: mpsc::Sender<PeerEvent>,
        source: crate::capture::Source,
    ) -> anyhow::Result<Self> {
        let control = Arc::new(MediaControl::default());
        let tasks = Arc::new(Mutex::new(JoinSet::new()));
        let (gather_events, gather) = tokio::sync::watch::channel(0);
        let target = Arc::new(AtomicU64::new(crate::video::INITIAL_BITRATE as u64));
        let codec = RTCRtpCodec {
            mime_type: "video/H264".into(),
            clock_rate: 90000,
            channels: 0,
            sdp_fmtp_line: "level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e028"
                .into(),
            rtcp_feedback: vec![],
        };
        let mut engine = MediaEngine::default();
        engine.register_codec(
            RTCRtpCodecParameters {
                rtp_codec: codec.clone(),
                payload_type: 96,
            },
            RtpCodecKind::Video,
        )?;
        let estimator = ReportingEstimator {
            inner: Gcc::new(crate::video::INITIAL_BITRATE as f64, 100_000.0, 8_000_000.0),
            target: target.clone(),
        };
        let registry = configure_congestion_control(
            Registry::new(),
            estimator,
            CongestionFeedback::Twcc,
            &mut engine,
        )?;
        let registry = register_default_interceptors(registry, &mut engine)?
            .with(
                Slot::Pacer,
                crate::pacing::GopPacer::new(control.pacing.clone()),
            )
            .with(
                Slot::from(14_000),
                KeyframeFeedback {
                    read: VecDeque::new(),
                    write: VecDeque::new(),
                    idr: control.clone(),
                },
            );
        let handler = Arc::new(Handler {
            session,
            events,
            gather: gather_events,
            tasks: tasks.clone(),
            channels: AtomicU8::new(0),
        });
        let media_bind = if matches!(source, crate::capture::Source::Synthetic) {
            "127.0.0.1:0"
        } else {
            "0.0.0.0:0"
        };
        let pc = PeerConnectionBuilder::new()
            .with_media_engine(engine)
            .with_interceptor_registry(registry)
            .with_data_channel_send_buffer_limit(64 * 1024)
            .with_handler(handler.clone())
            // The management bridge stays loopback. Native harness media may
            // cross the test LAN; ICE/DTLS still authenticate the negotiated peer.
            // Adapter/relay ICE servers belong to the later integration path.
            .with_udp_addrs(vec![media_bind])
            .build()
            .await?;
        // rtc 0.21.1's DCEP accept path drops incoming reliability metadata.
        // Standard out-of-band negotiation preserves the wire policy on both
        // endpoints without weakening validation or patching a dependency.
        for kind in [
            Channel::Control,
            Channel::Input,
            Channel::Pointer,
            Channel::Clipboard,
        ] {
            let dc = pc
                .create_data_channel(
                    kind.label(),
                    Some(RTCDataChannelInit {
                        ordered: kind.ordered(),
                        max_retransmits: kind.max_retransmits(),
                        negotiated: Some(kind.id()),
                        ..Default::default()
                    }),
                )
                .await?;
            handler.on_data_channel(dc).await;
        }
        let track = Arc::new(TrackLocalStaticSample::new(
            Instant::now(),
            MediaStreamTrack::new(
                "synthetic-video".into(),
                "synthetic-stream".into(),
                "G1 synthetic".into(),
                RtpCodecKind::Video,
                vec![RTCRtpEncodingParameters {
                    rtp_coding_parameters: RTCRtpCodingParameters {
                        ssrc: Some(rand::random()),
                        ..Default::default()
                    },
                    codec,
                    ..Default::default()
                }],
            ),
        )?);
        let sender = pc.add_track(track.clone() as Arc<dyn TrackLocal>).await?;
        Ok(Self {
            pc: Arc::new(pc),
            control,
            tasks,
            gather,
            track,
            target,
            sender,
            started: false,
            source: Some(source),
        })
    }
    pub fn control(&self) -> Arc<MediaControl> {
        self.control.clone()
    }
    pub async fn answer(
        &mut self,
        sdp: String,
        fallback_active: bool,
    ) -> anyhow::Result<(String, bool)> {
        anyhow::ensure!(sdp.len() <= 512 * 1024, "SDP too large");
        let video = sdp
            .lines()
            .filter(|line| line.starts_with("m=video "))
            .count();
        let app = sdp
            .lines()
            .filter(|line| line.starts_with("m=application "))
            .count();
        anyhow::ensure!(
            video == 1 && app == 1 && sdp.lines().filter(|l| l.starts_with("m=")).count() == 2,
            "invalid media layout"
        );
        let offer = RTCSessionDescription::offer(crate::codec::promote_h264_level_4_0(&sdp))?;
        let old = self.pc.current_remote_description().await;
        let initial = old.is_none();
        let gather_required = match old {
            Some(old) => ice_generation(&old)? != ice_generation(&offer)?,
            None => true,
        };
        let completed = *self.gather.borrow();
        // Credential rotation/network recovery is serialized at the signaling
        // boundary. A new ICE generation must explicitly arm the library's
        // rebind path before creating the answer; replacing configuration alone
        // does not prove a new allocation or candidate pair.
        if gather_required {
            self.pc.restart_ice().await?;
        }
        self.pc.set_remote_description(offer).await?;
        let answer = self.pc.create_answer(None).await?;
        self.pc.set_local_description(answer).await?;
        let parameters = self.sender.get_parameters().await?;
        let codec = parameters
            .rtp_parameters
            .codecs
            .first()
            .ok_or_else(|| anyhow::anyhow!("missing negotiated codec"))?;
        let format = crate::codec::Format {
            payload_type: codec.payload_type,
            limits: crate::codec::Limits::parse(&codec.rtp_codec.sdp_fmtp_line)?,
        };
        {
            let mut previous = self.control.format.lock().unwrap();
            if previous.is_some_and(|old| old != format) {
                // Receiver constraints/payload can change on renegotiation. Do
                // not carry queued frames or retransmissions across formats.
                self.control
                    .pacing
                    .reset_requested
                    .store(true, Ordering::SeqCst);
            }
            *previous = Some(format);
        }
        self.control.idr.store(true, Ordering::SeqCst);
        if gather_required {
            // A dead STUN/TURN endpoint must not fail negotiation: host and
            // server-reflexive candidates gathered before the deadline are
            // already usable on a LAN. If none are usable the browser reports
            // ICE failure and selects the WebSocket fallback. Returning the
            // partial local description keeps the session alive for fallback.
            // The actor is serialized: a long gather wait also blocks the
            // fallback attach events that are already queued behind the offer.
            // Bound the initial negotiation so progressive fallback can start
            // near the head-start deadline. Host/srflx candidates are normally
            // available in well under this window; a black-holed TURN endpoint
            // must not delay the first fallback frame by seconds.
            let timeout = if fallback_active {
                Duration::from_millis(300)
            } else if initial {
                Duration::from_millis(500)
            } else {
                Duration::from_secs(5)
            };
            let gathered = tokio::time::timeout(
                timeout,
                self.gather.wait_for(|generation| *generation > completed),
            )
            .await;
            if let Ok(result) = gathered {
                result?;
            }
        }
        let answer = self
            .pc
            .local_description()
            .await
            .ok_or_else(|| anyhow::anyhow!("missing answer"))?
            .sdp;
        Ok((answer, gather_required))
    }
    pub fn metrics(&self) -> crate::contract::MediaMetrics {
        let pacing = &self.control.pacing;
        crate::contract::MediaMetrics {
            encoder: self.control.encoder_name.lock().unwrap().map(str::to_owned),
            estimated_bitrate: self.target.load(Ordering::Relaxed),
            paced_bitrate: pacing.target_bitrate.load(Ordering::Relaxed),
            queued_bytes: pacing.queued_bytes.load(Ordering::Relaxed),
            max_queued_bytes: pacing.max_queued_bytes.load(Ordering::Relaxed),
            queue_resets: pacing.resets.load(Ordering::Relaxed),
            frame_budget_drops: self.control.frame_budget_drops.load(Ordering::Relaxed),
            frames_sent: self.control.frames_sent.load(Ordering::Relaxed),
            keyframes_sent: self.control.keyframes_sent.load(Ordering::Relaxed),
        }
    }
    pub async fn clipboard_supported(&self) -> bool {
        let Some(sctp) = self.pc.sctp().await else {
            return false;
        };
        sctp.max_message_size()
            .await
            .is_ok_and(|size| size as usize >= MAX_CLIPBOARD_WIRE)
    }
    pub async fn start(
        &mut self,
        session: String,
        events: mpsc::Sender<PeerEvent>,
    ) -> anyhow::Result<()> {
        if self.started {
            return Ok(());
        }
        self.started = true;
        let mut source = self
            .source
            .take()
            .ok_or_else(|| anyhow::anyhow!("missing capture source"))?;
        let control = self.control.clone();
        let track = self.track.clone();
        let target = self.target.clone();
        self.tasks.lock().unwrap().spawn(async move {
            let result = async {
                let ssrc = *track
                    .ssrcs()
                    .await
                    .first()
                    .ok_or_else(|| anyhow::anyhow!("missing SSRC"))?;
                let mut format = control
                    .format
                    .lock()
                    .unwrap()
                    .ok_or_else(|| anyhow::anyhow!("missing negotiated format"))?;
                let policy = if matches!(&source, crate::capture::Source::Synthetic) {
                    crate::encoder::Policy::Software
                } else {
                    crate::encoder::Policy::Automatic
                };
                let mut encoder = crate::encoder::Encoder::new(
                    crate::video::INITIAL_BITRATE,
                    format.limits,
                    0,
                    policy,
                )?;
                let mut index = 0;
                let mut previous_sample = Instant::now();
                let mut frame_pressure = crate::video::FramePressure::default();
                let mut quality = crate::video::SoftwareQuality::default();
                let mut last_rate = Instant::now();
                let process_start = Instant::now();
                let mut fallback_frame_id = 0u32;
                let mut geometry = source.geometry();
                let mut geometry_unstable = None;
                let mut resolution = control.resolution_limit();
                let mut frame_rate = control.frame_rate_limit();
                let mut budget = crate::video::Budget::select_with_limits_resolution_and_fps(
                    geometry.width,
                    geometry.height,
                    crate::video::INITIAL_BITRATE,
                    format.limits,
                    resolution,
                    frame_rate,
                );
                let mut ticker = tokio::time::interval(budget.frame_time());
                ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
                loop {
                    if control.paused.load(Ordering::SeqCst) {
                        let (next, result) = tokio::task::spawn_blocking(move || {
                            let result = source.pause();
                            (source, result)
                        })
                        .await?;
                        source = next;
                        result?;
                        control.wake.notified().await;
                        continue;
                    }
                    ticker.tick().await;
                    if control.paused.load(Ordering::SeqCst) {
                        continue;
                    }

                    let (next_source, refreshed) = tokio::task::spawn_blocking(move || {
                        let refreshed = source.refresh_geometry();
                        (source, refreshed)
                    })
                    .await?;
                    source = next_source;
                    let refreshed = match refreshed {
                        Ok(g) => {
                            geometry_unstable = None;
                            g
                        }
                        Err(error)
                            if error.downcast_ref::<crate::error::BackendError>()
                                == Some(&crate::error::BackendError::GeometryChanged) =>
                        {
                            let since = geometry_unstable.get_or_insert_with(Instant::now);
                            anyhow::ensure!(
                                since.elapsed() < Duration::from_secs(2),
                                crate::error::BackendError::GeometryChanged
                            );
                            let (acknowledged, wait) = tokio::sync::oneshot::channel();
                            events
                                .send(PeerEvent::GeometryUnstable {
                                    session: session.clone(),
                                    acknowledged,
                                })
                                .await?;
                            tokio::time::timeout(Duration::from_secs(2), wait).await??;
                            continue;
                        }
                        Err(error) => return Err(error),
                    };
                    if refreshed != geometry {
                        // Do not capture/encode the replacement geometry before
                        // the actor releases the old epoch and publishes authority.
                        let (acknowledged, wait) = tokio::sync::oneshot::channel();
                        events
                            .send(PeerEvent::GeometryChanged {
                                session: session.clone(),
                                geometry: refreshed,
                                acknowledged,
                            })
                            .await?;
                        if !tokio::time::timeout(Duration::from_secs(2), wait).await?? {
                            continue;
                        }
                        geometry = refreshed;
                        control.pacing.request_idr.store(true, Ordering::SeqCst);
                        control.idr.store(true, Ordering::SeqCst);
                    }
                    let next_format = control
                        .format
                        .lock()
                        .unwrap()
                        .ok_or_else(|| anyhow::anyhow!("missing negotiated format"))?;
                    let min_qp = quality.floor(Instant::now());
                    if next_format != format || min_qp != encoder.min_qp() {
                        format = next_format;
                        encoder.reconfigure(encoder.bitrate(), format.limits, min_qp)?;
                        control.idr.store(true, Ordering::SeqCst);
                    }
                    let idr = control.idr.swap(false, Ordering::SeqCst)
                        | control.pacing.request_idr.swap(false, Ordering::SeqCst);
                    let fallback = control.fallback_sender();
                    let max_bitrate = if fallback.is_some() {
                        format
                            .limits
                            .max_bitrate
                            .min(crate::video::FALLBACK_MAX_BITRATE)
                    } else {
                        format.limits.max_bitrate
                    };
                    let desired = (target.load(Ordering::Relaxed) as u32).clamp(1, max_bitrate);
                    if last_rate.elapsed() >= Duration::from_secs(1)
                        && encoder.bitrate().abs_diff(desired) > encoder.bitrate() / 5
                    {
                        encoder.reconfigure(desired, format.limits, min_qp)?;
                        last_rate = Instant::now();
                        control.idr.store(true, Ordering::SeqCst);
                    }
                    let next_resolution = control.resolution_limit();
                    let next_frame_rate = control.frame_rate_limit();
                    if next_resolution != resolution || next_frame_rate != frame_rate {
                        resolution = next_resolution;
                        frame_rate = next_frame_rate;
                        frame_pressure = crate::video::FramePressure::default();
                        control.idr.store(true, Ordering::SeqCst);
                    }
                    let next_budget = frame_pressure.fit(
                        crate::video::Budget::select_with_limits_resolution_and_fps(
                            geometry.width,
                            geometry.height,
                            desired,
                            format.limits,
                            resolution,
                            frame_rate,
                        ),
                        Instant::now(),
                    );
                    if next_budget != budget {
                        budget = next_budget;
                        ticker = tokio::time::interval(budget.frame_time());
                        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
                        control.idr.store(true, Ordering::SeqCst);
                    }
                    let input = control.input.lock().unwrap().clone();
                    index += 1;
                    // One capture/convert/encode worker; no raw-frame queue grows
                    // while an encoder is busy. Native callbacks retain only one frame.
                    let (next, next_source, frame) = tokio::task::spawn_blocking(move || {
                        let result = (|| -> anyhow::Result<_> {
                            let Some(yuv) = source.frame(index, &input, idr, budget)? else {
                                return Ok(None);
                            };
                            encoder.encode(&yuv, idr)
                        })();
                        (encoder, source, result)
                    })
                    .await?;
                    encoder = next;
                    *control.encoder_name.lock().unwrap() = Some(encoder.name());
                    source = next_source;
                    let Some(mut frame) = frame? else {
                        if idr {
                            control.idr.store(true, Ordering::SeqCst);
                        }
                        continue;
                    };
                    if !crate::video::FramePressure::fits(frame.annex_b.len(), desired)
                        && encoder.is_software()
                        && quality.reject(Instant::now())
                    {
                        control.frame_budget_drops.fetch_add(1, Ordering::Relaxed);
                        control.idr.store(true, Ordering::SeqCst);
                        continue;
                    }
                    if !frame_pressure.admit(
                        frame.annex_b.len(),
                        budget,
                        desired,
                        Instant::now(),
                    )? {
                        control.frame_budget_drops.fetch_add(1, Ordering::Relaxed);
                        // This frame was encoded but not sent. No dependent P
                        // frame may follow it: resize and restart with fresh IDR.
                        control.idr.store(true, Ordering::SeqCst);
                        continue;
                    }
                    frame.duration = Duration::ZERO;
                    if control.paused.load(Ordering::SeqCst)
                        || *control.format.lock().unwrap() != Some(format)
                    {
                        control.idr.store(true, Ordering::SeqCst);
                        continue;
                    }
                    let keyframe = frame.keyframe;
                    let encoded_bytes = frame.annex_b.len();
                    let frame_data = frame.annex_b;
                    let fallback_path = fallback.is_some();
                    let mut delivered = false;
                    if let Some(fallback) = fallback {
                        fallback_frame_id = fallback_frame_id.wrapping_add(1).max(1);
                        let encoded = remote_desktop_protocol::fallback::EncodedFrame {
                            frame_id: fallback_frame_id,
                            timestamp_us: process_start.elapsed().as_micros() as u64,
                            keyframe,
                            width: budget.width,
                            height: budget.height,
                            fps: budget.fps,
                            bitrate: desired,
                            // Keep the same encoded frame available for the
                            // background WebRTC track. Progressive fallback is
                            // an upgrade path, not an exclusive transport.
                            data: frame_data.clone(),
                        };
                        match fallback.try_send(encoded) {
                            Ok(()) => {
                                delivered = true;
                            }
                            Err(mpsc::error::TrySendError::Full(_)) => {
                                control.frame_budget_drops.fetch_add(1, Ordering::Relaxed);
                                control.idr.store(true, Ordering::SeqCst);
                            }
                            Err(mpsc::error::TrySendError::Closed(_)) => {
                                control.set_fallback(None);
                            }
                        }
                    }
                    // While fallback owns the foreground path and WebRTC is not
                    // connected, do not spend frame time in the RTP sender. Keep
                    // the sample clock current so promotion starts with a small
                    // gap instead of collapsing fallback seconds into one frame.
                    if !fallback_path || control.webrtc_ready.load(Ordering::SeqCst) {
                        // A timed-out write can have emitted part of a GOP. Terminate
                        // this diagnostic peer rather than send dependent frames after it.
                        let sample_time = Instant::now();
                        let gap = sample_time.saturating_duration_since(previous_sample);
                        previous_sample = sample_time;
                        let track_result =
                            tokio::time::timeout(Duration::from_millis(100), async {
                                // StaticSample increments RTP time AFTER packetization.
                                // XDamage/paused capture is sparse: advance the clock with
                                // an empty sample BEFORE this frame, otherwise seconds of
                                // wall time collapse to one nominal frame and Chrome builds
                                // an ever-growing playout delay. The maintained packetizer
                                // emits no RTP for empty data while advancing its clock.
                                track
                                    .write_sample(
                                        ssrc,
                                        format.payload_type,
                                        &Sample {
                                            duration: gap,
                                            ..Sample::new(sample_time)
                                        },
                                        &[],
                                    )
                                    .await?;
                                track
                                    .write_sample(
                                        ssrc,
                                        format.payload_type,
                                        &Sample {
                                            data: frame_data.into(),
                                            duration: Duration::ZERO,
                                            ..Sample::new(sample_time)
                                        },
                                        &[],
                                    )
                                    .await
                            })
                            .await;
                        match track_result {
                            Ok(Ok(())) => delivered = true,
                            Ok(Err(error)) if !fallback_path => return Err(error.into()),
                            Ok(Err(_)) => {}
                            Err(_) if !fallback_path => {
                                anyhow::bail!("WebRTC sample write timed out")
                            }
                            Err(_) => {}
                        }
                    } else {
                        previous_sample = Instant::now();
                    }
                    if !delivered {
                        continue;
                    }
                    control.frames_sent.fetch_add(1, Ordering::Relaxed);
                    if keyframe {
                        quality.observe_keyframe(encoded_bytes, desired);
                        control.keyframes_sent.fetch_add(1, Ordering::Relaxed);
                    }
                }
                #[allow(unreachable_code)]
                Ok::<(), anyhow::Error>(())
            }
            .await;
            if let Err(error) = result {
                // Only typed adapter codes cross the media boundary. Native
                // library errors can contain titles, paths or device details.
                let cause = crate::error::BackendError::from_error(&error);
                let _ = events
                    .send(PeerEvent::BackendFailed { session, cause })
                    .await;
            }
        });
        Ok(())
    }
    pub async fn close(self) {
        self.control.pause(true);
        self.tasks.lock().unwrap().abort_all();
        let _ = tokio::time::timeout(Duration::from_secs(5), self.pc.close()).await;
    }
}

/// Effective ICE credentials per media section, parsed by the maintained SDP
/// library. Never log this value: it belongs only to this peer's transport.
fn ice_generation(description: &RTCSessionDescription) -> anyhow::Result<Vec<(String, String)>> {
    let parsed = description.unmarshal()?;
    parsed
        .media_descriptions
        .iter()
        .map(|media| {
            let attribute = |name: &str| {
                media
                    .attributes
                    .iter()
                    .chain(parsed.attributes.iter())
                    .find(|a| a.key == name)
                    .and_then(|a| a.value.clone())
                    .ok_or_else(|| anyhow::anyhow!("missing ICE credentials"))
            };
            Ok((attribute("ice-ufrag")?, attribute("ice-pwd")?))
        })
        .collect()
}
