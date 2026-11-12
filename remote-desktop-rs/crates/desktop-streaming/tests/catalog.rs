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

fn named_source(identity: &str, application: Option<&str>, title: &str) -> NativeSource<u64> {
    NativeSource {
        identity: identity.into(),
        subtitle: application.map(str::to_string),
        title: title.into(),
        ..source()
    }
}

fn display_source(identity: &str, title: &str) -> NativeSource<u64> {
    NativeSource {
        identity: identity.into(),
        kind: "display".into(),
        title: title.into(),
        subtitle: Some("Primary".into()),
        ..source()
    }
}

#[test]
fn published_sources_sort_by_application_then_window_title() {
    let now = Instant::now();
    let mut catalog = Catalog::default();
    let entries = catalog
        .publish(
            owner(),
            vec![
                named_source("z-beta", Some("Zed"), "Beta"),
                named_source("a-zulu", Some("alpha"), "Zulu"),
                named_source("a-alpha", Some("Alpha"), "Alpha"),
                named_source("b-window", Some("Beta"), "Window"),
                named_source("fallback-gamma", None, "Gamma"),
            ],
            now,
        )
        .unwrap();

    assert_eq!(
        entries
            .iter()
            .map(|entry| (entry.subtitle.as_deref(), entry.title.as_str()))
            .collect::<Vec<_>>(),
        vec![
            (Some("Alpha"), "Alpha"),
            (Some("alpha"), "Zulu"),
            (Some("Beta"), "Window"),
            (None, "Gamma"),
            (Some("Zed"), "Beta"),
        ]
    );
}

#[test]
fn window_sorting_keeps_non_window_source_order() {
    let now = Instant::now();
    let mut catalog = Catalog::default();
    let entries = catalog
        .publish(
            owner(),
            vec![
                display_source("display-z", "Display Z"),
                named_source("window-z", Some("Zed"), "Window"),
                display_source("display-a", "Display A"),
                named_source("window-a", Some("Alpha"), "Window"),
            ],
            now,
        )
        .unwrap();

    assert_eq!(entries[0].title, "Display Z");
    assert_eq!(entries[1].title, "Window");
    assert_eq!(entries[1].subtitle.as_deref(), Some("Alpha"));
    assert_eq!(entries[2].title, "Display A");
    assert_eq!(entries[3].subtitle.as_deref(), Some("Zed"));
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
    let huge_entry = entries
        .iter()
        .find(|entry| !entry.capturable)
        .expect("oversized source remains visible");
    assert!(!huge_entry.capturable);
    assert_eq!(
        huge_entry.reason.as_deref(),
        Some("REMOTE_DESKTOP_SOURCE_DIMENSIONS_UNSUPPORTED")
    );
    assert_eq!(
        c.consume(&huge_entry.source_ref, &owner(), now),
        Err(CatalogError::InvalidReference)
    );
    let selectable = entries
        .iter()
        .find(|entry| entry.capturable)
        .expect("selectable source remains visible");
    assert_eq!(
        c.consume(&selectable.source_ref, &owner(), now),
        Ok(0x123456)
    );
}
