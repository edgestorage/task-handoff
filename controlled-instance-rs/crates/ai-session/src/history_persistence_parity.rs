use super::*;

fn fixture() -> Value {
    serde_json::from_str(include_str!(
        "../tests/fixtures/history-persistence-parity.json"
    ))
    .expect("Node history writer fixture")
}
fn read(path: &Path) -> Value {
    serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap()
}
fn parsed(value: &Value) -> AiSessionHistoryItem {
    serde_json::from_value(value.clone()).expect("item")
}
fn obstruct<T>(path: &Path, run: impl FnOnce() -> T) -> T {
    let before = std::fs::read(path).unwrap();
    let backup = path.with_extension("json.before");
    std::fs::rename(path, &backup).unwrap();
    std::fs::create_dir(path).unwrap();
    let result = run();
    std::fs::remove_dir(path).unwrap();
    std::fs::rename(backup, path).unwrap();
    assert_eq!(std::fs::read(path).unwrap(), before);
    result
}
fn capture(root: &Path, input: &Value) -> Value {
    let owner = AiSessionHistoryStore::new(root, Some(50));
    let old_id = input["old"]["id"].as_str().unwrap();
    let new_id = input["new"]["id"].as_str().unwrap();
    let items = owner.list(None);
    let old_detail = owner.detail(old_id);
    let new_detail = owner.detail(new_id);
    let old_path = owner.detail_path(old_id);
    let new_path = owner.detail_path(new_id);
    let mut files = std::fs::read_dir(owner.directory.join("details"))
        .unwrap()
        .map(|entry| entry.unwrap().file_name().to_str().unwrap().to_string())
        .collect::<Vec<_>>();
    files.sort();
    json!({"items":items,"oldDetail":old_detail,"newDetail":new_detail,
        "index":read(&owner.directory.join("index.json")),
        "oldBody":old_path.exists().then(|| read(&old_path)),
        "newBody":new_path.exists().then(|| read(&new_path)),
        "detailFiles":files,"removed":[]})
}
fn observe(name: &str) -> Value {
    if name == "C06" {
        return json!({
            "after-commit": observe("C06-after-commit"),
            "detail-after-commit": observe("C06-detail-after-commit"),
            "rollback-failure": observe("C06-rollback-failure"),
            "unverifiable": observe("C06-unverifiable"),
        });
    }
    let input = fixture()["input"].clone();
    let root = tempfile::tempdir().unwrap();
    let owner = AiSessionHistoryStore::new(root.path(), Some(50));
    let index = owner.directory.join("index.json");
    let old_path = owner.detail_path(input["old"]["id"].as_str().unwrap());
    let new_path = owner.detail_path(input["new"]["id"].as_str().unwrap());
    std::fs::create_dir_all(old_path.parent().unwrap()).unwrap();
    std::fs::write(&index, serde_json::to_vec(&input["n1Index"]).unwrap()).unwrap();
    std::fs::write(&old_path, serde_json::to_vec(&input["n1Detail"]).unwrap()).unwrap();
    if name == "C01" {
        owner
            .upsert(
                parsed(&input["updated"]),
                input["updatedTurns"].as_array().unwrap(),
            )
            .unwrap();
        owner
            .upsert(parsed(&input["new"]), input["newTurns"].as_array().unwrap())
            .unwrap();
        drop(owner);
        return capture(root.path(), &input);
    }
    if name == "C02" {
        let mut extended_index = input["n1Index"].clone();
        extended_index["futureIndex"] = json!(true);
        extended_index["items"][0]["futureItem"] = json!(true);
        let mut extended_body = input["n1Detail"].clone();
        extended_body["futureBody"] = json!(true);
        extended_body["turns"][0]["futureTurn"] = json!(true);
        extended_body["turns"]
            .as_array_mut()
            .unwrap()
            .push(json!({"broken":true}));
        std::fs::write(index, serde_json::to_vec(&extended_index).unwrap()).unwrap();
        std::fs::write(old_path, serde_json::to_vec(&extended_body).unwrap()).unwrap();
        drop(owner);
        let observed = capture(root.path(), &input);
        assert_eq!(observed["index"], input["n1Index"]);
        assert_eq!(observed["oldBody"], input["n1Detail"]);
        return json!({"observed":observed,"reopened":capture(root.path(), &input)});
    }
    let index_before = std::fs::read(&index).unwrap();
    let detail_before = std::fs::read(&old_path).unwrap();
    let is_new = name == "C05";
    let item = parsed(&input[if is_new { "new" } else { "updated" }]);
    let turns = input[if is_new { "newTurns" } else { "updatedTurns" }]
        .as_array()
        .unwrap();
    let failure = if name == "C03" {
        let mut attempted = false;
        let result = owner.upsert_with_writers(
            item,
            turns,
            |item, turns| {
                attempted = true;
                obstruct(&old_path, || owner.write_detail(item, turns))
            },
            |items| owner.write_index(items),
        );
        assert!(attempted, "C03 must reach the actual detail writer");
        result
    } else {
        assert!(name == "C04" || name == "C05" || name.starts_with("C06-"));
        let mut attempted = false;
        let mut detail_attempted = false;
        // The seam is exactly the production index commit call. list() still
        // sees the original index; the real atomic writer gets a directory.
        let result = owner.upsert_with_writers(
            item,
            turns,
            |item, turns| {
                detail_attempted = true;
                owner.write_detail(item, turns)?;
                if name == "C06-detail-after-commit" {
                    return Err(std::io::Error::other("post-detail-commit failure signal").into());
                }
                Ok(())
            },
            |items| {
                attempted = true;
                if name == "C06-after-commit" {
                    owner.write_index(items)?;
                    // Real replacement followed by a reported error signal;
                    // models the post-rename fsync boundary, not an actual fsync fault.
                    return Err(std::io::Error::other("post-commit failure signal").into());
                }
                let result = obstruct(&index, || owner.write_index(items));
                if name == "C06-rollback-failure" {
                    std::fs::rename(&old_path, old_path.with_extension("json.pending")).unwrap();
                    std::fs::create_dir(&old_path).unwrap();
                } else if name == "C06-unverifiable" {
                    std::fs::rename(&index, index.with_extension("json.unverified")).unwrap();
                    std::fs::create_dir(&index).unwrap();
                }
                result
            },
        );
        assert_eq!(attempted, name != "C06-detail-after-commit");
        assert!(detail_attempted);
        result
    };
    if name == "C06-rollback-failure" {
        let Err(AiSessionHistoryError::Rollback { commit, rollback }) = failure else {
            panic!("both commit and rollback failures must be exposed");
        };
        assert!(matches!(*commit, AiSessionHistoryError::Io(_)));
        assert!(rollback.raw_os_error().is_some());
    } else {
        assert!(matches!(failure, Err(AiSessionHistoryError::Io(_))));
    }
    if name.starts_with("C06-") {
        if name == "C06-rollback-failure" {
            std::fs::remove_dir(&old_path).unwrap();
            std::fs::rename(old_path.with_extension("json.pending"), &old_path).unwrap();
        } else if name == "C06-unverifiable" {
            std::fs::remove_dir(&index).unwrap();
            std::fs::rename(index.with_extension("json.unverified"), &index).unwrap();
        }
        drop(owner);
        let after_failure = capture(root.path(), &input);
        assert_eq!(
            after_failure["oldBody"]["turns"],
            input[if name == "C06-detail-after-commit" {
                "oldTurns"
            } else {
                "updatedTurns"
            }]
        );
        let retry = AiSessionHistoryStore::new(root.path(), Some(50));
        retry.upsert(parsed(&input["updated"]), turns).unwrap();
        drop(retry);
        return json!({"failed":true,"indexCommitted":name=="C06-after-commit",
            "rollbackFailed":name=="C06-rollback-failure","unverified":name=="C06-unverifiable",
            "afterFailure":after_failure,"afterRetry":capture(root.path(), &input)});
    }
    assert_eq!(std::fs::read(&index).unwrap(), index_before);
    drop(owner);
    let after_failure = capture(root.path(), &input);
    assert_eq!(
        std::fs::read(old_path).unwrap(),
        detail_before,
        "failed upsert must preserve previous body bytes"
    );
    assert!(
        !new_path.exists(),
        "failed first insert must not leave an orphan body"
    );
    let retry = AiSessionHistoryStore::new(root.path(), Some(50));
    retry
        .upsert(
            parsed(&input[if is_new { "new" } else { "updated" }]),
            turns,
        )
        .unwrap();
    drop(retry);
    json!({"failed":true,"afterFailure":after_failure,"afterRetry":capture(root.path(), &input)})
}
macro_rules! case {
    ($test:ident, $name:literal) => {
        #[test]
        fn $test() {
            let actual = observe($name);
            assert_eq!(actual, fixture()["expected"][$name]);
        }
    };
}
case!(c01_history_write_and_reopen_matches_node, "C01");
case!(c02_n1_history_sanitize_and_rewrite_matches_node, "C02");
case!(
    c03_detail_atomic_failure_preserves_index_and_body_matches_node,
    "C03"
);
case!(c04_index_failure_restores_previous_body_matches_node, "C04");
case!(c05_index_failure_removes_orphan_body_matches_node, "C05");
case!(
    c06_postcommit_and_secondary_io_failures_preserve_data_and_retry,
    "C06"
);
