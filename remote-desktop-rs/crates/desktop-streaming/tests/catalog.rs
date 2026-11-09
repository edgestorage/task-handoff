use desktop_streaming::{catalog::*, session::Owner};
use std::time::Instant;
fn owner() -> Owner {
    Owner {
        actor_id: "actor".into(),
        device_session_id: "device".into(),
    }
}
fn window() -> NativeWindow<u64> {
    NativeWindow {
        unavailable_reason: None,
        handle: 0x123456,
        title: "私有窗口".into(),
        application_name: "app".into(),
        width: 800,
        height: 600,
    }
}
#[test]
fn window_references_are_opaque_single_use_owner_generation_and_boot_bound() {
    let now = Instant::now();
    let mut c = Catalog::default();
    let entry = c.publish(owner(), vec![window()], now).unwrap().remove(0);
    let wire = serde_json::to_value(&entry).unwrap();
    for forbidden in ["handle", "pid", "path", "hwnd", "cgWindowId"] {
        assert!(wire.get(forbidden).is_none());
    }
    assert_ne!(entry.window_ref, "1193046");
    let other = Owner {
        actor_id: "other".into(),
        ..owner()
    };
    assert_eq!(
        c.consume(&entry.window_ref, &other, now),
        Err(CatalogError::InvalidReference)
    );
    assert_eq!(c.consume(&entry.window_ref, &owner(), now), Ok(0x123456));
    assert_eq!(
        c.consume(&entry.window_ref, &owner(), now),
        Err(CatalogError::InvalidReference)
    );
    let old = c.publish(owner(), vec![window()], now).unwrap().remove(0);
    c.publish(owner(), vec![window()], now).unwrap();
    assert_eq!(
        c.consume(&old.window_ref, &owner(), now),
        Err(CatalogError::InvalidReference)
    );
    let mut restarted = Catalog::<u64>::default();
    assert_eq!(
        restarted.consume(&old.window_ref, &owner(), now),
        Err(CatalogError::InvalidReference)
    );
}
#[test]
fn ttl_boundary_and_size_limits_are_enforced_without_truncation() {
    let now = Instant::now();
    let mut c = Catalog::default();
    let entry = c.publish(owner(), vec![window()], now).unwrap().remove(0);
    assert_eq!(
        c.consume(&entry.window_ref, &owner(), now + WINDOW_TTL),
        Err(CatalogError::InvalidReference)
    );
    assert!(matches!(
        c.publish(owner(), (0..257).map(|_| window()).collect(), now),
        Err(CatalogError::TooLarge)
    ));
    let mut w = window();
    w.title = "字".repeat(171);
    assert!(matches!(
        c.publish(owner(), vec![w], now),
        Err(CatalogError::TooLarge)
    ));
    let mut w = window();
    w.application_name = "x".repeat(257);
    assert!(matches!(
        c.publish(owner(), vec![w], now),
        Err(CatalogError::TooLarge)
    ));
}

#[test]
fn failed_refresh_can_invalidate_references_before_any_native_await() {
    let now = Instant::now();
    let mut c = Catalog::default();
    let entry = c.publish(owner(), vec![window()], now).unwrap().remove(0);
    c.invalidate();
    assert_eq!(
        c.consume(&entry.window_ref, &owner(), now),
        Err(CatalogError::InvalidReference)
    );
}

#[test]
fn oversized_windows_are_visible_but_never_retain_selectable_handles() {
    let now = Instant::now();
    let mut c = Catalog::default();
    let mut huge = window();
    huge.width = MAX_CAPTURE_DIMENSION + 1;
    let entries = c.publish(owner(), vec![huge, window()], now).unwrap();
    assert!(!entries[0].capturable);
    assert_eq!(
        entries[0].reason.as_deref(),
        Some("REMOTE_DESKTOP_WINDOW_DIMENSIONS_UNSUPPORTED")
    );
    assert_eq!(
        c.consume(&entries[0].window_ref, &owner(), now),
        Err(CatalogError::InvalidReference)
    );
    assert!(entries[1].capturable);
    assert_eq!(
        c.consume(&entries[1].window_ref, &owner(), now),
        Ok(0x123456)
    );
}
