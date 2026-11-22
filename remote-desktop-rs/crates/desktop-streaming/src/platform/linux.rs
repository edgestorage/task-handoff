//! X11/XShm/XDamage and XFixes. The connection owns all native handles; no
//! display/handle identifiers enter a public session or persisted business model.
use crate::{
    catalog::{CaptureSource, Catalog, CatalogError, NativeSource},
    error::BackendError,
    traits::{Geometry, RawFrame, WindowResizeTarget},
};
use std::{
    fs::File,
    os::unix::fs::FileExt,
    thread,
    time::{Duration, Instant},
};
use x11rb::{
    connection::Connection,
    protocol::{
        composite::{ConnectionExt as _, Redirect},
        damage::{ConnectionExt as _, ReportLevel},
        randr::ConnectionExt as _,
        shm::ConnectionExt as _,
        xfixes::ConnectionExt as _,
        xproto::{
            Atom, AtomEnum, ChangeWindowAttributesAux, ConfigureWindowAux, ConnectionExt as _,
            EventMask, ImageFormat, ImageOrder, InputFocus, MapState, Pixmap, StackMode, Window,
        },
        xtest::ConnectionExt as _,
        Event,
    },
    rust_connection::RustConnection,
};
#[derive(Clone)]
pub struct Config {
    pub display: String,
    pub cookie: Option<Vec<u8>>,
    pub authority: Option<std::path::PathBuf>,
    pub include_cursor: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Probe {
    pub has_window_manager: bool,
}

/// Non-destructive X11 capability check shared by preflight and surface
/// resolution. It opens one connection and validates every extension used by
/// capture, pointer input, keyboard input, and window enumeration.
pub fn probe(config: &Config) -> anyhow::Result<Probe> {
    let (conn, screen_index) = connect(config)?;
    initialize(&conn)?;
    conn.randr_query_version(1, 2)?.reply()?;
    conn.composite_query_version(0, 4)?.reply()?;
    conn.xtest_get_version(2, 2)?.reply()?;
    let screen = &conn.setup().roots[screen_index];
    validate_visual(&conn, screen_index, screen.root_depth, screen.root_visual)?;
    Ok(Probe {
        has_window_manager: window_manager_present(&conn, screen.root)?,
    })
}
#[derive(Clone)]
pub struct DisplayTarget {
    config: Config,
    output: String,
    geometry: Geometry,
}
impl DisplayTarget {
    pub fn source(&self, show_cursor: bool) -> anyhow::Result<crate::capture::Source> {
        let mut config = self.config.clone();
        config.include_cursor = show_cursor;
        let capture = if self.output.is_empty() {
            Capture::open(&config)?
        } else {
            Capture::open_output(&config, &self.output, self.geometry)?
        };
        Ok(crate::capture::Source::X11(Box::new(capture)))
    }
}
impl Config {
    pub fn environment(include_cursor: bool) -> anyhow::Result<Self> {
        Ok(Self {
            display: std::env::var("DISPLAY")
                .map_err(|_| anyhow::anyhow!(BackendError::NoInteractiveSession))?,
            cookie: None,
            authority: None,
            include_cursor,
        })
    }
}
#[derive(Clone, Copy)]
struct WindowHandle {
    window: Window,
    pid: Option<u32>,
}
#[derive(Clone)]
pub struct WindowTarget {
    config: Config,
    handle: WindowHandle,
}
impl WindowTarget {
    pub fn open(&self, include_cursor: bool) -> anyhow::Result<Capture> {
        let mut config = self.config.clone();
        config.include_cursor = include_cursor;
        Capture::open_window(&config, self.handle.window, self.handle.pid)
    }
    pub fn window_id(&self) -> Window {
        self.handle.window
    }
}
enum DrawableTarget {
    Display,
    Window(WindowHandle),
}
#[derive(Clone)]
struct PopupPolicy {
    pid: u32,
    wm_pid: Atom,
    wm_window_type: Atom,
    kinds: Vec<Atom>,
}
impl PopupPolicy {
    fn new(conn: &RustConnection, pid: Option<u32>) -> anyhow::Result<Option<Self>> {
        let Some(pid) = pid else {
            return Ok(None);
        };
        Ok(Some(Self {
            pid,
            wm_pid: x11_atom(conn, b"_NET_WM_PID")?,
            wm_window_type: x11_atom(conn, b"_NET_WM_WINDOW_TYPE")?,
            kinds: [
                "_NET_WM_WINDOW_TYPE_MENU",
                "_NET_WM_WINDOW_TYPE_DROPDOWN_MENU",
                "_NET_WM_WINDOW_TYPE_POPUP_MENU",
                "_NET_WM_WINDOW_TYPE_TOOLTIP",
                "_NET_WM_WINDOW_TYPE_COMBO",
                "_NET_WM_WINDOW_TYPE_DND",
            ]
            .iter()
            .map(|name| x11_atom(conn, name.as_bytes()))
            .collect::<anyhow::Result<Vec<_>>>()?,
        }))
    }
    fn allows(&self, conn: &RustConnection, root: Window, window: Window) -> anyhow::Result<bool> {
        if window == x11rb::NONE {
            return Ok(false);
        }
        let attributes = conn.get_window_attributes(window)?.reply()?;
        if attributes.map_state != MapState::VIEWABLE || !attributes.override_redirect {
            return Ok(false);
        }
        let tree = conn.query_tree(window)?.reply()?;
        if tree.parent != root {
            return Ok(false);
        }
        let pid = property_u32(conn, window, self.wm_pid, AtomEnum::CARDINAL)
            .and_then(|values| values.first().copied());
        if pid != Some(self.pid) {
            return Ok(false);
        }
        Ok(
            property_atoms(conn, window, self.wm_window_type, AtomEnum::ATOM)
                .unwrap_or_default()
                .iter()
                .any(|kind| self.kinds.contains(kind)),
        )
    }
}
struct PopupCapture {
    window: Window,
    damage: u32,
}
struct CompositeWindow {
    window: Window,
    pixmap: Pixmap,
    depth: u8,
    x: i32,
    y: i32,
    width: u16,
    height: u16,
}
struct CompositeCapture {
    window: Window,
    windows: Vec<CompositeWindow>,
}
pub struct Capture {
    conn: RustConnection,
    root: Window,
    target: DrawableTarget,
    segment: u32,
    damage: u32,
    file: File,
    geometry: Geometry,
    base: Vec<u8>,
    dirty: bool,
    include_cursor: bool,
    capture_origin: (i16, i16),
    display_output: Option<String>,
    last_cursor: (i16, i16, u32),
    popup_policy: Option<PopupPolicy>,
    popups: Vec<PopupCapture>,
    composite: Option<CompositeCapture>,
    composite_dirty: bool,
}
impl Capture {
    pub fn open(config: &Config) -> anyhow::Result<Self> {
        anyhow::ensure!(
            std::env::var_os("WSL_DISTRO_NAME").is_none(),
            BackendError::WslUnsupported
        );
        let (conn, screen_index) = connect(config)?;
        initialize(&conn)?;
        let setup = conn.setup();
        let screen = &setup.roots[screen_index];
        let root = screen.root;
        let geometry = Geometry {
            x: 0,
            y: 0,
            width: screen.width_in_pixels.into(),
            height: screen.height_in_pixels.into(),
            scale: 1.0,
        };
        validate_geometry(geometry)?;
        validate_visual(&conn, screen_index, screen.root_depth, screen.root_visual)?;
        Self::create(
            conn,
            root,
            DrawableTarget::Display,
            geometry,
            config.include_cursor,
            None,
        )
    }
    pub fn open_output(config: &Config, output: &str, geometry: Geometry) -> anyhow::Result<Self> {
        anyhow::ensure!(
            std::env::var_os("WSL_DISTRO_NAME").is_none(),
            BackendError::WslUnsupported
        );
        validate_geometry(geometry)?;
        let (conn, screen_index) = connect(config)?;
        initialize(&conn)?;
        let (root, depth, visual) = {
            let screen = &conn.setup().roots[screen_index];
            (screen.root, screen.root_depth, screen.root_visual)
        };
        validate_visual(&conn, screen_index, depth, visual)?;
        Self::create(
            conn,
            root,
            DrawableTarget::Display,
            geometry,
            config.include_cursor,
            Some(output.to_owned()),
        )
    }
    pub fn open_window(
        config: &Config,
        window: Window,
        expected_pid: Option<u32>,
    ) -> anyhow::Result<Self> {
        anyhow::ensure!(
            std::env::var_os("WSL_DISTRO_NAME").is_none(),
            BackendError::WslUnsupported
        );
        let (conn, screen_index) = connect(config)?;
        initialize(&conn)?;
        let root = conn.setup().roots[screen_index].root;
        let attributes = conn.get_window_attributes(window)?.reply()?;
        anyhow::ensure!(
            attributes.map_state == MapState::VIEWABLE,
            BackendError::WindowUnavailable
        );
        let pid = match expected_pid {
            Some(pid) => {
                anyhow::ensure!(
                    window_pid(&conn, window)? == Some(pid),
                    BackendError::WindowUnavailable
                );
                Some(pid)
            }
            None => window_pid(&conn, window)?,
        };
        let geometry = window_frame_geometry(&conn, root, window)?;
        let depth = conn.get_geometry(window)?.reply()?.depth;
        validate_geometry(geometry)?;
        validate_visual(&conn, screen_index, depth, attributes.visual)?;
        Self::create(
            conn,
            root,
            DrawableTarget::Window(WindowHandle { window, pid }),
            geometry,
            config.include_cursor,
            None,
        )
    }
    fn create(
        conn: RustConnection,
        root: Window,
        target: DrawableTarget,
        geometry: Geometry,
        include_cursor: bool,
        display_output: Option<String>,
    ) -> anyhow::Result<Self> {
        let (segment, file) = allocate_shm(&conn, geometry)?;
        let damage = conn.generate_id()?;
        conn.damage_create(damage, drawable(&target, root), ReportLevel::NON_EMPTY)?
            .check()?;
        let popup_policy = match &target {
            DrawableTarget::Display => None,
            DrawableTarget::Window(handle) => PopupPolicy::new(&conn, handle.pid)?,
        };
        let capture_origin = match &target {
            DrawableTarget::Display => (
                i16::try_from(geometry.x)
                    .map_err(|_| anyhow::anyhow!(BackendError::InvalidGeometry))?,
                i16::try_from(geometry.y)
                    .map_err(|_| anyhow::anyhow!(BackendError::InvalidGeometry))?,
            ),
            DrawableTarget::Window(_) => (0, 0),
        };
        let mut capture = Self {
            conn,
            root,
            target,
            segment,
            damage,
            file,
            geometry,
            base: vec![0; frame_bytes(geometry)?],
            dirty: true,
            include_cursor,
            capture_origin,
            display_output,
            last_cursor: (i16::MIN, i16::MIN, 0),
            popup_policy,
            popups: Vec::new(),
            composite: None,
            composite_dirty: false,
        };
        if capture.popup_policy.is_some() {
            capture
                .conn
                .change_window_attributes(
                    root,
                    &ChangeWindowAttributesAux::new().event_mask(EventMask::SUBSTRUCTURE_NOTIFY),
                )?
                .check()?;
            capture.refresh_popups()?;
        }
        capture.enable_composite();
        capture.conn.flush()?;
        Ok(capture)
    }
    pub fn geometry(&self) -> Geometry {
        self.geometry
    }
    pub fn window_input(&self) -> Option<(Window, Geometry)> {
        match self.target {
            DrawableTarget::Window(handle) => Some((handle.window, self.geometry)),
            DrawableTarget::Display => None,
        }
    }
    fn drawable(&self) -> u32 {
        drawable(&self.target, self.root)
    }
    fn current_geometry(&self) -> anyhow::Result<Geometry> {
        match self.target {
            DrawableTarget::Display => match &self.display_output {
                Some(output) => monitor_geometry(&self.conn, self.root, output),
                None => {
                    let actual = self.conn.get_geometry(self.root)?.reply()?;
                    Ok(Geometry {
                        x: 0,
                        y: 0,
                        width: actual.width.into(),
                        height: actual.height.into(),
                        scale: 1.0,
                    })
                }
            },
            DrawableTarget::Window(handle) => {
                window_frame_geometry(&self.conn, self.root, handle.window)
            }
        }
    }
    fn apply_geometry(&mut self, geometry: Geometry) -> anyhow::Result<()> {
        validate_geometry(geometry)?;
        if geometry.width != self.geometry.width || geometry.height != self.geometry.height {
            let (segment, file) = allocate_shm(&self.conn, geometry)?;
            self.conn.shm_detach(self.segment)?.check()?;
            self.segment = segment;
            self.file = file;
            self.base = vec![0; frame_bytes(geometry)?];
            self.dirty = true;
        }
        self.geometry = geometry;
        Ok(())
    }
    pub fn refresh_geometry(&mut self) -> anyhow::Result<Geometry> {
        match self.target {
            DrawableTarget::Display => {
                let actual = self.current_geometry()?;
                anyhow::ensure!(actual == self.geometry, BackendError::GeometryChanged);
            }
            DrawableTarget::Window(_) => self.apply_geometry(self.current_geometry()?)?,
        }
        Ok(self.geometry)
    }
    pub fn frame(&mut self, force: bool) -> anyhow::Result<Option<RawFrame>> {
        while let Some(event) = self.conn.poll_for_event()? {
            match event {
                Event::DamageNotify(_) => self.dirty = true,
                Event::MapNotify(event) => self.handle_structure_event(event.window)?,
                Event::UnmapNotify(event) => self.handle_structure_event(event.window)?,
                Event::DestroyNotify(event) => self.handle_structure_event(event.window)?,
                Event::ConfigureNotify(event) => self.handle_structure_event(event.window)?,
                Event::CirculateNotify(event) => self.handle_structure_event(event.window)?,
                _ => {}
            }
        }
        let actual = self.current_geometry()?;
        match self.target {
            DrawableTarget::Display => anyhow::ensure!(
                actual.width == self.geometry.width && actual.height == self.geometry.height,
                BackendError::GeometryChanged
            ),
            DrawableTarget::Window(_) => self.apply_geometry(actual)?,
        }
        if self.composite_dirty && self.composite.is_some() && self.refresh_composite().is_err() {
            self.disable_composite();
        }
        let cursor = if self.include_cursor {
            Some(self.conn.xfixes_get_cursor_image()?.reply()?)
        } else {
            None
        };
        let cursor_changed = cursor
            .as_ref()
            .is_some_and(|cursor| self.last_cursor != (cursor.x, cursor.y, cursor.cursor_serial));
        if !self.dirty && !cursor_changed && !force {
            return Ok(None);
        }
        if self.dirty {
            // NON_EMPTY reports only empty -> nonempty transitions. Acknowledge
            // before reading: a redraw after the read must produce another event,
            // rather than being swallowed by a subsequent subtraction. See the
            // deterministic concurrent-redraw regression in linux_surface.rs.
            self.conn
                .damage_subtract(self.damage, 0u32, 0u32)?
                .check()?;
            for popup in &self.popups {
                self.conn
                    .damage_subtract(popup.damage, 0u32, 0u32)?
                    .check()?;
            }
            if self.composite.is_some() && self.read_composite_frame().is_err() {
                self.disable_composite();
            }
            if self.composite.is_none() {
                self.read_direct_frame()?;
            }
            self.dirty = false;
        }
        let mut bgra = self.base.clone();
        if self.composite.is_none() {
            self.composite_popups(&mut bgra)?;
        }
        if let Some(cursor) = cursor {
            self.last_cursor = (cursor.x, cursor.y, cursor.cursor_serial);
            for row in 0..cursor.height as usize {
                for col in 0..cursor.width as usize {
                    let x = cursor.x as i32 - cursor.xhot as i32 + col as i32 - self.geometry.x;
                    let y = cursor.y as i32 - cursor.yhot as i32 + row as i32 - self.geometry.y;
                    if x < 0
                        || y < 0
                        || x >= self.geometry.width as i32
                        || y >= self.geometry.height as i32
                    {
                        continue;
                    }
                    let argb = cursor.cursor_image[row * cursor.width as usize + col];
                    let a = (argb >> 24) & 255;
                    let offset = (y as usize * self.geometry.width as usize + x as usize) * 4;
                    for c in 0..3 {
                        let src = (argb >> (c * 8)) & 255;
                        let dst = bgra[offset + c] as u32;
                        bgra[offset + c] = (src + (dst * (255 - a) + 127) / 255).min(255) as u8;
                    }
                    bgra[offset + 3] = 255;
                }
            }
        }
        Ok(Some(RawFrame {
            bgra,
            stride: self.geometry.width as usize * 4,
            geometry: self.geometry,
            captured_at: Instant::now(),
        }))
    }
    fn enable_composite(&mut self) {
        if !matches!(self.target, DrawableTarget::Window(_)) {
            return;
        }
        if self.try_enable_composite().is_err() {
            self.disable_composite();
        }
    }
    fn try_enable_composite(&mut self) -> anyhow::Result<()> {
        let extension = self.conn.query_extension(b"Composite")?.reply()?;
        if !extension.present {
            return Ok(());
        }
        let version = self.conn.composite_query_version(0, 4)?.reply()?;
        if version.major_version != 0 || version.minor_version < 2 {
            return Ok(());
        }
        let Some(top_level) = self.target_top_level()? else {
            return Ok(());
        };
        self.composite = Some(CompositeCapture {
            window: top_level,
            windows: Vec::new(),
        });
        self.composite_dirty = true;
        self.refresh_composite()
    }
    fn refresh_composite(&mut self) -> anyhow::Result<()> {
        let Some(composite) = self.composite.as_ref() else {
            self.composite_dirty = false;
            return Ok(());
        };
        let top_level = composite.window;
        anyhow::ensure!(
            self.target_top_level()?
                .is_some_and(|window| window == top_level),
            BackendError::WindowUnavailable
        );
        let target_geometry = self.geometry;
        let mut desired = Vec::with_capacity(self.popups.len() + 1);
        desired.push(top_level);
        desired.extend(self.popups.iter().map(|popup| popup.window));
        let conn = &self.conn;
        let root = self.root;
        let composite = self.composite.as_mut().expect("composite checked above");
        let mut previous = std::mem::take(&mut composite.windows);
        let mut next = Vec::with_capacity(desired.len());
        let outcome = (|| -> anyhow::Result<()> {
            for window in desired {
                let geometry = if window == top_level {
                    target_geometry
                } else {
                    match window_geometry(conn, root, window) {
                        Ok(geometry) => geometry,
                        Err(_) => continue,
                    }
                };
                let depth = conn.get_geometry(window)?.reply()?.depth;
                let existing = previous.iter().position(|capture| capture.window == window);
                let reused = existing.is_some();
                let entry =
                    existing
                        .map(|index| previous.swap_remove(index))
                        .unwrap_or(CompositeWindow {
                            window,
                            pixmap: 0,
                            depth,
                            x: geometry.x,
                            y: geometry.y,
                            width: geometry.width as u16,
                            height: geometry.height as u16,
                        });
                next.push(entry);
                let entry = next.last_mut().unwrap();
                if !reused {
                    conn.composite_redirect_window(window, Redirect::AUTOMATIC)?
                        .check()?;
                }
                if entry.pixmap != 0 {
                    conn.free_pixmap(entry.pixmap)?.check()?;
                }
                entry.pixmap = conn.generate_id()?;
                conn.composite_name_window_pixmap(window, entry.pixmap)?
                    .check()?;
                entry.depth = depth;
                entry.x = geometry.x;
                entry.y = geometry.y;
                entry.width = geometry.width as u16;
                entry.height = geometry.height as u16;
            }
            Ok(())
        })();
        if let Err(error) = outcome {
            previous.extend(next);
            composite.windows = previous;
            return Err(error);
        }
        for removed in previous {
            release_composite_window(conn, &removed);
        }
        composite.windows = next;
        self.composite_dirty = false;
        Ok(())
    }
    fn disable_composite(&mut self) {
        let Some(composite) = self.composite.take() else {
            self.composite_dirty = false;
            return;
        };
        for window in &composite.windows {
            release_composite_window(&self.conn, window);
        }
        self.composite_dirty = false;
        self.dirty = true;
    }
    fn read_composite_frame(&mut self) -> anyhow::Result<()> {
        let geometry = self.geometry;
        let stride = geometry.width as usize * 4;
        let mut frame = vec![0; frame_bytes(geometry)?];
        let windows: Vec<_> = self
            .composite
            .as_ref()
            .expect("composite checked by caller")
            .windows
            .iter()
            .map(|window| {
                (
                    window.pixmap,
                    window.depth,
                    window.x,
                    window.y,
                    window.width,
                    window.height,
                )
            })
            .collect();
        let target_right = geometry.x + geometry.width as i32;
        let target_bottom = geometry.y + geometry.height as i32;
        for (index, (pixmap, depth, x, y, width, height)) in windows.into_iter().enumerate() {
            let left = geometry.x.max(x);
            let top = geometry.y.max(y);
            let right = target_right.min(x + width as i32);
            let bottom = target_bottom.min(y + height as i32);
            if left >= right || top >= bottom {
                continue;
            }
            let width = (right - left) as u16;
            let height = (bottom - top) as u16;
            let pixels = match self.read_pixels(
                pixmap,
                (left - x) as i16,
                (top - y) as i16,
                width,
                height,
            ) {
                Ok(pixels) => pixels,
                Err(error) if index == 0 => return Err(error),
                Err(_) => continue,
            };
            let destination_x = (left - geometry.x) as usize;
            let destination_y = (top - geometry.y) as usize;
            if index == 0 || depth != 32 {
                copy_bgra_rect(
                    &mut frame,
                    stride,
                    destination_x,
                    destination_y,
                    &pixels,
                    width as usize,
                    height as usize,
                );
            } else {
                blend_bgra_rect(
                    &mut frame,
                    stride,
                    destination_x,
                    destination_y,
                    &pixels,
                    width as usize,
                    height as usize,
                );
            }
        }
        self.base = frame;
        Ok(())
    }
    fn read_direct_frame(&mut self) -> anyhow::Result<()> {
        let DrawableTarget::Window(handle) = &self.target else {
            self.conn
                .shm_get_image(
                    self.drawable(),
                    self.capture_origin.0,
                    self.capture_origin.1,
                    self.geometry.width as u16,
                    self.geometry.height as u16,
                    u32::MAX,
                    ImageFormat::Z_PIXMAP.into(),
                    self.segment,
                    0,
                )?
                .reply()?;
            self.file.read_exact_at(&mut self.base, 0)?;
            return Ok(());
        };
        // Without XComposite only the client drawable is available. Keep the
        // visible window rectangle and place the client at its frame-relative
        // origin so geometry and pointer input remain aligned.
        let frame = self.geometry;
        let client = window_geometry(&self.conn, self.root, handle.window)?;
        self.base.fill(0);
        let target_right = frame.x.saturating_add(frame.width as i32);
        let target_bottom = frame.y.saturating_add(frame.height as i32);
        let client_right = client.x.saturating_add(client.width as i32);
        let client_bottom = client.y.saturating_add(client.height as i32);
        let left = frame.x.max(client.x);
        let top = frame.y.max(client.y);
        let right = target_right.min(client_right);
        let bottom = target_bottom.min(client_bottom);
        if left >= right || top >= bottom {
            return Ok(());
        }
        let width = (right - left) as u16;
        let height = (bottom - top) as u16;
        let pixels = self.read_pixels(
            handle.window,
            (left - client.x) as i16,
            (top - client.y) as i16,
            width,
            height,
        )?;
        let frame_stride = frame.width as usize * 4;
        let source_stride = width as usize * 4;
        let destination_x = (left - frame.x) as usize;
        let destination_y = (top - frame.y) as usize;
        for row in 0..height as usize {
            let source = row * source_stride;
            let destination = (destination_y + row) * frame_stride + destination_x * 4;
            self.base[destination..destination + source_stride]
                .copy_from_slice(&pixels[source..source + source_stride]);
            for alpha in (destination + 3..destination + source_stride).step_by(4) {
                self.base[alpha] = 255;
            }
        }
        Ok(())
    }
    fn handle_structure_event(&mut self, window: Window) -> anyhow::Result<()> {
        let affects_capture = self.event_affects_capture(window)?;
        let popups_changed = self.refresh_popups()?;
        if affects_capture || popups_changed {
            self.dirty = true;
            self.composite_dirty |= self.composite.is_some();
        }
        Ok(())
    }
    fn event_affects_capture(&self, window: Window) -> anyhow::Result<bool> {
        if self.popups.iter().any(|popup| popup.window == window) {
            return Ok(true);
        }
        Ok(self
            .target_top_level()?
            .is_some_and(|top_level| top_level == window))
    }
    fn target_top_level(&self) -> anyhow::Result<Option<Window>> {
        let DrawableTarget::Window(handle) = &self.target else {
            return Ok(None);
        };
        Ok(Some(top_level_window(
            &self.conn,
            self.root,
            handle.window,
        )?))
    }
    fn refresh_popups(&mut self) -> anyhow::Result<bool> {
        let Some(policy) = self.popup_policy.clone() else {
            return Ok(false);
        };
        let Some(target_top_level) = self.target_top_level()? else {
            return Ok(false);
        };
        let tree = self.conn.query_tree(self.root)?.reply()?;
        let Some(target_index) = tree
            .children
            .iter()
            .position(|window| *window == target_top_level)
        else {
            return Ok(false);
        };
        let mut candidates = Vec::new();
        for window in &tree.children[target_index + 1..] {
            if policy.allows(&self.conn, self.root, *window)? {
                candidates.push(*window);
            }
        }
        let previous: Vec<Window> = self.popups.iter().map(|popup| popup.window).collect();
        let changed = previous != candidates;
        let mut existing = std::mem::take(&mut self.popups);
        let mut popups = Vec::with_capacity(candidates.len());
        for window in candidates {
            if let Some(index) = existing.iter().position(|popup| popup.window == window) {
                popups.push(existing.swap_remove(index));
            } else {
                let damage = self.conn.generate_id()?;
                self.conn
                    .damage_create(damage, window, ReportLevel::NON_EMPTY)?
                    .check()?;
                popups.push(PopupCapture { window, damage });
            }
        }
        for popup in existing {
            let _ = self.conn.damage_destroy(popup.damage);
        }
        self.popups = popups;
        Ok(changed)
    }
    fn composite_popups(&self, bgra: &mut [u8]) -> anyhow::Result<()> {
        if self.popups.is_empty() {
            return Ok(());
        }
        let target = self.geometry;
        let target_right = target.x + target.width as i32;
        let target_bottom = target.y + target.height as i32;
        let target_stride = target.width as usize * 4;
        for window in self.popups.iter().map(|popup| popup.window) {
            let Ok(popup) = window_geometry(&self.conn, self.root, window) else {
                continue;
            };
            let Ok(popup_depth) = window_depth(&self.conn, window) else {
                continue;
            };
            let left = target.x.max(popup.x);
            let top = target.y.max(popup.y);
            let right = target_right.min(popup.x + popup.width as i32);
            let bottom = target_bottom.min(popup.y + popup.height as i32);
            if left >= right || top >= bottom {
                continue;
            }
            let width = (right - left) as u16;
            let height = (bottom - top) as u16;
            let Ok(pixels) = self.read_pixels(
                window,
                (left - popup.x) as i16,
                (top - popup.y) as i16,
                width,
                height,
            ) else {
                continue;
            };
            let destination_x = (left - target.x) as usize;
            let destination_y = (top - target.y) as usize;
            if popup_depth == 32 {
                blend_bgra_rect(
                    bgra,
                    target_stride,
                    destination_x,
                    destination_y,
                    &pixels,
                    width as usize,
                    height as usize,
                );
            } else {
                copy_bgra_rect(
                    bgra,
                    target_stride,
                    destination_x,
                    destination_y,
                    &pixels,
                    width as usize,
                    height as usize,
                );
            }
        }
        Ok(())
    }
    fn read_pixels(
        &self,
        drawable: u32,
        x: i16,
        y: i16,
        width: u16,
        height: u16,
    ) -> anyhow::Result<Vec<u8>> {
        let mut pixels = vec![0; width as usize * height as usize * 4];
        self.conn
            .shm_get_image(
                drawable,
                x,
                y,
                width,
                height,
                u32::MAX,
                ImageFormat::Z_PIXMAP.into(),
                self.segment,
                0,
            )?
            .reply()?;
        self.file.read_exact_at(&mut pixels, 0)?;
        Ok(pixels)
    }
}
impl Drop for Capture {
    fn drop(&mut self) {
        if let Some(composite) = self.composite.take() {
            for window in &composite.windows {
                release_composite_window(&self.conn, window);
            }
        }
        for popup in &self.popups {
            let _ = self.conn.damage_destroy(popup.damage);
        }
        let _ = self.conn.damage_destroy(self.damage);
        let _ = self.conn.shm_detach(self.segment);
        let _ = self.conn.flush();
    }
}
fn release_composite_window(conn: &RustConnection, window: &CompositeWindow) {
    if window.pixmap != 0 {
        let _ = conn.free_pixmap(window.pixmap);
    }
    let _ = conn.composite_unredirect_window(window.window, Redirect::AUTOMATIC);
}
pub struct WindowCatalog {
    config: Config,
    references: Catalog<WindowHandle>,
}
impl WindowCatalog {
    pub fn new(config: Config) -> Self {
        Self::with_source_salt(config, crate::session::secret())
    }
    pub fn with_source_salt(config: Config, source_salt: String) -> Self {
        Self {
            config,
            references: Catalog::with_salt(source_salt),
        }
    }
    pub async fn enumerate(
        &mut self,
        owner: crate::session::Owner,
    ) -> anyhow::Result<Vec<CaptureSource>> {
        self.references.invalidate();
        let config = self.config.clone();
        let windows = tokio::task::spawn_blocking(move || enumerate_windows(&config)).await??;
        self.references
            .publish(owner, windows, Instant::now())
            .map_err(Into::into)
    }
    pub async fn consume(
        &mut self,
        reference: &str,
        owner: &crate::session::Owner,
    ) -> anyhow::Result<WindowTarget> {
        let handle = match self.references.consume(reference, owner, Instant::now()) {
            Ok(handle) => handle,
            Err(CatalogError::InvalidReference) => {
                // References are stable identities, while native handles and
                // ownership bindings are deliberately short-lived. Re-enumerate
                // before resolving so stale/expired handles never reach capture.
                self.enumerate(owner.clone()).await?;
                self.references.consume(reference, owner, Instant::now())?
            }
            Err(error) => return Err(error.into()),
        };
        Ok(WindowTarget {
            config: self.config.clone(),
            handle,
        })
    }
}
pub struct WindowLease {
    conn: RustConnection,
    root: Window,
    window: Window,
    geometry: Geometry,
    pid: Option<u32>,
    wm_pid: Atom,
    wm_window_type: Atom,
    input_popup_types: Vec<Atom>,
}

impl WindowLease {
    pub fn bind(window: Window, geometry: Geometry) -> anyhow::Result<Self> {
        let config = Config {
            display: std::env::var("DISPLAY")
                .map_err(|_| anyhow::anyhow!(BackendError::NoInteractiveSession))?,
            cookie: None,
            authority: std::env::var_os("XAUTHORITY").map(Into::into),
            include_cursor: false,
        };
        Self::bind_with_config(window, geometry, &config)
    }
    pub fn bind_with_config(
        window: Window,
        geometry: Geometry,
        config: &Config,
    ) -> anyhow::Result<Self> {
        let (conn, screen_index) = connect(config)?;
        let root = conn.setup().roots[screen_index].root;
        let atoms = Atoms::new(&conn)?;
        let pid = property_u32(&conn, window, atoms.wm_pid, AtomEnum::CARDINAL)
            .and_then(|values| values.first().copied());
        let input_popup_types = [
            "_NET_WM_WINDOW_TYPE_MENU",
            "_NET_WM_WINDOW_TYPE_DROPDOWN_MENU",
            "_NET_WM_WINDOW_TYPE_POPUP_MENU",
            "_NET_WM_WINDOW_TYPE_TOOLTIP",
            "_NET_WM_WINDOW_TYPE_COMBO",
            "_NET_WM_WINDOW_TYPE_DND",
        ]
        .iter()
        .map(|name| Ok(conn.intern_atom(false, name.as_bytes())?.reply()?.atom))
        .collect::<anyhow::Result<Vec<_>>>()?;
        let lease = Self {
            conn,
            root,
            window,
            geometry,
            pid,
            wm_pid: atoms.wm_pid,
            wm_window_type: atoms.wm_window_type,
            input_popup_types,
        };
        anyhow::ensure!(lease.geometry()? == geometry, BackendError::GeometryChanged);
        Ok(lease)
    }
    pub fn geometry(&self) -> anyhow::Result<Geometry> {
        window_frame_geometry(&self.conn, self.root, self.window)
    }
    pub fn resize(&mut self, target: WindowResizeTarget) -> anyhow::Result<Geometry> {
        const CONFIRM_TIMEOUT: Duration = Duration::from_millis(1_500);
        const POLL_INTERVAL: Duration = Duration::from_millis(25);
        const STABLE_SAMPLES: usize = 2;

        let before = self.geometry()?;
        let desired = match target {
            WindowResizeTarget::Preset { width, height }
            | WindowResizeTarget::Viewport { width, height } => Geometry {
                x: before.x,
                y: before.y,
                width,
                height,
                scale: before.scale,
            },
        };
        if desired == before {
            return Ok(before);
        }
        let insets = window_frame_insets(&self.conn, self.root, self.window)?;
        let (client_width, client_height) =
            client_size_for_frame(desired.width, desired.height, insets);
        let mut configure = ConfigureWindowAux::new()
            .width(client_width)
            .height(client_height);
        if desired.x != before.x {
            configure = configure.x(desired.x);
        }
        if desired.y != before.y {
            configure = configure.y(desired.y);
        }
        self.conn
            .configure_window(self.window, &configure)?
            .check()?;
        self.conn.flush()?;

        let started = Instant::now();
        let mut last = None;
        let mut stable = 0usize;
        while started.elapsed() < CONFIRM_TIMEOUT {
            match self.geometry() {
                Ok(geometry) if geometry != before => {
                    if last == Some(geometry) {
                        stable += 1;
                        if stable >= STABLE_SAMPLES {
                            self.geometry = geometry;
                            return Ok(geometry);
                        }
                    } else {
                        last = Some(geometry);
                        stable = 0;
                    }
                }
                Ok(_) => {
                    last = None;
                    stable = 0;
                }
                Err(error)
                    if matches!(
                        error.downcast_ref::<BackendError>(),
                        Some(BackendError::GeometryChanged | BackendError::WindowUnavailable)
                    ) => {}
                Err(error) => return Err(error),
            }
            thread::sleep(POLL_INTERVAL);
        }
        anyhow::bail!(BackendError::WindowResizeFailed)
    }
    pub fn reconfigure(&mut self, geometry: Geometry) -> anyhow::Result<()> {
        anyhow::ensure!(self.geometry()? == geometry, BackendError::GeometryChanged);
        self.geometry = geometry;
        Ok(())
    }
    pub fn focus(&self) -> anyhow::Result<Geometry> {
        let geometry = self.geometry()?;
        self.conn
            .configure_window(
                self.window,
                &ConfigureWindowAux::new().stack_mode(StackMode::ABOVE),
            )?
            .check()?;
        self.conn
            .set_input_focus(InputFocus::PARENT, self.window, x11rb::CURRENT_TIME)?
            .check()?;
        self.conn.flush()?;
        self.validate(geometry, None)?;
        Ok(geometry)
    }
    pub fn validate(&self, expected: Geometry, point: Option<(i32, i32)>) -> anyhow::Result<()> {
        let geometry = self.geometry()?;
        anyhow::ensure!(geometry == expected, BackendError::GeometryChanged);
        let focus = self.conn.get_input_focus()?.reply()?.focus;
        anyhow::ensure!(
            self.is_self_or_descendant(focus)?,
            BackendError::WindowFocusRequired
        );
        if point.is_some() {
            let pointer = self.conn.query_pointer(self.root)?.reply()?;
            anyhow::ensure!(pointer.same_screen, BackendError::PointerTargetMismatch);
            anyhow::ensure!(
                self.pointer_target_allowed(pointer.child)?,
                BackendError::PointerTargetMismatch
            );
        }
        Ok(())
    }
    fn pointer_target_allowed(&self, child: Window) -> anyhow::Result<bool> {
        if child == self.top_level()? {
            return Ok(true);
        }
        let Some(pid) = self.pid else {
            return Ok(false);
        };
        if child == x11rb::NONE {
            return Ok(false);
        }
        let attributes = self.conn.get_window_attributes(child)?.reply()?;
        if attributes.map_state != MapState::VIEWABLE || !attributes.override_redirect {
            return Ok(false);
        }
        let tree = self.conn.query_tree(child)?.reply()?;
        if tree.parent != self.root {
            return Ok(false);
        }
        let child_pid = property_u32(&self.conn, child, self.wm_pid, AtomEnum::CARDINAL)
            .and_then(|values| values.first().copied());
        if child_pid != Some(pid) {
            return Ok(false);
        }
        Ok(
            property_atoms(&self.conn, child, self.wm_window_type, AtomEnum::ATOM)
                .unwrap_or_default()
                .iter()
                .any(|kind| self.input_popup_types.contains(kind)),
        )
    }
    fn top_level(&self) -> anyhow::Result<Window> {
        top_level_window(&self.conn, self.root, self.window)
    }
    fn is_self_or_descendant(&self, candidate: Window) -> anyhow::Result<bool> {
        let mut current = candidate;
        for _ in 0..64 {
            if current == self.window {
                return Ok(true);
            }
            if current == x11rb::NONE || current == self.root {
                return Ok(false);
            }
            let tree = self.conn.query_tree(current)?.reply()?;
            anyhow::ensure!(tree.parent != current, BackendError::WindowUnavailable);
            current = tree.parent;
        }
        Ok(false)
    }
}
fn connect(config: &Config) -> anyhow::Result<(RustConnection, usize)> {
    if let Some(cookie) = &config.cookie {
        let number = config
            .display
            .strip_prefix(':')
            .ok_or_else(|| anyhow::anyhow!(BackendError::InvalidDisplay))?;
        let stream = std::os::unix::net::UnixStream::connect(format!("/tmp/.X11-unix/X{number}"))?;
        let stream = x11rb::rust_connection::DefaultStream::from_unix_stream(stream)?.0;
        Ok((
            RustConnection::connect_to_stream_with_auth_info(
                stream,
                0,
                b"MIT-MAGIC-COOKIE-1".to_vec(),
                cookie.clone(),
            )?,
            0,
        ))
    } else {
        Ok(x11rb::connect(Some(&config.display))?)
    }
}

pub fn enumerate_displays(config: &Config) -> anyhow::Result<Vec<NativeSource<DisplayTarget>>> {
    let (conn, screen_index) = connect(config)?;
    let screen = &conn.setup().roots[screen_index];
    let root = screen.root;
    let fallback = || NativeSource {
        identity: format!("x11-screen:{}", root),
        unavailable_reason: None,
        handle: DisplayTarget {
            config: config.clone(),
            output: String::new(),
            geometry: Geometry {
                x: 0,
                y: 0,
                width: screen.width_in_pixels.into(),
                height: screen.height_in_pixels.into(),
                scale: 1.0,
            },
        },
        kind: "display".into(),
        title: "Display 1".into(),
        subtitle: None,
        width: screen.width_in_pixels.into(),
        height: screen.height_in_pixels.into(),
    };
    let Ok(cookie) = conn.randr_get_monitors(root, true) else {
        return Ok(vec![fallback()]);
    };
    let Ok(reply) = cookie.reply() else {
        return Ok(vec![fallback()]);
    };
    let monitors = if reply.monitors.is_empty() {
        return Ok(vec![fallback()]);
    } else {
        reply.monitors
    };
    let mut sources = Vec::with_capacity(monitors.len());
    for (index, monitor) in monitors.into_iter().enumerate() {
        if monitor.width == 0 || monitor.height == 0 {
            continue;
        }
        let output = atom_name(&conn, monitor.name).unwrap_or_else(|| format!("display-{index}"));
        let geometry = Geometry {
            x: monitor.x.into(),
            y: monitor.y.into(),
            width: monitor.width.into(),
            height: monitor.height.into(),
            scale: 1.0,
        };
        sources.push(NativeSource {
            identity: format!("x11-monitor:{}", monitor.name),
            unavailable_reason: None,
            handle: DisplayTarget {
                config: config.clone(),
                output: output.clone(),
                geometry,
            },
            kind: "display".into(),
            title: output,
            subtitle: monitor.primary.then(|| "Primary".into()),
            width: geometry.width,
            height: geometry.height,
        });
    }
    Ok(if sources.is_empty() {
        vec![fallback()]
    } else {
        sources
    })
}

fn monitor_geometry(conn: &RustConnection, root: Window, output: &str) -> anyhow::Result<Geometry> {
    let reply = conn.randr_get_monitors(root, true)?.reply()?;
    for monitor in reply.monitors {
        if atom_name(conn, monitor.name).as_deref() == Some(output) {
            return Ok(Geometry {
                x: monitor.x.into(),
                y: monitor.y.into(),
                width: monitor.width.into(),
                height: monitor.height.into(),
                scale: 1.0,
            });
        }
    }
    anyhow::bail!(BackendError::GeometryChanged)
}

fn atom_name(conn: &RustConnection, atom: Atom) -> Option<String> {
    let value = conn.get_atom_name(atom).ok()?.reply().ok()?.name;
    let value = String::from_utf8_lossy(&value).trim().to_owned();
    (!value.is_empty()).then_some(value)
}
fn initialize(conn: &RustConnection) -> anyhow::Result<()> {
    conn.shm_query_version()?.reply()?;
    conn.damage_query_version(1, 1)?.reply()?;
    conn.xfixes_query_version(5, 0)?.reply()?;
    Ok(())
}

fn window_manager_present(conn: &RustConnection, root: Window) -> anyhow::Result<bool> {
    let supporting_wm = x11_atom(conn, b"_NET_SUPPORTING_WM_CHECK")?;
    let Some(window) = supporting_wm_window(conn, root, supporting_wm) else {
        return Ok(false);
    };
    if conn
        .get_window_attributes(window)
        .ok()
        .and_then(|cookie| cookie.reply().ok())
        .is_none()
    {
        return Ok(false);
    }
    Ok(supporting_wm_window(conn, window, supporting_wm) == Some(window))
}

fn supporting_wm_window(conn: &RustConnection, window: Window, property: Atom) -> Option<Window> {
    let reply = conn
        .get_property(false, window, property, AtomEnum::WINDOW, 0, 1)
        .ok()?
        .reply()
        .ok()?;
    if reply.format != 32 || reply.type_ != u32::from(AtomEnum::WINDOW) {
        return None;
    }
    let window = reply
        .value32()?
        .next()
        .filter(|window| *window != x11rb::NONE);
    window
}
fn drawable(target: &DrawableTarget, root: Window) -> u32 {
    match target {
        DrawableTarget::Display => root,
        DrawableTarget::Window(handle) => handle.window,
    }
}
fn frame_bytes(geometry: Geometry) -> anyhow::Result<usize> {
    (geometry.width as usize)
        .checked_mul(geometry.height as usize)
        .and_then(|pixels| pixels.checked_mul(4))
        .ok_or_else(|| anyhow::anyhow!(BackendError::InvalidGeometry))
}
fn copy_bgra_rect(
    destination: &mut [u8],
    destination_stride: usize,
    destination_x: usize,
    destination_y: usize,
    source: &[u8],
    width: usize,
    height: usize,
) {
    let source_stride = width * 4;
    for row in 0..height {
        let source_start = row * source_stride;
        let destination_start = (destination_y + row) * destination_stride + destination_x * 4;
        destination[destination_start..destination_start + source_stride]
            .copy_from_slice(&source[source_start..source_start + source_stride]);
        for alpha in (destination_start + 3..destination_start + source_stride).step_by(4) {
            destination[alpha] = 255;
        }
    }
}
fn blend_bgra_rect(
    destination: &mut [u8],
    destination_stride: usize,
    destination_x: usize,
    destination_y: usize,
    source: &[u8],
    width: usize,
    height: usize,
) {
    let source_stride = width * 4;
    for row in 0..height {
        for column in 0..width {
            let source_offset = row * source_stride + column * 4;
            let destination_offset =
                (destination_y + row) * destination_stride + (destination_x + column) * 4;
            let alpha = source[source_offset + 3] as u32;
            if alpha == 0 {
                continue;
            }
            if alpha == 255 {
                destination[destination_offset..destination_offset + 4]
                    .copy_from_slice(&source[source_offset..source_offset + 4]);
                destination[destination_offset + 3] = 255;
                continue;
            }
            // XRender ARGB32 windows (including GTK menus) store premultiplied
            // color channels. Composite the source as-is over the opaque frame.
            for channel in 0..3 {
                let source_value = source[source_offset + channel] as u32;
                let destination_value = destination[destination_offset + channel] as u32;
                destination[destination_offset + channel] =
                    (source_value + (destination_value * (255 - alpha) + 127) / 255).min(255) as u8;
            }
            destination[destination_offset + 3] = 255;
        }
    }
}
fn validate_geometry(geometry: Geometry) -> anyhow::Result<()> {
    anyhow::ensure!(
        geometry.width > 0
            && geometry.height > 0
            && geometry.width <= 8192
            && geometry.height <= 8192,
        BackendError::InvalidGeometry
    );
    Ok(())
}
fn allocate_shm(conn: &RustConnection, geometry: Geometry) -> anyhow::Result<(u32, File)> {
    let bytes = frame_bytes(geometry)?;
    let segment = conn.generate_id()?;
    let file = File::from(
        conn.shm_create_segment(segment, bytes as u32, false)?
            .reply()?
            .shm_fd,
    );
    Ok((segment, file))
}
fn validate_visual(
    conn: &RustConnection,
    screen_index: usize,
    depth: u8,
    visual_id: u32,
) -> anyhow::Result<()> {
    let setup = conn.setup();
    let screen = &setup.roots[screen_index];
    let visual = screen
        .allowed_depths
        .iter()
        .filter(|entry| entry.depth == depth)
        .flat_map(|entry| &entry.visuals)
        .find(|visual| visual.visual_id == visual_id)
        .ok_or_else(|| anyhow::anyhow!(BackendError::X11FormatUnsupported))?;
    let format = setup
        .pixmap_formats
        .iter()
        .find(|format| format.depth == depth)
        .ok_or_else(|| anyhow::anyhow!(BackendError::X11FormatUnsupported))?;
    anyhow::ensure!(
        format.bits_per_pixel == 32
            && setup.image_byte_order == ImageOrder::LSB_FIRST
            && visual.red_mask == 0xff0000
            && visual.green_mask == 0xff00
            && visual.blue_mask == 0xff,
        BackendError::X11FormatUnsupported
    );
    Ok(())
}
fn window_geometry(
    conn: &RustConnection,
    root: Window,
    window: Window,
) -> anyhow::Result<Geometry> {
    let attributes = conn.get_window_attributes(window)?.reply()?;
    anyhow::ensure!(
        attributes.map_state == MapState::VIEWABLE,
        BackendError::WindowUnavailable
    );
    let geometry = conn.get_geometry(window)?.reply()?;
    let position = conn.translate_coordinates(window, root, 0, 0)?.reply()?;
    anyhow::ensure!(position.same_screen, BackendError::WindowUnavailable);
    Ok(Geometry {
        x: position.dst_x.into(),
        y: position.dst_y.into(),
        width: geometry.width.into(),
        height: geometry.height.into(),
        scale: 1.0,
    })
}
fn window_depth(conn: &RustConnection, window: Window) -> anyhow::Result<u8> {
    Ok(conn.get_geometry(window)?.reply()?.depth)
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct WindowFrameInsets {
    left: u32,
    top: u32,
    right: u32,
    bottom: u32,
}
fn window_frame_geometry(
    conn: &RustConnection,
    root: Window,
    window: Window,
) -> anyhow::Result<Geometry> {
    let frame = top_level_window(conn, root, window)?;
    window_geometry(conn, root, frame)
}
fn window_frame_insets(
    conn: &RustConnection,
    root: Window,
    window: Window,
) -> anyhow::Result<WindowFrameInsets> {
    let client = window_geometry(conn, root, window)?;
    let frame = window_frame_geometry(conn, root, window)?;
    let client_right = client.x.saturating_add(client.width as i32);
    let client_bottom = client.y.saturating_add(client.height as i32);
    let frame_right = frame.x.saturating_add(frame.width as i32);
    let frame_bottom = frame.y.saturating_add(frame.height as i32);
    anyhow::ensure!(
        client.x >= frame.x
            && client.y >= frame.y
            && client_right <= frame_right
            && client_bottom <= frame_bottom,
        BackendError::InvalidGeometry
    );
    Ok(WindowFrameInsets {
        left: (client.x - frame.x) as u32,
        top: (client.y - frame.y) as u32,
        right: (frame_right - client_right) as u32,
        bottom: (frame_bottom - client_bottom) as u32,
    })
}
fn client_size_for_frame(width: u32, height: u32, insets: WindowFrameInsets) -> (u32, u32) {
    (
        width
            .saturating_sub(insets.left.saturating_add(insets.right))
            .max(1),
        height
            .saturating_sub(insets.top.saturating_add(insets.bottom))
            .max(1),
    )
}
fn top_level_window(conn: &RustConnection, root: Window, window: Window) -> anyhow::Result<Window> {
    let mut current = window;
    for _ in 0..64 {
        let tree = conn.query_tree(current)?.reply()?;
        if tree.parent == root || tree.parent == x11rb::NONE {
            return Ok(current);
        }
        anyhow::ensure!(tree.parent != current, BackendError::WindowUnavailable);
        current = tree.parent;
    }
    anyhow::bail!(BackendError::WindowUnavailable)
}
struct Atoms {
    client_list: Atom,
    client_list_stacking: Atom,
    wm_name: Atom,
    net_wm_name: Atom,
    utf8_string: Atom,
    wm_class: Atom,
    wm_state: Atom,
    wm_state_hidden: Atom,
    wm_window_type: Atom,
    wm_pid: Atom,
    skipped_types: Vec<Atom>,
}
impl Atoms {
    fn new(conn: &RustConnection) -> anyhow::Result<Self> {
        let atom = |name: &[u8]| -> anyhow::Result<Atom> {
            Ok(conn.intern_atom(false, name)?.reply()?.atom)
        };
        Ok(Self {
            client_list: atom(b"_NET_CLIENT_LIST")?,
            client_list_stacking: atom(b"_NET_CLIENT_LIST_STACKING")?,
            wm_name: AtomEnum::WM_NAME.into(),
            net_wm_name: atom(b"_NET_WM_NAME")?,
            utf8_string: atom(b"UTF8_STRING")?,
            wm_class: AtomEnum::WM_CLASS.into(),
            wm_state: atom(b"_NET_WM_STATE")?,
            wm_state_hidden: atom(b"_NET_WM_STATE_HIDDEN")?,
            wm_window_type: atom(b"_NET_WM_WINDOW_TYPE")?,
            wm_pid: atom(b"_NET_WM_PID")?,
            skipped_types: [
                "_NET_WM_WINDOW_TYPE_DESKTOP",
                "_NET_WM_WINDOW_TYPE_DOCK",
                "_NET_WM_WINDOW_TYPE_TOOLBAR",
                "_NET_WM_WINDOW_TYPE_MENU",
                "_NET_WM_WINDOW_TYPE_DROPDOWN_MENU",
                "_NET_WM_WINDOW_TYPE_POPUP_MENU",
                "_NET_WM_WINDOW_TYPE_TOOLTIP",
                "_NET_WM_WINDOW_TYPE_NOTIFICATION",
                "_NET_WM_WINDOW_TYPE_COMBO",
                "_NET_WM_WINDOW_TYPE_DND",
            ]
            .iter()
            .map(|name| atom(name.as_bytes()))
            .collect::<anyhow::Result<Vec<_>>>()?,
        })
    }
}
fn enumerate_windows(config: &Config) -> anyhow::Result<Vec<NativeSource<WindowHandle>>> {
    let (conn, screen_index) = connect(config)?;
    let root = conn.setup().roots[screen_index].root;
    let atoms = Atoms::new(&conn)?;
    let mut result = Vec::new();
    for window in client_windows(&conn, root, &atoms)? {
        if result.len() >= crate::catalog::MAX_SOURCES {
            break;
        }
        let Some(entry) = inspect_window(&conn, screen_index, root, &atoms, window) else {
            continue;
        };
        result.push(entry);
    }
    Ok(result)
}
fn client_windows(
    conn: &RustConnection,
    root: Window,
    atoms: &Atoms,
) -> anyhow::Result<Vec<Window>> {
    for property in [atoms.client_list_stacking, atoms.client_list] {
        let reply = conn
            .get_property(
                false,
                root,
                property,
                AtomEnum::WINDOW,
                0,
                crate::catalog::MAX_SOURCES as u32,
            )?
            .reply()?;
        let mut windows: Vec<Window> = reply
            .value32()
            .map(|values| values.collect())
            .unwrap_or_default();
        if !windows.is_empty() {
            windows.reverse();
            return Ok(windows);
        }
    }
    let tree = conn.query_tree(root)?.reply()?;
    let mut children = tree.children;
    children.reverse();
    Ok(children)
}
fn inspect_window(
    conn: &RustConnection,
    screen_index: usize,
    root: Window,
    atoms: &Atoms,
    window: Window,
) -> Option<NativeSource<WindowHandle>> {
    let attributes = conn.get_window_attributes(window).ok()?.reply().ok()?;
    if attributes.override_redirect {
        return None;
    }
    if window_type_skipped(conn, window, atoms) {
        return None;
    }
    let hidden = attributes.map_state != MapState::VIEWABLE
        || property_atoms(conn, window, atoms.wm_state, AtomEnum::ATOM)
            .is_some_and(|values| values.contains(&atoms.wm_state_hidden));
    let client_geometry = conn.get_geometry(window).ok()?.reply().ok()?;
    let geometry = window_frame_geometry(conn, root, window).ok()?;
    if geometry.width == 0 || geometry.height == 0 {
        return None;
    }
    let title = window_title(conn, window, atoms);
    let application_name = window_application(conn, window, atoms);
    let (title, subtitle) = crate::catalog::source_labels(title, application_name);
    let pid = property_u32(conn, window, atoms.wm_pid, AtomEnum::CARDINAL)
        .and_then(|v| v.first().copied());
    let unavailable_reason = if hidden {
        Some(BackendError::WindowUnavailable.to_string())
    } else if validate_visual(conn, screen_index, client_geometry.depth, attributes.visual).is_err()
    {
        Some(BackendError::WindowUnsupported.to_string())
    } else {
        None
    };
    Some(NativeSource {
        identity: format!("x11:{}:{}", window, pid.unwrap_or_default()),
        unavailable_reason,
        handle: WindowHandle { window, pid },
        kind: "window".into(),
        title,
        subtitle,
        width: geometry.width,
        height: geometry.height,
    })
}
fn window_type_skipped(conn: &RustConnection, window: Window, atoms: &Atoms) -> bool {
    property_atoms(conn, window, atoms.wm_window_type, AtomEnum::ATOM).is_some_and(|types| {
        types
            .iter()
            .any(|value| atoms.skipped_types.contains(value))
    })
}
fn window_title(conn: &RustConnection, window: Window, atoms: &Atoms) -> String {
    let title = property_bytes(conn, window, atoms.net_wm_name, atoms.utf8_string)
        .filter(|value| !value.is_empty())
        .or_else(|| property_bytes(conn, window, atoms.wm_name, AtomEnum::ANY.into()))
        .map(|value| String::from_utf8_lossy(&value).into_owned())
        .unwrap_or_default();
    truncate(title, 512)
}
fn window_application(conn: &RustConnection, window: Window, atoms: &Atoms) -> String {
    let value =
        property_bytes(conn, window, atoms.wm_class, AtomEnum::STRING.into()).unwrap_or_default();
    let class = String::from_utf8_lossy(&value);
    let mut parts = class.split('\0').filter(|part| !part.is_empty());
    let first = parts.next().unwrap_or_default();
    let name = parts.next().unwrap_or(first);
    truncate(name.to_string(), 256)
}
fn window_pid(conn: &RustConnection, window: Window) -> anyhow::Result<Option<u32>> {
    let atom = conn.intern_atom(false, b"_NET_WM_PID")?.reply()?.atom;
    Ok(property_u32(conn, window, atom, AtomEnum::CARDINAL)
        .and_then(|values| values.first().copied()))
}
fn x11_atom(conn: &RustConnection, name: &[u8]) -> anyhow::Result<Atom> {
    Ok(conn.intern_atom(false, name)?.reply()?.atom)
}
fn property_atoms(
    conn: &RustConnection,
    window: Window,
    property: Atom,
    kind: AtomEnum,
) -> Option<Vec<Atom>> {
    let reply = conn
        .get_property(false, window, property, kind, 0, 1024)
        .ok()?
        .reply()
        .ok()?;
    reply.value32().map(|values| values.collect())
}
fn property_u32(
    conn: &RustConnection,
    window: Window,
    property: Atom,
    kind: AtomEnum,
) -> Option<Vec<u32>> {
    property_atoms(conn, window, property, kind)
}
fn property_bytes(
    conn: &RustConnection,
    window: Window,
    property: Atom,
    kind: Atom,
) -> Option<Vec<u8>> {
    let reply = conn
        .get_property(false, window, property, kind, 0, 4096)
        .ok()?
        .reply()
        .ok()?;
    Some(reply.value)
}
fn truncate(value: String, maximum_bytes: usize) -> String {
    if value.len() <= maximum_bytes {
        return value;
    }
    let mut result = String::new();
    for character in value.chars() {
        if result.len() + character.len_utf8() > maximum_bytes {
            break;
        }
        result.push(character);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::{blend_bgra_rect, client_size_for_frame, copy_bgra_rect, WindowFrameInsets};

    #[test]
    fn frame_resize_removes_window_manager_insets_from_the_client_request() {
        let insets = WindowFrameInsets {
            left: 5,
            top: 29,
            right: 5,
            bottom: 5,
        };
        assert_eq!(client_size_for_frame(917, 664, insets), (907, 630));
        assert_eq!(client_size_for_frame(100, 40, insets), (90, 6));
        assert_eq!(client_size_for_frame(8, 20, insets), (1, 1));
    }

    #[test]
    fn popup_blend_preserves_transparency_and_composites_premultiplied_shadow() {
        let mut destination = vec![255; 3 * 4];
        let source = [
            10, 20, 30, 0, // transparent popup shadow
            10, 20, 30, 128, // premultiplied semi-transparent popup shadow
            40, 50, 60, 255, // opaque popup content
        ];
        blend_bgra_rect(&mut destination, 12, 0, 0, &source, 3, 1);
        assert_eq!(&destination[0..4], &[255, 255, 255, 255]);
        assert_eq!(&destination[4..8], &[137, 147, 157, 255]);
        assert_eq!(&destination[8..12], &[40, 50, 60, 255]);
    }

    #[test]
    fn opaque_window_copy_forces_the_published_alpha_channel() {
        let mut destination = vec![0; 4];
        copy_bgra_rect(&mut destination, 4, 0, 0, &[1, 2, 3, 0], 1, 1);
        assert_eq!(destination, vec![1, 2, 3, 255]);
    }
}
