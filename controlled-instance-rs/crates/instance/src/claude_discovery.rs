use chrono::{SecondsFormat, Utc};
use controlled_instance_ai_session::{AiSession, AiSessionRuntime, ClaudeDaemonJob, ProviderError};
use controlled_instance_core::claude::{
    claude_home_from_env, claude_sessions_dir, control_socket_path_from_env,
    find_claude_transcript_path, find_claude_transcript_path_in,
};
use controlled_instance_protocol::{mint_entity_id, AiSessionQueue, AppSession};
use serde_json::{json, Map, Value};
use std::{
    collections::{BTreeMap, BTreeSet, HashSet},
    fs,
    path::{Path, PathBuf},
};

#[derive(Debug, Clone, Default)]
pub(crate) struct ClaudeDiscoveryRefresh {
    pub changed: usize,
    pub subscriptions: BTreeMap<String, PathBuf>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct ClaudeLifecycle {
    running: bool,
    waiting: bool,
    failed: bool,
}

impl ClaudeLifecycle {
    fn status(self) -> &'static str {
        if self.failed {
            "failed"
        } else if self.waiting {
            "waiting"
        } else if self.running {
            "running"
        } else {
            "idle"
        }
    }

    fn phase(self) -> &'static str {
        if self.running {
            "thinking"
        } else {
            "unknown"
        }
    }
}

pub(crate) fn refresh_claude_sessions(
    sessions: &AiSessionRuntime,
    jobs: &[ClaudeDaemonJob],
    app_sessions: &[AppSession],
) -> Result<ClaudeDiscoveryRefresh, ProviderError> {
    let claude_home = claude_home_from_env();
    refresh_claude_sessions_with_home(sessions, jobs, app_sessions, claude_home.as_deref())
}

fn refresh_claude_sessions_with_home(
    sessions: &AiSessionRuntime,
    jobs: &[ClaudeDaemonJob],
    app_sessions: &[AppSession],
    claude_home: Option<&Path>,
) -> Result<ClaudeDiscoveryRefresh, ProviderError> {
    let running = app_sessions
        .iter()
        .filter(|session| {
            let status = session.status.trim().to_ascii_lowercase();
            status.is_empty() || status == "running"
        })
        .collect::<Vec<_>>();
    let mut app_sessions_by_short = BTreeMap::new();
    for app_session in &running {
        if let Some(short) = app_claude_short(app_session) {
            app_sessions_by_short.insert(short, *app_session);
        }
    }

    let mut refresh = ClaudeDiscoveryRefresh::default();
    for app_session in &running {
        let Some(short) = app_claude_short(app_session) else {
            continue;
        };
        let job = jobs.iter().find(|job| {
            job.short
                .as_deref()
                .map(|short| compact(short, 80))
                .as_deref()
                == Some(short.as_str())
        });
        let job = job
            .cloned()
            .unwrap_or_else(|| claude_job_from_app_session(app_session));
        let Some((changed, control_sock)) =
            upsert_claude_job_in(sessions, &job, Some(app_session), claude_home)?
        else {
            continue;
        };
        refresh.changed += usize::from(changed);
        refresh.subscriptions.insert(short, control_sock);
    }
    for job in jobs {
        let Some(short) = job_short(job) else {
            continue;
        };
        if app_sessions_by_short.contains_key(&short) {
            continue;
        }
        if let Some((changed, control_sock)) =
            upsert_claude_job_in(sessions, job, None, claude_home)?
        {
            refresh.changed += usize::from(changed);
            refresh.subscriptions.insert(short, control_sock);
        }
    }

    refresh.changed += apply_claude_runtime_bindings(sessions, &running, claude_home)?;

    refresh.changed += reconcile_claude_sessions(
        sessions,
        &running
            .iter()
            .map(|session| session.id.clone())
            .collect::<HashSet<_>>(),
        jobs,
        &refresh.subscriptions.keys().cloned().collect(),
    )?;
    Ok(refresh)
}

pub(crate) fn upsert_claude_job(
    sessions: &AiSessionRuntime,
    job: &ClaudeDaemonJob,
    app_session: Option<&AppSession>,
) -> Result<Option<(bool, PathBuf)>, ProviderError> {
    let claude_home = claude_home_from_env();
    upsert_claude_job_in(sessions, job, app_session, claude_home.as_deref())
}

