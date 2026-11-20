// Included inside each authority's test module so its production private clock
// seam stays private. Node registry summary hashes are opaque authority inputs;
// this verifies stream ownership/forwarding, not registry hash generation.
use std::io::Write;
use std::process::{Command, Stdio};

const START_MS: i64 = 1_793_836_800_000;

fn at(offset: i64) -> String {
    chrono::DateTime::from_timestamp_millis(START_MS + offset)
        .expect("fixed clock")
        .to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn input(epoch: &str, base: i64, revision: u64) -> Snapshot {
    let now = base + (revision as i64 - 1) * 1000;
    let value = if TOPIC == "app" {
        json!({
            "runningCount":1,"problemCount":0,"updatedAt":at(now),"sessions":[{
                "id":"app_epoch","appId":"terminal-tty","title":format!("{epoch}-{revision}"),
                "kind":"tty","status":"running","createdAt":at(base),"updatedAt":at(base),
                "bindings":[{"type":"app-session","id":"app_epoch"}],
                "workspace":{"cwd":"/workspace"},"paths":{"sessionDir":"/tmp/session","logDir":"/tmp/logs"}
            }]
        })
    } else {
        let mut record = json!({
            "id":format!("<ai-{epoch}-session>"),"agent":"codex","creationSource":"ai-session",
            "providerSessionId":"provider-epoch","title":"Epoch session",
            "actions":{"send":true,"interrupt":false,"approval":false,"fork":false,
                "rename":false,"openApp":true,"close":true},
            "detailRevision":"8J1v3lisaTdoB00MdJ1bq6","turnsRevision":"T1PNoYwrqgwDVLtfmj7L5e",
            "unread":false,"turnCount":0,"status":"idle","phase":"unknown",
            "toolCallsSinceLastMessage":0,"subAgentCount":0,"subAgents":[],
            "queue":{"revision":0,"pendingCount":0,"items":[]},"startedAt":at(base),"updatedAt":at(now)
        });
        if revision > 1 {
            record["storyId"] = json!(format!("{epoch}-{revision}"));
        }
        json!({"runningCount":0,"waitingCount":0,"staleCount":0,"sessions":[record],"updatedAt":at(now)})
    };
    serde_json::from_value(value).expect("explicit source input")
}

fn samples() -> Value {
    let mut output = json!({});
    for (epoch, base) in [("old", 0), ("next", 10_000)] {
        let stream = format!("{TOPIC}-{epoch}");
        let mut authority = Authority::new("standalone", &stream, at(base));
        let mut states = Vec::new();
        let mut events = Vec::new();
        let mut trace_ids = HashMap::new();
        for revision in 1..=3 {
            let now = base + (revision as i64 - 1) * 1000;
            let reason = match (TOPIC, revision) {
                ("app", 1) => "app-session-created",
                ("app", _) => "app-session-updated",
                (_, 1) => "startup",
                _ => "control-action",
            };
            let event = authority
                .prepare_with_clocks(
                    input(epoch, base, revision),
                    reason,
                    || at(now),
                    || START_MS + now,
                )
                .expect("semantic change");
            trace_ids.insert(
                revision,
                event.payload["meta"]["traceId"]
                    .as_str()
                    .expect("trace")
                    .to_string(),
            );
            events.push(json!({"type":event.event_type,"payload":event.payload}));
            states.push(
                serde_json::to_value(
                    authority.state(
                        authority
                            .published_snapshot()
                            .expect("published snapshot")
                            .clone(),
                    ),
                )
                .expect("state"),
            );
        }
        assert_eq!(
            trace_ids
                .values()
                .collect::<std::collections::HashSet<_>>()
                .len(),
            3
        );
        let delta = authority.delta_at(&stream, 1.0, START_MS + base + 2000);
        let mut value = json!({"states":states,"events":events,"delta":delta});
        fn normalize(value: &mut Value, epoch: &str, traces: &HashMap<u64, String>) {
            match value {
                Value::Array(items) => items
                    .iter_mut()
                    .for_each(|item| normalize(item, epoch, traces)),
                Value::Object(object) => {
                    if let Some(trace) = object.get("traceId").and_then(Value::as_str) {
                        let revision = object["revision"].as_u64().expect("revision");
                        assert_eq!(Some(trace), traces.get(&revision).map(String::as_str));
                        let prefix = if TOPIC == "ai" {
                            "ais_evt_"
                        } else {
                            "aps_evt_"
                        };
                        assert!(trace.starts_with(prefix));
                        object.insert(
                            "traceId".to_string(),
                            json!(format!("<{TOPIC}-{epoch}-trace-{revision}>")),
                        );
                    }
                    object
                        .values_mut()
                        .for_each(|item| normalize(item, epoch, traces));
                }
                _ => {}
            }
        }
        normalize(&mut value, epoch, &trace_ids);
        output[epoch] = value;
    }
    output
}

#[test]
fn c01_c04_epoch_outputs_match_node_and_existing_consumers() {
    let actual = samples();
    let golden: Value =
        serde_json::from_str(include_str!("../tests/fixtures/session-epoch-parity.json"))
            .expect("fixed Node source");
    assert_eq!(
        actual, golden["expected"][TOPIC],
        "full events, states and delta; no time/revision normalization"
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
            "test/fixtures/session-epoch-consumers.js",
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("Node source consumer prerequisites required; no skip");
    child
        .stdin
        .take()
        .expect("stdin")
        .write_all(&serde_json::to_vec(&json!({"topic":TOPIC,"samples":actual})).expect("samples"))
        .expect("write samples");
    let result = child
        .wait_with_output()
        .expect("bounded Node consumer comparison");
    assert!(
        result.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&result.stdout),
        String::from_utf8_lossy(&result.stderr)
    );
}
