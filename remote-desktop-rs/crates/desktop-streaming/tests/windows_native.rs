#![allow(clippy::await_holding_lock)] // serializes native desktop fixtures across tests
#![cfg(target_os = "windows")]
//! Real WGC window acceptance against a disposable top-level fixture. This
//! exercises the same catalog, DWM geometry and Win32 input lease used by the
//! service instead of relying only on pure geometry/relation tests.
use crabgrab::prelude::*;

use desktop_streaming::{
    capture::Source as CaptureSource,
    channel::{Button as ChannelButton, Input},
    input_driver::NativeInput,
    platform::{
        apple_windows::{Capture, Target},
        display::DisplayCatalog,
        native_catalog,
        window::{WindowCatalog, WindowTarget},
        windows_window,
    },
    session::Owner,
};
use std::{
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Arc, Once,
    },
    time::{Duration, Instant},
};
use windows_sys::Win32::{
    Foundation::{HWND, LPARAM, LRESULT, POINT, WPARAM},
    Graphics::Gdi::UpdateWindow,
    UI::WindowsAndMessaging::{
        CreateWindowExW, DefWindowProcW, DestroyWindow, DispatchMessageW, GetCursorPos,
        LoadCursorW, PeekMessageW, RegisterClassW, SetCursorPos, SetWindowPos, ShowWindow,
        TranslateMessage, CS_HREDRAW, CS_VREDRAW, HWND_TOPMOST, IDC_ARROW, MSG, PM_REMOVE,
        SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SW_SHOW, WM_LBUTTONDOWN, WM_LBUTTONUP, WNDCLASSW,
        WS_OVERLAPPEDWINDOW, WS_VISIBLE,
    },
};

const FIXTURE_CLASS: &str = "TaskHandoffWgcFixture";
static REGISTER_FIXTURE_CLASS: Once = Once::new();
static DESKTOP_FIXTURE: std::sync::Mutex<()> = std::sync::Mutex::new(());
static FIXTURE_CLICKS: AtomicUsize = AtomicUsize::new(0);

unsafe extern "system" fn fixture_window_proc(
    hwnd: HWND,
    message: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    match message {
        WM_LBUTTONDOWN => {
            FIXTURE_CLICKS.fetch_add(1, Ordering::SeqCst);
            0
        }
        WM_LBUTTONUP => 0,
        _ => DefWindowProcW(hwnd, message, wparam, lparam),
    }
}

#[tokio::test]
#[ignore = "requires an active WTS desktop; a disconnected or locked session fails closed"]
async fn display_catalog_and_wgc_capture_emit_real_frames() -> anyhow::Result<()> {
    let _desktop = DESKTOP_FIXTURE
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    let owner = Owner {
        actor_id: "windows-display-test".into(),
        device_session_id: "owned-displays".into(),
    };
    let mut catalog = DisplayCatalog::with_source_salt("windows-display-test-salt".into());
    let sources = catalog.enumerate(owner.clone()).await?;
    anyhow::ensure!(!sources.is_empty(), "no interactive displays enumerated");
    let selected = sources[0].clone();
    anyhow::ensure!(selected.kind == "display");
    let target = catalog.consume(&selected.source_ref, &owner).await?;
    let mut source = target.source(true)?;
    let geometry = source.geometry();
    anyhow::ensure!(geometry.width > 0 && geometry.height > 0);
    anyhow::ensure!(
        geometry.width == selected.width && geometry.height == selected.height,
        "catalog and capture geometry disagree"
    );
    let CaptureSource::Native(capture) = &mut source else {
        anyhow::bail!("Windows display did not resolve to the native WGC backend");
    };
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    let frame = loop {
        if let Some(frame) = capture.frame(true)? {
            break frame;
        }
        anyhow::ensure!(
            tokio::time::Instant::now() < deadline,
            "WGC emitted no display frame"
        );
        tokio::time::sleep(Duration::from_millis(33)).await;
    };
    anyhow::ensure!(
        frame.stride == frame.geometry.width as usize * 4
            && frame.bgra.len() == frame.stride * frame.geometry.height as usize,
        "WGC display frame does not match its reported BGRA geometry"
    );
    anyhow::ensure!(
        frame.bgra.iter().take(1 << 20).any(|byte| *byte != 0),
        "WGC display frame contains no visible pixels"
    );
    capture.pause()?;
    let input = NativeInput::new(geometry, None)?;
    input.prepare()?;
    println!(
        "display capture ok: sources={} geometry={}x{} frame={}x{} cursor=true",
        sources.len(),
        geometry.width,
        geometry.height,
        frame.geometry.width,
        frame.geometry.height
    );
    Ok(())
}

struct Fixture(HWND);

