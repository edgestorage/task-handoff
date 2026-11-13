use desktop_streaming::session::*;
use std::time::{Duration, Instant};
fn owner() -> Owner {
    Owner {
        actor_id: "actor".into(),
        device_session_id: "device".into(),
    }
}
fn display() -> CaptureSelection {
    CaptureSelection {
        source_ref: "display".into(),
        stream_region: None,
        control_region: None,
    }
}
fn window(source_ref: &str) -> CaptureSelection {
    CaptureSelection {
        source_ref: source_ref.into(),
        stream_region: None,
        control_region: None,
    }
}
fn active(r: &mut Registry, now: Instant) -> Snapshot {
    let (s, t) = r.reserve("create", owner(), display(), now).unwrap();
    r.attach(&s.viewer_session_id, &owner(), &display(), &t, now)
        .unwrap();
    r.connected(&s.viewer_session_id, now).unwrap();
    r.snapshot(&s.viewer_session_id, &owner()).unwrap()
}
fn active_viewer(r: &mut Registry, request: &str, now: Instant) -> Snapshot {
    let (snapshot, token) = r.reserve(request, owner(), display(), now).unwrap();
    r.attach(
        &snapshot.viewer_session_id,
        &owner(),
        &display(),
        &token,
        now,
    )
    .unwrap();
    r.connected(&snapshot.viewer_session_id, now).unwrap();
    r.snapshot(&snapshot.viewer_session_id, &owner()).unwrap()
}
#[test]
fn reserve_is_idempotent_allows_four_viewers_and_rejects_the_fifth() {
    let mut r = Registry::new();
    let now = Instant::now();
    let (s, t) = r.reserve("one", owner(), display(), now).unwrap();
    let (retry, t2) = r.reserve("one", owner(), display(), now).unwrap();
    assert_eq!(s.viewer_session_id, retry.viewer_session_id);
    assert_eq!(t, t2);
    for index in 2..=MAX_VIEWERS {
        assert!(r
            .reserve(&format!("viewer-{index}"), owner(), display(), now,)
            .is_ok());
    }
    assert_eq!(
        r.reserve("viewer-5", owner(), display(), now).unwrap_err(),
        Error::Busy
    );
    assert_eq!(
        r.attach(&s.viewer_session_id, &owner(), &display(), "bad", now)
            .unwrap_err(),
        Error::InvalidAttach
    );
    assert_eq!(
        r.attach(&s.viewer_session_id, &owner(), &window("other"), &t, now)
            .unwrap_err(),
        Error::InvalidAttach
    );
    r.attach(&s.viewer_session_id, &owner(), &display(), &t, now)
        .unwrap();
    assert_eq!(
        r.attach(&s.viewer_session_id, &owner(), &display(), &t, now)
            .unwrap_err(),
        Error::InvalidAttach
    );
    assert_eq!(
        r.reserve("one", owner(), display(), now).unwrap_err(),
        Error::RequestConflict
    );
}
#[test]
fn owner_device_isolation_and_late_callbacks_cannot_stop_new_session() {
    let now = Instant::now();
    let mut r = Registry::new();
    let s = active(&mut r, now);
    let other = Owner {
        device_session_id: "another-device".into(),
        ..owner()
    };
    assert_eq!(
        r.stop(&s.viewer_session_id, &other, now).unwrap_err(),
        Error::Forbidden
    );
    assert_eq!(
        r.snapshot(&s.viewer_session_id, &other).unwrap_err(),
        Error::Forbidden
    );
    assert!(
        r.stop(&s.viewer_session_id, &owner(), now)
            .unwrap()
            .close_peer
    );
    r.drained(&s.viewer_session_id).unwrap();
    let (new, _) = r.reserve("new", owner(), display(), now).unwrap();
    assert_eq!(
        r.drained(&s.viewer_session_id).unwrap_err(),
        Error::NotFound
    );
    assert_eq!(
        r.snapshot(&new.viewer_session_id, &owner()).unwrap().phase,
        Phase::Starting
    );
}
#[test]
fn lost_reservation_and_unfinished_negotiation_release_slot_after_bounded_drain() {
    for attach in [false, true] {
        let now = Instant::now();
        let mut r = Registry::new();
        let (s, t) = r.reserve("one", owner(), display(), now).unwrap();
        if attach {
            r.attach(&s.viewer_session_id, &owner(), &display(), &t, now)
                .unwrap();
        }
        for index in 2..=MAX_VIEWERS {
            r.reserve(&format!("viewer-{index}"), owner(), display(), now)
                .unwrap();
        }
        let deadline = now + if attach { SIGNAL_LIVENESS } else { STARTING };
        assert!(r
            .tick(deadline)
            .iter()
            .any(|(_, effects)| effects.close_peer));
        assert_eq!(
            r.snapshot(&s.viewer_session_id, &owner()).unwrap().phase,
            Phase::Draining
        );
        // Draining sessions no longer hold a viewer slot. For a lost reservation,
        // all four Starting sessions expire together, while an unfinished
        // negotiation leaves the other three slots live.
        r.reserve("replacement", owner(), display(), deadline)
            .unwrap();
        let blocked = r.reserve("blocked", owner(), display(), deadline);
        if attach {
            assert_eq!(blocked.unwrap_err(), Error::Busy);
        } else {
            assert!(blocked.is_ok());
        }
        r.tick(deadline + DRAINING);
        assert_eq!(
            r.snapshot(&s.viewer_session_id, &owner()).unwrap().phase,
            Phase::Failed
        );
        let after_drain = r.reserve("after-drain", owner(), display(), deadline + DRAINING);
        if attach {
            assert_eq!(after_drain.unwrap_err(), Error::Busy);
        } else {
            assert!(after_drain.is_ok());
        }
    }
}