fn upsert_claude_job_in(
    sessions: &AiSessionRuntime,
    job: &ClaudeDaemonJob,
    app_session: Option<&AppSession>,
    claude_home: Option<&Path>,
) -> Result<Option<(bool, PathBuf)>, ProviderError> {
    let Some(short) = job_short(job) else {
        return Ok(None);
    };
    let provider_session_id = compact_optional(
        first_truthy_string([
            job.session_id.as_deref(),
            app_claude_string(app_session, "providerSessionId"),
        ]),
        240,
    );
    let cwd = compact_optional(
        first_truthy_string([
            job.cwd.as_deref(),
            app_claude_string(app_session, "cwd"),
            app_session.and_then(|session| session.tty.as_ref().map(|tty| tty.cwd.as_str())),
            app_session.and_then(|session| {
                session
                    .launch
                    .as_ref()
                    .and_then(|launch| launch.cwd.as_deref())
            }),
        ]),
        4096,
    );
    let control_sock = compact_optional(app_claude_string(app_session, "controlSock"), 4096)
        .map(PathBuf::from)
        .unwrap_or_else(control_socket_path_from_env);
    let existing = find_claude_session(
        sessions,
        provider_session_id.as_deref(),
        app_session.map(|session| session.id.as_str()),
        Some(short.as_str()),
    );
    let is_app_session = app_session.is_some()
        || existing
            .as_ref()
            .is_some_and(|session| session.app_session_id.is_some());
    let lifecycle = claude_lifecycle(
        first_truthy_string([
            job.state.as_deref(),
            app_claude_string(app_session, "state"),
        ]),
        has_work_signal(job),
        is_app_session,
    );
    let app_id = app_session
        .map(|session| compact(&session.app_id, 120))
        .filter(|value| !value.is_empty())
        .or_else(|| app_session.map(|_| "claude".to_string()))
        .unwrap_or_else(|| "claude-daemon".to_string());
    let title = app_session
        .and_then(|session| compact_optional(Some(session.title.as_str()), 240))
        .unwrap_or_else(|| "Claude".to_string());
    let provider_meta = claude_provider_meta(job, app_session, &short, &control_sock);
    let transcript_path = provider_session_id
        .as_deref()
        .and_then(|provider_session_id| {
            resolve_claude_transcript_path(provider_session_id, cwd.as_deref(), claude_home)
        });
    let actions = claude_actions(Some(lifecycle.status()), app_session.is_some());
    let app_binding_keys = claude_app_binding_keys(app_session, &short);

    let Some(existing) = existing else {
        let timestamp = now_iso();
        let app_session_id = app_session.map(|session| compact(&session.id, 120));
        let session = AiSession {
            id: mint_entity_id("ses"),
            agent: "claude".to_string(),
            creation_source: "app-session".to_string(),
            app_session_id,
            app_id: Some(app_id),
            provider_session_id,
            lineage: None,
            provider_meta: Some(provider_meta),
            model_selection: None,
            reasoning_effort: None,
            story_id: None,
            app_binding_keys: Some(app_binding_keys),
            actions: Some(actions),
            active_turn_id: None,
            title: Some(title),
            cwd,
            cwd_folder_id: None,
            user_prompt: None,
            turns: None,
            status: lifecycle.status().to_string(),
            phase: lifecycle.phase().to_string(),
            summary: None,
            last_message: None,
            last_message_item_id: None,
            current_tool: None,
            tool_calls_since_last_message: 0,
            sub_agents: Vec::new(),
            transcript_path,
            transcript_size: None,
            started_at: timestamp.clone(),
            updated_at: timestamp,
            completed_at: None,
            error: None,
            counters: Default::default(),
            queue: AiSessionQueue::default(),
            unread: false,
        };
        sessions.save(session).map_err(persistence_error)?;
        return Ok(Some((true, control_sock)));
    };

    let updated = sessions
        .update(&existing.id, |session| {
            Ok(merge_claude_snapshot(
                session,
                ClaudeSnapshot {
                    app_session,
                    app_id: &app_id,
                    provider_session_id: provider_session_id.as_deref(),
                    provider_meta: &provider_meta,
                    app_binding_keys: &app_binding_keys,
                    actions: &actions,
                    title: &title,
                    cwd: cwd.as_deref(),
                    transcript_path: transcript_path.as_deref(),
                    lifecycle,
                },
            ))
        })
        .map_err(persistence_error)?;
    Ok(Some((updated != existing, control_sock)))
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ClaudeRuntimeSession {
    session_id: String,
    cwd: Option<String>,
    status: Option<String>,
}

fn apply_claude_runtime_bindings(
    sessions: &AiSessionRuntime,
    app_sessions: &[&AppSession],
    claude_home: Option<&Path>,
) -> Result<usize, ProviderError> {
    let runtime_sessions = read_claude_runtime_sessions(claude_home);
    let mut changed = 0;
    for app_session in app_sessions {
        if compact(&app_session.app_id, 120) != "claude" {
            continue;
        }
        let status = compact(&app_session.status, 80).to_ascii_lowercase();
        if !status.is_empty() && status != "running" {
            continue;
        }
        let Some(pid) = app_session
            .process
            .as_ref()
            .and_then(|process| process.pid)
            .filter(|pid| *pid > 0)
        else {
            continue;
        };
        let Some(runtime_session) = runtime_sessions.get(&pid) else {
            continue;
        };
        let provider_session_id = runtime_session.session_id.clone();
        let cwd = compact_optional(
            first_truthy_string([
                runtime_session.cwd.as_deref(),
                app_session.tty.as_ref().map(|tty| tty.cwd.as_str()),
                app_session
                    .launch
                    .as_ref()
                    .and_then(|launch| launch.cwd.as_deref()),
            ]),
            4096,
        );
        let transcript_path =
            resolve_claude_transcript_path(&provider_session_id, cwd.as_deref(), claude_home);
        let title = compact_optional(Some(app_session.title.as_str()), 240)
            .unwrap_or_else(|| "Claude".to_string());
        let lifecycle = claude_runtime_lifecycle(runtime_session.status.as_deref());

        let existing = sessions
            .get_by_provider_session_id("claude", &provider_session_id)
            .or_else(|| {
                let listed = sessions.list();
                listed
                    .iter()
                    .find(|session| {
                        session.agent == "claude"
                            && session.app_session_id.as_deref() == Some(app_session.id.as_str())
                    })
                    .cloned()
                    .or_else(|| {
                        transcript_path.as_deref().and_then(|transcript_path| {
                            listed.into_iter().find(|session| {
                                session.agent == "claude"
                                    && session.transcript_path.as_deref() == Some(transcript_path)
                            })
                        })
                    })
            });

        let Some(existing) = existing else {
            let timestamp = now_iso();
            let session = AiSession {
                id: mint_entity_id("ses"),
                agent: "claude".to_string(),
                creation_source: "app-session".to_string(),
                app_session_id: Some(app_session.id.clone()),
                app_id: Some("claude".to_string()),
                provider_session_id: Some(provider_session_id),
                lineage: None,
                provider_meta: None,
                model_selection: None,
                reasoning_effort: None,
                story_id: None,
                app_binding_keys: None,
                actions: None,
                active_turn_id: None,
                title: Some(title),
                cwd,
                cwd_folder_id: None,
                user_prompt: None,
                turns: None,
                status: lifecycle.to_string(),
                phase: "unknown".to_string(),
                summary: None,
                last_message: None,
                last_message_item_id: None,
                current_tool: None,
                tool_calls_since_last_message: 0,
                sub_agents: Vec::new(),
                transcript_path,
                transcript_size: None,
                started_at: timestamp.clone(),
                updated_at: timestamp,
                completed_at: None,
                error: None,
                counters: Default::default(),
                queue: AiSessionQueue::default(),
                unread: false,
            };
            sessions.save(session).map_err(persistence_error)?;
            changed += 1;
            continue;
        };

        let updated = sessions
            .update(&existing.id, |session| {
                let before = session.clone();
                session.app_session_id = Some(app_session.id.clone());
                session.app_id = Some("claude".to_string());
                session.provider_session_id = Some(provider_session_id);
                session.title = Some(title);
                if let Some(cwd) = cwd.as_ref() {
                    session.cwd = Some(cwd.clone());
                }
                if let Some(transcript_path) = transcript_path.as_ref() {
                    session.transcript_path = Some(transcript_path.clone());
                }
                session.status = lifecycle.to_string();
                Ok(*session != before)
            })
            .map_err(persistence_error)?;
        changed += usize::from(updated != existing);
    }
    Ok(changed)
}

fn resolve_claude_transcript_path(
    provider_session_id: &str,
    cwd: Option<&str>,
    claude_home: Option<&Path>,
) -> Option<String> {
    claude_home
        .and_then(|claude_home| {
            find_claude_transcript_path_in(claude_home, provider_session_id, cwd)
        })
        .or_else(|| {
            claude_home
                .is_none()
                .then(|| find_claude_transcript_path(provider_session_id, cwd))
                .flatten()
        })
        .map(|path| path.display().to_string())
}

fn read_claude_runtime_sessions(claude_home: Option<&Path>) -> BTreeMap<u32, ClaudeRuntimeSession> {
    let mut by_pid = BTreeMap::new();
    let Some(claude_home) = claude_home else {
        return by_pid;
    };
    let Ok(entries) = fs::read_dir(claude_sessions_dir(claude_home)) else {
        return by_pid;
    };
    for entry in entries.flatten() {
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        let path = entry.path();
        if !file_type.is_file() || path.extension().and_then(|value| value.to_str()) != Some("json")
        {
            continue;
        }
        let Ok(text) = fs::read_to_string(&path) else {
            continue;
        };
        let Ok(value) = serde_json::from_str::<Value>(&text) else {
            continue;
        };
        let record = value.as_object();
        let file_pid = path
            .file_stem()
            .and_then(|value| value.to_str())
            .and_then(|value| value.trim().parse::<u32>().ok());
        let record_pid = record
            .and_then(|record| record.get("pid"))
            .and_then(json_pid)
            .filter(|pid| *pid > 0);
        let Some(pid) = record_pid.or(file_pid.filter(|pid| *pid > 0)) else {
            continue;
        };
        let Some(session_id) = record
            .and_then(|record| record.get("sessionId"))
            .and_then(Value::as_str)
            .map(|value| compact(value, 240))
            .filter(|value| !value.is_empty())
        else {
            continue;
        };
        let cwd = record
            .and_then(|record| record.get("cwd"))
            .and_then(Value::as_str)
            .map(|value| compact(value, 4096))
            .filter(|value| !value.is_empty());
        let status = record
            .and_then(|record| record.get("status"))
            .and_then(Value::as_str)
            .map(|value| compact(value, 80))
            .filter(|value| !value.is_empty());
        by_pid.insert(
            pid,
            ClaudeRuntimeSession {
                session_id,
                cwd,
                status,
            },
        );
    }
    by_pid
}

fn json_pid(value: &Value) -> Option<u32> {
    match value {
        Value::Number(value) => value
            .as_u64()
            .and_then(|value| u32::try_from(value).ok())
            .or_else(|| {
                value
                    .as_f64()
                    .filter(|value| value.is_finite() && *value >= 0.0 && value.fract() == 0.0)
                    .and_then(|value| u32::try_from(value as u64).ok())
            }),
        Value::String(value) => value.trim().parse().ok(),
        _ => None,
    }
}

fn claude_runtime_lifecycle(value: Option<&str>) -> &'static str {
    match value
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase()
        .as_str()
    {
        "" | "idle" | "stopped" | "exited" => "idle",
        "failed" => "failed",
        "active" | "busy" | "running" | "thinking" | "working" => "running",
        _ => "idle",
    }
}

