use chrono::{Duration, SecondsFormat, Utc};
use controlled_instance_protocol::{
    AppSession, AppSessionsSnapshot, AppSessionsState, APP_SESSION_TOMBSTONE_RETENTION_MS,
};
use serde_json::{json, Value};
use std::collections::{HashMap, VecDeque};

const EVENT_RETENTION_MS: i64 = 60 * 60 * 1000;

#[derive(Debug, Clone)]
struct RetainedAppEvent {
    event_type: String,
    payload: Value,
    revision: u64,
    created_at_ms: i64,
}

#[derive(Debug)]
pub struct AppSessionAuthority {
    instance_id: String,
    stream_id: String,
    revision: u64,
    last_event_at: String,
    last_snapshot: Option<AppSessionsSnapshot>,
    history: VecDeque<RetainedAppEvent>,
}

pub struct AppSessionAuthorityEvent {
    pub event_type: String,
    pub payload: Value,
}

impl AppSessionAuthority {
    pub fn new(
        instance_id: impl Into<String>,
        stream_id: impl Into<String>,
        started_at: String,
    ) -> Self {
        Self {
            instance_id: instance_id.into(),
            stream_id: stream_id.into(),
            revision: 0,
            last_event_at: started_at,
            last_snapshot: None,
            history: VecDeque::new(),
        }
    }

    pub fn stream_id(&self) -> &str {
        &self.stream_id
    }

    pub fn revision(&self) -> u64 {
        self.revision
    }

    pub fn earliest_retained_revision(&self) -> u64 {
        self.history
            .front()
            .map(|event| event.revision)
            .unwrap_or(self.revision.saturating_add(1))
    }

    pub fn retained_event_count(&self) -> usize {
        self.history.len()
    }

    pub fn state(&self, snapshot: AppSessionsSnapshot) -> AppSessionsState {
        AppSessionsState {
            stream_id: self.stream_id.clone(),
            revision: self.revision,
            last_event_at: self.last_event_at.clone(),
            snapshot,
        }
    }

    pub fn prepare(
        &mut self,
        snapshot: AppSessionsSnapshot,
        reason: &str,
    ) -> Option<AppSessionAuthorityEvent> {
        if self.last_snapshot.as_ref() == Some(&snapshot) {
            return None;
        }
        let had_previous = self.last_snapshot.is_some();
        let changes = snapshot_changes(self.last_snapshot.as_ref(), &snapshot);
        if had_previous && changes.is_empty() {
            return None;
        }
        self.revision = self.revision.saturating_add(1);
        let generated_at = now_iso();
        let mut meta = json!({
            "streamId": self.stream_id,
            "instanceId": self.instance_id,
            "revision": self.revision,
            "traceId": crate::ai_session_authority::event_trace_id("aps_evt"),
            "generatedAt": generated_at,
            "reason": reason,
        });
        if self.revision > 0 {
            meta.as_object_mut().expect("meta object").insert(
                "previousRevision".to_string(),
                json!(self.revision.saturating_sub(1)),
            );
        }
        if let (Some(object), Some(node_id)) = (
            meta.as_object_mut(),
            std::env::var("TASK_HANDOFF_NODE_ID")
                .ok()
                .filter(|value| !value.trim().is_empty()),
        ) {
            object.insert("nodeId".to_string(), Value::String(node_id));
        }
        let (event_type, payload) = match (had_previous, changes.as_slice()) {
            (false, _) => (
                "app-session.snapshot",
                json!({ "meta": meta, "snapshot": snapshot }),
            ),
            (
                true,
                [SnapshotChange::Removed {
                    session_id,
                    tombstone,
                }],
            ) => (
                "app-session.removed",
                json!({
                    "meta": meta,
                    "sessionId": session_id,
                    "tombstone": tombstone,
                    "expiresAt": (Utc::now() + Duration::milliseconds(APP_SESSION_TOMBSTONE_RETENTION_MS))
                        .to_rfc3339_opts(SecondsFormat::Millis, true),
                }),
            ),
            (true, [SnapshotChange::Upsert { session }]) => (
                "app-session.patch",
                json!({ "meta": meta, "session": session }),
            ),
            _ => (
                "app-session.snapshot",
                json!({ "meta": meta, "snapshot": snapshot }),
            ),
        };
        self.last_snapshot = Some(snapshot);
        self.last_event_at = generated_at;
        self.remember(event_type, &payload);
        Some(AppSessionAuthorityEvent {
            event_type: event_type.to_string(),
            payload,
        })
    }