#[test]
fn expired_reservations_do_not_consume_viewer_slots_before_tick() {
    let now = Instant::now();
    let mut r = Registry::new();
    for index in 1..=MAX_VIEWERS {
        r.reserve(&format!("viewer-{index}"), owner(), display(), now)
            .unwrap();
    }
    assert_eq!(
        r.reserve(
            "still-full",
            owner(),
            display(),
            now + STARTING - Duration::from_millis(1),
        )
        .unwrap_err(),
        Error::Busy
    );
    assert!(r
        .reserve("after-expiry", owner(), display(), now + STARTING)
        .is_ok());
}

#[test]
fn draining_sessions_are_not_reported_as_viewers() {
    let now = Instant::now();
    let mut r = Registry::new();
    let first = active(&mut r, now);
    let second = active_viewer(&mut r, "second", now);
    assert_eq!(
        r.snapshot(&first.viewer_session_id, &owner())
            .unwrap()
            .viewer_count,
        2
    );
    r.stop(&second.viewer_session_id, &owner(), now).unwrap();
    assert_eq!(
        r.snapshot(&first.viewer_session_id, &owner())
            .unwrap()
            .viewer_count,
        1
    );
}
#[test]
fn negotiating_deadline_is_not_extended_by_healthy_signaling() {
    let now = Instant::now();
    let mut r = Registry::new();
    let (s, t) = r.reserve("one", owner(), display(), now).unwrap();
    r.attach(&s.viewer_session_id, &owner(), &display(), &t, now)
        .unwrap();
    for second in [2, 4, 6, 8, 10, 12, 14, 16, 18] {
        r.signal_alive(&s.viewer_session_id, now + Duration::from_secs(second))
            .unwrap();
    }
    assert!(r
        .tick(now + NEGOTIATING)
        .iter()
        .any(|(_, effects)| effects.close_peer));
    assert!(r
        .connected(&s.viewer_session_id, now + NEGOTIATING)
        .is_err());
}
#[test]
fn input_heartbeat_freeze_and_cross_channel_old_epoch_never_rebuild_pressed_state() {
    let now = Instant::now();
    let mut r = Registry::new();
    let s = active(&mut r, now);
    let id = &s.viewer_session_id;
    let first = r.resume_input(id, now).unwrap();
    assert!(r.check_epoch(id, first, now).is_ok());
    r.input_alive(id, first, now + Duration::from_millis(500))
        .unwrap();
    assert!(!r
        .tick(now + Duration::from_millis(1999))
        .iter()
        .any(|(_, effects)| effects.release_input));
    assert!(r
        .tick(now + Duration::from_millis(2000))
        .iter()
        .any(|(_, effects)| effects.release_input));
    assert_eq!(
        r.check_epoch(id, first, now + Duration::from_millis(2000)),
        Err(Error::StaleEpoch)
    );
    let second = r
        .resume_input(id, now + Duration::from_millis(2000))
        .unwrap();
    assert!(second > first);
    assert_eq!(
        r.check_epoch(id, first, now + Duration::from_millis(2001)),
        Err(Error::StaleEpoch)
    );
    assert!(r.suspend_input(id).unwrap().release_input);
    assert_eq!(
        r.input_alive(id, second, now + Duration::from_millis(2100)),
        Err(Error::StaleEpoch)
    );
}