pub(crate) fn apply_claude_subscribe_message(
    sessions: &AiSessionRuntime,
    short: &str,
    control_sock: &std::path::Path,
    message: &Value,
) -> Result<bool, ProviderError> {
    let record = message.get("record").and_then(Value::as_object);
    let mut changed = false;
    if let Some(record) = record {
        if let Ok(job) = serde_json::from_value::<ClaudeDaemonJob>(Value::Object(record.clone())) {
            if let Some((record_changed, _)) = upsert_claude_job(sessions, &job, None)? {
                changed |= record_changed;
            }
        }
    }

    let state = claude_subscribe_state(message, record);
    let Some(observed_state) = state.observed_state else {
        return Ok(changed);
    };
    let Some(existing) = find_claude_session(sessions, None, None, Some(short)) else {
        return Ok(changed);
    };
    let lifecycle = state
        .lifecycle_state
        .as_deref()
        .map(|state| claude_lifecycle(Some(state), false, existing.app_session_id.is_some()));
    let actions = claude_actions(
        lifecycle.map(ClaudeLifecycle::status),
        existing.app_session_id.is_some(),
    );
    let update = sessions
        .update(&existing.id, |session| {
            let before = session.clone();
            if let Some(lifecycle) = lifecycle {
                session.status = lifecycle.status().to_string();
                session.phase = lifecycle.phase().to_string();
            }
            session.actions = Some(actions.clone());
            let mut provider_meta = session
                .provider_meta
                .as_ref()
                .and_then(Value::as_object)
                .cloned()
                .unwrap_or_default();
            provider_meta.insert("short".to_string(), json!(short));
            provider_meta.insert(
                "controlSock".to_string(),
                json!(control_sock.display().to_string()),
            );
            provider_meta.insert("state".to_string(), json!(observed_state));
            if let Some(source) = state.source {
                provider_meta.insert("stateSource".to_string(), json!(source));
            }
            session.provider_meta = Some(Value::Object(provider_meta));
            Ok(*session != before)
        })
        .map_err(persistence_error)?;
    changed |= update != existing;
    Ok(changed)
}

