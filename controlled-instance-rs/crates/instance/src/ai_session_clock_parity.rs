use super::*;

const START: &str = "2026-11-05T00:00:00.000Z";
const START_MS: i64 = 1_793_836_800_000;

fn fixture() -> Value {
    serde_json::from_str(include_str!(
        "../tests/fixtures/ai-session-clock-parity.json"
    ))
    .expect("fixed Node HTTP source and consumer output")
}

fn at(offset: i64) -> String {
    chrono::DateTime::from_timestamp_millis(START_MS + offset)
        .expect("clock")
        .to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn input(story: Option<&str>, now: i64) -> AiSessionsSnapshot {
    // Authority input is a summary, including opaque detail/turn revisions from
    // the source registry. This suite checks forwarding and stream ownership;
    // it does not claim to verify the registry's revision-hash implementation.
    let mut record = json!({
        "id": "<session>", "agent": "codex", "creationSource": "ai-session",
        "providerSessionId": "provider-clock", "title": "Clock session",
        "actions": {"send":true,"interrupt":false,"approval":false,"fork":false,
            "rename":false,"openApp":true,"close":true},
        "detailRevision":"8J1v3lisaTdoB00MdJ1bq6", "turnsRevision":"T1PNoYwrqgwDVLtfmj7L5e",
        "unread":false,"turnCount":0,"status":"idle","phase":"unknown",
        "toolCallsSinceLastMessage":0,"subAgentCount":0,"subAgents":[],
        "queue":{"revision":0,"pendingCount":0,"items":[]},
        "startedAt":START,"updatedAt":if story.is_some(){at(now)}else{at(0)}
    });
    if let Some(story) = story {
        record["storyId"] = json!(story);
    }
    AiSessionsSnapshot {
        running_count: 0,
        waiting_count: 0,
        stale_count: 0,
        sessions: vec![serde_json::from_value(record).expect("source summary input")],
        updated_at: at(now),
    }
}

fn samples() -> Value {
    let mut authority = AiSessionAuthority::new("standalone", "<stream>", START.to_string());
    let state = |authority: &AiSessionAuthority| {
        serde_json::to_value(
            authority.state(
                authority
                    .published_snapshot()
                    .cloned()
                    .unwrap_or_else(|| input(None, 0)),
            ),
        )
        .expect("state")
    };
    let publish = |authority: &mut AiSessionAuthority, story, now| {
        authority.prepare_with_clocks(
            input(story, now),
            if now == 1000 {
                "startup"
            } else {
                "control-action"
            },
            || at(now),
            || START_MS + now,
        )
    };
    let startup = state(&authority);
    publish(&mut authority, None, 1000).expect("first control action");
    let first = state(&authority);
    publish(&mut authority, Some("story-clock"), 2000).expect("story update");
    let retained = state(&authority);
    let original_events = authority.delta_at("<stream>", 0.0, START_MS + 2000)["events"].clone();
    let boundary_delta = authority.delta_at("<stream>", 1.0, START_MS + 2000 + EVENT_RETENTION_MS);
    let boundary = state(&authority);
    let idle_before_delta = state(&authority);
    let expired_delta = authority.delta_at("<stream>", 1.0, START_MS + 2001 + EVENT_RETENTION_MS);
    assert_eq!(authority.retained_event_count(), 0);
    let expired = state(&authority);
    // An already-read control action preserves the old summary.updatedAt.
    let mut noop_input = input(Some("story-clock"), 2000);
    noop_input.updated_at = at(2001 + EVENT_RETENTION_MS);
    assert!(authority
        .prepare_with_clocks(
            noop_input,
            "control-action",
            || at(2001 + EVENT_RETENTION_MS),
            || START_MS + 2001 + EVENT_RETENTION_MS
        )
        .is_none());
    let noop = state(&authority);
    publish(
        &mut authority,
        Some("story-after-expiry"),
        3000 + EVENT_RETENTION_MS,
    )
    .expect("next story");
    let resumed = state(&authority);
    let resumed_delta = authority.delta_at("<stream>", 2.0, START_MS + 3000 + EVENT_RETENTION_MS);
    let mut samples = json!({
        "startup":startup,"first":first,"retained":retained,"originalEvents":original_events,
        "boundaryDelta":boundary_delta,"boundary":boundary,"idleBeforeDelta":idle_before_delta,
        "expiredDelta":expired_delta,"expired":expired,"expiredAlias":expired,"noop":noop,
        "resumed":resumed,"resumedDelta":resumed_delta,
    });
    fn normalize(value: &mut Value, traces: &mut HashMap<u64, String>) {
        match value {
            Value::Array(items) => items.iter_mut().for_each(|item| normalize(item, traces)),
            Value::Object(object) => {
                if let Some(trace) = object.get("traceId").and_then(Value::as_str) {
                    let revision = object["revision"].as_u64().expect("revision");
                    assert!(trace.starts_with("ais_evt_"));
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

#[test]
fn c01_retained_cutoff_and_lazy_state_clock_match_node_http() {
    let actual = samples();
    let expected = fixture()["expected"].clone();
    for name in [
        "startup",
        "first",
        "retained",
        "originalEvents",
        "boundaryDelta",
        "boundary",
        "idleBeforeDelta",
    ] {
        assert_eq!(actual[name], expected[name], "{name}");
    }
}

#[test]
fn c02_pruned_history_fallback_and_noop_match_node_http() {
    let actual = samples();
    let expected = fixture()["expected"].clone();
    for name in ["expiredDelta", "expired", "expiredAlias", "noop"] {
        assert_eq!(actual[name], expected[name], "{name}");
    }
    assert_eq!(
        actual["expired"]["snapshot"],
        actual["retained"]["snapshot"]
    );
}

#[test]
fn c03_cold_and_warm_consumers_match_node_exact_state_and_timestamps() {
    use std::io::Write;
    use std::process::{Command, Stdio};
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .ancestors()
        .nth(3)
        .expect("repository root");
    // Test-only use of the existing consumer, never a production Node fallback.
    let mut child = Command::new("node")
        .current_dir(root)
        .args([
            "--import",
            "./test/setup-isolated-runtime.mjs",
            "test/fixtures/ai-session-clock-parity.js",
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("Node prerequisites required; no skip");
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
fn c04_new_event_after_expiry_matches_node_exact_clock_and_revision() {
    let actual = samples();
    let expected = fixture()["expected"].clone();
    for name in ["resumed", "resumedDelta"] {
        assert_eq!(actual[name], expected[name], "{name}");
    }
}