#[test]
fn repeated_resume_returns_the_live_epoch_and_starts_a_new_lease_after_expiry() {
    let now = Instant::now();
    let mut r = Registry::new();
    let snapshot = active(&mut r, now);
    let id = &snapshot.viewer_session_id;
    let epoch = r.resume_input(id, now).unwrap();
    assert_eq!(r.live_input_epoch(id, now), Some(epoch));
    assert_eq!(r.live_input_epoch(id, now + INPUT_LIVENESS), None);
}

#[test]
fn hidden_pauses_media_visible_requests_idr_but_does_not_resume_input() {
    let now = Instant::now();
    let mut r = Registry::new();
    let s = active(&mut r, now);
    let id = &s.viewer_session_id;
    let epoch = r.resume_input(id, now).unwrap();
    let hidden = r.visibility(id, true, now).unwrap();
    assert!(hidden.release_input);
    assert!(!hidden.request_idr);
    let snapshot = r.snapshot(id, &owner()).unwrap();
    assert!(snapshot.media_paused);
    assert!(snapshot.idle_expires_at.is_some());
    r.visibility(id, true, now + Duration::from_secs(2))
        .unwrap();
    assert_eq!(
        snapshot.idle_expires_at,
        r.snapshot(id, &owner()).unwrap().idle_expires_at
    );
    assert!(r.resume_input(id, now).is_err());
    assert!(r.visibility(id, false, now).unwrap().request_idr);
    let snapshot = r.snapshot(id, &owner()).unwrap();
    assert!(!snapshot.media_paused);
    assert_eq!(snapshot.input_epoch, None);
    assert_eq!(snapshot.idle_expires_at, None);
    assert_eq!(r.check_epoch(id, epoch, now), Err(Error::StaleEpoch));
}
#[test]
fn hidden_and_absolute_deadlines_cannot_be_extended_by_signal_heartbeats() {
    for hidden in [false, true] {
        let now = Instant::now();
        let mut r = Registry::new();
        let s = active(&mut r, now);
        let id = &s.viewer_session_id;
        if hidden {
            r.visibility(id, true, now).unwrap();
        }
        let end = if hidden { HIDDEN } else { MAX_SESSION };
        let mut t = Duration::from_secs(2);
        while t < end {
            r.signal_alive(id, now + t).unwrap();
            t += Duration::from_secs(2);
        }
        assert!(r
            .tick(now + end)
            .iter()
            .any(|(_, effects)| effects.close_peer));
        assert_eq!(r.snapshot(id, &owner()).unwrap().phase, Phase::Draining);
    }
}
#[test]
fn ice_recovery_has_fixed_deadline_and_always_requires_new_input_epoch() {
    let now = Instant::now();
    let mut r = Registry::new();
    let s = active(&mut r, now);
    let id = &s.viewer_session_id;
    r.resume_input(id, now).unwrap();
    assert!(r.ice_disconnected(id, now).unwrap().release_input);
    assert!(r.resume_input(id, now).is_err());
    r.ice_disconnected(id, now + Duration::from_secs(2))
        .unwrap();
    for second in [2, 4, 6, 8, 10, 12, 14] {
        r.signal_alive(id, now + Duration::from_secs(second))
            .unwrap();
    }
    assert!(r
        .tick(now + ICE_RECOVERY)
        .iter()
        .any(|(_, effects)| effects.close_peer));
    assert!(r.ice_recovered(id, now + ICE_RECOVERY).is_err());
}
#[test]
fn transport_generation_advances_only_for_a_verified_restart_recovery() {
    let now = Instant::now();
    let mut r = Registry::new();
    let s = active(&mut r, now);
    let id = &s.viewer_session_id;
    assert_eq!(r.snapshot(id, &owner()).unwrap().transport_generation, 0);
    r.ice_disconnected(id, now).unwrap();
    r.ice_recovered(id, now + Duration::from_secs(1)).unwrap();
    assert_eq!(r.snapshot(id, &owner()).unwrap().transport_generation, 0);
    r.ice_disconnected(id, now + Duration::from_secs(2))
        .unwrap();
    r.transport_recovered(id, now + Duration::from_secs(3))
        .unwrap();
    assert_eq!(r.snapshot(id, &owner()).unwrap().transport_generation, 1);
}
#[test]
fn restarting_component_invalidates_all_previous_identifiers() {
    let now = Instant::now();
    let mut old = Registry::new();
    let (s, t) = old.reserve("one", owner(), display(), now).unwrap();
    let mut new = Registry::new();
    assert_ne!(old.boot_id(), new.boot_id());
    assert_eq!(
        new.attach(&s.viewer_session_id, &owner(), &display(), &t, now)
            .unwrap_err(),
        Error::NotFound
    );
}

