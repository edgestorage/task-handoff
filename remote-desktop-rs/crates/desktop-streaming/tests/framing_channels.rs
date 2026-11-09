use desktop_streaming::{channel::*, contract::MAX_IPC_FRAME, framing};
use serde_json::{json, Value};
use tokio::io::AsyncWriteExt;
#[tokio::test]
async fn framing_accepts_fragmented_and_coalesced_frames() {
    let (mut writer, mut reader) = tokio::io::duplex(1024);
    let task = tokio::spawn(async move {
        let body = br#"{"requestId":"fixture","unknownFutureField":true}"#;
        let wire = [&(body.len() as u32).to_be_bytes()[..], body].concat();
        for byte in wire {
            writer.write_all(&[byte]).await.unwrap();
        }
        framing::write(&mut writer, &json!({"next":true}))
            .await
            .unwrap();
    });
    assert_eq!(
        framing::read::<Value>(&mut reader).await.unwrap().unwrap()["requestId"],
        "fixture"
    );
    assert_eq!(
        framing::read::<Value>(&mut reader).await.unwrap().unwrap()["next"],
        true
    );
    assert!(framing::read::<Value>(&mut reader).await.unwrap().is_none());
    task.await.unwrap();
}
#[tokio::test]
async fn framing_rejects_truncation_empty_oversize_and_invalid_json() {
    for wire in [
        vec![0],
        vec![0, 0, 0, 2, b'{'],
        vec![0, 0, 0, 0],
        ((MAX_IPC_FRAME + 1) as u32).to_be_bytes().to_vec(),
        vec![0, 0, 0, 1, b'x'],
    ] {
        let mut input = &wire[..];
        assert!(framing::read::<Value>(&mut input).await.is_err());
    }
}
fn encode(v: Value) -> Vec<u8> {
    serde_json::to_vec(&v).unwrap()
}
#[test]
fn channel_settings_and_cross_channel_routing_are_explicit() {
    assert!(!Channel::Pointer.ordered());
    assert_eq!(Channel::Pointer.max_retransmits(), Some(0));
    for channel in [Channel::Control, Channel::Input, Channel::Clipboard] {
        assert!(channel.ordered());
        assert_eq!(channel.max_retransmits(), None);
    }
    let mut d = Decoder::default();
    let wire = encode(
        json!({"v":"2026-11-05","seq":0,"type":"key","payload":{"inputEpoch":1,"code":"KeyA","down":true,"repeat":false,"modifiers":0}}),
    );
    assert!(d.decode(Channel::Pointer, &wire).is_err());
    assert!(d.decode(Channel::Input, &wire).is_ok());
    assert!(d.decode(Channel::Input, &wire).is_err());
}
#[test]
fn sequence_and_coordinates_are_validated_without_consuming_invalid_messages() {
    let mut d = Decoder::default();
    for x in [-0.1, 1.1] {
        assert!(d.decode(Channel::Pointer,&encode(json!({"v":"2026-11-05","seq":1,"type":"pointer","payload":{"inputEpoch":1,"x":x,"y":0.5}}))).is_err());
    }
    assert!(d.decode(Channel::Pointer,&encode(json!({"v":"2026-11-05","seq":1,"type":"pointer","payload":{"inputEpoch":1,"x":0.0,"y":1.0}}))).is_ok());
    assert!(d.decode(Channel::Pointer,&encode(json!({"v":"2026-11-05","seq":0,"type":"pointer","payload":{"inputEpoch":1,"x":0.0,"y":1.0}}))).is_err());
    assert!(
        d.decode(
            Channel::Control,
            &encode(json!({"v":"future-date","seq":0,"type":"input.suspend","futureField":true}))
        )
        .unwrap()
        .1
    );
}
#[test]
fn unit_control_messages_accept_empty_payload_but_reject_content() {
    for (seq, ty) in [
        (0, "input.suspend"),
        (1, "stream.keyframe"),
        (2, "session.stop"),
        (3, "control.request"),
    ] {
        for payload in [None, Some(json!({}))] {
            let mut wire = json!({"v":"2026-11-05","seq":seq,"type":ty});
            if let Some(payload) = payload {
                wire["payload"] = payload;
            }
            let mut d = Decoder::default();
            d.decode(Channel::Control, &encode(wire)).unwrap();
        }
        let mut d = Decoder::default();
        let wire =
            encode(json!({"v":"2026-11-05","seq":seq,"type":ty,"payload":{"unexpected":true}}));
        assert!(d.decode(Channel::Control, &wire).is_err());
    }
    let mut d = Decoder::default();
    d.decode(
        Channel::Clipboard,
        &encode(json!({"v":"2026-11-05","seq":0,"type":"clipboard.read","payload":{}})),
    )
    .unwrap();
}

