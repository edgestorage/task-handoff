use super::*;

const START: &str = "2026-11-05T00:00:00.000Z";
const START_MS: i64 = 1_793_836_800_000;

fn fixture() -> Value {
    serde_json::from_str(include_str!(
        "../tests/fixtures/app-session-clock-parity.json"
    ))
    .expect("fixed Node HTTP source and consumer output")
}

fn at(offset: i64) -> String {
    chrono::DateTime::from_timestamp_millis(START_MS + offset)
        .expect("clock")
        .to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn input(title: &str, now: i64) -> AppSessionsSnapshot {
    let records = if title.is_empty() {
        vec![]
    } else {
        vec![serde_json::from_value(json!({
            "id": "app_clock", "appId": "terminal-tty", "title": title,
            "kind": "tty", "status": "running", "createdAt": START, "updatedAt": START,
            "workspace": {"cwd": "/workspace"},
            "paths": {"sessionDir": "/tmp/session", "logDir": "/tmp/logs"}
        }))
        .expect("session")]
    };
    let mut snapshot = AppSessionsSnapshot::active(records);
    snapshot.updated_at = at(now);
    snapshot
}

fn samples() -> Value {
    let mut authority = AppSessionAuthority::new("standalone", "<stream>", START.to_string());
    let state = |authority: &AppSessionAuthority, title, now| {
        // Use the published content, as production AppState does. Node's HTTP
        // snapshot.updatedAt is the read time; compare that field separately
        // from the event timestamp contract rather than hide the difference.
        serde_json::to_value(
            authority.state(
                authority
                    .published_snapshot()
                    .cloned()
                    .unwrap_or_else(|| input(title, now)),
            ),
        )
        .expect("state")
    };
    let publish = |authority: &mut AppSessionAuthority, title, now| {
        authority.prepare_with_clocks(
            input(title, now),
            if title == "Initial title" {
                "app-session-created"
            } else {
                "app-session-updated"
            },
            || at(now),
            || START_MS + now,
        )
    };
    let startup = state(&authority, "", 0);
    publish(&mut authority, "Initial title", 1000).expect("first");
    let first = state(&authority, "Initial title", 1000);
    publish(&mut authority, "Renamed", 2000).expect("rename");
    let retained = state(&authority, "Renamed", 2000);
    let original_events = authority.delta_at("<stream>", 0.0, START_MS + 2000)["events"].clone();
    let boundary_delta = authority.delta_at("<stream>", 1.0, START_MS + 2000 + EVENT_RETENTION_MS);
    let boundary = state(&authority, "Renamed", 2000 + EVENT_RETENTION_MS);
    let idle_before_delta = state(&authority, "Renamed", 2001 + EVENT_RETENTION_MS);
    let expired_delta = authority.delta_at("<stream>", 1.0, START_MS + 2001 + EVENT_RETENTION_MS);
    assert_eq!(authority.retained_event_count(), 0);
    let expired = state(&authority, "Renamed", 2001 + EVENT_RETENTION_MS);
    assert!(publish(&mut authority, "Renamed", 2001 + EVENT_RETENTION_MS).is_none());
    let noop = state(&authority, "Renamed", 2001 + EVENT_RETENTION_MS);
    publish(&mut authority, "After expiry", 3000 + EVENT_RETENTION_MS).expect("resume");
    let resumed = state(&authority, "After expiry", 3000 + EVENT_RETENTION_MS);
    let resumed_delta = authority.delta_at("<stream>", 2.0, START_MS + 3000 + EVENT_RETENTION_MS);
    let mut samples = json!({
        "startup": startup, "first": first, "retained": retained, "originalEvents": original_events,
        "boundaryDelta": boundary_delta, "boundary": boundary, "idleBeforeDelta": idle_before_delta,
        "expiredDelta": expired_delta, "expired": expired, "expiredAlias": expired,
        "noop": noop, "resumed": resumed, "resumedDelta": resumed_delta,
    });
    fn normalize(value: &mut Value, traces: &mut HashMap<u64, String>) {
        match value {
            Value::Array(items) => items.iter_mut().for_each(|item| normalize(item, traces)),
            Value::Object(object) => {
                if let Some(trace) = object.get("traceId").and_then(Value::as_str) {
                    let revision = object["revision"].as_u64().expect("revision");
                    assert!(trace.starts_with("aps_evt_"));
                    if let Some(previous) = traces.get(&revision) {
                        assert_eq!(previous, trace);
                    } else {
                        assert!(!traces.values().any(|previous| previous == trace));
                        traces.insert(revision, trace.to_string());
                    }
                    object.insert("traceId".to_string(), json!(format!("<trace-{revision}>")));
                }
                object.values_mut().for_each(|item| normalize(item, traces));
            }
            _ => {}
        }
    }
    normalize(&mut samples, &mut HashMap::new());
    samples
}

fn compare_state(actual: &Value, expected: &Value, published_at: &str) {
    assert_eq!(actual["snapshot"]["updatedAt"], published_at);
    let mut actual = actual.clone();
    let mut expected = expected.clone();
    // This pre-existing source distinction is explicit: Node stamps HTTP read
    // time, Rust keeps published snapshot time (U02.3). Neither is lastEventAt.
    actual["snapshot"]
        .as_object_mut()
        .unwrap()
        .remove("updatedAt");
    expected["snapshot"]
        .as_object_mut()
        .unwrap()
        .remove("updatedAt");
    assert_eq!(actual, expected);
}

#[test]
fn c01_retained_cutoff_and_lazy_state_clock_match_node_http() {
    let actual = samples();
    let expected = fixture()["expected"].clone();
    for (name, published_at) in [
        ("startup", at(0)),
        ("first", at(1000)),
        ("retained", at(2000)),
        ("boundary", at(2000)),
        ("idleBeforeDelta", at(2000)),
    ] {
        compare_state(&actual[name], &expected[name], &published_at);
    }
    assert_eq!(actual["originalEvents"], expected["originalEvents"]);
    assert_eq!(actual["boundaryDelta"], expected["boundaryDelta"]);
}

#[test]
fn c02_pruned_history_fallback_and_noop_match_node_http() {
    let actual = samples();
    let expected = fixture()["expected"].clone();
    assert_eq!(actual["expiredDelta"], expected["expiredDelta"]);
    for name in ["expired", "expiredAlias", "noop"] {
        compare_state(&actual[name], &expected[name], &at(2000));
    }
    assert_eq!(
        actual["expired"]["snapshot"],
        actual["retained"]["snapshot"]
    );
}

#[test]
fn c03_cold_and_warm_consumers_match_node_exact_timestamps() {
    use std::io::Write;
    use std::process::{Command, Stdio};
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .ancestors()
        .nth(3)
        .expect("repository root");
    // Test-only execution of the existing TS consumer; never a production fallback.
    let mut child = Command::new("node")
        .current_dir(root)
        .args([
            "--import",
            "./test/setup-isolated-runtime.mjs",
            "test/fixtures/app-session-clock-parity.js",
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("Node source/consumer prerequisites required; no skip");
    child
        .stdin
        .take()
        .expect("stdin")
        .write_all(&serde_json::to_vec(&samples()).expect("samples"))
        .expect("samples write");
    let result = child.wait_with_output().expect("bounded consumer test");
    assert!(
        result.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&result.stdout),
        String::from_utf8_lossy(&result.stderr)
    );
}

#[test]
fn c04_new_event_after_expiry_restores_published_clock_matches_node_http() {
    let actual = samples();
    let expected = fixture()["expected"].clone();
    compare_state(
        &actual["resumed"],
        &expected["resumed"],
        &at(3000 + EVENT_RETENTION_MS),
    );
    assert_eq!(actual["resumedDelta"], expected["resumedDelta"]);
}
