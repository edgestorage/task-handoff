//! Synthetic GUI benchmark. Explicit owned DISPLAY/XAUTHORITY only; it never
//! reads user content. A click toggles a fixed marker for input-to-photon timing.
#[cfg(target_os = "linux")]
fn main() -> anyhow::Result<()> {
    use std::time::{Duration, Instant};
    use x11rb::{
        connection::Connection,
        protocol::{xproto::*, Event},
    };
    let mode = std::env::args().nth(1).unwrap_or_else(|| "static".into());
    anyhow::ensure!(
        ["static", "scroll", "drag"].contains(&mode.as_str()),
        "invalid workload"
    );
    let seconds = std::env::args()
        .nth(2)
        .map(|s| s.parse::<u64>())
        .transpose()?
        .unwrap_or(300)
        .clamp(1, 360);
    let display = std::env::var("DISPLAY")?;
    anyhow::ensure!(
        std::env::var_os("XAUTHORITY").is_some(),
        "explicit owned authority required"
    );
    let (conn, screen) = x11rb::connect(Some(&display))?;
    let screen = &conn.setup().roots[screen];
    anyhow::ensure!(
        screen.width_in_pixels == 1920 && screen.height_in_pixels == 1080,
        "1920x1080fixture required"
    );
    let window = conn.generate_id()?;
    conn.create_window(
        screen.root_depth,
        window,
        screen.root,
        0,
        0,
        1920,
        1080,
        0,
        WindowClass::INPUT_OUTPUT,
        0,
        &CreateWindowAux::new()
            .background_pixel(0x20252b)
            .override_redirect(1)
            .event_mask(EventMask::BUTTON_PRESS | EventMask::KEY_PRESS | EventMask::EXPOSURE),
    )?
    .check()?;
    let gc = conn.generate_id()?;
    let font = conn.generate_id()?;
    conn.open_font(font, b"fixed")?.check()?;
    conn.create_gc(gc, window, &CreateGCAux::new().font(font))?
        .check()?;
    conn.map_window(window)?.check()?;
    conn.set_input_focus(InputFocus::PARENT, window, x11rb::CURRENT_TIME)?
        .check()?;
    let mut marker = false;
    let mut dirty = true;
    let mut frame = 0u32;
    let mut interactions = 0u32;
    let origin = Instant::now();
    let end = Instant::now() + Duration::from_secs(seconds);
    while Instant::now() < end {
        let started = Instant::now();
        while let Some(event) = conn.poll_for_event()? {
            match event {
                Event::ButtonPress(e) if e.detail == 1 => {
                    marker = !marker;
                    dirty = true;
                    interactions += 1;
                    eprintln!("{{\"kind\":\"fixture-input\",\"interaction\":{interactions},\"marker\":{marker},\"elapsedMs\":{}}}", origin.elapsed().as_millis());
                }
                Event::KeyPress(_) => {
                    marker = !marker;
                    dirty = true;
                }
                Event::Expose(_) => dirty = true,
                _ => {}
            }
        }
        if dirty || mode != "static" {
            conn.change_gc(gc, &ChangeGCAux::new().foreground(0x20252b))?;
            conn.poly_fill_rectangle(
                window,
                gc,
                &[Rectangle {
                    x: 0,
                    y: 0,
                    width: 1920,
                    height: 1080,
                }],
            )?;
            conn.change_gc(gc, &ChangeGCAux::new().foreground(0xb7c4d2))?;
            let offset = if mode == "scroll" {
                (frame * 3 % 24) as i16
            } else {
                0
            };
            for line in 0..45i16 {
                let text=format!("{:04}  Synthetic editor line - bounded capture, encoder and pacing reference workload",line as u32+if mode=="scroll"{frame/8}else{0});
                conn.image_text8(window, gc, 100, 80 + line * 22 - offset, text.as_bytes())?;
            }
            if mode == "drag" {
                conn.change_gc(gc, &ChangeGCAux::new().foreground(0x517da3))?;
                // Deterministic moving application panel; ordinary app cost is
                // outside the streaming cgroup, while Xvfb readback stays inside.
                let x = (frame * 7 % 1400) as i16;
                let y = 150 + (frame * 3 % 600) as i16;
                conn.poly_fill_rectangle(
                    window,
                    gc,
                    &[Rectangle {
                        x,
                        y,
                        width: 400,
                        height: 220,
                    }],
                )?;
            }
            conn.change_gc(
                gc,
                &ChangeGCAux::new().foreground(if marker { 0xe02020 } else { 0x2030e0 }),
            )?;
            conn.poly_fill_rectangle(
                window,
                gc,
                &[Rectangle {
                    x: 12,
                    y: 12,
                    width: 64,
                    height: 64,
                }],
            )?;
            conn.flush()?;
            dirty = false;
        }
        frame = frame.wrapping_add(1);
        std::thread::sleep(Duration::from_millis(33).saturating_sub(started.elapsed()));
    }
    eprintln!(
        "{{\"kind\":\"fixture-expired\",\"interactions\":{interactions},\"elapsedMs\":{}}}",
        origin.elapsed().as_millis()
    );
    Ok(())
}
#[cfg(not(target_os = "linux"))]
fn main() -> anyhow::Result<()> {
    anyhow::bail!("Linux X11 GUI fixture only")
}