fn reconcile_claude_sessions(
    sessions: &AiSessionRuntime,
    app_session_ids: &HashSet<String>,
    jobs: &[ClaudeDaemonJob],
    shorts: &BTreeSet<String>,
) -> Result<usize, ProviderError> {
    let provider_session_ids = jobs
        .iter()
        .filter_map(|job| compact_optional(job.session_id.as_deref(), 240))
        .collect::<HashSet<_>>();
    let mut changed = 0;
    for session in sessions.list() {
        if session.agent != "claude" {
            continue;
        }
        let short = session
            .provider_meta
            .as_ref()
            .and_then(Value::as_object)
            .and_then(|meta| meta.get("short"))
            .and_then(Value::as_str)
            .map(|value| compact(value, 80))
            .filter(|value| !value.is_empty());
        let has_identity = session.app_session_id.is_some()
            || session.provider_session_id.is_some()
            || short.is_some();
        if !has_identity {
            continue;
        }
        let present = session
            .app_session_id
            .as_deref()
            .is_some_and(|id| app_session_ids.contains(id))
            || session
                .provider_session_id
                .as_deref()
                .is_some_and(|id| provider_session_ids.contains(id))
            || short.as_deref().is_some_and(|short| shorts.contains(short));
        if present {
            continue;
        }
        if sessions
            .remove(&session.id)
            .map_err(persistence_error)?
            .is_some()
        {
            changed += 1;
        }
    }
    Ok(changed)
}

struct ClaudeSnapshot<'a> {
    app_session: Option<&'a AppSession>,
    app_id: &'a str,
    provider_session_id: Option<&'a str>,
    provider_meta: &'a Value,
    app_binding_keys: &'a [String],
    actions: &'a Value,
    title: &'a str,
    cwd: Option<&'a str>,
    transcript_path: Option<&'a str>,
    lifecycle: ClaudeLifecycle,
}

fn merge_claude_snapshot(session: &mut AiSession, snapshot: ClaudeSnapshot<'_>) -> bool {
    let before = session.clone();
    if let Some(app_session) = snapshot.app_session {
        session.app_session_id = Some(app_session.id.clone());
    }
    session.app_id = Some(snapshot.app_id.to_string());
    if let Some(provider_session_id) = snapshot.provider_session_id {
        session.provider_session_id = Some(provider_session_id.to_string());
    }
    session.provider_meta = Some(snapshot.provider_meta.clone());
    session.app_binding_keys = Some(snapshot.app_binding_keys.to_vec());
    session.actions = Some(snapshot.actions.clone());
    session.title = Some(snapshot.title.to_string());
    if let Some(cwd) = snapshot.cwd {
        session.cwd = Some(cwd.to_string());
    }
    if let Some(transcript_path) = snapshot.transcript_path {
        session.transcript_path = Some(transcript_path.to_string());
    }
    session.status = snapshot.lifecycle.status().to_string();
    session.phase = snapshot.lifecycle.phase().to_string();
    *session != before
}

fn find_claude_session(
    sessions: &AiSessionRuntime,
    provider_session_id: Option<&str>,
    app_session_id: Option<&str>,
    short: Option<&str>,
) -> Option<AiSession> {
    if let Some(provider_session_id) = provider_session_id {
        if let Some(session) = sessions.get_by_provider_session_id("claude", provider_session_id) {
            return Some(session);
        }
    }
    let listed = sessions.list();
    if let Some(app_session_id) = app_session_id {
        if let Some(session) = listed.iter().find(|session| {
            session.agent == "claude" && session.app_session_id.as_deref() == Some(app_session_id)
        }) {
            return Some(session.clone());
        }
    }
    short.and_then(|short| {
        listed.into_iter().find(|session| {
            session.agent == "claude"
                && session
                    .provider_meta
                    .as_ref()
                    .and_then(Value::as_object)
                    .and_then(|meta| meta.get("short"))
                    .and_then(Value::as_str)
                    .is_some_and(|known| known == short)
        })
    })
}

