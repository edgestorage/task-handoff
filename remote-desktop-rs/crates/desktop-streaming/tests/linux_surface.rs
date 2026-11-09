#![cfg(target_os = "linux")]
use desktop_streaming::{
    channel::{Input, Key},
    input_guard::{Backend, Client, Command, Event},
    platform::linux::Capture,
    surface,
};
use std::{path::Path, time::Duration};
use x11rb::{connection::Connection, protocol::xproto::ConnectionExt};
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
    let surface = surface::Client::spawn(binary()).await.unwrap();
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
        session::{CaptureTarget, Owner},
    };
    let owner = Owner {
        actor_id: "surface-fixture".into(),
        device_session_id: "fixture-device".into(),
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
                capture_target: CaptureTarget::Display,
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
                capture_target: CaptureTarget::Display,
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
    let surface = surface::Client::spawn(binary()).await.unwrap();
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
    let surface = surface::Client::spawn(binary()).await.unwrap();
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