#[test]
fn consumed_create_request_cannot_be_replayed_after_another_session() {
    let now = Instant::now();
    let mut r = Registry::new();
    let first = active(&mut r, now);
    r.stop(&first.viewer_session_id, &owner(), now).unwrap();
    r.drained(&first.viewer_session_id).unwrap();
    let (second, _) = r.reserve("second", owner(), display(), now).unwrap();
    r.stop(&second.viewer_session_id, &owner(), now).unwrap();
    r.drained(&second.viewer_session_id).unwrap();
    assert_eq!(
        r.reserve("create", owner(), display(), now).unwrap_err(),
        Error::RequestConflict
    );
}
#[test]
fn delayed_signaling_or_resume_does_not_resurrect_expired_session() {
    let now = Instant::now();
    let mut r = Registry::new();
    let s = active(&mut r, now);
    assert_eq!(
        r.signal_alive(&s.viewer_session_id, now + SIGNAL_LIVENESS),
        Err(Error::InvalidState)
    );
    assert_eq!(
        r.resume_input(&s.viewer_session_id, now + SIGNAL_LIVENESS),
        Err(Error::InvalidState)
    );
    assert!(r
        .visibility(&s.viewer_session_id, false, now + SIGNAL_LIVENESS)
        .is_err());
    assert!(r
        .tick(now + SIGNAL_LIVENESS)
        .iter()
        .any(|(_, effects)| effects.close_peer));
}

#[test]
fn peer_failure_releases_input_and_preserves_its_cause_after_drain() {
    let now = Instant::now();
    let mut r = Registry::new();
    let s = active(&mut r, now);
    r.resume_input(&s.viewer_session_id, now).unwrap();
    let effects = r.peer_failed(&s.viewer_session_id, now).unwrap();
    assert!(effects.release_input && effects.close_peer);
    let snapshot = r.snapshot(&s.viewer_session_id, &owner()).unwrap();
    assert_eq!(snapshot.input_epoch, None);
    assert_eq!(snapshot.phase, Phase::Draining);
    assert_eq!(
        snapshot.reason.as_deref(),
        Some("REMOTE_DESKTOP_PEER_FAILED")
    );
    r.drained(&s.viewer_session_id).unwrap();
    let snapshot = r.snapshot(&s.viewer_session_id, &owner()).unwrap();
    assert_eq!(snapshot.phase, Phase::Failed);
    assert_eq!(
        snapshot.reason.as_deref(),
        Some("REMOTE_DESKTOP_PEER_FAILED")
    );
}

