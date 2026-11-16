#![cfg(target_os = "windows")]
//! No desktop access: children wait for bootstrap for the whole test. These
//! exercise real kernel Jobs when run on an authorized Windows target.
use desktop_streaming::platform::windows_job::Job;
use std::{process::Stdio, time::Duration};

fn child() -> tokio::process::Child {
    tokio::process::Command::new(env!("CARGO_BIN_EXE_task-handoff-desktop-streaming"))
        .arg("--input-guard")
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .unwrap()
}

#[tokio::test]
async fn closing_job_terminates_assigned_child_before_it_can_bootstrap() {
    let job = Job::new(true).unwrap();
    let mut child = child();
    job.assign(&mut child).await.unwrap();
    assert!(child.try_wait().unwrap().is_none());
    drop(job);
    // Windows may report exit code 0 for a child terminated by
    // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE. Completion well before the guard's
    // five-second bootstrap timeout proves the job, not normal startup, ended it.
    let _status = tokio::time::timeout(Duration::from_secs(2), child.wait())
        .await
        .unwrap()
        .unwrap();
}

#[tokio::test]
async fn job_cleanup_does_not_terminate_unassigned_processes() {
    let job = Job::new(false).unwrap();
    let mut owned = child();
    let mut unrelated = child();
    job.assign(&mut owned).await.unwrap();
    drop(job);
    tokio::time::timeout(Duration::from_secs(2), owned.wait())
        .await
        .unwrap()
        .unwrap();
    assert!(unrelated.try_wait().unwrap().is_none());
    unrelated.kill().await.unwrap();
}