    pub fn delta(&self, stream_id: &str, since_revision: f64) -> Value {
        let latest_revision = self.revision;
        let earliest_retained_revision = self
            .history
            .front()
            .map(|event| event.revision)
            .unwrap_or(latest_revision.saturating_add(1));
        if stream_id != self.stream_id || since_revision > latest_revision as f64 {
            return delta_response(
                &self.stream_id,
                &self.instance_id,
                since_revision,
                latest_revision,
                earliest_retained_revision,
                true,
                Vec::new(),
            );
        }
        if since_revision == latest_revision as f64 {
            return delta_response(
                &self.stream_id,
                &self.instance_id,
                since_revision,
                latest_revision,
                earliest_retained_revision,
                false,
                Vec::new(),
            );
        }
        let events = self
            .history
            .iter()
            .filter(|event| event.revision as f64 > since_revision)
            .collect::<Vec<_>>();
        let sync_required = events
            .first()
            .is_none_or(|event| event.revision as f64 != since_revision + 1.0);
        let events = if sync_required {
            Vec::new()
        } else {
            events
                .into_iter()
                .map(|event| json!({ "type": event.event_type, "payload": event.payload }))
                .collect()
        };
        delta_response(
            &self.stream_id,
            &self.instance_id,
            since_revision,
            latest_revision,
            earliest_retained_revision,
            sync_required,
            events,
        )
    }

    fn remember(&mut self, event_type: &str, payload: &Value) {
        let now = Utc::now().timestamp_millis();
        while self
            .history
            .front()
            .is_some_and(|event| event.created_at_ms < now - EVENT_RETENTION_MS)
        {
            self.history.pop_front();
        }
        self.history.push_back(RetainedAppEvent {
            event_type: event_type.to_string(),
            payload: payload.clone(),
            revision: self.revision,
            created_at_ms: now,
        });
    }
}

enum SnapshotChange {
    Upsert {
        session: AppSession,
    },
    Removed {
        session_id: String,
        tombstone: Option<AppSession>,
    },
}

fn snapshot_changes(
    previous: Option<&AppSessionsSnapshot>,
    next: &AppSessionsSnapshot,
) -> Vec<SnapshotChange> {
    let Some(previous) = previous else {
        return Vec::new();
    };
    let previous_by_id = previous
        .sessions
        .iter()
        .map(|session| (session.id.as_str(), session))
        .collect::<HashMap<_, _>>();
    let next_ids = next
        .sessions
        .iter()
        .map(|session| session.id.as_str())
        .collect::<std::collections::HashSet<_>>();
    let mut changes = next
        .sessions
        .iter()
        .filter(|session| {
            previous_by_id
                .get(session.id.as_str())
                .is_none_or(|previous_session| *previous_session != *session)
        })
        .cloned()
        .map(|session| SnapshotChange::Upsert { session })
        .collect::<Vec<_>>();
    changes.extend(
        previous
            .sessions
            .iter()
            .filter(|session| !next_ids.contains(session.id.as_str()))
            .map(|session| SnapshotChange::Removed {
                session_id: session.id.clone(),
                tombstone: Some(session.clone()),
            }),
    );
    changes
}

fn delta_response(
    stream_id: &str,
    instance_id: &str,
    since_revision: f64,
    latest_revision: u64,
    earliest_retained_revision: u64,
    sync_required: bool,
    events: Vec<Value>,
) -> Value {
    json!({
        "streamId": stream_id,
        "instanceId": instance_id,
        "sinceRevision": js_number_value(since_revision),
        "latestRevision": latest_revision,
        "earliestRetainedRevision": earliest_retained_revision,
        "syncRequired": sync_required,
        "events": events,
    })
}

