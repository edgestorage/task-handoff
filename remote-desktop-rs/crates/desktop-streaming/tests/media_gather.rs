use desktop_streaming::{contract::IceServer, media::MediaPeer};
use rtc::rtp_transceiver::rtp_sender::RtpCodecKind;
use std::{
    sync::Arc,
    time::{Duration, Instant},
};
use webrtc::peer_connection::{
    MediaEngine, PeerConnection, PeerConnectionBuilder, PeerConnectionEventHandler,
    RTCConfigurationBuilder,
};

struct Handler;

#[async_trait::async_trait]
impl PeerConnectionEventHandler for Handler {}

async fn browser_offer() -> anyhow::Result<String> {
    let mut media = MediaEngine::default();
    media.register_default_codecs()?;
    let peer = PeerConnectionBuilder::new()
        .with_configuration(RTCConfigurationBuilder::new().build())
        .with_media_engine(media)
        .with_handler(Arc::new(Handler))
        .with_udp_addrs(vec!["127.0.0.1:0"])
        .build()
        .await?;
    peer.add_transceiver_from_kind(RtpCodecKind::Video, None)
        .await?;
    peer.create_data_channel("control", None).await?;
    let offer = peer.create_offer(None).await?;
    peer.set_local_description(offer.clone()).await?;
    Ok(offer.sdp)
}

#[tokio::test]
async fn unreachable_turn_gathering_timeout_returns_usable_partial_answer() -> anyhow::Result<()> {
    // A bound socket that never answers models a TURN endpoint that silently
    // drops allocations (the production failure mode when coturn is stopped).
    let blackhole = tokio::net::UdpSocket::bind("127.0.0.1:0").await?;
    let port = blackhole.local_addr()?.port();
    tokio::spawn(async move {
        let mut buffer = [0u8; 2048];
        while blackhole.recv_from(&mut buffer).await.is_ok() {}
    });

    let (events, _receiver) = tokio::sync::mpsc::channel(16);
    let mut peer = MediaPeer::new("gather-timeout".into(), events).await?;
    peer.configure_ice(&[IceServer {
        urls: vec![format!("turn:127.0.0.1:{port}?transport=udp")],
        username: "probe".into(),
        credential: "probe".into(),
    }])
    .await?;

    let started = Instant::now();
    let (answer, restarted) = peer.answer(browser_offer().await?, false).await?;
    assert!(restarted);
    assert!(started.elapsed() >= Duration::from_millis(400));
    assert!(
        started.elapsed() < Duration::from_secs(2),
        "progressive negotiation must not wait for a black-holed TURN allocation"
    );
    assert!(
        answer.lines().any(|line| line.starts_with("a=candidate:")),
        "partial answer must retain candidates gathered before the deadline"
    );
    Ok(())
}
