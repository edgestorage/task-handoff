use desktop_streaming::{catalog::*, session::Owner};
use std::time::Instant;
fn owner() -> Owner {
    Owner {
        actor_id: "actor".into(),
        device_session_id: "device".into(),
    }
}
fn source() -> NativeSource<u64> {
    NativeSource {
        identity: "x11:1193046:4242".into(),
        unavailable_reason: None,
        handle: 0x123456,
        kind: "window".into(),
        title: "私有窗口".into(),
        subtitle: Some("app".into()),
        width: 800,
        height: 600,
    }
}

#[test]
fn source_labels_keep_provider_context_out_of_the_page_model() {
    assert_eq!(
        source_labels("Terminal".into(), "XTerm".into()),
        ("Terminal".into(), Some("XTerm".into()))
    );
    assert_eq!(
        source_labels("".into(), "XTerm".into()),
        ("XTerm".into(), None)
    );
    assert_eq!(
        source_labels("XTerm".into(), "XTerm".into()),
        ("XTerm".into(), None)
    );
}
#[test]
fn source_references_are_opaque_stable_and_owner_bound() {
    let now = Instant::now();
    let mut c = Catalog::default();
    let entry = c.publish(owner(), vec![source()], now).unwrap().remove(0);
    let wire = serde_json::to_value(&entry).unwrap();
    for forbidden in ["handle", "pid", "path", "hwnd", "cgWindowId"] {
        assert!(wire.get(forbidden).is_none());
    }
    assert_ne!(entry.source_ref, "1193046");
    let refreshed = c.publish(owner(), vec![source()], now).unwrap().remove(0);
    assert_eq!(entry.source_ref, refreshed.source_ref);
    let other = Owner {
        actor_id: "other".into(),
        ..owner()
    };
    assert_eq!(
        c.consume(&entry.source_ref, &other, now),
        Err(CatalogError::InvalidReference)
    );
    assert_eq!(c.consume(&entry.source_ref, &owner(), now), Ok(0x123456));
    assert_eq!(
        c.consume(&entry.source_ref, &owner(), now),
        Err(CatalogError::InvalidReference)
    );
    let old = c.publish(owner(), vec![source()], now).unwrap().remove(0);
    let next = c.publish(owner(), vec![source()], now).unwrap().remove(0);
    assert_eq!(old.source_ref, next.source_ref);
    assert_eq!(c.consume(&old.source_ref, &owner(), now), Ok(0x123456));
    let after_consume = c.publish(owner(), vec![source()], now).unwrap().remove(0);
    assert_eq!(old.source_ref, after_consume.source_ref);
    assert_eq!(
        c.consume(&after_consume.source_ref, &owner(), now),
        Ok(0x123456)
    );
    let mut restarted = Catalog::<u64>::default();
    assert_eq!(
        restarted.consume(&old.source_ref, &owner(), now),
        Err(CatalogError::InvalidReference)
    );
}
#[test]
fn ttl_boundary_and_size_limits_are_enforced_without_truncation() {
    let now = Instant::now();
    let mut c = Catalog::default();
    let entry = c.publish(owner(), vec![source()], now).unwrap().remove(0);
    assert_eq!(
        c.consume(&entry.source_ref, &owner(), now + SOURCE_TTL),
        Err(CatalogError::InvalidReference)
    );
    assert!(matches!(
        c.publish(owner(), (0..257).map(|_| source()).collect(), now),
        Err(CatalogError::TooLarge)
    ));
    let mut w = source();
    w.title = "字".repeat(171);
    assert!(matches!(
        c.publish(owner(), vec![w], now),
        Err(CatalogError::TooLarge)
    ));
    let mut w = source();
    w.subtitle = Some("x".repeat(257));
    assert!(matches!(
        c.publish(owner(), vec![w], now),
        Err(CatalogError::TooLarge)
    ));
}

#[test]
fn failed_refresh_can_invalidate_references_before_any_native_await() {
    let now = Instant::now();
    let mut c = Catalog::default();
    let entry = c.publish(owner(), vec![source()], now).unwrap().remove(0);
    c.invalidate();
    assert_eq!(
        c.consume(&entry.source_ref, &owner(), now),
        Err(CatalogError::InvalidReference)
    );
}

#[test]
fn oversized_sources_are_visible_but_never_retain_selectable_handles() {
    let now = Instant::now();
    let mut c = Catalog::default();
    let mut huge = source();
    huge.width = MAX_CAPTURE_DIMENSION + 1;
    let entries = c.publish(owner(), vec![huge, source()], now).unwrap();
    assert!(!entries[0].capturable);
    assert_eq!(
        entries[0].reason.as_deref(),
        Some("REMOTE_DESKTOP_SOURCE_DIMENSIONS_UNSUPPORTED")
    );
    assert_eq!(
        c.consume(&entries[0].source_ref, &owner(), now),
        Err(CatalogError::InvalidReference)
    );
    assert!(entries[1].capturable);
    assert_eq!(
        c.consume(&entries[1].source_ref, &owner(), now),
        Ok(0x123456)
    );
}