fn js_number_value(number: f64) -> Value {
    if number >= 0.0 && number <= u64::MAX as f64 && number.fract() == 0.0 {
        json!(number as u64)
    } else {
        json!(number)
    }
}

fn now_iso() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn session(id: &str, status: &str, title: &str) -> AppSession {
        serde_json::from_value(json!({
            "id": id,
            "appId": "terminal-tty",
            "title": title,
            "kind": "tty",
            "status": status,
            "createdAt": "2026-11-02T00:00:00.000Z",
            "updatedAt": "2026-11-02T00:00:00.000Z",
            "workspace": {"cwd": "/workspace"},
            "paths": {"sessionDir": "/tmp/s", "logDir": "/tmp/l"}
        }))
        .expect("session")
    }

    fn snapshot(updated_at: &str, sessions: Vec<AppSession>) -> AppSessionsSnapshot {
        AppSessionsSnapshot {
            running_count: sessions
                .iter()
                .filter(|session| session.status == "running")
                .count() as u64,
            problem_count: 0,
            sessions,
            updated_at: updated_at.to_string(),
        }
    }

    #[test]
    fn first_change_is_a_snapshot_and_single_changes_are_patches() {
        let mut authority =
            AppSessionAuthority::new("ins_1", "aps_1", "2026-11-02T00:00:00.000Z".to_string());
        assert_eq!(authority.earliest_retained_revision(), 1);
        let first = authority
            .prepare(
                snapshot(
                    "2026-11-02T00:00:00.000Z",
                    vec![session("app-1", "running", "Terminal")],
                ),
                "startup",
            )
            .expect("snapshot");
        assert_eq!(first.event_type, "app-session.snapshot");
        assert_eq!(first.payload["meta"]["previousRevision"], 0);
        assert!(authority
            .prepare(
                snapshot(
                    "2026-11-02T00:00:01.000Z",
                    vec![session("app-1", "running", "Terminal")]
                ),
                "startup"
            )
            .is_none());
        let patch = authority
            .prepare(
                snapshot(
                    "2026-11-02T00:00:02.000Z",
                    vec![session("app-1", "running", "Renamed")],
                ),
                "app-session-updated",
            )
            .expect("patch");
        assert_eq!(patch.event_type, "app-session.patch");
        assert_eq!(patch.payload["meta"]["revision"], 2);
        assert_eq!(patch.payload["meta"]["previousRevision"], 1);
        assert_eq!(patch.payload["session"]["title"], "Renamed");
    }

    #[test]
    fn retained_revision_tracks_the_oldest_available_delta() {
        let mut authority =
            AppSessionAuthority::new("ins_1", "aps_1", "2026-11-02T00:00:00.000Z".to_string());
        authority
            .prepare(
                snapshot(
                    "2026-11-02T00:00:00.000Z",
                    vec![session("app-1", "running", "Terminal")],
                ),
                "test",
            )
            .expect("snapshot");
        authority
            .prepare(
                snapshot(
                    "2026-11-02T00:00:01.000Z",
                    vec![session("app-1", "stopped", "Terminal")],
                ),
                "test",
            )
            .expect("patch");
        assert_eq!(authority.revision(), 2);
        assert_eq!(authority.earliest_retained_revision(), 1);
    }

    #[test]
    fn first_snapshot_with_multiple_sessions_stays_a_snapshot() {
        let mut authority =
            AppSessionAuthority::new("ins_1", "aps_1", "2026-11-02T00:00:00.000Z".to_string());
        let event = authority
            .prepare(
                snapshot(
                    "2026-11-02T00:00:00.000Z",
                    vec![
                        session("app-1", "running", "One"),
                        session("app-2", "running", "Two"),
                    ],
                ),
                "startup",
            )
            .expect("event");
        assert_eq!(event.event_type, "app-session.snapshot");
        assert_eq!(
            event.payload["snapshot"]["sessions"]
                .as_array()
                .unwrap()
                .len(),
            2
        );
    }
}