fn claude_job_from_app_session(app_session: &AppSession) -> ClaudeDaemonJob {
    ClaudeDaemonJob {
        short: app_claude_short(app_session),
        nonce: None,
        session_id: app_claude_string(Some(app_session), "providerSessionId")
            .map(ToString::to_string),
        pid: app_claude_pid(app_session),
        attempt: None,
        started_at: None,
        cwd: first_truthy_string([
            app_claude_string(Some(app_session), "cwd"),
            app_session.tty.as_ref().map(|tty| tty.cwd.as_str()),
            app_session
                .launch
                .as_ref()
                .and_then(|launch| launch.cwd.as_deref()),
        ])
        .map(ToString::to_string),
        backend: None,
        tempo: app_claude_string(Some(app_session), "tempo").map(ToString::to_string),
        state: app_claude_string(Some(app_session), "state").map(ToString::to_string),
        detail: None,
        intent: None,
        needs: None,
        cli_version: app_claude_string(Some(app_session), "cliVersion").map(ToString::to_string),
        source: app_claude_string(Some(app_session), "source").map(ToString::to_string),
    }
}

fn claude_provider_meta(
    job: &ClaudeDaemonJob,
    app_session: Option<&AppSession>,
    short: &str,
    control_sock: &std::path::Path,
) -> Value {
    let mut meta = Map::new();
    meta.insert("short".to_string(), json!(short));
    meta.insert(
        "controlSock".to_string(),
        json!(control_sock.display().to_string()),
    );
    if let Some(pid) = job
        .pid
        .filter(|pid| *pid != 0)
        .or_else(|| app_claude_pid_opt(app_session))
        .filter(|pid| *pid > 0)
    {
        meta.insert("pid".to_string(), json!(pid));
    }
    for (key, value) in [
        (
            "state",
            first_truthy_string([
                job.state.as_deref(),
                app_claude_string(app_session, "state"),
            ]),
        ),
        (
            "tempo",
            first_truthy_string([
                job.tempo.as_deref(),
                app_claude_string(app_session, "tempo"),
            ]),
        ),
        (
            "cliVersion",
            first_truthy_string([
                job.cli_version.as_deref(),
                app_claude_string(app_session, "cliVersion"),
            ]),
        ),
        (
            "source",
            first_truthy_string([
                job.source.as_deref(),
                app_claude_string(app_session, "source"),
            ]),
        ),
    ] {
        if let Some(value) = compact_optional(value, 80) {
            meta.insert(key.to_string(), json!(value));
        }
    }
    Value::Object(meta)
}

fn claude_app_binding_keys(app_session: Option<&AppSession>, short: &str) -> Vec<String> {
    let mut keys = Vec::new();
    if let Some(app_session_id) = app_session
        .map(|session| compact(&session.id, 120))
        .filter(|value| !value.is_empty())
    {
        keys.push(format!("app:{app_session_id}"));
    }
    keys.push(format!("claude-short:{short}"));
    keys
}

fn claude_lifecycle(
    value: Option<&str>,
    has_work_signal: bool,
    is_app_session: bool,
) -> ClaudeLifecycle {
    let normalized = value.unwrap_or_default().trim().to_ascii_lowercase();
    match normalized.as_str() {
        "" | "idle" | "blocked" | "stopped" | "exited" | "completed" | "done" => ClaudeLifecycle {
            running: false,
            waiting: false,
            failed: false,
        },
        "waiting" => ClaudeLifecycle {
            running: false,
            waiting: true,
            failed: false,
        },
        "failed" => ClaudeLifecycle {
            running: false,
            waiting: false,
            failed: true,
        },
        "active" | "busy" | "running" | "thinking" | "working"
            if is_app_session && !has_work_signal =>
        {
            ClaudeLifecycle {
                running: false,
                waiting: false,
                failed: false,
            }
        }
        "active" | "busy" | "running" | "thinking" | "working" => ClaudeLifecycle {
            running: true,
            waiting: false,
            failed: false,
        },
        _ => ClaudeLifecycle {
            running: false,
            waiting: false,
            failed: false,
        },
    }
}

fn claude_actions(status: Option<&str>, has_app_session: bool) -> Value {
    json!({
        "send": true,
        "interrupt": matches!(status, Some("running" | "waiting")),
        "approval": false,
        "rename": has_app_session,
    })
}

fn has_work_signal(job: &ClaudeDaemonJob) -> bool {
    compact_optional(job.detail.as_deref(), 500).is_some()
        || compact_optional(job.intent.as_deref(), 500).is_some()
        || job.needs.as_ref().is_some_and(value_has_text)
}

fn value_has_text(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::String(value) => !value.trim().is_empty(),
        Value::Array(values) => !values.is_empty(),
        Value::Object(values) => !values.is_empty(),
        _ => true,
    }
}

struct ClaudeSubscribeState<'a> {
    observed_state: Option<String>,
    lifecycle_state: Option<String>,
    source: Option<&'a str>,
}

fn claude_subscribe_state<'a>(
    message: &'a Value,
    record: Option<&'a Map<String, Value>>,
) -> ClaudeSubscribeState<'a> {
    let patch = message.get("patch").and_then(Value::as_object);
    let settled_outcome = (message
        .get("type")
        .and_then(Value::as_str)
        .map(|value| compact(value, 80))
        .as_deref()
        == Some("settled"))
    .then(|| compact_value(message.get("outcome")))
    .flatten();
    let candidates = [
        ("message.state", compact_value(message.get("state"))),
        (
            "patch.state",
            patch.and_then(|patch| compact_value(patch.get("state"))),
        ),
        (
            "record.state",
            record.and_then(|record| compact_value(record.get("state"))),
        ),
        ("settled.outcome", settled_outcome.clone()),
    ];
    let Some((source, observed_state)) = candidates
        .into_iter()
        .find_map(|(source, value)| value.map(|value| (source, value)))
    else {
        return ClaudeSubscribeState {
            observed_state: None,
            lifecycle_state: None,
            source: None,
        };
    };
    ClaudeSubscribeState {
        observed_state: Some(observed_state),
        lifecycle_state: settled_outcome,
        source: Some(source),
    }
}