impl Fixture {
    fn new(title: &str) -> anyhow::Result<Self> {
        REGISTER_FIXTURE_CLASS.call_once(|| unsafe {
            let class = wide(FIXTURE_CLASS);
            let wc = WNDCLASSW {
                style: CS_HREDRAW | CS_VREDRAW,
                lpfnWndProc: Some(fixture_window_proc),
                cbClsExtra: 0,
                cbWndExtra: 0,
                hInstance: std::ptr::null_mut(),
                hIcon: std::ptr::null_mut(),
                hCursor: LoadCursorW(std::ptr::null_mut(), IDC_ARROW),
                hbrBackground: std::ptr::null_mut(),
                lpszMenuName: std::ptr::null(),
                lpszClassName: class.as_ptr(),
            };
            RegisterClassW(&wc);
        });
        let class = wide(FIXTURE_CLASS);
        let title = wide(title);
        let hwnd = unsafe {
            CreateWindowExW(
                0,
                class.as_ptr(),
                title.as_ptr(),
                WS_OVERLAPPEDWINDOW | WS_VISIBLE,
                120,
                120,
                480,
                320,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null(),
            )
        };
        anyhow::ensure!(!hwnd.is_null(), "fixture window creation failed");
        let fixture = Self(hwnd);
        unsafe {
            ShowWindow(hwnd, SW_SHOW);
            UpdateWindow(hwnd);
            anyhow::ensure!(
                SetWindowPos(
                    hwnd,
                    HWND_TOPMOST,
                    0,
                    0,
                    0,
                    0,
                    SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
                ) != 0,
                "fixture topmost placement failed"
            );
        }
        Ok(fixture)
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        unsafe {
            DestroyWindow(self.0);
        }
    }
}

fn wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(Some(0)).collect()
}

fn describe(hwnd: HWND) -> String {
    use windows_sys::Win32::{
        Foundation::RECT,
        Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_CLOAKED},
        UI::WindowsAndMessaging::{
            GetAncestor, GetClassNameW, GetWindowLongPtrW, GetWindowRect, GetWindowTextW,
            GetWindowThreadProcessId, GA_ROOT, GWL_EXSTYLE,
        },
    };
    if hwnd.is_null() {
        return "null".to_string();
    }
    let mut class = [0u16; 128];
    let n = unsafe { GetClassNameW(hwnd, class.as_mut_ptr(), class.len() as i32) };
    let class = String::from_utf16_lossy(&class[..n.max(0) as usize]);
    let mut title = [0u16; 128];
    let n = unsafe { GetWindowTextW(hwnd, title.as_mut_ptr(), title.len() as i32) };
    let title = String::from_utf16_lossy(&title[..n.max(0) as usize]);
    let root = unsafe { GetAncestor(hwnd, GA_ROOT) };
    let ex = unsafe { GetWindowLongPtrW(hwnd, GWL_EXSTYLE) } as u32;
    let mut pid = 0;
    let tid = unsafe { GetWindowThreadProcessId(hwnd, &mut pid) };
    let mut rect = RECT::default();
    unsafe { GetWindowRect(hwnd, &mut rect) };
    let mut cloaked = 0u32;
    let cloaked_hr = unsafe {
        DwmGetWindowAttribute(
            hwnd,
            DWMWA_CLOAKED as u32,
            (&mut cloaked as *mut u32).cast(),
            std::mem::size_of_val(&cloaked) as u32,
        )
    };
    format!(
        "{hwnd:?} class={class:?} title={title:?} root={root:?} ex=0x{ex:X} pid={pid} tid={tid} rect=({},{},{},{}) cloaked={cloaked} hr={cloaked_hr}",
        rect.left, rect.top, rect.right, rect.bottom
    )
}

fn pump_until_clicked(timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        unsafe {
            let mut message = std::mem::zeroed::<MSG>();
            while PeekMessageW(&mut message, std::ptr::null_mut(), 0, 0, PM_REMOVE) != 0 {
                TranslateMessage(&message);
                DispatchMessageW(&message);
            }
        }
        if FIXTURE_CLICKS.load(Ordering::SeqCst) > 0 {
            return true;
        }
        std::thread::sleep(Duration::from_millis(5));
    }
    FIXTURE_CLICKS.load(Ordering::SeqCst) > 0
}

