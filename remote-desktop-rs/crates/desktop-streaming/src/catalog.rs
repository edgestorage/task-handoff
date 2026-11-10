//! Opaque, process-stable window identity with short-lived native handles.
//! Native handles never cross IPC/wire.
use crate::session::{secret, Owner};
use std::{
    collections::HashMap,
    time::{Duration, Instant},
};
pub const WINDOW_TTL: Duration = Duration::from_secs(60);
pub const MAX_WINDOWS: usize = 256;
pub const MAX_CAPTURE_DIMENSION: u32 = 8192;
pub const MAX_CATALOG_BYTES: usize = 512 * 1024;

pub use remote_desktop_protocol::model::WindowEntry;
/// Platform-only input to publication; H may hold a retained SCWindow/WGC item.
pub struct NativeWindow<H> {
    /// Stable platform identity used only inside the component to keep the
    /// public opaque reference stable across catalog refreshes.
    pub identity: String,
    pub unavailable_reason: Option<String>,
    pub handle: H,
    pub title: String,
    pub application_name: String,
    pub width: u32,
    pub height: u32,
}
struct Reference<H> {
    handle: H,
    owner: Owner,
    expires: Instant,
}
pub struct Catalog<H> {
    references: HashMap<String, Reference<H>>,
    identities: HashMap<String, String>,
}
#[derive(Debug, PartialEq, Eq, thiserror::Error)]
pub enum CatalogError {
    #[error("REMOTE_DESKTOP_WINDOW_CATALOG_TOO_LARGE")]
    TooLarge,
    #[error("REMOTE_DESKTOP_WINDOW_REFERENCE_INVALID")]
    InvalidReference,
}
impl<H> Default for Catalog<H> {
    fn default() -> Self {
        Self {
            references: HashMap::new(),
            identities: HashMap::new(),
        }
    }
}
impl<H> Catalog<H> {
    /// Invalidate before starting asynchronous enumeration, including a failed
    /// native request. No periodic enumeration or expired-handle polling.
    pub fn invalidate(&mut self) {
        self.references.clear();
    }
    /// Refresh invalidates retained native handles, including on enumeration
    /// failure. Stable wire identities survive so the same native window keeps
    /// the same opaque reference.
    pub fn publish(
        &mut self,
        owner: Owner,
        windows: Vec<NativeWindow<H>>,
        now: Instant,
    ) -> Result<Vec<WindowEntry>, CatalogError> {
        self.references.clear();
        if windows.len() > MAX_WINDOWS
            || windows
                .iter()
                .any(|w| w.title.len() > 512 || w.application_name.len() > 256)
        {
            return Err(CatalogError::TooLarge);
        }
        let mut references = HashMap::new();
        let mut identities = HashMap::new();
        let mut entries = Vec::new();
        for w in windows {
            // Filtering platform shell/cloaked/protected windows belongs in the
            // backend. Zero geometry is never a valid selectable target.
            if w.width == 0 || w.height == 0 {
                continue;
            }
            let capturable = w.unavailable_reason.is_none()
                && w.width <= MAX_CAPTURE_DIMENSION
                && w.height <= MAX_CAPTURE_DIMENSION;
            let window_ref = self
                .identities
                .get(&w.identity)
                .cloned()
                .unwrap_or_else(secret);
            identities.insert(w.identity, window_ref.clone());
            entries.push(WindowEntry {
                window_ref: window_ref.clone(),
                title: w.title,
                application_name: w.application_name,
                width: w.width,
                height: w.height,
                capturable,
                reason: w.unavailable_reason.or_else(|| {
                    (!capturable).then(|| "REMOTE_DESKTOP_WINDOW_DIMENSIONS_UNSUPPORTED".into())
                }),
            });
            if !capturable {
                continue;
            }
            references.insert(
                window_ref,
                Reference {
                    handle: w.handle,
                    owner: owner.clone(),
                    expires: now + WINDOW_TTL,
                },
            );
        }
        if serde_json::to_vec(&entries)
            .map_err(|_| CatalogError::TooLarge)?
            .len()
            > MAX_CATALOG_BYTES
        {
            return Err(CatalogError::TooLarge);
        }
        self.references = references;
        self.identities = identities;
        Ok(entries)
    }
    /// Resolve the current native handle for a stable window reference. The
    /// reference itself remains stable; only this retained handle is consumed.
    /// A later resolve re-enumerates and receives the same reference again.
    pub fn consume(
        &mut self,
        window_ref: &str,
        owner: &Owner,
        now: Instant,
    ) -> Result<H, CatalogError> {
        self.references.retain(|_, r| r.expires > now);
        let r = self
            .references
            .get(window_ref)
            .ok_or(CatalogError::InvalidReference)?;
        if &r.owner != owner {
            return Err(CatalogError::InvalidReference);
        }
        Ok(self.references.remove(window_ref).unwrap().handle)
    }
}
