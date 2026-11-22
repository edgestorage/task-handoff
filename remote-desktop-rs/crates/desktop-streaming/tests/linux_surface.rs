#![cfg(target_os = "linux")]
use desktop_streaming::{
    channel::{Button, Input, Key, Pointer},
    input_guard::{Backend, Client, Command, Event},
    platform::linux::Capture,
    surface,
};
use std::{
    io::{BufRead, BufReader},
    path::Path,
    process::{Child, Command as ProcessCommand, Stdio},
    time::{Duration, Instant},
};
use x11rb::{connection::Connection, protocol::xproto::ConnectionExt, wrapper::ConnectionExt as _};
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
fn pressed(c: &x11rb::rust_connection::RustConnection) -> bool {
    let reply = c.query_keymap().unwrap().reply().unwrap();
    reply.keys[38 / 8] & (1 << (38 % 8)) != 0
}
#[tokio::test]
#[ignore = "requires a disposable Linux test host with Xvfb/Openbox/tint2"]
async fn private_surface_real_capture_cursor_guard_release_and_lifetime_cleanup() {
    let surface = surface::Client::spawn_private(binary()).await.unwrap();
    let config = surface.config();
    let mut capture = Capture::open(&config).unwrap();
    let (conn, _) = {
        let stream = std::os::unix::net::UnixStream::connect(format!(
            "/tmp/.X11-unix/X{}",
            config.display.trim_start_matches(':')
        ))
        .unwrap();
        let stream = x11rb::rust_connection::DefaultStream::from_unix_stream(stream)
            .unwrap()
            .0;
        (
            x11rb::rust_connection::RustConnection::connect_to_stream_with_auth_info(
                stream,
                0,
                b"MIT-MAGIC-COOKIE-1".to_vec(),
                config.cookie.clone().unwrap(),
            )
            .unwrap(),
            0,
        )
    };
    let root = conn.setup().roots[0].root;
    // A fixture window is ordinary desktop content. Capturing never launches an
    // AppSession or adopts any preexisting display, process or VNC endpoint.
    let window = conn.generate_id().unwrap();
    conn.create_window(
        x11rb::COPY_FROM_PARENT as u8,
        window,
        root,
        50,
        50,
        320,
        200,
        0,
        x11rb::protocol::xproto::WindowClass::INPUT_OUTPUT,
        0,
        &x11rb::protocol::xproto::CreateWindowAux::new().background_pixel(0x00ff0000),
    )
    .unwrap()
    .check()
    .unwrap();
    conn.map_window(window).unwrap().check().unwrap();
    conn.flush().unwrap();
    tokio::time::sleep(Duration::from_millis(300)).await;
    let frame = capture.frame(true).unwrap().unwrap();
    assert_eq!((frame.geometry.width, frame.geometry.height), (1280, 720));
    assert!(
        frame
            .bgra
            .chunks_exact(4)
            .any(|p| p[2] > 180 && p[1] < 80 && p[0] < 80),
        "real X11 fixture must be visible"
    );
    conn.change_window_attributes(
        window,
        &x11rb::protocol::xproto::ChangeWindowAttributesAux::new().background_pixel(0x0000ff00),
    )
    .unwrap()
    .check()
    .unwrap();
    conn.clear_area(false, window, 0, 0, 0, 0)
        .unwrap()
        .check()
        .unwrap();
    conn.flush().unwrap();
    tokio::time::timeout(Duration::from_millis(200), async {
        loop {
            if capture.frame(false).unwrap().is_some_and(|frame| {
                frame
                    .bgra
                    .chunks_exact(4)
                    .any(|p| p[1] > 180 && p[2] < 80 && p[0] < 80)
            }) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("XDamage must report a mapped child window redraw promptly");
    let cursor = conn.query_pointer(root).unwrap().reply().unwrap();
    assert!(cursor.same_screen);
    let mut guard = Client::spawn(
        binary(),
        Backend::Native {
            geometry: capture.geometry(),
            display: Some(config.display.clone()),
            authority: config.authority.clone(),
        },
    )
    .await
    .unwrap();
    // A real terminal consumes Unicode XTest input; inspect its captured stdin,
    // rather than accepting a successful API call as evidence of text commit.
    let text_dir = tempfile::tempdir().unwrap();
    let text_path = text_dir.path().join("unicode.txt");
    let mut terminal = tokio::process::Command::new("xterm")
        .env("DISPLAY", &config.display)
        .env("XAUTHORITY", config.authority.as_ref().unwrap())
        .env("LANG", "C.UTF-8")
        .args([
            "-title",
            "G1 Unicode fixture",
            "-e",
            "sh",
            "-c",
            "stty raw -echo; exec cat > \"$1\"",
            "sh",
        ])
        .arg(&text_path)
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    tokio::time::timeout(Duration::from_secs(3), async {
        while !text_path.exists() {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap();
    guard.call(&Command::Arm { epoch: 1 }).await.unwrap();
    let unicode = "中文・日本語・é・😀 setsid sleep 600 >/dev/null 2>&1 &";
    let commit_started = std::time::Instant::now();
    let committed = guard
        .call(&Command::Input {
            event: Input::Text(desktop_streaming::channel::Text {
                input_epoch: 1,
                text: unicode.into(),
            }),
        })
        .await;
    assert!(
        committed.is_ok(),
        "Unicode command must complete within guard budget: elapsed {:?}, failed={} ",
        commit_started.elapsed(),
        committed.is_err()
    );
    tokio::time::timeout(Duration::from_secs(2), async {
        while std::fs::read(&text_path).unwrap_or_default() != unicode.as_bytes() {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("real terminal must receive exact UTF-8 commit");
    let long_text = "abc日本語>".repeat(500);
    let batch_started = std::time::Instant::now();
    let stopped = guard
        .call(&Command::Input {
            event: Input::Text(desktop_streaming::channel::Text {
                input_epoch: 1,
                text: long_text.clone(),
            }),
        })
        .await
        .unwrap();
    assert!(
        matches!(stopped, Event::State { epoch: None, .. }),
        "lease expiry must cancel long native text without success ACK"
    );
    assert!(batch_started.elapsed() < Duration::from_millis(1650));
    tokio::time::sleep(Duration::from_millis(100)).await;
    let length = std::fs::metadata(&text_path).unwrap().len();
    assert!(length > unicode.len() as u64 && length < (unicode.len() + long_text.len()) as u64);
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert_eq!(
        std::fs::metadata(&text_path).unwrap().len(),
        length,
        "expired text must not continue typing"
    );
    terminal.kill().await.unwrap();
    let mut clipboard = desktop_streaming::clipboard::Client::spawn(
        binary(),
        Some(config.display.clone()),
        config.authority.clone(),
    )
    .await
    .unwrap();
    assert!(matches!(
        clipboard
            .call(&desktop_streaming::clipboard::Command::Write {
                text: unicode.into()
            })
            .await
            .unwrap(),
        desktop_streaming::clipboard::Reply::Written
    ));
    // A second process/connection is the clipboard observer, not the writer's cache.
    let mut reader = desktop_streaming::clipboard::Client::spawn(
        binary(),
        Some(config.display.clone()),
        config.authority.clone(),
    )
    .await
    .unwrap();
    assert!(
        matches!(reader.call(&desktop_streaming::clipboard::Command::Read).await.unwrap(), desktop_streaming::clipboard::Reply::Text { text } if text==unicode)
    );
    drop(reader);
    drop(clipboard);

    guard.call(&Command::Arm { epoch: 2 }).await.unwrap();
    guard.call(&key(2, true)).await.unwrap();
    assert!(pressed(&conn));
    tokio::time::sleep(Duration::from_millis(1550)).await;
    assert!(
        !pressed(&conn),
        "watchdog must release a native XTest key without host work"
    );
    assert!(matches!(
        guard.call(&key(2, true)).await.unwrap(),
        Event::Rejected
    ));
    guard.call(&Command::Arm { epoch: 3 }).await.unwrap();
    guard.call(&key(3, true)).await.unwrap();
    assert!(pressed(&conn));
    guard.close_pipe();
    tokio::time::timeout(Duration::from_secs(2), guard.child.wait())
        .await
        .unwrap()
        .unwrap();
    assert!(
        !pressed(&conn),
        "native key must release on parent pipe EOF"
    );
    drop(capture);
    drop(conn);
    let socket = format!("/tmp/.X11-unix/X{}", config.display.trim_start_matches(':'));
    surface.close().await.unwrap();
    assert!(
        !std::path::Path::new(&socket).exists(),
        "owned surface socket must be removed"
    );
    assert!(
        !config.authority.unwrap().exists(),
        "private auth material must be removed"
    );
}

fn children(pid: u32) -> Vec<u32> {
    std::fs::read_to_string(format!("/proc/{pid}/task/{pid}/children"))
        .unwrap_or_default()
        .split_whitespace()
        .filter_map(|s| s.parse().ok())
        .collect()
}
async fn attach_virtual(host: &mut desktop_streaming::host::TestHost, request: &str) -> String {
    use desktop_streaming::{
        contract::{Command, Reply},
        session::{CaptureSelection, Owner},
    };
    let owner = Owner {
        actor_id: "surface-fixture".into(),
        device_session_id: "fixture-device".into(),
    };
    let selection = CaptureSelection {
        source_ref: "display".into(),
        stream_region: None,
        control_region: None,
    };
    let Reply::Reserved {
        snapshot,
        attach_token,
        ..
    } = host
        .request(
            request,
            Command::Reserve {
                owner: owner.clone(),
                capture_selection: selection.clone(),
            },
        )
        .await
        .unwrap()
    else {
        panic!("reserve");
    };
    assert!(matches!(
        host.request(
            &format!("{request}-attach"),
            Command::Attach {
                owner,
                viewer_session_id: snapshot.viewer_session_id.clone(),
                capture_selection: selection,
                attach_token
            }
        )
        .await
        .unwrap(),
        Reply::Snapshot { .. }
    ));
    snapshot.viewer_session_id
}
#[tokio::test]
#[ignore = "requires a disposable Linux test host with Xvfb/Openbox/tint2"]
async fn surface_crash_reclaims_slot_and_component_sigkill_reaps_owned_tree() {
    use desktop_streaming::{
        capture::Mode,
        contract::{Command, Reply},
        host::TestHost,
        session::{Owner, Phase},
    };
    let mut host = TestHost::spawn_mode(binary(), Mode::Virtual).await.unwrap();
    let first = attach_virtual(&mut host, "first").await;
    let component = host.child.id().unwrap();
    let keeper = children(component)
        .into_iter()
        .find(|pid| {
            std::fs::read(format!("/proc/{pid}/cmdline"))
                .unwrap_or_default()
                .split(|b| *b == 0)
                .any(|arg| arg == b"--surface-owner")
        })
        .unwrap();
    let xvfb = children(keeper)
        .into_iter()
        .find(|pid| {
            std::fs::read(format!("/proc/{pid}/cmdline"))
                .unwrap_or_default()
                .starts_with(b"Xvfb\0")
        })
        .unwrap();
    unsafe {
        assert_eq!(libc::kill(xvfb as i32, libc::SIGKILL), 0);
    }
    let owner = Owner {
        actor_id: "surface-fixture".into(),
        device_session_id: "fixture-device".into(),
    };
    tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            if matches!(host.request("snapshot", Command::Snapshot { owner:owner.clone(), viewer_session_id:first.clone() }).await.unwrap(), Reply::Snapshot { snapshot } if snapshot.phase==Phase::Failed) { break; }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }).await.expect("surface failure must publish authoritative failed state");
    let second = attach_virtual(&mut host, "second").await;
    assert_ne!(first, second);
    let direct = children(component);
    let mut owned = direct.clone();
    for child in direct {
        owned.extend(children(child));
    }
    assert!(
        owned.len() >= 5,
        "keeper, guard, Xvfb, WM and panel must exist"
    );
    host.child.kill().await.unwrap();
    tokio::time::timeout(Duration::from_secs(3), async {
        while owned
            .iter()
            .any(|pid| std::path::Path::new(&format!("/proc/{pid}")).exists())
        {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("SIGKILL must leave no owned guard or surface processes");
}

#[tokio::test]
#[ignore = "requires a disposable Linux test host with Xvfb/Openbox/tint2"]
async fn damage_acknowledgement_must_precede_image_read_to_preserve_concurrent_redraw() {
    use x11rb::protocol::{
        damage::{ConnectionExt as _, ReportLevel},
        xproto::*,
        Event,
    };
    let surface = surface::Client::spawn_private(binary()).await.unwrap();
    let config = surface.config();
    let stream = std::os::unix::net::UnixStream::connect(format!(
        "/tmp/.X11-unix/X{}",
        config.display.trim_start_matches(':')
    ))
    .unwrap();
    let stream = x11rb::rust_connection::DefaultStream::from_unix_stream(stream)
        .unwrap()
        .0;
    let conn = x11rb::rust_connection::RustConnection::connect_to_stream_with_auth_info(
        stream,
        0,
        b"MIT-MAGIC-COOKIE-1".to_vec(),
        config.cookie.unwrap(),
    )
    .unwrap();
    conn.damage_query_version(1, 1).unwrap().reply().unwrap();
    let screen = &conn.setup().roots[0];
    // A private pixmap avoids unrelated WM/panel repaint notifications. DAMAGE
    // accumulation/NonEmpty semantics are the same as the captured root drawable.
    let pixmap = conn.generate_id().unwrap();
    conn.create_pixmap(screen.root_depth, pixmap, screen.root, 8, 8)
        .unwrap()
        .check()
        .unwrap();
    let gc = conn.generate_id().unwrap();
    conn.create_gc(gc, pixmap, &CreateGCAux::new())
        .unwrap()
        .check()
        .unwrap();
    let damage = conn.generate_id().unwrap();
    conn.damage_create(damage, pixmap, ReportLevel::NON_EMPTY)
        .unwrap()
        .check()
        .unwrap();
    let draw = |color| {
        conn.change_gc(gc, &ChangeGCAux::new().foreground(color))
            .unwrap()
            .check()
            .unwrap();
        conn.poly_fill_rectangle(
            pixmap,
            gc,
            &[Rectangle {
                x: 0,
                y: 0,
                width: 8,
                height: 8,
            }],
        )
        .unwrap()
        .check()
        .unwrap();
    };
    let read = || {
        conn.get_image(ImageFormat::Z_PIXMAP, pixmap, 0, 0, 8, 8, u32::MAX)
            .unwrap()
            .reply()
            .unwrap()
            .data
    };
    let ack = || {
        conn.damage_subtract(damage, 0u32, 0u32)
            .unwrap()
            .check()
            .unwrap()
    };
    let notified = || {
        conn.get_input_focus().unwrap().reply().unwrap();
        let mut found = false;
        while let Some(event) = conn.poll_for_event().unwrap() {
            if matches!(event, Event::DamageNotify(e) if e.damage == damage) {
                found = true;
            }
        }
        found
    };
    ack();
    notified();
    draw(0xff0000);
    assert!(notified());
    let stale = read();
    draw(0x00ff00); // Redraw while the consumed damage region remains NonEmpty.
    ack();
    assert!(!notified(), "read-then-ack loses the redraw notification");
    assert_ne!(
        stale,
        read(),
        "cached pixels are stale despite no new notification"
    );
    draw(0xff0000);
    assert!(notified());
    ack();
    let stale = read();
    draw(0x00ff00);
    assert!(
        notified(),
        "ack-before-read preserves redraws after the image boundary"
    );
    assert_ne!(stale, read());
    conn.damage_destroy(damage).unwrap().check().unwrap();
    conn.free_gc(gc).unwrap().check().unwrap();
    conn.free_pixmap(pixmap).unwrap().check().unwrap();
    drop(conn);
    surface.close().await.unwrap();
}

#[tokio::test]
#[ignore = "requires a disposable Linux test host with Xvfb/Openbox/tint2"]
async fn xfixes_cursor_hotspot_motion_and_transparent_hide_update_captured_pixels() {
    use x11rb::protocol::{xfixes::ConnectionExt as _, xproto::*};
    let surface = surface::Client::spawn_private(binary()).await.unwrap();
    let config = surface.config();
    let stream = std::os::unix::net::UnixStream::connect(format!(
        "/tmp/.X11-unix/X{}",
        config.display.trim_start_matches(':')
    ))
    .unwrap();
    let stream = x11rb::rust_connection::DefaultStream::from_unix_stream(stream)
        .unwrap()
        .0;
    let conn = x11rb::rust_connection::RustConnection::connect_to_stream_with_auth_info(
        stream,
        0,
        b"MIT-MAGIC-COOKIE-1".to_vec(),
        config.cookie.clone().unwrap(),
    )
    .unwrap();
    let root = conn.setup().roots[0].root;
    let window = conn.generate_id().unwrap();
    conn.create_window(
        x11rb::COPY_FROM_PARENT as u8,
        window,
        root,
        1000,
        400,
        64,
        64,
        0,
        WindowClass::INPUT_OUTPUT,
        0,
        &CreateWindowAux::new()
            .background_pixel(0)
            .override_redirect(1),
    )
    .unwrap()
    .check()
    .unwrap();
    let source = conn.generate_id().unwrap();
    let mask = conn.generate_id().unwrap();
    for pixmap in [source, mask] {
        conn.create_pixmap(1, pixmap, root, 8, 8)
            .unwrap()
            .check()
            .unwrap();
    }
    let gc = conn.generate_id().unwrap();
    conn.create_gc(gc, source, &CreateGCAux::new().foreground(1))
        .unwrap()
        .check()
        .unwrap();
    let rect = [Rectangle {
        x: 0,
        y: 0,
        width: 8,
        height: 8,
    }];
    for pixmap in [source, mask] {
        conn.poly_fill_rectangle(pixmap, gc, &rect)
            .unwrap()
            .check()
            .unwrap();
    }
    let visible = conn.generate_id().unwrap();
    conn.create_cursor(visible, source, mask, u16::MAX, 0, u16::MAX, 0, 0, 0, 2, 3)
        .unwrap()
        .check()
        .unwrap();
    conn.change_window_attributes(window, &ChangeWindowAttributesAux::new().cursor(visible))
        .unwrap()
        .check()
        .unwrap();
    conn.map_window(window).unwrap().check().unwrap();
    conn.warp_pointer(x11rb::NONE, root, 0, 0, 0, 0, 1020, 420)
        .unwrap()
        .check()
        .unwrap();
    let mut capture = Capture::open(&config).unwrap();
    let frame = capture.frame(false).unwrap().unwrap();
    let pixel = |frame: &desktop_streaming::traits::RawFrame, x: usize, y: usize| {
        let i = y * frame.stride + x * 4;
        frame.bgra[i..i + 3].to_vec()
    };
    assert_eq!(
        pixel(&frame, 1018, 417),
        [255, 0, 255],
        "shape must use native hotspot"
    );
    assert_eq!(pixel(&frame, 1017, 417), [0, 0, 0]);
    conn.warp_pointer(x11rb::NONE, root, 0, 0, 0, 0, 1040, 440)
        .unwrap()
        .check()
        .unwrap();
    let moved = capture.frame(false).unwrap().unwrap();
    assert_eq!(pixel(&moved, 1038, 437), [255, 0, 255]);
    assert_eq!(
        pixel(&moved, 1018, 417),
        [0, 0, 0],
        "cursor motion cannot leave trails"
    );
    // Record the protocol visibility limitation independently of our compositor:
    // XFixes server suppression may leave image/serial unchanged. Never infer a
    // visible cursor from those properties alone when publishing capabilities.
    conn.xfixes_query_version(5, 0).unwrap().reply().unwrap();
    let before_hide = conn.xfixes_get_cursor_image().unwrap().reply().unwrap();
    conn.xfixes_hide_cursor(window).unwrap().check().unwrap();
    let server_hidden = conn.xfixes_get_cursor_image().unwrap().reply().unwrap();
    conn.xfixes_show_cursor(window).unwrap().check().unwrap();
    eprintln!(
        "XFixes server hide leaves image/serial unchanged: {}",
        before_hide.cursor_image == server_hidden.cursor_image
            && before_hide.cursor_serial == server_hidden.cursor_serial
    );
    // X11 applications conventionally hide by defining a transparent cursor.
    // This exercises the actual server image/serial, not a local visibility flag.
    conn.change_gc(gc, &ChangeGCAux::new().foreground(0))
        .unwrap()
        .check()
        .unwrap();
    conn.poly_fill_rectangle(mask, gc, &rect)
        .unwrap()
        .check()
        .unwrap();
    let hidden = conn.generate_id().unwrap();
    conn.create_cursor(hidden, source, mask, u16::MAX, 0, u16::MAX, 0, 0, 0, 2, 3)
        .unwrap()
        .check()
        .unwrap();
    conn.change_window_attributes(window, &ChangeWindowAttributesAux::new().cursor(hidden))
        .unwrap()
        .check()
        .unwrap();
    let hidden_frame = capture.frame(false).unwrap().unwrap();
    assert_eq!(
        pixel(&hidden_frame, 1038, 437),
        [0, 0, 0],
        "transparent cursor must disappear without desktop repaint"
    );
    drop(capture);
    drop(conn);
    surface.close().await.unwrap();
}

#[tokio::test]
#[ignore = "requires a disposable Linux test host with Xvfb/Openbox/tint2"]
async fn window_catalog_consumes_real_window_and_capture_uses_window_drawable() {
    use desktop_streaming::{platform::linux::WindowCatalog, session::Owner};
    use x11rb::protocol::xproto::{AtomEnum, CreateWindowAux, PropMode, WindowClass};
    use x11rb::wrapper::ConnectionExt as _;

    let surface = surface::Client::spawn_private(binary()).await.unwrap();
    let config = surface.config();
    let stream = std::os::unix::net::UnixStream::connect(format!(
        "/tmp/.X11-unix/X{}",
        config.display.trim_start_matches(':')
    ))
    .unwrap();
    let stream = x11rb::rust_connection::DefaultStream::from_unix_stream(stream)
        .unwrap()
        .0;
    let conn = x11rb::rust_connection::RustConnection::connect_to_stream_with_auth_info(
        stream,
        0,
        b"MIT-MAGIC-COOKIE-1".to_vec(),
        config.cookie.clone().unwrap(),
    )
    .unwrap();
    let root = conn.setup().roots[0].root;
    let window = conn.generate_id().unwrap();
    conn.create_window(
        x11rb::COPY_FROM_PARENT as u8,
        window,
        root,
        80,
        90,
        320,
        200,
        0,
        WindowClass::INPUT_OUTPUT,
        0,
        &CreateWindowAux::new().background_pixel(0x00ff0000),
    )
    .unwrap()
    .check()
    .unwrap();
    let child = conn.generate_id().unwrap();
    conn.create_window(
        x11rb::COPY_FROM_PARENT as u8,
        child,
        window,
        40,
        30,
        120,
        80,
        0,
        WindowClass::INPUT_OUTPUT,
        0,
        &CreateWindowAux::new().background_pixel(0x0000ff00),
    )
    .unwrap()
    .check()
    .unwrap();
    conn.map_window(child).unwrap().check().unwrap();
    let net_wm_name = conn
        .intern_atom(false, b"_NET_WM_NAME")
        .unwrap()
        .reply()
        .unwrap()
        .atom;
    let utf8_string = conn
        .intern_atom(false, b"UTF8_STRING")
        .unwrap()
        .reply()
        .unwrap()
        .atom;
    conn.change_property8(
        PropMode::REPLACE,
        window,
        net_wm_name,
        utf8_string,
        "Window Capture Fixture".as_bytes(),
    )
    .unwrap()
    .check()
    .unwrap();
    conn.change_property8(
        PropMode::REPLACE,
        window,
        AtomEnum::WM_CLASS,
        AtomEnum::STRING,
        b"fixture\0WindowCaptureFixture\0",
    )
    .unwrap()
    .check()
    .unwrap();
    conn.map_window(window).unwrap().check().unwrap();
    conn.flush().unwrap();
    tokio::time::sleep(Duration::from_millis(350)).await;
    let frame_window = conn.query_tree(window).unwrap().reply().unwrap().parent;
    assert_ne!(frame_window, root, "Openbox must reparent the fixture");
    let frame_geometry = conn.get_geometry(frame_window).unwrap().reply().unwrap();
    let frame_position = conn
        .translate_coordinates(frame_window, root, 0, 0)
        .unwrap()
        .reply()
        .unwrap();
    let client_position = conn
        .translate_coordinates(window, root, 0, 0)
        .unwrap()
        .reply()
        .unwrap();
    let client_x = (client_position.dst_x - frame_position.dst_x) as usize;
    let client_y = (client_position.dst_y - frame_position.dst_y) as usize;

    let owner = Owner {
        actor_id: "actor-window-test".into(),
        device_session_id: "device-window-test".into(),
    };
    let mut catalog = WindowCatalog::new(config.clone());
    let windows = catalog.enumerate(owner.clone()).await.unwrap();
    let entry = windows
        .iter()
        .find(|entry| entry.title == "Window Capture Fixture")
        .expect("mapped client window must be catalogued");
    assert!(entry.capturable, "catalogued window must be capturable");
    assert_eq!(
        (entry.width, entry.height),
        (frame_geometry.width.into(), frame_geometry.height.into())
    );
    assert_eq!(entry.subtitle.as_deref(), Some("WindowCaptureFixture"));

    let target = catalog.consume(&entry.source_ref, &owner).await.unwrap();
    let mut capture = target.open(false).unwrap();
    let frame = capture.frame(true).unwrap().unwrap();
    assert_eq!(
        (frame.geometry.width, frame.geometry.height),
        (frame_geometry.width.into(), frame_geometry.height.into())
    );
    let pixel = |x: usize, y: usize| {
        let offset = (y * frame.geometry.width as usize + x) * 4;
        [
            frame.bgra[offset],
            frame.bgra[offset + 1],
            frame.bgra[offset + 2],
        ]
    };
    assert_eq!(
        pixel(client_x, client_y),
        [0, 0, 255],
        "the captured frame must begin at the window-manager frame origin"
    );
    assert_eq!(
        pixel(client_x + 319, client_y + 199),
        [0, 0, 255],
        "the client's right and bottom edges must remain visible"
    );
    assert!(
        frame
            .bgra
            .chunks_exact(4)
            .any(|pixel| pixel[2] > 180 && pixel[1] < 80 && pixel[0] < 80),
        "direct window drawable must contain the fixture background"
    );
    assert!(
        frame
            .bgra
            .chunks_exact(4)
            .any(|pixel| pixel[1] > 180 && pixel[2] < 80 && pixel[0] < 80),
        "window capture must include rendered child windows"
    );
    drop(capture);
    drop(conn);
    surface.close().await.unwrap();
}

#[tokio::test]
#[ignore = "requires a disposable Linux test host with Xvfb/Openbox/tint2"]
async fn window_pointer_moves_before_validating_the_hit_target() {
    use x11rb::protocol::xproto::{CreateWindowAux, WindowClass};

    let surface = surface::Client::spawn_private(binary()).await.unwrap();
    let config = surface.config();
    let stream = std::os::unix::net::UnixStream::connect(format!(
        "/tmp/.X11-unix/X{}",
        config.display.trim_start_matches(':')
    ))
    .unwrap();
    let stream = x11rb::rust_connection::DefaultStream::from_unix_stream(stream)
        .unwrap()
        .0;
    let conn = x11rb::rust_connection::RustConnection::connect_to_stream_with_auth_info(
        stream,
        0,
        b"MIT-MAGIC-COOKIE-1".to_vec(),
        config.cookie.clone().unwrap(),
    )
    .unwrap();
    let root = conn.setup().roots[0].root;
    let window = conn.generate_id().unwrap();
    conn.create_window(
        x11rb::COPY_FROM_PARENT as u8,
        window,
        root,
        700,
        450,
        260,
        160,
        0,
        WindowClass::INPUT_OUTPUT,
        0,
        &CreateWindowAux::new()
            .background_pixel(0x00ff0000)
            .override_redirect(1),
    )
    .unwrap()
    .check()
    .unwrap();
    conn.map_window(window).unwrap().check().unwrap();
    conn.warp_pointer(x11rb::NONE, root, 0, 0, 0, 0, 0, 0)
        .unwrap()
        .check()
        .unwrap();
    conn.flush().unwrap();
    tokio::time::sleep(Duration::from_millis(100)).await;

    let capture = Capture::open_window(&config, window, None).unwrap();
    let geometry = capture.geometry();
    let mut guard = Client::spawn(
        binary(),
        Backend::LinuxWindow {
            window,
            geometry,
            display: Some(config.display.clone()),
            authority: config.authority.clone(),
        },
    )
    .await
    .unwrap();
    guard.call(&Command::Arm { epoch: 1 }).await.unwrap();
    let reply = guard
        .call(&Command::Pointer {
            event: Pointer {
                input_epoch: 1,
                x: 0.25,
                y: 0.5,
            },
        })
        .await
        .unwrap();
    assert!(matches!(reply, Event::State { epoch: Some(1), .. }));

    let pointer = conn.query_pointer(root).unwrap().reply().unwrap();
    assert!(pointer.same_screen);
    assert_eq!(
        (pointer.root_x, pointer.root_y),
        (
            (geometry.x + (0.25 * f64::from(geometry.width - 1)).round() as i32) as i16,
            (geometry.y + (0.5 * f64::from(geometry.height - 1)).round() as i32) as i16,
        )
    );
    assert_eq!(pointer.child, window);

    drop(capture);
    drop(guard);
    drop(conn);
    surface.close().await.unwrap();
}

#[tokio::test]
#[ignore = "requires a disposable Linux test host with Xvfb/Openbox/tint2"]
async fn window_pointer_accepts_same_process_menu_popup_inside_the_target() {
    use x11rb::protocol::xproto::{
        AtomEnum, ConfigureWindowAux, CreateWindowAux, InputFocus, PropMode, StackMode, WindowClass,
    };

    let surface = surface::Client::spawn_private(binary()).await.unwrap();
    let config = surface.config();
    let stream = std::os::unix::net::UnixStream::connect(format!(
        "/tmp/.X11-unix/X{}",
        config.display.trim_start_matches(':')
    ))
    .unwrap();
    let stream = x11rb::rust_connection::DefaultStream::from_unix_stream(stream)
        .unwrap()
        .0;
    let conn = x11rb::rust_connection::RustConnection::connect_to_stream_with_auth_info(
        stream,
        0,
        b"MIT-MAGIC-COOKIE-1".to_vec(),
        config.cookie.clone().unwrap(),
    )
    .unwrap();
    let root = conn.setup().roots[0].root;
    let target = conn.generate_id().unwrap();
    conn.create_window(
        x11rb::COPY_FROM_PARENT as u8,
        target,
        root,
        700,
        450,
        300,
        200,
        0,
        WindowClass::INPUT_OUTPUT,
        0,
        &CreateWindowAux::new()
            .background_pixel(0x00ff0000)
            .override_redirect(1),
    )
    .unwrap()
    .check()
    .unwrap();
    let popup = conn.generate_id().unwrap();
    conn.create_window(
        x11rb::COPY_FROM_PARENT as u8,
        popup,
        root,
        760,
        500,
        300,
        200,
        0,
        WindowClass::INPUT_OUTPUT,
        0,
        &CreateWindowAux::new()
            .background_pixel(0x0000ff00)
            .override_redirect(1),
    )
    .unwrap()
    .check()
    .unwrap();
    let unrelated_popup = conn.generate_id().unwrap();
    conn.create_window(
        x11rb::COPY_FROM_PARENT as u8,
        unrelated_popup,
        root,
        710,
        460,
        30,
        30,
        0,
        WindowClass::INPUT_OUTPUT,
        0,
        &CreateWindowAux::new()
            .background_pixel(0x000000ff)
            .override_redirect(1),
    )
    .unwrap()
    .check()
    .unwrap();
    let wm_pid = conn
        .intern_atom(false, b"_NET_WM_PID")
        .unwrap()
        .reply()
        .unwrap()
        .atom;
    let wm_window_type = conn
        .intern_atom(false, b"_NET_WM_WINDOW_TYPE")
        .unwrap()
        .reply()
        .unwrap()
        .atom;
    let menu_type = conn
        .intern_atom(false, b"_NET_WM_WINDOW_TYPE_MENU")
        .unwrap()
        .reply()
        .unwrap()
        .atom;
    let pid = std::process::id();
    for window in [target, popup, unrelated_popup] {
        conn.change_property32(
            PropMode::REPLACE,
            window,
            wm_pid,
            AtomEnum::CARDINAL,
            &[pid],
        )
        .unwrap()
        .check()
        .unwrap();
    }
    conn.change_property32(
        PropMode::REPLACE,
        popup,
        wm_window_type,
        AtomEnum::ATOM,
        &[menu_type],
    )
    .unwrap()
    .check()
    .unwrap();
    conn.map_window(target).unwrap().check().unwrap();
    conn.set_input_focus(InputFocus::PARENT, target, x11rb::CURRENT_TIME)
        .unwrap()
        .check()
        .unwrap();
    conn.flush().unwrap();
    tokio::time::sleep(Duration::from_millis(100)).await;

    let mut capture = Capture::open_window(&config, target, Some(pid)).unwrap();
    let geometry = capture.geometry();
    let mut guard = Client::spawn(
        binary(),
        Backend::LinuxWindow {
            window: target,
            geometry,
            display: Some(config.display.clone()),
            authority: config.authority.clone(),
        },
    )
    .await
    .unwrap();
    guard.call(&Command::Arm { epoch: 1 }).await.unwrap();
    conn.map_window(unrelated_popup).unwrap().check().unwrap();
    conn.map_window(popup).unwrap().check().unwrap();
    conn.configure_window(
        popup,
        &ConfigureWindowAux::new().stack_mode(StackMode::ABOVE),
    )
    .unwrap()
    .check()
    .unwrap();
    conn.warp_pointer(x11rb::NONE, root, 0, 0, 0, 0, 830, 550)
        .unwrap()
        .check()
        .unwrap();
    conn.flush().unwrap();
    tokio::time::sleep(Duration::from_millis(50)).await;
    conn.get_input_focus().unwrap().reply().unwrap();
    let frame = capture.frame(true).unwrap().unwrap();
    let pixel = |x: usize, y: usize| {
        let offset = (y * frame.geometry.width as usize + x) * 4;
        &frame.bgra[offset..offset + 4]
    };
    assert_eq!(&pixel(10, 10)[..3], &[0, 0, 255]);
    assert_eq!(&pixel(200, 160)[..3], &[0, 255, 0]);
    assert_eq!(&pixel(295, 195)[..3], &[0, 255, 0]);
    let x = f64::from(830 - geometry.x) / f64::from(geometry.width - 1);
    let y = f64::from(550 - geometry.y) / f64::from(geometry.height - 1);
    let reply = guard
        .call(&Command::Pointer {
            event: Pointer {
                input_epoch: 1,
                x,
                y,
            },
        })
        .await
        .unwrap();
    assert!(matches!(reply, Event::State { epoch: Some(1), .. }));
    for down in [true, false] {
        let reply = guard
            .call(&Command::Input {
                event: Input::Button(Button {
                    input_epoch: 1,
                    x,
                    y,
                    button: 0,
                    down,
                }),
            })
            .await
            .unwrap();
        assert!(matches!(reply, Event::State { epoch: Some(1), .. }));
    }

    let pointer = conn.query_pointer(root).unwrap().reply().unwrap();
    assert_eq!((pointer.root_x, pointer.root_y), (830, 550));
    assert_eq!(pointer.child, popup);

    drop(capture);
    drop(guard);
    drop(conn);
    surface.close().await.unwrap();
}

#[tokio::test]
#[ignore = "requires a disposable Linux test host with Xvfb/Openbox/tint2"]
async fn direct_window_capture_tracks_move_resize_focus_and_unmap() {
    use desktop_streaming::platform::linux::WindowLease;
    use x11rb::protocol::xproto::{
        ChangeWindowAttributesAux, ConfigureWindowAux, CreateWindowAux, WindowClass,
    };

    let surface = surface::Client::spawn_private(binary()).await.unwrap();
    let config = surface.config();
    let stream = std::os::unix::net::UnixStream::connect(format!(
        "/tmp/.X11-unix/X{}",
        config.display.trim_start_matches(':')
    ))
    .unwrap();
    let stream = x11rb::rust_connection::DefaultStream::from_unix_stream(stream)
        .unwrap()
        .0;
    let conn = x11rb::rust_connection::RustConnection::connect_to_stream_with_auth_info(
        stream,
        0,
        b"MIT-MAGIC-COOKIE-1".to_vec(),
        config.cookie.clone().unwrap(),
    )
    .unwrap();
    let root = conn.setup().roots[0].root;
    let window = conn.generate_id().unwrap();
    conn.create_window(
        x11rb::COPY_FROM_PARENT as u8,
        window,
        root,
        140,
        160,
        240,
        140,
        0,
        WindowClass::INPUT_OUTPUT,
        0,
        &CreateWindowAux::new()
            .background_pixel(0x00ff0000)
            .override_redirect(1),
    )
    .unwrap()
    .check()
    .unwrap();
    conn.map_window(window).unwrap().check().unwrap();
    conn.flush().unwrap();
    tokio::time::sleep(Duration::from_millis(100)).await;

    let mut capture = Capture::open_window(&config, window, None).unwrap();
    let frame = capture.frame(true).unwrap().unwrap();
    assert_eq!((frame.geometry.x, frame.geometry.y), (140, 160));
    assert_eq!((frame.geometry.width, frame.geometry.height), (240, 140));
    let _lease = WindowLease::bind_with_config(window, capture.geometry(), &config).unwrap();
    _lease.focus().unwrap();

    conn.change_window_attributes(
        window,
        &ChangeWindowAttributesAux::new().background_pixel(0x0000ff00),
    )
    .unwrap()
    .check()
    .unwrap();
    conn.configure_window(
        window,
        &ConfigureWindowAux::new()
            .x(360)
            .y(240)
            .width(300)
            .height(180),
    )
    .unwrap()
    .check()
    .unwrap();
    conn.clear_area(false, window, 0, 0, 0, 0)
        .unwrap()
        .check()
        .unwrap();
    conn.flush().unwrap();
    let geometry = capture.refresh_geometry().unwrap();
    assert_eq!((geometry.x, geometry.y), (360, 240));
    assert_eq!((geometry.width, geometry.height), (300, 180));
    let frame = capture.frame(true).unwrap().unwrap();
    assert!(
        frame
            .bgra
            .chunks_exact(4)
            .any(|pixel| pixel[1] > 180 && pixel[2] < 80 && pixel[0] < 80),
        "resized window must expose the new background"
    );

    conn.unmap_window(window).unwrap().check().unwrap();
    conn.flush().unwrap();
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert!(capture.refresh_geometry().is_err());
    drop(capture);
    drop(conn);
    surface.close().await.unwrap();
}

#[tokio::test]
#[ignore = "requires a disposable Linux test host with Xvfb/Openbox and XComposite"]
async fn composite_window_capture_ignores_occlusion_and_tracks_children_popups_resize_and_release()
{
    use x11rb::protocol::{composite::ConnectionExt as _, xproto::*};

    let config = desktop_streaming::platform::linux::Config::environment(false).unwrap();
    let (conn, screen) = x11rb::connect(Some(&config.display)).unwrap();
    let root = conn.setup().roots[screen].root;
    let pid = std::process::id();
    let wm_pid = conn
        .intern_atom(false, b"_NET_WM_PID")
        .unwrap()
        .reply()
        .unwrap()
        .atom;
    let wm_window_type = conn
        .intern_atom(false, b"_NET_WM_WINDOW_TYPE")
        .unwrap()
        .reply()
        .unwrap()
        .atom;
    let menu_type = conn
        .intern_atom(false, b"_NET_WM_WINDOW_TYPE_MENU")
        .unwrap()
        .reply()
        .unwrap()
        .atom;

    let target = conn.generate_id().unwrap();
    conn.create_window(
        x11rb::COPY_FROM_PARENT as u8,
        target,
        root,
        1100,
        600,
        260,
        200,
        0,
        WindowClass::INPUT_OUTPUT,
        0,
        &CreateWindowAux::new()
            .background_pixel(0x000000ff)
            .override_redirect(1),
    )
    .unwrap()
    .check()
    .unwrap();
    conn.change_property32(
        PropMode::REPLACE,
        target,
        wm_pid,
        AtomEnum::CARDINAL,
        &[pid],
    )
    .unwrap()
    .check()
    .unwrap();

    let child = conn.generate_id().unwrap();
    conn.create_window(
        x11rb::COPY_FROM_PARENT as u8,
        child,
        target,
        200,
        140,
        60,
        50,
        0,
        WindowClass::INPUT_OUTPUT,
        0,
        &CreateWindowAux::new().background_pixel(0x0000ff00),
    )
    .unwrap()
    .check()
    .unwrap();

    let cover = conn.generate_id().unwrap();
    conn.create_window(
        x11rb::COPY_FROM_PARENT as u8,
        cover,
        root,
        1120,
        620,
        120,
        100,
        0,
        WindowClass::INPUT_OUTPUT,
        0,
        &CreateWindowAux::new()
            .background_pixel(0x00ff0000)
            .override_redirect(1),
    )
    .unwrap()
    .check()
    .unwrap();

    conn.map_window(target).unwrap().check().unwrap();
    conn.map_window(child).unwrap().check().unwrap();
    conn.map_window(cover).unwrap().check().unwrap();
    conn.flush().unwrap();
    tokio::time::sleep(Duration::from_millis(200)).await;

    let mut capture = Capture::open_window(&config, target, Some(pid)).unwrap();
    let frame = capture.frame(true).unwrap().unwrap();
    assert_eq!((frame.geometry.width, frame.geometry.height), (260, 200));
    assert_eq!(
        pixel(&frame, 50, 50),
        [255, 0, 0],
        "covered target pixels must remain intact"
    );
    assert_eq!(
        pixel(&frame, 220, 165),
        [0, 255, 0],
        "descendant content must remain composed"
    );

    let gc = conn.generate_id().unwrap();
    conn.create_gc(gc, target, &CreateGCAux::new().foreground(0x00ffff00))
        .unwrap()
        .check()
        .unwrap();
    conn.poly_fill_rectangle(
        target,
        gc,
        &[Rectangle {
            x: 20,
            y: 110,
            width: 60,
            height: 60,
        }],
    )
    .unwrap()
    .check()
    .unwrap();
    conn.flush().unwrap();
    tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            if capture
                .frame(false)
                .unwrap()
                .is_some_and(|frame| pixel(&frame, 50, 140) == [0, 255, 255])
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("covered target redraw must reach the composite pixmap");

    let popup = conn.generate_id().unwrap();
    conn.create_window(
        x11rb::COPY_FROM_PARENT as u8,
        popup,
        root,
        1150,
        630,
        70,
        45,
        0,
        WindowClass::INPUT_OUTPUT,
        0,
        &CreateWindowAux::new()
            .background_pixel(0x00ff00ff)
            .override_redirect(1),
    )
    .unwrap()
    .check()
    .unwrap();
    conn.change_property32(PropMode::REPLACE, popup, wm_pid, AtomEnum::CARDINAL, &[pid])
        .unwrap()
        .check()
        .unwrap();
    conn.change_property32(
        PropMode::REPLACE,
        popup,
        wm_window_type,
        AtomEnum::ATOM,
        &[menu_type],
    )
    .unwrap()
    .check()
    .unwrap();
    conn.map_window(popup).unwrap().check().unwrap();
    conn.flush().unwrap();
    tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            if capture
                .frame(false)
                .unwrap()
                .is_some_and(|frame| pixel(&frame, 60, 40) == [255, 0, 255])
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("same-process menu popup must be composed above the target");

    conn.configure_window(target, &ConfigureWindowAux::new().width(320).height(220))
        .unwrap()
        .check()
        .unwrap();
    conn.flush().unwrap();
    tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            if capture.frame(false).unwrap().is_some_and(|frame| {
                frame.geometry.width == 320
                    && frame.geometry.height == 220
                    && pixel(&frame, 300, 205) == [255, 0, 0]
            }) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("resized composite window must expose its new background");

    conn.composite_query_version(0, 4).unwrap().reply().unwrap();
    let redirect_probe = conn.generate_id().unwrap();
    conn.composite_name_window_pixmap(target, redirect_probe)
        .unwrap()
        .check()
        .unwrap();
    conn.free_pixmap(redirect_probe).unwrap().check().unwrap();
    drop(capture);
    tokio::time::sleep(Duration::from_millis(50)).await;
    let release_probe = conn.generate_id().unwrap();
    assert!(
        conn.composite_name_window_pixmap(target, release_probe)
            .unwrap()
            .check()
            .is_err(),
        "dropping capture must release XComposite redirection"
    );
}

struct KillOnDrop(Child);
impl Drop for KillOnDrop {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

fn process_alive(pid: u32) -> bool {
    unsafe { libc::kill(pid as i32, 0) == 0 }
}

#[tokio::test]
#[ignore = "requires a disposable Linux test host with Xvfb/Openbox"]
async fn attached_desktop_survives_surface_shutdown() {
    let mut xvfb = ProcessCommand::new("Xvfb")
        .args([
            "-displayfd",
            "1",
            "-screen",
            "0",
            "1280x720x24",
            "-nolisten",
            "tcp",
            "-noreset",
            "-ac",
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let mut display = String::new();
    BufReader::new(xvfb.stdout.take().unwrap())
        .read_line(&mut display)
        .unwrap();
    let display = format!(":{}", display.trim());
    let xvfb = KillOnDrop(xvfb);
    let openbox = KillOnDrop(
        ProcessCommand::new("openbox")
            .env("DISPLAY", &display)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap(),
    );
    let openbox_pid = openbox.0.id();
    let xvfb_pid = xvfb.0.id();
    let config = desktop_streaming::platform::linux::Config {
        display: display.clone(),
        cookie: None,
        authority: None,
        include_cursor: true,
    };
    let deadline = Instant::now() + Duration::from_secs(5);
    while !desktop_streaming::platform::linux::probe(&config)
        .is_ok_and(|probe| probe.has_window_manager)
    {
        assert!(Instant::now() < deadline, "Openbox did not become ready");
        tokio::time::sleep(Duration::from_millis(50)).await;
    }

    let surface = surface::Client::spawn_attached(binary(), display.as_ref())
        .await
        .unwrap();
    assert_eq!(surface.ready.display, display);
    assert!(surface.ready.cookie.is_none());
    assert!(surface.ready.authority.is_none());
    surface.close().await.unwrap();

    assert!(process_alive(xvfb_pid), "attached Xvfb must survive");
    assert!(process_alive(openbox_pid), "attached Openbox must survive");
}

fn pixel(frame: &desktop_streaming::traits::RawFrame, x: usize, y: usize) -> [u8; 3] {
    let offset = y * frame.stride + x * 4;
    [
        frame.bgra[offset],
        frame.bgra[offset + 1],
        frame.bgra[offset + 2],
    ]
}
