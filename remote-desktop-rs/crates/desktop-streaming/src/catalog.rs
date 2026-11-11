//! Opaque, process-stable source identity with short-lived native handles.
//! Native handles never cross IPC/wire.
use crate::session::{secret, Owner};
use std::{
    collections::HashMap,
    time::{Duration, Instant},
};
pub const SOURCE_TTL: Duration = Duration::from_secs(60);
pub const MAX_SOURCES: usize = 256;
pub const MAX_CAPTURE_DIMENSION: u32 = 8192;
pub const MAX_CATALOG_BYTES: usize = 512 * 1024;

pub use remote_desktop_protocol::model::CaptureSource;

/// Keep the provider-specific source label decision at the catalog boundary.
/// Consumers always render `title` as primary and `subtitle` as context.
pub fn source_labels(primary: String, context: String) -> (String, Option<String>) {
    let primary = primary.trim().to_string();
    let context = context.trim().to_string();
    if primary.is_empty() {
        (context, None)
    } else {
        let subtitle = (!context.is_empty() && context != primary).then_some(context);
        (primary, subtitle)
    }
}
/// Platform-only input to publication; H may hold a retained display/window item.
pub struct NativeSource<H> {
    /// Stable platform identity used only inside the component to keep the
    /// public opaque reference stable across catalog refreshes.
    pub identity: String,
    pub unavailable_reason: Option<String>,
    pub handle: H,
    pub kind: String,
    pub title: String,
    pub subtitle: Option<String>,
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
    #[error("REMOTE_DESKTOP_SOURCE_CATALOG_TOO_LARGE")]
    TooLarge,
    #[error("REMOTE_DESKTOP_SOURCE_REFERENCE_INVALID")]
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
    /// failure. Stable wire identities survive so the same native source keeps
    /// the same opaque reference.
    pub fn publish(
        &mut self,
        owner: Owner,
        sources: Vec<NativeSource<H>>,
        now: Instant,
    ) -> Result<Vec<CaptureSource>, CatalogError> {
        self.references.clear();
        if sources.len() > MAX_SOURCES
            || sources.iter().any(|s| {
                s.kind.len() > 64
                    || s.title.len() > 512
                    || s.subtitle.as_ref().is_some_and(|value| value.len() > 256)
            })
        {
            return Err(CatalogError::TooLarge);
        }
        let mut references = HashMap::new();
        let mut identities = HashMap::new();
        let mut entries = Vec::new();
        for source in sources {
            // Filtering platform shell/cloaked/protected windows belongs in the
            // backend. Zero geometry is never a valid selectable target.
            if source.width == 0 || source.height == 0 {
                continue;
            }
            let capturable = source.unavailable_reason.is_none()
                && source.width <= MAX_CAPTURE_DIMENSION
                && source.height <= MAX_CAPTURE_DIMENSION;
            let source_ref = self
                .identities
                .get(&source.identity)
                .cloned()
                .unwrap_or_else(secret);
            identities.insert(source.identity, source_ref.clone());
            entries.push(CaptureSource {
                source_ref: source_ref.clone(),
                kind: source.kind,
                title: source.title,
                subtitle: source.subtitle,
                width: source.width,
                height: source.height,
                capturable,
                reason: source.unavailable_reason.or_else(|| {
                    (!capturable).then(|| "REMOTE_DESKTOP_SOURCE_DIMENSIONS_UNSUPPORTED".into())
                }),
            });
            if !capturable {
                continue;
            }
            references.insert(
                source_ref,
                Reference {
                    handle: source.handle,
                    owner: owner.clone(),
                    expires: now + SOURCE_TTL,
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
    /// Resolve the current native handle for a stable source reference. The
    /// reference itself remains stable; only this retained handle is consumed.
    /// A later resolve re-enumerates and receives the same reference again.
    pub fn consume(
        &mut self,
        source_ref: &str,
        owner: &Owner,
        now: Instant,
    ) -> Result<H, CatalogError> {
        self.references.retain(|_, r| r.expires > now);
        let r = self
            .references
            .get(source_ref)
            .ok_or(CatalogError::InvalidReference)?;
        if &r.owner != owner {
            return Err(CatalogError::InvalidReference);
        }
        Ok(self.references.remove(source_ref).unwrap().handle)
    }
}