#[test]
fn typed_backend_failure_drains_once_preserves_cause_and_ignores_late_peer_error() {
    use desktop_streaming::error::BackendError;
    let now = Instant::now();
    let mut r = Registry::new();
    let s = active(&mut r, now);
    r.resume_input(&s.viewer_session_id, now).unwrap();
    let effects = r
        .backend_failed(&s.viewer_session_id, BackendError::GeometryChanged, now)
        .unwrap();
    assert!(effects.release_input && effects.close_peer);
    assert_eq!(
        r.peer_failed(&s.viewer_session_id, now),
        Err(Error::InvalidState)
    );
    r.drained(&s.viewer_session_id).unwrap();
    let snapshot = r.snapshot(&s.viewer_session_id, &owner()).unwrap();
    assert_eq!(snapshot.phase, Phase::Failed);
    assert_eq!(snapshot.input_epoch, None);
    assert_eq!(
        snapshot.reason.as_deref(),
        Some("REMOTE_DESKTOP_GEOMETRY_CHANGED")
    );
    let unknown = anyhow::anyhow!("private native window title/path must never escape");
    assert_eq!(
        BackendError::from_error(&unknown),
        BackendError::CaptureUnavailable
    );
}

#[test]
fn native_prepare_does_not_publish_input_and_failed_attempts_never_reuse_epochs() {
    let mut r = Registry::new();
    let now = Instant::now();
    let snapshot = active(&mut r, now);
    let id = &snapshot.viewer_session_id;
    r.drain_events().for_each(drop);
    let abandoned = r.prepare_input(id, now).unwrap();
    assert!(r.drain_events().next().is_none());
    assert_eq!(r.snapshot(id, &owner()).unwrap().input_epoch, None);
    let current = r.prepare_input(id, now).unwrap();
    assert!(current > abandoned);
    assert_eq!(r.commit_input(id, abandoned, now), Err(Error::InvalidState));
    r.commit_input(id, current, now).unwrap();
    assert_eq!(r.check_epoch(id, current, now), Ok(()));
}

#[test]
fn move_only_native_geometry_change_advances_revision_and_invalidates_held_epoch() {
    let mut r = Registry::new();
    let now = Instant::now();
    let snapshot = active(&mut r, now);
    let id = &snapshot.viewer_session_id;
    let epoch = r.resume_input(id, now).unwrap();
    let before = r.snapshot(id, &owner()).unwrap();
    r.capture_geometry(
        id,
        desktop_streaming::traits::Geometry {
            x: 500,
            y: 300,
            width: 640,
            height: 392,
            scale: 1.0,
        },
    )
    .unwrap();
    let after = r.snapshot(id, &owner()).unwrap();
    assert!(after.session_revision > before.session_revision);
    assert_eq!(after.input_epoch, None);
    assert_eq!(
        after.capture_geometry,
        Some(CaptureGeometry {
            width: 640,
            height: 392
        })
    );
    assert_eq!(r.check_epoch(id, epoch, now), Err(Error::StaleEpoch));
    assert_eq!(after.phase, Phase::Active);
    assert!(!after.media_paused);
}

