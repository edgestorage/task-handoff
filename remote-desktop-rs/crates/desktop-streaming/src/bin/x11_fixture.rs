//! Disposable high-entropy GUI workload for bounded G1 network/load tests.
//! DISPLAY/XAUTHORITY must point to the owned test surface. Never discovers one.
#[cfg(target_os = "linux")]
fn main() -> anyhow::Result<()> {
    use rand::RngCore;
    use x11rb::{connection::Connection, protocol::xproto::*};
    let display = std::env::var("DISPLAY")?;
    anyhow::ensure!(
        std::env::var_os("XAUTHORITY").is_some(),
        "explicit test authority required"
    );
    let (conn, screen) = x11rb::connect(Some(&display))?;
    let root = &conn.setup().roots[screen];
    let window = conn.generate_id()?;
    conn.create_window(
        root.root_depth,
        window,
        root.root,
        40,
        40,
        640,
        360,
        0,
        WindowClass::INPUT_OUTPUT,
        0,
        &CreateWindowAux::new().background_pixel(0),
    )?
    .check()?;
    conn.change_property(
        PropMode::REPLACE,
        window,
        AtomEnum::WM_NAME,
        AtomEnum::STRING,
        8,
        24,
        b"G1 bounded noise fixture",
    )?
    .check()?;
    let gc = conn.generate_id()?;
    conn.create_gc(gc, window, &CreateGCAux::new())?.check()?;
    conn.map_window(window)?.check()?;
    let mut pixels = vec![0; 640 * 360 * 4];
    let mut rng = rand::rng();
    let end = std::time::Instant::now() + std::time::Duration::from_secs(30);
    while std::time::Instant::now() < end {
        let start = std::time::Instant::now();
        rng.fill_bytes(&mut pixels);
        // Each request fits the base X11 request-size limit, no raw frame queue.
        for row in (0..360).step_by(12) {
            conn.put_image(
                ImageFormat::Z_PIXMAP,
                window,
                gc,
                640,
                12,
                0,
                row as i16,
                0,
                root.root_depth,
                &pixels[row * 640 * 4..(row + 12) * 640 * 4],
            )?;
        }
        conn.flush()?;
        std::thread::sleep(std::time::Duration::from_millis(33).saturating_sub(start.elapsed()));
    }
    Ok(())
}
#[cfg(not(target_os = "linux"))]
fn main() -> anyhow::Result<()> {
    anyhow::bail!("Linux X11 test fixture only")
}
