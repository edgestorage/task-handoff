//! Native actuator boundary. Physical key translation comes from Chromium's
//! maintained keycode map; Enigo owns XTest/CGEvent/SendInput, not shell commands.
use crate::{
    channel::Input,
    traits::{Geometry, PointerMapping},
};
#[cfg(not(target_os = "macos"))]
use enigo::{Axis, Button, Coordinate, Mouse};
use enigo::{Direction, Enigo, Keyboard, Settings};
use std::collections::HashSet;
pub struct NativeInput {
    enigo: Enigo,
    #[cfg(target_os = "macos")]
    mouse: crate::platform::macos_mouse::Mouse,
    geometry: Geometry,
    pointer_mapping: PointerMapping,
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    display_geometry: Option<crate::platform::display_geometry::DisplayGeometry>,
    #[cfg(target_os = "macos")]
    window: Option<crate::platform::macos_window::Lease>,
    #[cfg(target_os = "linux")]
    window: Option<crate::platform::linux::WindowLease>,
    #[cfg(target_os = "windows")]
    window: Option<crate::platform::windows_window::Lease>,
    keys: HashSet<u16>,
    buttons: HashSet<u8>,
    wheel_x: f64,
    wheel_y: f64,
}
impl NativeInput {
    pub fn new(geometry: Geometry, display: Option<String>) -> anyhow::Result<Self> {
        Self::build(
            geometry,
            display,
            #[cfg(target_os = "macos")]
            None,
            #[cfg(target_os = "linux")]
            None,
            #[cfg(target_os = "windows")]
            None,
        )
    }
    #[cfg(target_os = "macos")]
    pub fn new_window(
        identity: crate::platform::macos_window::Identity,
        geometry: Geometry,
    ) -> anyhow::Result<Self> {
        let lease = crate::platform::macos_window::Lease::bind(identity, geometry)?;
        Self::build(geometry, None, Some(lease))
    }
    #[cfg(target_os = "linux")]
    pub fn new_window(
        window: u32,
        geometry: Geometry,
        display: Option<String>,
    ) -> anyhow::Result<Self> {
        let lease = crate::platform::linux::WindowLease::bind(window, geometry)?;
        Self::build(geometry, display, Some(lease))
    }
    #[cfg(target_os = "windows")]
    pub fn new_window(
        identity: crate::platform::windows_window::Identity,
        geometry: Geometry,
    ) -> anyhow::Result<Self> {
        let lease = crate::platform::windows_window::Lease::bind(identity, geometry)?;
        Self::build(geometry, None, Some(lease))
    }
    fn build(
        geometry: Geometry,
        display: Option<String>,
        #[cfg(target_os = "macos")] window: Option<crate::platform::macos_window::Lease>,
        #[cfg(target_os = "linux")] window: Option<crate::platform::linux::WindowLease>,
        #[cfg(target_os = "windows")] window: Option<crate::platform::windows_window::Lease>,
    ) -> anyhow::Result<Self> {
        geometry.validate()?;
        #[cfg(target_os = "windows")]
        {
            crate::platform::windows_access::prepare_dpi()?;
            crate::platform::windows_access::check()?;
        }
        #[cfg(any(target_os = "macos", target_os = "windows"))]
        let display_geometry = {
            #[cfg(target_os = "macos")]
            if window.is_some() {
                None
            } else {
                Some(crate::platform::display_geometry::DisplayGeometry::bind(
                    geometry,
                )?)
            }
            #[cfg(target_os = "windows")]
            if window.is_some() {
                None
            } else {
                Some(crate::platform::display_geometry::DisplayGeometry::bind(
                    geometry,
                )?)
            }
        };
        let settings = Settings {
            x11_display: display,
            linux_delay: 0,
            open_prompt_to_get_permissions: false,
            ..Settings::default()
        };
        let enigo = Enigo::new(&settings)
            .map_err(|_| anyhow::anyhow!(crate::error::BackendError::InputPermissionRequired))?;
        Ok(Self {
            enigo,
            #[cfg(target_os = "macos")]
            mouse: crate::platform::macos_mouse::Mouse::new()?,
            geometry,
            pointer_mapping: PointerMapping::from_geometry(geometry),
            #[cfg(any(target_os = "macos", target_os = "windows"))]
            display_geometry,
            #[cfg(target_os = "macos")]
            window,
            #[cfg(target_os = "linux")]
            window,
            #[cfg(target_os = "windows")]
            window,
            keys: HashSet::new(),
            buttons: HashSet::new(),
            wheel_x: 0.0,
            wheel_y: 0.0,
        })
    }
    pub fn validate(&self, point: Option<(i32, i32)>) -> anyhow::Result<()> {
        #[cfg(target_os = "macos")]
        if let Some(window) = &self.window {
            return window.validate(self.geometry, point);
        }
        #[cfg(target_os = "linux")]
        if let Some(window) = &self.window {
            return window.validate(self.geometry, point);
        }
        #[cfg(target_os = "windows")]
        if let Some(window) = &self.window {
            return window.validate(self.geometry, point);
        }
        let _ = point;
        #[cfg(any(target_os = "macos", target_os = "windows"))]
        if let Some(display) = &self.display_geometry {
            display.validate()?;
        }
        Ok(())
    }
    pub fn prepare(&self) -> anyhow::Result<()> {
        #[cfg(target_os = "macos")]
        if let Some(window) = &self.window {
            window.focus()?;
        }
        #[cfg(target_os = "linux")]
        if let Some(window) = &self.window {
            window.focus()?;
        }
        #[cfg(target_os = "windows")]
        if let Some(window) = &self.window {
            window.focus()?;
        }
        self.validate(None)
    }
    pub fn reconfigure(&mut self, geometry: Geometry) -> anyhow::Result<()> {
        self.release_all()?;
        #[cfg(target_os = "macos")]
        if let Some(window) = &self.window {
            anyhow::ensure!(
                window.geometry()? == geometry,
                crate::error::BackendError::GeometryChanged
            );
            self.geometry = geometry;
            self.pointer_mapping = PointerMapping::from_geometry(geometry);
            return Ok(());
        }
        #[cfg(target_os = "linux")]
        if let Some(window) = &mut self.window {
            window.reconfigure(geometry)?;
            self.geometry = geometry;
            self.pointer_mapping = PointerMapping::from_geometry(geometry);
            return Ok(());
        }
        #[cfg(target_os = "windows")]
        if let Some(window) = &self.window {
            anyhow::ensure!(
                window.geometry()? == geometry,
                crate::error::BackendError::GeometryChanged
            );
            self.geometry = geometry;
            self.pointer_mapping = PointerMapping::from_geometry(geometry);
            return Ok(());
        }
        anyhow::ensure!(
            self.geometry == geometry,
            crate::error::BackendError::GeometryChanged
        );
        self.pointer_mapping = PointerMapping::from_geometry(geometry);
        Ok(())
    }
    /// The encoded surface can contain letterbox bars around the captured
    /// window and its transient popovers. Keep that viewport separate from the
    /// native window geometry used for focus and hit validation.
    pub fn set_pointer_mapping(&mut self, mapping: PointerMapping) -> anyhow::Result<()> {
        self.pointer_mapping = mapping;
        Ok(())
    }
    pub fn pointer(&mut self, x: f64, y: f64) -> anyhow::Result<()> {
        self.validate(None)?;
        #[cfg(target_os = "windows")]
        crate::platform::windows_access::check()?;
        let (x, y) = self.pointer_mapping.map(x, y)?;
        #[cfg(target_os = "macos")]
        {
            static POINTER_TRACE: std::sync::atomic::AtomicUsize =
                std::sync::atomic::AtomicUsize::new(0);
            let count = POINTER_TRACE.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            if count < 20 || count.is_multiple_of(12) {
                eprintln!(
                    "REMOTE_DESKTOP_INPUT_TRACE phase=driver.pointer mappedX={x} mappedY={y}"
                );
            }
            self.mouse.pointer((x, y), &self.buttons)?;
        }
        #[cfg(not(target_os = "macos"))]
        {
            self.enigo
                .move_mouse(x, y, Coordinate::Abs)
                .map_err(|_| anyhow::anyhow!("REMOTE_DESKTOP_INPUT_FAILED"))?;
        }
        self.validate(Some((x, y)))
    }
    pub fn apply(&mut self, event: &Input) -> anyhow::Result<()> {
        self.validate(None)?;
        #[cfg(target_os = "windows")]
        crate::platform::windows_access::check()?;
        let result = match event {
            Input::Key(k) => {
                if k.repeat {
                    return Ok(());
                }
                let code = k
                    .code
                    .parse::<keycode::KeyMappingCode>()
                    .map_err(|_| anyhow::anyhow!("REMOTE_DESKTOP_UNSUPPORTED_KEY"))?;
                let map = keycode::KeyMap::from(code);
                #[cfg(target_os = "macos")]
                let raw = map.mac;
                #[cfg(target_os = "windows")]
                let raw = map.win;
                #[cfg(not(any(target_os = "macos", target_os = "windows")))]
                let raw = map.xkb;
                // 0xffff denotes an unmapped native key; macOS KeyA legitimately is 0.
                anyhow::ensure!(raw != 0xffff, "REMOTE_DESKTOP_UNSUPPORTED_KEY");
                if k.down {
                    if !self.keys.insert(raw) {
                        return Ok(());
                    }
                } else if !self.keys.contains(&raw) {
                    return Ok(());
                }
                let result = self.enigo.raw(
                    raw,
                    if k.down {
                        Direction::Press
                    } else {
                        Direction::Release
                    },
                );
                if !k.down && result.is_ok() {
                    self.keys.remove(&raw);
                }
                result
            }
            Input::Button(b) => {
                self.pointer(b.x, b.y)?;
                #[cfg(not(target_os = "macos"))]
                let button = button(b.button)?;
                if b.down {
                    if !self.buttons.insert(b.button) {
                        return Ok(());
                    }
                } else if !self.buttons.contains(&b.button) {
                    return Ok(());
                }
                #[cfg(target_os = "macos")]
                let result = {
                    let (mapped_x, mapped_y) = self.pointer_mapping.map(b.x, b.y)?;
                    eprintln!(
                        "REMOTE_DESKTOP_INPUT_TRACE phase=driver.button epoch={} button={} down={} normalizedX={:.4} normalizedY={:.4} mappedX={mapped_x} mappedY={mapped_y}",
                        b.input_epoch, b.button, b.down, b.x, b.y
                    );
                    self.mouse
                        .button((mapped_x, mapped_y), b.button, b.down)
                        .map_err(|_| enigo::InputError::Simulate("native mouse event failed"))
                };
                #[cfg(not(target_os = "macos"))]
                let result = self.enigo.button(
                    button,
                    if b.down {
                        Direction::Press
                    } else {
                        Direction::Release
                    },
                );
                if !b.down && result.is_ok() {
                    self.buttons.remove(&b.button);
                }
                result
            }
            Input::Wheel(w) => {
                self.pointer(w.x, w.y)?;
                let steps_x = take_wheel_steps(&mut self.wheel_x, w.delta_x);
                let steps_y = take_wheel_steps(&mut self.wheel_y, w.delta_y);
                #[cfg(target_os = "macos")]
                {
                    if steps_x == 0 && steps_y == 0 {
                        Ok(())
                    } else {
                        self.mouse
                            .wheel(
                                self.pointer_mapping.map(w.x, w.y)?,
                                steps_x as f64 * WHEEL_STEP_DELTA,
                                steps_y as f64 * WHEEL_STEP_DELTA,
                            )
                            .map_err(|_| enigo::InputError::Simulate("native wheel event failed"))
                    }
                }
                #[cfg(not(target_os = "macos"))]
                {
                    if steps_x != 0 {
                        self.enigo.scroll(steps_x, Axis::Horizontal)?;
                    }
                    if steps_y != 0 {
                        self.enigo.scroll(steps_y, Axis::Vertical)?;
                    }
                    Ok(())
                }
            }
            Input::Text(_) => anyhow::bail!("REMOTE_DESKTOP_TEXT_REQUIRES_LEASE"),
        };
        result.map_err(|_| anyhow::anyhow!("REMOTE_DESKTOP_INPUT_FAILED"))
    }
    /// Text can take longer than the reliable queue budget. Keep the batch
    /// cooperative with the guard's monotonic lease and parent lifetime, rather
    /// than blocking in one uninterruptible library call for the whole string.
    pub fn text_while(
        &mut self,
        text: &str,
        mut permitted: impl FnMut() -> bool,
    ) -> anyhow::Result<bool> {
        self.release_all()?;
        for character in text.chars() {
            self.validate(None)?;
            #[cfg(target_os = "windows")]
            crate::platform::windows_access::check()?;
            if !permitted() {
                return Ok(false);
            }
            let mut buffer = [0; 4];
            self.enigo
                .text(character.encode_utf8(&mut buffer))
                .map_err(|_| anyhow::anyhow!("REMOTE_DESKTOP_INPUT_FAILED"))?;
        }
        Ok(permitted())
    }
    pub fn release_all(&mut self) -> anyhow::Result<()> {
        let mut failed = false;
        for code in self.keys.clone() {
            if self.enigo.raw(code, Direction::Release).is_ok() {
                self.keys.remove(&code);
            } else {
                failed = true;
            }
        }
        for code in self.buttons.clone() {
            #[cfg(target_os = "macos")]
            let released = self.mouse.release(code).is_ok();
            #[cfg(not(target_os = "macos"))]
            let released = self.enigo.button(button(code)?, Direction::Release).is_ok();
            if released {
                self.buttons.remove(&code);
            } else {
                failed = true;
            }
        }
        anyhow::ensure!(!failed, "REMOTE_DESKTOP_INPUT_RELEASE_FAILED");
        Ok(())
    }
}
impl Drop for NativeInput {
    fn drop(&mut self) {
        let _ = self.release_all();
    }
}
const WHEEL_STEP_DELTA: f64 = 40.0;

