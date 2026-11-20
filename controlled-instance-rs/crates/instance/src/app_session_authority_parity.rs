use super::*;

const PUBLISHED_AT_MS: i64 = 1_800_000_000_000;
const CREATED_AT: &str = "2026-11-02T00:00:00.000Z";

fn expected(name: &str) -> Value {
    let fixture: Value = serde_json::from_str(include_str!(
        "../tests/fixtures/app-session-authority-parity.json"
    ))
    .expect("fixed Node HTTP output");
    fixture["expected"][name].clone()
}

fn input(title: &str) -> AppSessionsSnapshot {
    let mut record = session("app_authority", "running", title);
    record.paths.session_dir = "/tmp/session".to_string();
    record.paths.log_dir = "/tmp/logs".to_string();
    AppSessionsSnapshot::active(vec![record])
}

struct Observation {
    authority: AppSessionAuthority,
    traces: HashMap<u64, String>,
}

impl Observation {
    fn new() -> Self {
        let mut result = Self {
            authority: AppSessionAuthority::new("standalone", "<stream>", CREATED_AT.to_string()),
            traces: HashMap::new(),
        };
        result.publish("Initial title", "app-session-created", PUBLISHED_AT_MS);
        result
    }

    fn publish(&mut self, title: &str, reason: &str, now_ms: i64) {
        let event = self
            .authority
            .prepare_with_retention_clock(input(title), reason, || now_ms)
            .expect("changed");
        let retained = self.authority.history.back().expect("retained event");
        assert_eq!(retained.payload, event.payload);
    }

    fn normalize(&mut self, value: &mut Value) {
        match value {
            Value::Array(values) => values.iter_mut().for_each(|value| self.normalize(value)),
            Value::Object(object) => {
                if let Some(trace) = object.get("traceId").and_then(Value::as_str) {
                    assert!(trace.starts_with("aps_evt_"));
                    let revision = object["revision"].as_u64().expect("trace revision");
                    if let Some(previous) = self.traces.get(&revision) {
                        assert_eq!(previous, trace, "same event keeps its trace");
                    } else {
                        assert!(!self.traces.values().any(|previous| previous == trace));
                        self.traces.insert(revision, trace.to_string());
                    }
                    object.insert("traceId".to_string(), json!(format!("<trace-{revision}>")));
                }
                for (key, value) in object {
                    if key == "streamId" {
                        assert_eq!(value, "<stream>");
                    } else if key == "lastEventAt"
                        || key == "generatedAt"
                        || (key == "updatedAt" && value != CREATED_AT)
                    {
                        chrono::DateTime::parse_from_rfc3339(value.as_str().expect("time"))
                            .expect("valid wall clock");
                        *value = json!("<wall-clock>");
                    } else {
                        self.normalize(value);
                    }
                }
            }
            _ => {}
        }
    }

    fn state(&mut self, title: &str) -> Value {
        let mut value = serde_json::to_value(self.authority.state(input(title))).expect("state");
        self.normalize(&mut value);
        value
    }

    fn delta(&mut self, revision: f64, stream: &str, now_ms: i64) -> Value {
        let mut value = self.authority.delta_at(stream, revision, now_ms);
        self.normalize(&mut value);
        value
    }

    fn queries(&mut self, now_ms: i64) -> Value {
        json!({
            "current": self.delta(2.0, "<stream>", now_ms),
            "wrongStream": self.delta(1.0, "wrong-stream", now_ms),
            "future": self.delta(3.0, "<stream>", now_ms),
        })
    }
}

fn data(value: Value) -> Value {
    value["data"].clone()
}

#[test]
fn c01_continuous_delta_and_noop_match_node_http() {
    let mut observation = Observation::new();
    assert_eq!(
        observation.state("Initial title"),
        data(expected("initial"))
    );
    observation.publish("Renamed", "app-session-updated", PUBLISHED_AT_MS);
    assert_eq!(observation.state("Renamed"), data(expected("latest")));
    assert!(observation
        .authority
        .prepare(input("Renamed"), "app-session-updated")
        .is_none());
    assert_eq!(observation.state("Renamed"), data(expected("unchanged")));
    assert_eq!(
        observation.delta(0.0, "<stream>", PUBLISHED_AT_MS),
        data(expected("within"))
    );
}

#[test]
fn c02_retention_cutoff_is_inclusive_matches_node_http() {
    let mut observation = Observation::new();
    observation.publish("Renamed", "app-session-updated", PUBLISHED_AT_MS);
    assert_eq!(
        observation.delta(1.0, "<stream>", PUBLISHED_AT_MS + EVENT_RETENTION_MS),
        data(expected("boundary"))
    );
}

#[test]
fn c03_idle_expiry_requires_snapshot_matches_node_http() {
    let mut observation = Observation::new();
    observation.publish("Renamed", "app-session-updated", PUBLISHED_AT_MS);
    assert_eq!(
        observation.delta(1.0, "<stream>", PUBLISHED_AT_MS + EVENT_RETENTION_MS + 1),
        data(expected("expired"))
    );
    assert_eq!(observation.authority.retained_event_count(), 0);
    // Also exercise the public real-clock entry used by AppState/HTTP, so a
    // correct delta_at cannot mask incorrect production clock delegation.
    let mut observation = Observation::new();
    observation.publish("Renamed", "app-session-updated", PUBLISHED_AT_MS);
    let expired_at = Utc::now().timestamp_millis() - EVENT_RETENTION_MS - 1;
    for retained in &mut observation.authority.history {
        retained.created_at_ms = expired_at;
    }
    assert_eq!(
        observation.authority.delta("<stream>", 1.0),
        data(expected("expired"))
    );
}

