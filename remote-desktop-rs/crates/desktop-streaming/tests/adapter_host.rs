#[cfg(unix)]
use controlled_instance_protocol::AppManagementOperation;
use desktop_component_host::{
    contract::{Command, Reply},
    host::ComponentHost,
};
use serde_json::{json, Value};
use std::{path::Path, time::Duration};
fn substitute(value: &Value, session: &str, token: &str) -> Value {
    match value {
        Value::String(s) if s == "$session" => json!(session),
        Value::String(s) if s == "$token" => json!(token),
        Value::Object(fields) => Value::Object(
            fields
                .iter()
                .map(|(k, v)| (k.clone(), substitute(v, session, token)))
                .collect(),
        ),
        other => other.clone(),
    }
}
#[tokio::test]
async fn production_host_consumes_shared_adapter_contract_and_restart_invalidates_references() {
    let binary = Path::new(env!("CARGO_BIN_EXE_task-handoff-desktop-streaming"));
    let host = ComponentHost::spawn_arguments(binary, &[]).await.unwrap();
    let mut events = host.subscribe();
    let steps: Vec<Value> =
        serde_json::from_str(include_str!("../fixtures/adapter-contract.json")).unwrap();
    let (mut session, mut token) = (String::new(), String::new());
    let mut revisions = vec![];
    for step in steps {
        let command: Command =
            serde_json::from_value(substitute(&step["command"], &session, &token)).unwrap();
        let reply = host
            .request(step["id"].as_str().unwrap(), command)
            .await
            .unwrap();
        let result = serde_json::to_value(reply).unwrap();
        assert_eq!(result["type"], step["expectType"]);
        if let Some(code) = step.get("expectCode") {
            assert_eq!(&result["code"], code);
        }
        if result["type"] == "reserved" {
            let fresh_session = result["snapshot"]["viewerSessionId"].as_str().unwrap();
            let fresh_token = result["attachToken"].as_str().unwrap();
            if !session.is_empty() {
                assert_eq!(session, fresh_session);
                assert_eq!(token, fresh_token);
            }
            session = fresh_session.into();
            token = fresh_token.into();
        }
        while let Ok(event) = events.try_recv() {
            assert_eq!(event.boot_id, host.boot_id);
            revisions.push(event.snapshot.session_revision);
        }
    }
    assert!(revisions.len() >= 3);
    assert!(revisions.windows(2).all(|a| a[0] < a[1]));
    let boot = host.boot_id.clone();
    host.shutdown().await.unwrap();
    assert!(host.is_closed());
    let second = ComponentHost::spawn_arguments(binary, &[]).await.unwrap();
    assert_ne!(second.boot_id, boot);
    let old = json!({"type":"attach","owner":{"actorId":"adapter-actor","deviceSessionId":"adapter-device"},"viewerSessionId":session,"captureSelection":{"sourceRef":"display"},"attachToken":token});
    assert!(matches!(
        second
            .request("stale", serde_json::from_value(old).unwrap())
            .await
            .unwrap(),
        Reply::Error { .. }
    ));
    // Dropping the last host closes stdin; no explicit shutdown command needed.
    let mut events = second.subscribe();
    drop(second);
    tokio::time::timeout(Duration::from_secs(7), async {
        while events.recv().await.is_ok() {}
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn final_shutdown_reply_is_drained_before_child_exit() {
    let binary = Path::new(env!("CARGO_BIN_EXE_task-handoff-desktop-streaming"));
    for _ in 0..20 {
        let host = ComponentHost::spawn_arguments(binary, &[]).await.unwrap();
        host.shutdown().await.unwrap();
        assert!(host.is_closed());
    }
}

#[tokio::test]
async fn owner_takeover_stale_callback_and_force_stop_consume_shared_contract() {
    fn replace(value: &Value, values: &serde_json::Map<String, Value>) -> Value {
        match value {
            Value::String(s) if s.starts_with('$') => values.get(&s[1..]).unwrap().clone(),
            Value::Object(fields) => Value::Object(
                fields
                    .iter()
                    .map(|(key, value)| (key.clone(), replace(value, values)))
                    .collect(),
            ),
            other => other.clone(),
        }
    }
    let host = ComponentHost::spawn_arguments(
        Path::new(env!("CARGO_BIN_EXE_task-handoff-desktop-streaming")),
        &[],
    )
    .await
    .unwrap();
    let mut values = serde_json::Map::new();
    let steps: Vec<Value> =
        serde_json::from_str(include_str!("../fixtures/ownership-contract.json")).unwrap();
    for step in steps {
        let command = serde_json::from_value(replace(&step["command"], &values)).unwrap();
        let reply = host
            .request(step["id"].as_str().unwrap(), command)
            .await
            .unwrap();
        let result = serde_json::to_value(reply).unwrap();
        assert_eq!(result["type"], step["expectType"]);
        if let Some(code) = step.get("expectCode") {
            assert_eq!(&result["code"], code);
        }
        if let Some(phase) = step.get("expectPhase") {
            assert_eq!(&result["snapshot"]["phase"], phase);
        }
        if let Some(save) = step["save"].as_str() {
            let key = format!("{save}Session");
            if let Some(old) = values.get(&key) {
                assert_eq!(old, &result["snapshot"]["viewerSessionId"]);
            }
            values.insert(key, result["snapshot"]["viewerSessionId"].clone());
            values.insert(format!("{save}Token"), result["attachToken"].clone());
        }
        if result["code"] == "REMOTE_DESKTOP_BUSY" {
            assert_eq!(result.as_object().unwrap().len(), 2);
        }
    }
    assert_ne!(values["firstSession"], values["secondSession"]);
    host.shutdown().await.unwrap();
}

#[cfg(unix)]
#[tokio::test]
async fn real_service_enabled_intent_package_drain_restart_and_capability_are_boot_bound() {
    use desktop_component_host::{
        host::CaptureMode,
        service::{DesktopPackage, DesktopService},
    };
    use std::{
        os::unix::fs::PermissionsExt,
        sync::{
            atomic::{AtomicBool, Ordering},
            Arc,
        },
    };
    let dir = tempfile::tempdir().unwrap();
    let wrapper = dir.path().join("component");
    let binary = env!("CARGO_BIN_EXE_task-handoff-desktop-streaming");
    let quoted = binary.replace('\'', "'\\''");
    std::fs::write(
        &wrapper,
        format!("#!/bin/sh\nshift\nexec '{quoted}' \"$@\"\n"),
    )
    .unwrap();
    std::fs::set_permissions(&wrapper, std::fs::Permissions::from_mode(0o700)).unwrap();
    let present = Arc::new(AtomicBool::new(false));
    let admission = Arc::new(AtomicBool::new(true));
    let make_service = || {
        let package = wrapper.clone();
        let installed = present.clone();
        let allowed = admission.clone();
        DesktopService::new(
            dir.path(),
            CaptureMode::Local,
            move || {
                Ok(installed.load(Ordering::SeqCst).then(|| DesktopPackage {
                    binary: package.clone(),
                    version: "1".into(),
                }))
            },
            move || allowed.load(Ordering::SeqCst),
        )
    };
    let service = make_service();
    assert_eq!(
        service.reconcile().await.reason.as_deref(),
        Some("REMOTE_DESKTOP_NOT_INSTALLED")
    );
    present.store(true, Ordering::SeqCst);
    assert_eq!(
        service.reconcile().await.reason.as_deref(),
        Some("REMOTE_DESKTOP_DISABLED")
    );
    service.set_enabled(true).await.unwrap();
    // Control-only preflight advertises no native access, and starts no surface.
    assert!(!service.status().available);
    let owner = json!({"actorId":"actor","deviceSessionId":"device"});
    let reserve = || {
        serde_json::from_value(
            json!({"type":"reserve","owner":owner,"captureSelection":{"sourceRef":"display"}}),
        )
        .unwrap()
    };
    let (old_boot, reply) = service
        .request_bound("first", reserve(), None)
        .await
        .unwrap();
    assert!(matches!(reply, Reply::Reserved { .. }));
    admission.store(false, Ordering::SeqCst);
    service.before_package_change().await.unwrap();
    assert!(!service.is_current_boot(&old_boot).await);
    assert_eq!(
        service
            .request("during-change", reserve())
            .await
            .err()
            .unwrap()
            .to_string(),
        "REMOTE_DESKTOP_UPDATING"
    );
    service
        .package_changed(AppManagementOperation::Install, false)
        .await
        .unwrap();
    assert!(service.settings.enabled());
    admission.store(true, Ordering::SeqCst);
    service.refresh().await;
    let (new_boot, _) = service.request_bound("new", reserve(), None).await.unwrap();
    assert_ne!(new_boot, old_boot);
    assert!(service
        .request_bound("stale", reserve(), Some(&old_boot))
        .await
        .is_err());
    service.close().await.unwrap();
    let restarted = make_service();
    assert!(restarted.settings.enabled());
    restarted.reconcile().await;
    let (restart_boot, reply) = restarted
        .request_bound("restart", reserve(), None)
        .await
        .unwrap();
    assert_ne!(restart_boot, new_boot);
    assert!(matches!(reply, Reply::Reserved { .. }));
    restarted.before_package_change().await.unwrap();
    restarted
        .package_changed(AppManagementOperation::Uninstall, true)
        .await
        .unwrap();
    present.store(false, Ordering::SeqCst);
    assert!(!restarted.settings.enabled());
    restarted.close().await.unwrap();
}