#[test]
fn transport_resolution_is_an_optional_bounded_control_message() {
    for (seq, payload, expected_resolution, expected_frame_rate) in [
        (
            0,
            json!({"maxWidth":1280,"maxHeight":720,"maxFrameRate":30}),
            Some((1280, 720)),
            Some(30),
        ),
        (
            1,
            json!({"maxWidth":null,"maxHeight":null,"maxFrameRate":null}),
            None,
            None,
        ),
        (
            2,
            json!({"maxWidth":1920,"maxHeight":1080,"maxFrameRate":15}),
            Some((1920, 1080)),
            Some(15),
        ),
    ] {
        let mut decoder = Decoder::default();
        let wire = encode(json!({
            "v":"2026-11-05",
            "seq":seq,
            "type":"stream.resolution",
            "payload":payload
        }));
        let (
            Message::Control(Control::StreamResolution {
                max_width,
                max_height,
                max_frame_rate,
            }),
            _,
        ) = decoder.decode(Channel::Control, &wire).unwrap()
        else {
            panic!("wrong message");
        };
        assert_eq!(max_width.zip(max_height), expected_resolution);
        assert_eq!(max_frame_rate, expected_frame_rate);
    }
}

#[test]
fn clipboard_has_independent_wire_and_utf8_bounds_and_no_unbounded_reassembly() {
    for text in [
        "字".repeat(MAX_CLIPBOARD_TEXT / 3 + 1),
        "\0".repeat(MAX_CLIPBOARD_TEXT),
    ] {
        let mut d = Decoder::default();
        assert!(d.decode(Channel::Clipboard,&encode(json!({"v":"2026-11-05","seq":0,"type":"clipboard.write","payload":{"text":text}}))).is_err());
    }
    let mut d = Decoder::default();
    assert!(d.decode(Channel::Clipboard,&encode(json!({"v":"2026-11-05","seq":0,"type":"clipboard.write","payload":{"text":"x".repeat(MAX_CLIPBOARD_TEXT)}}))).is_ok());
}
#[test]
fn composition_commits_are_utf8_and_preedit_is_never_accepted() {
    for text in ["中文", "日本語", "é", "👨‍👩‍👧‍👦"] {
        let mut d = Decoder::default();
        let wire = encode(
            json!({"v":"2026-11-05","seq":0,"type":"text.commit","payload":{"inputEpoch":1,"text":text}}),
        );
        let (Message::Input(Input::Text(commit)), _) = d.decode(Channel::Input, &wire).unwrap()
        else {
            panic!("wrong channel");
        };
        assert_eq!(commit.text, text);
    }
    let mut d = Decoder::default();
    assert!(d.decode(Channel::Input,&encode(json!({"v":"2026-11-05","seq":0,"type":"text.preedit","payload":{"inputEpoch":1,"text":"中"}}))).is_err());
}
#[tokio::test]
async fn shared_node_rust_fixtures_have_identical_framing_and_channel_contract() {
    let fixture: Value = serde_json::from_str(include_str!("../fixtures/contract.json")).unwrap();
    assert_eq!(
        fixture["ipcVersion"],
        desktop_streaming::contract::IPC_VERSION
    );
    assert_eq!(
        fixture["channelVersion"],
        desktop_streaming::contract::CHANNEL_VERSION
    );
    assert_eq!(fixture["maxIpcFrame"], MAX_IPC_FRAME);
    let mut wire = Vec::new();
    framing::write(&mut wire, &fixture["framing"]["json"])
        .await
        .unwrap();
    let hex: String = wire.iter().map(|b| format!("{b:02x}")).collect();
    assert_eq!(hex, fixture["framing"]["hex"]);
    for value in fixture["channels"].as_array().unwrap() {
        let channel: Channel = serde_json::from_value(value["label"].clone()).unwrap();
        assert_eq!(value["id"], channel.id());
        assert_eq!(value["negotiated"], true);
        assert_eq!(value["ordered"], channel.ordered());
        assert_eq!(
            value["maxRetransmits"],
            serde_json::to_value(channel.max_retransmits()).unwrap()
        );
    }
    for value in fixture["messages"].as_array().unwrap() {
        let channel: Channel = serde_json::from_value(value["channel"].clone()).unwrap();
        assert!(Decoder::default()
            .decode(channel, &encode(value["message"].clone()))
            .is_ok());
    }
}

#[test]
fn resume_accepts_legacy_display_message_and_optional_authoritative_revision() {
    let mut decoder = Decoder::default();
    for (seq, payload, expected) in [
        (0, None, None),
        (
            1,
            Some(json!({"sessionRevision":91,"future":true})),
            Some(91),
        ),
    ] {
        let mut wire = json!({"v":"2026-11-05","seq":seq,"type":"input.resume"});
        if let Some(payload) = payload {
            wire["payload"] = payload;
        }
        let (Message::Control(Control::Resume(resume)), _) =
            decoder.decode(Channel::Control, &encode(wire)).unwrap()
        else {
            panic!("wrong message");
        };
        assert_eq!(resume.session_revision, expected);
    }
}
