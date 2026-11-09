use desktop_streaming::{
    channel::{Input, Key},
    input_driver::map_point,
    input_guard::{Backend, Client, Command, Event},
    traits::Geometry,
};
use std::{
    path::Path,
    time::{Duration, Instant},
};
fn binary() -> &'static Path {
    Path::new(env!("CARGO_BIN_EXE_task-handoff-desktop-streaming"))
}
fn key(epoch: u64, down: bool) -> Command {
    Command::Input {
        event: Input::Key(Key {
            input_epoch: epoch,
            code: "KeyA".into(),
            down,
            modifiers: 0,
            repeat: false,
        }),
    }
}
#[tokio::test]
async fn independent_watchdog_expires_without_parent_work_and_never_reopens_old_epoch() {
    let mut guard = Client::spawn(binary(), Backend::Synthetic).await.unwrap();
    assert!(matches!(
        guard.call(&Command::Arm { epoch: 1 }).await.unwrap(),
        Event::State { epoch: Some(1), .. }
    ));
    assert!(matches!(
        guard.call(&key(1, true)).await.unwrap(),
        Event::State { pressed: 1, .. }
    ));
    // The host does no deadline driving: all timing and release live in the child.
    tokio::time::sleep(Duration::from_millis(1550)).await;
    assert!(matches!(
        guard.call(&Command::Probe).await.unwrap(),
        Event::State {
            epoch: None,
            pressed: 0,
            ..
        }
    ));
    assert!(matches!(
        guard.call(&Command::Alive { epoch: 1 }).await.unwrap(),
        Event::Rejected
    ));
    assert!(matches!(
        guard.call(&key(1, true)).await.unwrap(),
        Event::Rejected
    ));
    assert!(matches!(
        guard.call(&Command::Arm { epoch: 1 }).await.unwrap(),
        Event::Rejected
    ));
    assert!(matches!(
        guard.call(&Command::Arm { epoch: 2 }).await.unwrap(),
        Event::State {
            epoch: Some(2),
            pressed: 0,
            ..
        }
    ));
    guard.close().await.unwrap();
}
#[tokio::test]
async fn suspend_ack_follows_release_and_pipe_eof_terminates_guard() {
    let mut guard = Client::spawn(binary(), Backend::Synthetic).await.unwrap();
    guard.call(&Command::Arm { epoch: 1 }).await.unwrap();
    guard.call(&key(1, true)).await.unwrap();
    assert!(matches!(
        guard.call(&Command::Suspend).await.unwrap(),
        Event::Released
    ));
    assert!(matches!(
        guard.call(&Command::Probe).await.unwrap(),
        Event::State {
            epoch: None,
            pressed: 0,
            ..
        }
    ));
    guard.call(&Command::Arm { epoch: 2 }).await.unwrap();
    guard.call(&key(2, true)).await.unwrap();
    let closed = Instant::now();
    guard.close_pipe();
    tokio::time::timeout(Duration::from_secs(2), guard.child.wait())
        .await
        .unwrap()
        .unwrap();
    assert!(closed.elapsed() < Duration::from_secs(2));
}
#[test]
fn retina_and_dpi_mapping_use_authoritative_actuator_geometry() {
    for scale in [1.0, 1.25, 1.5, 2.0] {
        let geometry = Geometry {
            x: -1440,
            y: 100,
            width: 1440,
            height: 900,
            scale,
        };
        assert_eq!(map_point(geometry, 0.0, 0.0).unwrap(), (-1440, 100));
        assert_eq!(map_point(geometry, 1.0, 1.0).unwrap(), (-1, 999));
        assert_eq!(map_point(geometry, 0.5, 0.5).unwrap(), (-721, 550));
        assert!(map_point(geometry, f64::NAN, 0.0).is_err());
        assert!(map_point(geometry, 1.1, 0.0).is_err());
    }
}

#[test]
fn native_rectangles_reject_saturating_casts_and_preserve_negative_origins() {
    let g = Geometry::from_actuator_rect(-1440.0, 100.0, 1440.0, 900.0).unwrap();
    assert_eq!(map_point(g, 1.0, 1.0).unwrap(), (-1, 999));
    for (x, y, w, h) in [
        (f64::NAN, 0.0, 100.0, 100.0),
        (0.0, f64::INFINITY, 100.0, 100.0),
        (0.0, 0.0, 0.0, 100.0),
        (0.0, 0.0, -1.0, 100.0),
        (0.0, 0.0, f64::INFINITY, 100.0),
        (i32::MAX as f64, 0.0, 2.0, 100.0),
        (i32::MIN as f64 - 1.0, 0.0, 100.0, 100.0),
    ] {
        assert!(Geometry::from_actuator_rect(x, y, w, h).is_err());
    }
}

#[tokio::test]
async fn native_construction_failure_preserves_typed_code_without_opening_a_desktop() {
    let error = match Client::spawn(
        binary(),
        Backend::Native {
            geometry: Geometry {
                x: 0,
                y: 0,
                width: 0,
                height: 0,
                scale: 1.0,
            },
            display: None,
            authority: None,
        },
    )
    .await
    {
        Ok(_) => panic!("invalid native geometry accepted"),
        Err(error) => error,
    };
    assert_eq!(
        error.downcast_ref::<desktop_streaming::error::BackendError>(),
        Some(&desktop_streaming::error::BackendError::InvalidGeometry)
    );
}

#[tokio::test]
async fn unexpected_guard_exit_has_a_typed_failure_and_never_acknowledges_new_input() {
    let mut guard = Client::spawn(binary(), Backend::Synthetic).await.unwrap();
    guard.call(&Command::Arm { epoch: 1 }).await.unwrap();
    guard.child.kill().await.unwrap();
    let error = match guard.call(&key(1, true)).await {
        Ok(_) => panic!("dead guard acknowledged input"),
        Err(error) => error,
    };
    assert_eq!(
        error.downcast_ref::<desktop_streaming::error::BackendError>(),
        Some(&desktop_streaming::error::BackendError::InputGuardFailed)
    );
    assert_eq!(
        guard.exited_cause().await,
        desktop_streaming::error::BackendError::InputGuardFailed
    );
}