/// Preserve movement smaller than one native wheel notch across events. Touch
/// scrolling arrives as a stream of fractional deltas; rounding every event in
/// isolation drops most of them and makes the remote view advance in bursts.
fn take_wheel_steps(remainder: &mut f64, delta: f64) -> i32 {
    let total = *remainder + delta;
    let steps = (total / WHEEL_STEP_DELTA).round() as i32;
    *remainder = total - steps as f64 * WHEEL_STEP_DELTA;
    steps
}
#[cfg(not(target_os = "macos"))]
fn button(code: u8) -> anyhow::Result<Button> {
    Ok(match code {
        0 => Button::Left,
        1 => Button::Middle,
        2 => Button::Right,
        3 => Button::Back,
        4 => Button::Forward,
        _ => anyhow::bail!("REMOTE_DESKTOP_UNSUPPORTED_BUTTON"),
    })
}
pub fn map_point(g: Geometry, x: f64, y: f64) -> anyhow::Result<(i32, i32)> {
    anyhow::ensure!(
        x.is_finite() && y.is_finite() && (0.0..=1.0).contains(&x) && (0.0..=1.0).contains(&y),
        "REMOTE_DESKTOP_INVALID_COORDINATES"
    );
    // Geometry is always in actuator coordinates. Capture pixels/Retina/DPI are
    // converted by the platform producer, never guessed again by an input reader.
    let px = g.x as f64 + x * g.width.saturating_sub(1) as f64;
    let py = g.y as f64 + y * g.height.saturating_sub(1) as f64;
    anyhow::ensure!(
        px >= i32::MIN as f64
            && px <= i32::MAX as f64
            && py >= i32::MIN as f64
            && py <= i32::MAX as f64,
        "REMOTE_DESKTOP_INVALID_GEOMETRY"
    );
    Ok((px.round() as i32, py.round() as i32))
}