#[test]
fn takeover_preserves_fixed_target_and_rejects_other_actor_without_draining() {
    let mut registry = Registry::new();
    let now = Instant::now();
    let target = window("opaque-window-selection");
    let (original, _) = registry
        .reserve("original", owner(), target.clone(), now)
        .unwrap();
    let next = Owner {
        actor_id: "actor".into(),
        device_session_id: "new-device".into(),
    };
    assert_eq!(
        registry
            .prepare_takeover(
                "wrong-target",
                &original.viewer_session_id,
                &next,
                &display(),
                now
            )
            .unwrap_err(),
        Error::UnsupportedTarget
    );
    assert_eq!(
        registry
            .snapshot(&original.viewer_session_id, &owner())
            .unwrap()
            .phase,
        Phase::Starting
    );
    let foreign = Owner {
        actor_id: "foreign".into(),
        device_session_id: "new-device".into(),
    };
    assert_eq!(
        registry
            .prepare_takeover(
                "foreign",
                &original.viewer_session_id,
                &foreign,
                &target,
                now
            )
            .unwrap_err(),
        Error::Forbidden
    );
    let effects = registry
        .prepare_takeover("replace", &original.viewer_session_id, &next, &target, now)
        .unwrap();
    assert!(effects.close_peer);
    registry.drained(&original.viewer_session_id).unwrap();
    let (replacement, _) = registry
        .reserve_for(
            "replace",
            next,
            target.clone(),
            Some(&original.viewer_session_id),
            now,
        )
        .unwrap();
    assert_eq!(replacement.capture_selection, target);
    assert_ne!(replacement.viewer_session_id, original.viewer_session_id);
}

#[test]
fn viewers_share_one_transferable_control_lease() {
    let mut r = Registry::new();
    let now = Instant::now();
    let first_id = active_viewer(&mut r, "first", now).viewer_session_id;
    let second = active_viewer(&mut r, "second", now);
    let first = r.snapshot(&first_id, &owner()).unwrap();
    assert!(first.is_controller);
    assert!(!second.is_controller);
    assert!(second.has_controller);
    assert_eq!(first.viewer_count, 2);
    assert_eq!(
        r.resume_input(&second.viewer_session_id, now),
        Err(Error::InvalidState)
    );

    let first_epoch = r.resume_input(&first.viewer_session_id, now).unwrap();
    let before = r.snapshot(&second.viewer_session_id, &owner()).unwrap();
    let previous = r.request_control(&second.viewer_session_id, now).unwrap();
    assert_eq!(previous.as_deref(), Some(first.viewer_session_id.as_str()));
    let first_after = r.snapshot(&first.viewer_session_id, &owner()).unwrap();
    let second_after = r.snapshot(&second.viewer_session_id, &owner()).unwrap();
    assert!(!first_after.is_controller);
    assert!(second_after.is_controller);
    assert!(second_after.has_controller);
    assert_eq!(first_after.input_epoch, None);
    assert!(second_after.control_revision > before.control_revision);
    assert_eq!(
        r.check_epoch(&first.viewer_session_id, first_epoch, now),
        Err(Error::StaleEpoch)
    );
    let second_epoch = r.resume_input(&second.viewer_session_id, now).unwrap();
    assert!(second_epoch > first_epoch);
    assert!(r
        .check_epoch(&second.viewer_session_id, second_epoch, now)
        .is_ok());

    let previous = r.request_control(&first.viewer_session_id, now).unwrap();
    assert_eq!(previous.as_deref(), Some(second.viewer_session_id.as_str()));
    assert_eq!(
        r.check_epoch(&second.viewer_session_id, second_epoch, now),
        Err(Error::StaleEpoch)
    );
    assert!(
        r.snapshot(&first.viewer_session_id, &owner())
            .unwrap()
            .is_controller
    );
    let reclaimed_epoch = r.resume_input(&first.viewer_session_id, now).unwrap();
    assert!(reclaimed_epoch > second_epoch);
}