fn app_claude_short(app_session: &AppSession) -> Option<String> {
    compact_optional(app_claude_string(Some(app_session), "short"), 80)
}

fn first_truthy_string<'a>(values: impl IntoIterator<Item = Option<&'a str>>) -> Option<&'a str> {
    values.into_iter().flatten().find(|value| !value.is_empty())
}

fn app_claude_string<'a>(app_session: Option<&'a AppSession>, key: &str) -> Option<&'a str> {
    app_session?.ai.as_ref()?.get("claude")?.get(key)?.as_str()
}

fn app_claude_pid(app_session: &AppSession) -> Option<u32> {
    app_claude_pid_opt(Some(app_session))
}

fn app_claude_pid_opt(app_session: Option<&AppSession>) -> Option<u32> {
    app_session?
        .ai
        .as_ref()?
        .get("claude")?
        .get("pid")?
        .as_u64()
        .and_then(|pid| u32::try_from(pid).ok())
        .filter(|pid| *pid > 0)
}

fn job_short(job: &ClaudeDaemonJob) -> Option<String> {
    compact_optional(job.short.as_deref(), 80)
}

fn compact_optional(value: Option<&str>, max: usize) -> Option<String> {
    value
        .map(|value| compact(value, max))
        .filter(|value| !value.is_empty())
}

fn compact_value(value: Option<&Value>) -> Option<String> {
    match value? {
        Value::String(value) => compact_optional(Some(value), 80),
        Value::Number(value) => Some(value.to_string()),
        Value::Bool(value) => Some(value.to_string()),
        Value::Array(values) if values.is_empty() => None,
        Value::Object(_) => Some("[object Object]".to_string()),
        Value::Null => None,
        value => Some(value.to_string()),
    }
}

fn compact(value: &str, max: usize) -> String {
    let text = value.split_whitespace().collect::<Vec<_>>().join(" ");
    if text.encode_utf16().count() <= max {
        return text;
    }
    let keep = max.saturating_sub(3);
    let mut units = 0;
    let mut truncated = String::new();
    for character in text.chars() {
        let width = character.len_utf16();
        if units + width > keep {
            break;
        }
        units += width;
        truncated.push(character);
    }
    truncated.push_str("...");
    truncated
}

fn persistence_error(error: controlled_instance_ai_session::AiSessionStoreError) -> ProviderError {
    ProviderError::new(
        "AI_SESSION_DISCOVERY_PERSIST_FAILED",
        error.to_string(),
        500,
    )
}

