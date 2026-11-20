// Shared inside the two authority test modules. Frozen Node normalized summaries
// are inputs: registry/provider behavior and summary hashes are not reimplemented.
use std::io::Write;
use std::process::{Command, Stdio};

const START_MS: i64 = 1_793_836_800_000;

fn at(offset: i64) -> String {
    chrono::DateTime::from_timestamp_millis(START_MS + offset)
        .expect("clock")
        .to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn expected() -> Value {
    let fixture: Value = serde_json::from_str(include_str!(
        "../tests/fixtures/session-removal-parity.json"
    ))
    .expect("fixed production Node source");
    fixture["expected"]["samples"][TOPIC].clone()
}

fn samples() -> Value {
    let source = expected();
    let input = |name: &str| -> Snapshot {
        serde_json::from_value(source[name]["snapshot"].clone()).expect("source summary input")
    };
    let mut authority = Authority::new("standalone", format!("{TOPIC}-removal"), at(0));
    let mut output = json!({});
    let mut events = Vec::new();
    let mut traces = HashMap::new();
    for (index, name) in ["initial", "updated", "removed"].into_iter().enumerate() {
        let revision = index as u64 + 1;
        let event = publish(&mut authority, input(name), revision).expect("semantic transition");
        traces.insert(
            revision,
            event["payload"]["meta"]["traceId"]
                .as_str()
                .expect("trace")
                .to_string(),
        );
        events.push(event);
        output[name] = serde_json::to_value(
            authority.state(
                authority
                    .published_snapshot()
                    .expect("published state")
                    .clone(),
            ),
        )
        .expect("state");
    }
    assert_eq!(
        traces
            .values()
            .collect::<std::collections::HashSet<_>>()
            .len(),
        3
    );
    assert!(
        publish(&mut authority, input("removed"), 3).is_none(),
        "repeated deletion cannot allocate a revision"
    );
    output["noop"] =
        serde_json::to_value(authority.state(authority.published_snapshot().unwrap().clone()))
            .unwrap();
    output["events"] = json!(events);
    let stream = authority.stream_id().to_string();
    output["delta"] = authority.delta_at(&stream, 1.0, START_MS + 2000);
    output["boundaryDelta"] =
        authority.delta_at(&stream, 2.0, START_MS + 2000 + EVENT_RETENTION_MS);
    output["expiredDelta"] = authority.delta_at(&stream, 2.0, START_MS + 2001 + EVENT_RETENTION_MS);
    assert_eq!(authority.retained_event_count(), 0);
    fn normalize(value: &mut Value, traces: &HashMap<u64, String>) {
        match value {
            Value::Array(items) => items.iter_mut().for_each(|item| normalize(item, traces)),
            Value::Object(object) => {
                if let Some(trace) = object.get("traceId").and_then(Value::as_str) {
                    let revision = object["revision"].as_u64().expect("revision");
                    assert_eq!(Some(trace), traces.get(&revision).map(String::as_str));
                    assert!(trace.starts_with(if TOPIC == "ai" {
                        "ais_evt_"
                    } else {
                        "aps_evt_"
                    }));
                    object.insert(
                        "traceId".to_string(),
                        json!(format!("<{TOPIC}-trace-{revision}>")),
                    );
                }
                object.values_mut().for_each(|item| normalize(item, traces));
            }
            _ => {}
        }
    }
    normalize(&mut output, &traces);
    output
}

#[test]
fn c01_c04_removal_tombstone_expiry_and_existing_consumers_match_node() {
    let actual = samples();
    assert_eq!(
        actual,
        expected(),
        "full output, exact TTL, revisions and summary references"
    );
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .ancestors()
        .nth(3)
        .expect("repository root");
    let mut child = Command::new("node")
        .current_dir(root)
        .args([
            "--import",
            "./test/setup-isolated-runtime.mjs",
            "test/fixtures/session-removal-consumers.js",
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("existing Node consumer prerequisites required; no skip");
    child
        .stdin
        .take()
        .expect("stdin")
        .write_all(&serde_json::to_vec(&json!({"topic":TOPIC,"sample":actual})).expect("samples"))
        .expect("write samples");
    let result = child
        .wait_with_output()
        .expect("bounded consumer comparison");
    assert!(
        result.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&result.stdout),
        String::from_utf8_lossy(&result.stderr)
    );
}
