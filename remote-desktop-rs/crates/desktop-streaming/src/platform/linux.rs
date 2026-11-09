//! X11/XShm/XDamage and XFixes. The connection owns all native handles; no
//! display/handle identifiers enter a public session or persisted business model.
use crate::error::BackendError;
use crate::traits::{Geometry, RawFrame};
use std::{fs::File, os::unix::fs::FileExt, time::Instant};
use x11rb::{
    connection::Connection,
    protocol::{
        damage::{ConnectionExt as _, ReportLevel},
        shm::ConnectionExt as _,
        xfixes::ConnectionExt as _,
        xproto::{ConnectionExt as _, ImageFormat, ImageOrder},
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
pub struct Capture {
    conn: RustConnection,
    root: u32,
    segment: u32,
    damage: u32,
    file: File,
    geometry: Geometry,
    base: Vec<u8>,
    dirty: bool,
    include_cursor: bool,
    last_cursor: (i16, i16, u32),
}
impl Capture {
    pub fn open(config: &Config) -> anyhow::Result<Self> {
        anyhow::ensure!(
            std::env::var_os("WSL_DISTRO_NAME").is_none(),
            BackendError::WslUnsupported
        );
        let (conn, screen_index) = if let Some(cookie) = &config.cookie {
            let number = config
                .display
                .strip_prefix(':')
                .ok_or_else(|| anyhow::anyhow!(BackendError::InvalidDisplay))?;
            let stream =
                std::os::unix::net::UnixStream::connect(format!("/tmp/.X11-unix/X{number}"))?;
            let stream = x11rb::rust_connection::DefaultStream::from_unix_stream(stream)?.0;
            (
                RustConnection::connect_to_stream_with_auth_info(
                    stream,
                    0,
                    b"MIT-MAGIC-COOKIE-1".to_vec(),
                    cookie.clone(),
                )?,
                0,
            )
        } else {
            x11rb::connect(Some(&config.display))?
        };
        conn.shm_query_version()?.reply()?;
        conn.damage_query_version(1, 1)?.reply()?;
        conn.xfixes_query_version(5, 0)?.reply()?;
        let setup = conn.setup();
        let screen = &setup.roots[screen_index];
        let visual = screen
            .allowed_depths
            .iter()
            .flat_map(|d| &d.visuals)
            .find(|v| v.visual_id == screen.root_visual)
            .ok_or_else(|| anyhow::anyhow!(BackendError::X11FormatUnsupported))?;
        let format = setup
            .pixmap_formats
            .iter()
            .find(|p| p.depth == screen.root_depth)
            .ok_or_else(|| anyhow::anyhow!(BackendError::X11FormatUnsupported))?;
        anyhow::ensure!(
            format.bits_per_pixel == 32
                && setup.image_byte_order == ImageOrder::LSB_FIRST
                && visual.red_mask == 0xff0000
                && visual.green_mask == 0xff00
                && visual.blue_mask == 0xff,
            BackendError::X11FormatUnsupported
        );
        let root = screen.root;
        let geometry = Geometry {
            x: 0,
            y: 0,
            width: screen.width_in_pixels.into(),
            height: screen.height_in_pixels.into(),
            scale: 1.0,
        };
        anyhow::ensure!(
            geometry.width > 0
                && geometry.height > 0
                && geometry.width <= 8192
                && geometry.height <= 8192,
            BackendError::InvalidGeometry
        );
        let bytes = geometry.width as usize * geometry.height as usize * 4;
        let segment = conn.generate_id()?;
        let file = File::from(
            conn.shm_create_segment(segment, bytes as u32, false)?
                .reply()?
                .shm_fd,
        );
        let damage = conn.generate_id()?;
        conn.damage_create(damage, root, ReportLevel::NON_EMPTY)?
            .check()?;
        conn.flush()?;
        Ok(Self {
            conn,
            root,
            segment,
            damage,
            file,
            geometry,
            base: vec![0; bytes],
            dirty: true,
            include_cursor: config.include_cursor,
            last_cursor: (i16::MIN, i16::MIN, 0),
        })
    }
    pub fn geometry(&self) -> Geometry {
        self.geometry
    }
    pub fn frame(&mut self, force: bool) -> anyhow::Result<Option<RawFrame>> {
        while let Some(event) = self.conn.poll_for_event()? {
            if matches!(event, Event::DamageNotify(_)) {
                self.dirty = true;
            }
        }
        let actual = self.conn.get_geometry(self.root)?.reply()?;
        anyhow::ensure!(
            actual.width as u32 == self.geometry.width
                && actual.height as u32 == self.geometry.height,
            BackendError::GeometryChanged
        );
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
            self.conn
                .shm_get_image(
                    self.root,
                    0,
                    0,
                    actual.width,
                    actual.height,
                    u32::MAX,
                    ImageFormat::Z_PIXMAP.into(),
                    self.segment,
                    0,
                )?
                .reply()?;
            self.file.read_exact_at(&mut self.base, 0)?;
            self.dirty = false;
        }
        let mut bgra = self.base.clone();
        if let Some(cursor) = cursor {
            self.last_cursor = (cursor.x, cursor.y, cursor.cursor_serial);
            for row in 0..cursor.height as usize {
                for col in 0..cursor.width as usize {
                    let x = cursor.x as i32 - cursor.xhot as i32 + col as i32;
                    let y = cursor.y as i32 - cursor.yhot as i32 + row as i32;
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
}
impl Drop for Capture {
    fn drop(&mut self) {
        let _ = self.conn.damage_destroy(self.damage);
        let _ = self.conn.shm_detach(self.segment);
        let _ = self.conn.flush();
    }
}