#[test]
fn c04_revision_and_stream_guards_prune_first_matches_node_http() {
    let fixture = expected("before");
    let mut observation = Observation::new();
    observation.publish("Renamed", "app-session-updated", PUBLISHED_AT_MS);
    let before = observation.queries(PUBLISHED_AT_MS);
    for name in ["current", "wrongStream", "future"] {
        assert_eq!(before[name], fixture[name]["data"], "before {name}");
    }
    // Each guard must expire history even when it is the first request.
    let fixture = expected("after");
    for (name, revision, stream) in [
        ("current", 2.0, "<stream>"),
        ("wrongStream", 1.0, "wrong-stream"),
        ("future", 3.0, "<stream>"),
    ] {
        let mut observation = Observation::new();
        observation.publish("Renamed", "app-session-updated", PUBLISHED_AT_MS);
        assert_eq!(
            observation.delta(revision, stream, PUBLISHED_AT_MS + EVENT_RETENTION_MS + 1),
            fixture[name]["data"],
            "after {name}"
        );
    }
}

#[test]
fn c05_snapshot_recovery_then_next_delta_matches_node_http() {
    let mut observation = Observation::new();
    observation.publish("Renamed", "app-session-updated", PUBLISHED_AT_MS);
    let now = PUBLISHED_AT_MS + EVENT_RETENTION_MS + 1;
    assert_eq!(
        observation.delta(1.0, "<stream>", now),
        data(expected("expired"))
    );
    assert_eq!(observation.state("Renamed"), data(expected("recovered")));
    observation.publish("After recovery", "app-session-updated", now);
    assert_eq!(
        observation.delta(2.0, "<stream>", now),
        data(expected("next"))
    );
    assert_eq!(
        observation.state("After recovery"),
        data(expected("nextState"))
    );
}

#[test]
fn u024_node_and_rust_outputs_match_through_existing_ts_consumers() {
    use std::io::Write;
    use std::process::{Command, Stdio};

    let mut authority =
        AppSessionAuthority::new("standalone", "rust-consumer-stream", CREATED_AT.to_string());
    let mut events = Vec::new();
    let publish = |authority: &mut AppSessionAuthority,
                   events: &mut Vec<Value>,
                   title: &str,
                   reason: &str,
                   now: i64| {
        let event = authority
            .prepare_with_retention_clock(input(title), reason, || now)
            .expect("changed");
        events.push(json!({ "type": event.event_type, "payload": event.payload }));
    };
    publish(
        &mut authority,
        &mut events,
        "Initial title",
        "app-session-created",
        PUBLISHED_AT_MS,
    );
    let initial = authority.state(input("Initial title"));
    publish(
        &mut authority,
        &mut events,
        "Renamed",
        "app-session-updated",
        PUBLISHED_AT_MS,
    );
    let now = PUBLISHED_AT_MS + EVENT_RETENTION_MS + 1;
    assert_eq!(
        authority.delta_at("rust-consumer-stream", 1.0, now)["syncRequired"],
        true
    );
    publish(
        &mut authority,
        &mut events,
        "After recovery",
        "app-session-updated",
        now,
    );
    let recovery_delta = authority.delta_at("rust-consumer-stream", 1.0, now);
    let recovered = authority.state(input("After recovery"));
    publish(
        &mut authority,
        &mut events,
        "After snapshot recovery",
        "app-session-updated",
        now,
    );
    let final_state = authority.state(input("After snapshot recovery"));
    let samples = json!({
        "initial": initial,
        "events": events,
        "recoveryDelta": recovery_delta,
        "recovered": recovered,
        "final": final_state,
    });
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(std::path::Path::parent)
        .and_then(std::path::Path::parent)
        .expect("repository root");
    // Test-only bridge: execute the *existing* TS reducer/CP aggregator/UI store
    // and collect an independent Node HTTP source in an isolated process. This
    // is never used by the production instance to execute business logic.
    let mut child = Command::new("node")
        .current_dir(root)
        .args([
            "--import",
            "./test/setup-isolated-runtime.mjs",
            "test/fixtures/app-session-consumer-parity.js",
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("Node is required for the source/consumer differential; do not silently skip");
    child
        .stdin
        .take()
        .expect("stdin")
        .write_all(&serde_json::to_vec(&samples).expect("samples"))
        .expect("write samples and close stdin");
    let result = child
        .wait_with_output()
        .expect("bounded Node consumer test");
    assert!(
        result.status.success(),
        "same-consumer differential failed:\n{}\n{}",
        String::from_utf8_lossy(&result.stdout),
        String::from_utf8_lossy(&result.stderr)
    );
    assert!(String::from_utf8_lossy(&result.stdout)
        .contains("U02.4 C01-C04: Node HTTP and Rust authority outputs match"));
}