fn now_iso() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use controlled_instance_protocol::{
        AppLaunchOptions, AppSessionPaths, AppSessionProcess, AppSessionTty, AppSessionWorkspace,
    };

    fn app_session(short: &str) -> AppSession {
        AppSession {
            id: "aps_0000000000001".to_string(),
            app_id: "claude".to_string(),
            title: "Claude TUI".to_string(),
            kind: "tty".to_string(),
            status: "running".to_string(),
            created_at: now_iso(),
            updated_at: now_iso(),
            workspace: AppSessionWorkspace {
                cwd: "/workspace".to_string(),
            },
            launch: None,
            tty: None,
            display: None,
            vnc: None,
            web: None,
            automation: None,
            process: None,
            ai: Some(json!({
                "claude": {
                    "short": short,
                    "controlSock": "/tmp/claude-control.sock",
                    "cwd": "/workspace",
                    "state": "active"
                }
            })),
            paths: AppSessionPaths {
                session_dir: "/tmp/app".to_string(),
                log_dir: "/tmp/log".to_string(),
            },
            bindings: Vec::new(),
            extra: Default::default(),
        }
    }

    fn job(short: &str) -> ClaudeDaemonJob {
        ClaudeDaemonJob {
            short: Some(short.to_string()),
            session_id: Some("provider-session".to_string()),
            cwd: Some("/workspace".to_string()),
            state: Some("active".to_string()),
            detail: Some("working".to_string()),
            ..Default::default()
        }
    }

    fn claude_home(root: &Path) -> PathBuf {
        let home = root.join(".claude");
        std::fs::create_dir_all(home.join("sessions")).expect("sessions dir");
        home
    }

    fn write_runtime_session(home: &Path, name: &str, value: Value) {
        std::fs::write(
            home.join("sessions").join(name),
            serde_json::to_vec(&value).expect("runtime session"),
        )
        .expect("write runtime session");
    }

    fn write_transcript(home: &Path, cwd: &str, session_id: &str) -> PathBuf {
        let project = home.join("projects").join(cwd.replace(['\\', '/'], "-"));
        std::fs::create_dir_all(&project).expect("project dir");
        let transcript = project.join(format!("{session_id}.jsonl"));
        std::fs::write(&transcript, b"{}\n").expect("transcript");
        transcript
    }

    #[test]
    fn discovery_merges_app_and_daemon_jobs_and_tracks_subscriptions() {
        let sessions = AiSessionRuntime::new("test", None);
        let app = app_session("a1b2c3d4");
        let mut app_job = job("a1b2c3d4");
        app_job.detail = None;
        let mut daemon = job("b1c2d3e4");
        daemon.session_id = Some("daemon-session".to_string());
        let refresh =
            refresh_claude_sessions(&sessions, &[app_job, daemon], std::slice::from_ref(&app))
                .expect("refresh");
        assert_eq!(refresh.changed, 2);
        assert_eq!(refresh.subscriptions.len(), 2);
        assert_eq!(
            refresh.subscriptions["a1b2c3d4"],
            PathBuf::from("/tmp/claude-control.sock")
        );

        let app_bound = sessions
            .list()
            .into_iter()
            .find(|session| session.app_session_id.as_deref() == Some(app.id.as_str()))
            .expect("app session");
        assert_eq!(app_bound.status, "idle");
        assert_eq!(app_bound.title.as_deref(), Some("Claude TUI"));
        assert_eq!(
            app_bound.provider_session_id.as_deref(),
            Some("provider-session")
        );
        assert_eq!(
            app_bound
                .provider_meta
                .as_ref()
                .and_then(|meta| meta.get("short"))
                .and_then(Value::as_str),
            Some("a1b2c3d4")
        );
        assert_eq!(
            app_bound.app_binding_keys.as_deref(),
            Some(
                [
                    "app:aps_0000000000001".to_string(),
                    "claude-short:a1b2c3d4".to_string()
                ]
                .as_slice()
            )
        );
        assert_eq!(app_bound.actions.as_ref().unwrap()["rename"], true);

        let standalone = sessions
            .list()
            .into_iter()
            .find(|session| session.app_session_id.is_none())
            .expect("daemon session");
        assert_eq!(standalone.status, "running");
        assert_eq!(standalone.phase, "thinking");
        assert_eq!(standalone.app_id.as_deref(), Some("claude-daemon"));
        assert_eq!(standalone.title.as_deref(), Some("Claude"));
        assert_eq!(standalone.actions.as_ref().unwrap()["interrupt"], true);
    }

    #[test]
    fn discovery_removes_sessions_without_a_live_identity() {
        let sessions = AiSessionRuntime::new("test", None);
        let refresh =
            refresh_claude_sessions(&sessions, &[job("a1b2c3d4")], &[app_session("a1b2c3d4")])
                .expect("initial refresh");
        assert_eq!(refresh.changed, 1);
        let refresh = refresh_claude_sessions(&sessions, &[], &[]).expect("empty refresh");
        assert_eq!(refresh.changed, 1);
        assert!(sessions.list().is_empty());
    }

    #[test]
    fn runtime_pid_binding_creates_session_and_resolves_transcript() {
        let root = tempfile::tempdir().expect("tempdir");
        let home = claude_home(root.path());
        let sessions = AiSessionRuntime::new("test", None);
        write_runtime_session(
            &home,
            "4242.json",
            json!({
                "pid": 4242,
                "sessionId": "runtime-session",
                "cwd": "/workspace",
                "status": "active"
            }),
        );
        let transcript = write_transcript(&home, "/workspace", "runtime-session");
        let mut app = app_session("a1b2c3d4");
        app.ai = None;
        app.title = "Claude PID".to_string();
        app.process = Some(AppSessionProcess {
            pid: Some(4242),
            command: "claude".to_string(),
            exit_code: None,
            signal: None,
        });

        let refresh =
            refresh_claude_sessions_with_home(&sessions, &[], &[app], Some(home.as_path()))
                .expect("refresh");
        assert_eq!(refresh.changed, 1);
        assert!(refresh.subscriptions.is_empty());
        let session = sessions.list().into_iter().next().expect("session");
        assert_eq!(session.app_session_id.as_deref(), Some("aps_0000000000001"));
        assert_eq!(session.app_id.as_deref(), Some("claude"));
        assert_eq!(
            session.provider_session_id.as_deref(),
            Some("runtime-session")
        );
        assert_eq!(session.title.as_deref(), Some("Claude PID"));
        assert_eq!(session.cwd.as_deref(), Some("/workspace"));
        assert_eq!(session.status, "running");
        assert_eq!(session.phase, "unknown");
        assert_eq!(session.transcript_path.as_deref(), transcript.to_str());
        assert!(session.provider_meta.is_none());
        assert!(session.actions.is_none());
        assert!(session.app_binding_keys.is_none());
    }

    #[test]
    fn runtime_pid_binding_uses_filename_and_preserves_daemon_metadata() {
        let root = tempfile::tempdir().expect("tempdir");
        let home = claude_home(root.path());
        let sessions = AiSessionRuntime::new("test", None);
        write_runtime_session(
            &home,
            "4242.json",
            json!({
                "sessionId": "runtime-session",
                "cwd": "/workspace",
                "status": "failed"
            }),
        );
        let mut app = app_session("a1b2c3d4");
        app.process = Some(AppSessionProcess {
            pid: Some(4242),
            command: "claude".to_string(),
            exit_code: None,
            signal: None,
        });

        refresh_claude_sessions_with_home(
            &sessions,
            &[job("a1b2c3d4")],
            std::slice::from_ref(&app),
            Some(home.as_path()),
        )
        .expect("refresh");

        let session = sessions.list().into_iter().next().expect("session");
        assert_eq!(
            session.provider_session_id.as_deref(),
            Some("runtime-session")
        );
        assert_eq!(session.status, "failed");
        assert_eq!(session.provider_meta.as_ref().unwrap()["short"], "a1b2c3d4");
        assert_eq!(
            session.app_binding_keys.as_deref(),
            Some(
                [
                    "app:aps_0000000000001".to_string(),
                    "claude-short:a1b2c3d4".to_string()
                ]
                .as_slice()
            )
        );
        assert_eq!(session.actions.as_ref().unwrap()["interrupt"], true);
    }

    #[test]
    fn runtime_pid_binding_ignores_ineligible_apps_and_unknown_pids() {
        let root = tempfile::tempdir().expect("tempdir");
        let home = claude_home(root.path());
        let sessions = AiSessionRuntime::new("test", None);
        write_runtime_session(
            &home,
            "4242.json",
            json!({ "pid": 4242, "sessionId": "runtime-session", "status": "active" }),
        );
        let mut stopped = app_session("a1b2c3d4");
        stopped.ai = None;
        stopped.status = "exited".to_string();
        stopped.process = Some(AppSessionProcess {
            pid: Some(4242),
            command: "claude".to_string(),
            exit_code: Some(Some(0)),
            signal: None,
        });
        let mut unknown_pid = app_session("b1c2d3e4");
        unknown_pid.ai = None;
        unknown_pid.process = Some(AppSessionProcess {
            pid: Some(5151),
            command: "claude".to_string(),
            exit_code: None,
            signal: None,
        });

        let refresh = refresh_claude_sessions_with_home(
            &sessions,
            &[],
            &[stopped, unknown_pid],
            Some(home.as_path()),
        )
        .expect("refresh");
        assert_eq!(refresh.changed, 0);
        assert!(sessions.list().is_empty());
    }

    #[test]
    fn subscribe_messages_apply_settled_lifecycle_and_preserve_provider_metadata() {
        let sessions = AiSessionRuntime::new("test", None);
        refresh_claude_sessions(
            &sessions,
            &[],
            std::slice::from_ref(&app_session("a1b2c3d4")),
        )
        .expect("refresh");
        let changed = apply_claude_subscribe_message(
            &sessions,
            "a1b2c3d4",
            std::path::Path::new("/tmp/claude-control.sock"),
            &json!({ "type": "settled", "outcome": "waiting" }),
        )
        .expect("subscribe update");
        assert!(changed);
        let session = sessions.list().into_iter().next().expect("session");
        assert_eq!(session.status, "waiting");
        assert_eq!(session.phase, "unknown");
        assert_eq!(
            session.provider_meta.as_ref().unwrap()["stateSource"],
            "settled.outcome"
        );
        assert_eq!(session.provider_meta.as_ref().unwrap()["state"], "waiting");
        assert_eq!(
            session.provider_meta.as_ref().unwrap()["controlSock"],
            "/tmp/claude-control.sock"
        );
        assert_eq!(session.actions.as_ref().unwrap()["interrupt"], true);
    }

    #[test]
    fn duplicate_app_shorts_use_the_last_app_projection() {
        let sessions = AiSessionRuntime::new("test", None);
        let mut first = app_session("a1b2c3d4");
        first.id = "aps_0000000000001".to_string();
        first.title = "First".to_string();
        let mut second = app_session("a1b2c3d4");
        second.id = "aps_0000000000002".to_string();
        second.title = "Second".to_string();

        refresh_claude_sessions(&sessions, &[], &[first, second]).expect("refresh");
        let session = sessions.list().into_iter().next().expect("session");
        assert_eq!(session.title.as_deref(), Some("Second"));
        assert_eq!(session.app_session_id.as_deref(), Some("aps_0000000000002"));
    }

    #[test]
    fn whitespace_app_cwd_stops_the_tty_fallback_like_javascript_truthiness() {
        let sessions = AiSessionRuntime::new("test", None);
        let mut whitespace = app_session("a1b2c3d4");
        whitespace
            .ai
            .as_mut()
            .expect("ai")
            .as_object_mut()
            .expect("ai object")
            .get_mut("claude")
            .expect("claude")
            .as_object_mut()
            .expect("claude object")
            .insert("cwd".to_string(), json!("   "));
        whitespace.tty = Some(AppSessionTty {
            web_path: "/tty".to_string(),
            shell: "bash".to_string(),
            cwd: "/tty-cwd".to_string(),
            mode: None,
        });
        whitespace.launch = Some(AppLaunchOptions {
            title: None,
            args: Vec::new(),
            cwd: Some("/launch-cwd".to_string()),
            env: Default::default(),
            profile_id: None,
            display: None,
            display_target: None,
            ai_session_resume: None,
        });
        assert_eq!(
            claude_job_from_app_session(&whitespace).cwd.as_deref(),
            Some("   ")
        );

        refresh_claude_sessions(&sessions, &[], &[whitespace]).expect("refresh");
        let session = sessions.list().into_iter().next().expect("session");
        assert_eq!(session.cwd, None);

        let mut empty = app_session("b1c2d3e4");
        empty
            .ai
            .as_mut()
            .expect("ai")
            .as_object_mut()
            .expect("ai object")
            .get_mut("claude")
            .expect("claude")
            .as_object_mut()
            .expect("claude object")
            .insert("cwd".to_string(), json!(""));
        empty.id = "aps_0000000000002".to_string();
        empty.tty = Some(AppSessionTty {
            web_path: "/tty".to_string(),
            shell: "bash".to_string(),
            cwd: "/tty-cwd".to_string(),
            mode: None,
        });
        let empty_sessions = AiSessionRuntime::new("test", None);
        refresh_claude_sessions(&empty_sessions, &[], &[empty]).expect("empty refresh");
        let session = empty_sessions
            .list()
            .into_iter()
            .next()
            .expect("empty session");
        assert_eq!(session.cwd.as_deref(), Some("/tty-cwd"));
    }
}