#[test]
fn different_sources_stream_concurrently_with_one_control_lease() {
    let mut r = Registry::new();
    let now = Instant::now();
    let display = active_viewer(&mut r, "display", now);
    let window_target = window("window-channel");
    let (window, token) = r
        .reserve("window", owner(), window_target.clone(), now)
        .unwrap();
    r.attach(
        &window.viewer_session_id,
        &owner(),
        &window_target,
        &token,
        now,
    )
    .unwrap();
    r.connected(&window.viewer_session_id, now).unwrap();

    let display_snapshot = r.snapshot(&display.viewer_session_id, &owner()).unwrap();
    let window_snapshot = r.snapshot(&window.viewer_session_id, &owner()).unwrap();
    assert_eq!(display_snapshot.phase, Phase::Active);
    assert_eq!(window_snapshot.phase, Phase::Active);
    // Viewer totals are instance-wide, while the per-source breakdown keeps the
    // two capture targets distinguishable for the connection UI.
    assert_eq!(display_snapshot.viewer_count, 2);
    assert_eq!(window_snapshot.viewer_count, 2);
    assert_eq!(display_snapshot.viewer_sources.len(), 2);
    assert!(display_snapshot
        .viewer_sources
        .iter()
        .any(|source| source.source_ref == "display" && source.viewer_count == 1));
    assert!(display_snapshot
        .viewer_sources
        .iter()
        .any(|source| source.source_ref == "window-channel" && source.viewer_count == 1));
    assert!(display_snapshot.is_controller);
    assert!(!window_snapshot.is_controller);

    let display_epoch = r.resume_input(&display.viewer_session_id, now).unwrap();
    let previous = r.request_control(&window.viewer_session_id, now).unwrap();
    assert_eq!(
        previous.as_deref(),
        Some(display.viewer_session_id.as_str())
    );
    assert_eq!(
        r.check_epoch(&display.viewer_session_id, display_epoch, now),
        Err(Error::StaleEpoch)
    );
    assert!(
        r.snapshot(&window.viewer_session_id, &owner())
            .unwrap()
            .is_controller
    );
    assert!(r
        .resume_input(&window.viewer_session_id, now)
        .is_ok_and(|epoch| epoch > display_epoch));
}

#[test]
fn controller_disconnect_leaves_control_empty_and_non_controller_stop_preserves_it() {
    let mut r = Registry::new();
    let now = Instant::now();
    let first = active_viewer(&mut r, "first", now);
    let second = active_viewer(&mut r, "second", now);
    r.stop(&second.viewer_session_id, &owner(), now).unwrap();
    r.drained(&second.viewer_session_id).unwrap();
    assert!(
        r.snapshot(&first.viewer_session_id, &owner())
            .unwrap()
            .is_controller
    );

    r.stop(&first.viewer_session_id, &owner(), now).unwrap();
    r.drained(&first.viewer_session_id).unwrap();
    let second_after_holder_disconnect = r.snapshot(&second.viewer_session_id, &owner()).unwrap();
    assert!(!second_after_holder_disconnect.is_controller);
    assert!(!second_after_holder_disconnect.has_controller);
    let third = active_viewer(&mut r, "third", now);
    assert!(third.is_controller);
    let fourth = active_viewer(&mut r, "fourth", now);
    assert!(!fourth.is_controller);

    let revision = r
        .snapshot(&fourth.viewer_session_id, &owner())
        .unwrap()
        .control_revision;
    let non_holder_stop = r.stop(&fourth.viewer_session_id, &owner(), now).unwrap();
    assert!(!non_holder_stop.release_input);
    let holder = r.snapshot(&third.viewer_session_id, &owner()).unwrap();
    assert!(holder.is_controller);
    assert_eq!(holder.control_revision, revision);
}

#[test]
fn progressive_fallback_upgrades_to_webrtc_without_replacing_the_session() {
    let mut r = Registry::new();
    let now = Instant::now();
    let session = active(&mut r, now);
    let id = session.viewer_session_id;
    r.fallback_activated(&id).unwrap();
    assert_eq!(
        r.snapshot(&id, &owner()).unwrap().transport,
        "websocket-fallback"
    );
    r.request_control(&id, now).unwrap();
    let epoch = r.prepare_input(&id, now).unwrap();
    r.commit_input(&id, epoch, now).unwrap();

    let effects = r.webrtc_upgraded(&id).unwrap();
    assert!(effects.release_input);
    assert!(effects.request_idr);
    let upgraded = r.snapshot(&id, &owner()).unwrap();
    assert_eq!(upgraded.viewer_session_id, id);
    assert_eq!(upgraded.transport, "webrtc");
    assert_eq!(upgraded.input_epoch, None);
    assert_eq!(r.webrtc_upgraded(&id).unwrap_err(), Error::InvalidState);
}