#[cfg(test)]
mod tests {
    use super::{map_point, take_wheel_steps};
    use crate::traits::{Geometry, NormalizedRect, PointerMapping};

    #[test]
    fn wheel_remainder_accumulates_sub_notches() {
        let mut remainder = 0.0;
        assert_eq!(take_wheel_steps(&mut remainder, 10.0), 0);
        assert_eq!(take_wheel_steps(&mut remainder, 10.0), 1);
        assert_eq!(remainder, -20.0);
        assert_eq!(take_wheel_steps(&mut remainder, 10.0), 0);
        assert_eq!(take_wheel_steps(&mut remainder, 10.0), 0);
        assert_eq!(remainder, 0.0);
    }

    #[test]
    fn wheel_remainder_preserves_overshoot_and_direction_changes() {
        let mut remainder = 0.0;
        assert_eq!(take_wheel_steps(&mut remainder, 25.0), 1);
        assert_eq!(remainder, -15.0);
        assert_eq!(take_wheel_steps(&mut remainder, -25.0), -1);
        assert_eq!(remainder, 0.0);
        assert_eq!(take_wheel_steps(&mut remainder, -10.0), 0);
        assert_eq!(take_wheel_steps(&mut remainder, -30.0), -1);
        assert_eq!(remainder, 0.0);
    }

    #[test]
    fn captured_content_rect_maps_normalized_pointer_into_screen_space() {
        let content = Geometry {
            x: 400,
            y: 120,
            width: 801,
            height: 601,
            scale: 1.0,
        };
        assert_eq!(map_point(content, 0.0, 0.0).unwrap(), (400, 120));
        assert_eq!(map_point(content, 0.5, 0.5).unwrap(), (800, 420));
        assert_eq!(map_point(content, 1.0, 1.0).unwrap(), (1200, 720));
    }

    #[test]
    fn letterboxed_pointer_mapping_uses_the_content_viewport() {
        let mapping = PointerMapping::new(
            Geometry {
                x: -149,
                y: 30,
                width: 1794,
                height: 1050,
                scale: 1.0,
            },
            NormalizedRect::new(0.0, 0.0, 1.0, 811.204 / 1050.0).unwrap(),
        )
        .unwrap();
        assert_eq!(mapping.map(0.5, 811.204 / 2100.0).unwrap(), (748, 555));
        assert_eq!(mapping.map(0.5, 1.0).unwrap(), (748, 1079));
    }
}