#[tokio::test]
#[ignore = "requires an active WTS desktop; a disconnected RDP session fails closed"]
async fn wgc_window_catalog_capture_and_input_lease_share_geometry() -> anyhow::Result<()> {
    let _desktop = DESKTOP_FIXTURE
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    let title = "TaskHandoff disposable WGC window";
    let _fixture = Fixture::new(title)?;
    let owner = Owner {
        actor_id: "windows-native-test".into(),
        device_session_id: "owned-fixture".into(),
    };
    let mut catalog = WindowCatalog::with_source_salt("windows-native-test-salt".into());
    let sources = catalog.enumerate(owner.clone()).await?;
    let source = sources
        .iter()
        .find(|source| source.kind == "window" && source.title == title)
        .ok_or_else(|| anyhow::anyhow!("owned fixture was not published"))?;
    anyhow::ensure!(source.capturable && source.width > 0 && source.height > 0);

    let target = catalog.consume(&source.source_ref, &owner).await?;
    let WindowTarget::Windows(window) = target;
    let identity = native_catalog::identity(&window)?;
    let mut capture = Capture::new_with_cursor(Target::Window(window), true)?;
    let geometry = capture.geometry();
    anyhow::ensure!(geometry.width > 0 && geometry.height > 0);

    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    let frame = loop {
        if let Some(frame) = capture.frame(true)? {
            break frame;
        }
        anyhow::ensure!(
            tokio::time::Instant::now() < deadline,
            "WGC emitted no window frame"
        );
        tokio::time::sleep(Duration::from_millis(33)).await;
    };
    anyhow::ensure!(
        frame.stride == frame.geometry.width as usize * 4
            && frame.bgra.len() == frame.stride * frame.geometry.height as usize,
        "WGC frame does not match its reported BGRA geometry"
    );
    capture.pause()?;
    let lease = windows_window::Lease::bind(identity, geometry)?;
    let mut previous = POINT::default();
    anyhow::ensure!(unsafe { GetCursorPos(&mut previous) } != 0);
    let center = (
        geometry.x + geometry.width.saturating_sub(1) as i32 / 2,
        geometry.y + geometry.height.saturating_sub(1) as i32 / 2,
    );
    let result = (|| -> anyhow::Result<()> {
        anyhow::ensure!(unsafe { SetCursorPos(center.0, center.1) } != 0);
        if let Err(error) = lease.focus() {
            let foreground =
                unsafe { windows_sys::Win32::UI::WindowsAndMessaging::GetForegroundWindow() };
            println!(
                "focus failed: {error:?} foreground={foreground:?} target={:?} center={center:?}",
                identity.window
            );
            return Err(error);
        }
        if let Err(error) = lease.validate(geometry, Some(center)) {
            let foreground =
                unsafe { windows_sys::Win32::UI::WindowsAndMessaging::GetForegroundWindow() };
            let hit = unsafe {
                windows_sys::Win32::UI::WindowsAndMessaging::WindowFromPoint(POINT {
                    x: center.0,
                    y: center.1,
                })
            };
            println!(
                "validate failed: {error:?} foreground={} hit={} target={} center={center:?}",
                describe(foreground),
                describe(hit),
                describe(identity.window as HWND)
            );
            return Err(error);
        }

        let mut input = NativeInput::new_window(identity, geometry)?;
        input.prepare()?;
        FIXTURE_CLICKS.store(0, Ordering::SeqCst);
        for down in [true, false] {
            input.apply(&Input::Button(ChannelButton {
                input_epoch: 0,
                x: 0.5,
                y: 0.5,
                button: 0,
                down,
            }))?;
        }
        anyhow::ensure!(
            pump_until_clicked(Duration::from_secs(2)),
            "fixture received no native click"
        );
        Ok(())
    })();
    unsafe {
        SetCursorPos(previous.x, previous.y);
    }
    result
}

#[tokio::test]
#[ignore = "diagnostic for an explicitly active Windows desktop"]
async fn direct_wgc_emits_frames_for_a_visible_owned_window() -> anyhow::Result<()> {
    let _desktop = DESKTOP_FIXTURE
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    let title = "TaskHandoff direct WGC window";
    let _fixture = Fixture::new(title)?;
    let content = CapturableContent::new(CapturableContentFilter::NORMAL_WINDOWS).await?;
    let window = content
        .windows()
        .find(|window| window.title() == title)
        .ok_or_else(|| anyhow::anyhow!("owned fixture was not enumerated"))?;
    let rect = window.rect();
    let config = CaptureConfig::with_window(window, CapturePixelFormat::Bgra8888)?
        .with_output_size(Size {
            width: rect.size.width,
            height: rect.size.height,
        })
        .with_buffer_count(2);
    let token = CaptureStream::test_access(false)
        .ok_or_else(|| anyhow::anyhow!("WGC access unavailable"))?;
    let arrived = Arc::new(AtomicBool::new(false));
    let signal = arrived.clone();
    let mut stream = CaptureStream::new(token, config, move |event| {
        if matches!(event, Ok(StreamEvent::Video(_))) {
            signal.store(true, Ordering::Release);
        }
    })
    .map_err(|error| anyhow::anyhow!("WGC stream creation failed: {error:?}"))?;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    while !arrived.load(Ordering::Acquire) {
        anyhow::ensure!(
            tokio::time::Instant::now() < deadline,
            "direct WGC emitted no frame"
        );
        tokio::time::sleep(Duration::from_millis(33)).await;
    }
    stream
        .stop()
        .map_err(|error| anyhow::anyhow!("WGC stream stop failed: {error:?}"))?;
    Ok(())
}
