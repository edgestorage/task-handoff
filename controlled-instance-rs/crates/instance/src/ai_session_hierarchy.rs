use serde_json::Value;
use std::collections::{HashMap, HashSet};

#[derive(Debug, Clone)]
pub struct AiSessionHierarchyRecord {
    pub id: String,
    pub agent: String,
    pub provider_session_id: Option<String>,
    pub lineage: Option<Value>,
    pub updated_at: String,
}

#[derive(Debug, Clone)]
pub struct AiSessionSubtree {
    pub postorder: Vec<String>,
    pub parent_by_id: HashMap<String, String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AiSessionRetentionCandidate {
    pub root_id: String,
    pub last_active_at: String,
}

pub fn derive_subtree(
    records: &[AiSessionHierarchyRecord],
    target_id: &str,
) -> Option<AiSessionSubtree> {
    if !records.iter().any(|record| record.id == target_id) {
        return None;
    }
    let parent_by_id = derive_parent_map(records);
    Some(AiSessionSubtree {
        postorder: derive_postorder(records, &parent_by_id, target_id),
        parent_by_id,
    })
}

pub fn derive_retention_candidates(
    records: &[AiSessionHierarchyRecord],
    status_by_id: &HashMap<String, String>,
    last_active_by_id: &HashMap<String, String>,
) -> Vec<AiSessionRetentionCandidate> {
    let parent_by_id = derive_parent_map(records);
    let by_id = records
        .iter()
        .map(|record| (record.id.as_str(), record))
        .collect::<HashMap<_, _>>();
    let roots = records
        .iter()
        .filter(|record| !parent_by_id.contains_key(&record.id));
    let mut candidates = roots
        .filter_map(|root| {
            if root
                .lineage
                .as_ref()
                .and_then(|lineage| lineage.get("kind"))
                .and_then(Value::as_str)
                == Some("subagent")
            {
                return None;
            }
            let session_ids = derive_postorder(records, &parent_by_id, &root.id);
            if !session_ids
                .iter()
                .all(|id| status_by_id.get(id).is_some_and(|status| status == "idle"))
            {
                return None;
            }
            let last_active_at = session_ids
                .iter()
                .filter_map(|id| {
                    last_active_by_id
                        .get(id)
                        .or_else(|| by_id.get(id.as_str()).map(|record| &record.updated_at))
                })
                .max_by(|left, right| timestamp_key(left).cmp(&timestamp_key(right)))?
                .clone();
            Some(AiSessionRetentionCandidate {
                root_id: root.id.clone(),
                last_active_at,
            })
        })
        .collect::<Vec<_>>();
    candidates.sort_by(|left, right| {
        timestamp_key(&left.last_active_at)
            .cmp(&timestamp_key(&right.last_active_at))
            .then_with(|| left.root_id.cmp(&right.root_id))
    });
    candidates
}

fn timestamp_key(value: &str) -> i64 {
    chrono::DateTime::parse_from_rfc3339(value)
        .map(|timestamp| timestamp.timestamp_millis())
        .unwrap_or(0)
}

fn derive_parent_map(records: &[AiSessionHierarchyRecord]) -> HashMap<String, String> {
    let mut by_identity = HashMap::new();
    for record in records {
        let Some(provider_session_id) = record
            .provider_session_id
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        else {
            continue;
        };
        by_identity
            .entry((record.agent.as_str(), provider_session_id))
            .or_insert(record.id.as_str());
    }

    let mut parent_by_id = HashMap::new();
    for record in records {
        if record
            .lineage
            .as_ref()
            .and_then(|lineage| lineage.get("kind"))
            .and_then(Value::as_str)
            != Some("subagent")
        {
            continue;
        }
        let Some(parent_provider_session_id) = record
            .lineage
            .as_ref()
            .and_then(|lineage| lineage.get("parentProviderSessionId"))
            .and_then(Value::as_str)
        else {
            continue;
        };
        let Some(parent_id) = by_identity
            .get(&(record.agent.as_str(), parent_provider_session_id))
            .copied()
        else {
            continue;
        };
        if parent_id != record.id {
            parent_by_id.insert(record.id.clone(), parent_id.to_string());
        }
    }

    let cycle_members = find_cycle_members(records, &parent_by_id);
    for session_id in cycle_members {
        parent_by_id.remove(&session_id);
    }

    parent_by_id
}

fn derive_postorder(
    records: &[AiSessionHierarchyRecord],
    parent_by_id: &HashMap<String, String>,
    target_id: &str,
) -> Vec<String> {
    let by_id = records
        .iter()
        .map(|record| (record.id.as_str(), record))
        .collect::<HashMap<_, _>>();
    let mut children_by_id: HashMap<String, Vec<String>> = HashMap::new();
    for (child_id, parent_id) in parent_by_id {
        children_by_id
            .entry(parent_id.clone())
            .or_default()
            .push(child_id.clone());
    }
    for children in children_by_id.values_mut() {
        children.sort_by(|left, right| {
            let left_updated = by_id.get(left.as_str()).map(|record| &record.updated_at);
            let right_updated = by_id.get(right.as_str()).map(|record| &record.updated_at);
            right_updated
                .cmp(&left_updated)
                .then_with(|| right.cmp(left))
        });
    }

    let mut postorder = Vec::new();
    let mut stack = vec![(target_id.to_string(), false)];
    while let Some((session_id, visited)) = stack.pop() {
        if visited {
            postorder.push(session_id);
            continue;
        }
        stack.push((session_id.clone(), true));
        if let Some(children) = children_by_id.get(&session_id) {
            for child in children {
                stack.push((child.clone(), false));
            }
        }
    }

    postorder
}

fn find_cycle_members(
    records: &[AiSessionHierarchyRecord],
    parent_by_id: &HashMap<String, String>,
) -> HashSet<String> {
    let mut complete = HashSet::new();
    let mut cycle_members = HashSet::new();
    for record in records {
        if complete.contains(&record.id) {
            continue;
        }
        let mut path = Vec::new();
        let mut position = HashMap::new();
        let mut current = Some(record.id.as_str());
        while let Some(session_id) = current {
            if complete.contains(session_id) {
                break;
            }
            if let Some(seen_at) = position.get(session_id).copied() {
                cycle_members.extend(path[seen_at..].iter().cloned());
                break;
            }
            position.insert(session_id, path.len());
            path.push(session_id.to_string());
            current = parent_by_id.get(session_id).map(String::as_str);
        }
        complete.extend(path);
    }
    cycle_members
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn record(
        id: &str,
        provider_session_id: &str,
        lineage: Option<Value>,
        updated_at: &str,
    ) -> AiSessionHierarchyRecord {
        AiSessionHierarchyRecord {
            id: id.to_string(),
            agent: "codex".to_string(),
            provider_session_id: Some(provider_session_id.to_string()),
            lineage,
            updated_at: updated_at.to_string(),
        }
    }

    fn subagent(parent: &str) -> Option<Value> {
        Some(json!({ "kind": "subagent", "parentProviderSessionId": parent }))
    }

    #[test]
    fn subtree_is_closed_children_first_and_ignores_forks() {
        let records = vec![
            record("ses_root", "thread-root", None, "2026-11-02T00:00:00.000Z"),
            record(
                "ses_child_old",
                "thread-child-old",
                subagent("thread-root"),
                "2026-11-02T00:01:00.000Z",
            ),
            record(
                "ses_child_new",
                "thread-child-new",
                subagent("thread-root"),
                "2026-11-02T00:02:00.000Z",
            ),
            record(
                "ses_grandchild",
                "thread-grandchild",
                subagent("thread-child-new"),
                "2026-11-02T00:03:00.000Z",
            ),
            record(
                "ses_fork",
                "thread-fork",
                Some(json!({
                    "kind": "fork",
                    "parentProviderSessionId": "thread-root"
                })),
                "2026-11-02T00:04:00.000Z",
            ),
        ];
        let subtree = derive_subtree(&records, "ses_root").expect("subtree");
        assert_eq!(
            subtree.postorder,
            vec![
                "ses_child_old",
                "ses_grandchild",
                "ses_child_new",
                "ses_root"
            ]
        );
        assert!(!subtree.postorder.contains(&"ses_fork".to_string()));
    }

    #[test]
    fn cycles_are_not_treated_as_parent_relationships() {
        let records = vec![
            record(
                "ses_a",
                "thread-a",
                subagent("thread-b"),
                "2026-11-02T00:00:00.000Z",
            ),
            record(
                "ses_b",
                "thread-b",
                subagent("thread-a"),
                "2026-11-02T00:01:00.000Z",
            ),
        ];
        let subtree = derive_subtree(&records, "ses_a").expect("subtree");
        assert_eq!(subtree.postorder, vec!["ses_a"]);
        assert!(subtree.parent_by_id.is_empty());
    }

    #[test]
    fn retention_requires_the_entire_root_subtree_to_be_idle() {
        let records = vec![
            record("ses_idle", "thread-idle", None, "2026-11-02T00:00:00.000Z"),
            record(
                "ses_child",
                "thread-child",
                subagent("thread-idle"),
                "2026-11-02T00:05:00.000Z",
            ),
            record("ses_busy", "thread-busy", None, "2026-11-02T00:02:00.000Z"),
            record(
                "ses_orphan_child",
                "thread-orphan",
                subagent("thread-missing"),
                "2026-11-02T00:03:00.000Z",
            ),
        ];
        let statuses = HashMap::from([
            ("ses_idle".to_string(), "idle".to_string()),
            ("ses_child".to_string(), "idle".to_string()),
            ("ses_busy".to_string(), "running".to_string()),
            ("ses_orphan_child".to_string(), "idle".to_string()),
        ]);
        let last_active = HashMap::from([
            (
                "ses_idle".to_string(),
                "2026-11-02T00:00:00.000Z".to_string(),
            ),
            (
                "ses_child".to_string(),
                "2026-11-02T00:05:00.000Z".to_string(),
            ),
            (
                "ses_busy".to_string(),
                "2026-11-02T00:02:00.000Z".to_string(),
            ),
            (
                "ses_orphan_child".to_string(),
                "2026-11-02T00:03:00.000Z".to_string(),
            ),
        ]);
        let candidates = derive_retention_candidates(&records, &statuses, &last_active);
        assert_eq!(
            candidates,
            vec![AiSessionRetentionCandidate {
                root_id: "ses_idle".to_string(),
                last_active_at: "2026-11-02T00:05:00.000Z".to_string(),
            }]
        );
    }

    #[test]
    fn retention_excludes_idle_roots_that_are_themselves_subagents() {
        let records = vec![record(
            "ses_subagent_root",
            "thread-subagent",
            subagent("thread-missing"),
            "2026-11-02T00:00:00.000Z",
        )];
        let statuses = HashMap::from([("ses_subagent_root".to_string(), "idle".to_string())]);
        assert!(derive_retention_candidates(&records, &statuses, &HashMap::new()).is_empty());
    }
}
