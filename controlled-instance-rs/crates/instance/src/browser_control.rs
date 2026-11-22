use chrono::{DateTime, Duration, SecondsFormat, Utc};
use controlled_instance_protocol::{
    mint_entity_id, EmbeddedBrowserAccessView, EmbeddedBrowserChannelCapabilities,
    EmbeddedBrowserCreationApprovalListResponse, EmbeddedBrowserCreationApprovalView,
    EmbeddedBrowserCreationCandidate, EmbeddedBrowserCreationStatus, EmbeddedBrowserCreationView,
    EmbeddedBrowserLease, EmbeddedBrowserPage, EmbeddedBrowserPageHost,
    EmbeddedBrowserPageHostCapabilities, EmbeddedBrowserPageListResponse,
    EmbeddedBrowserRegistryDelta, EmbeddedBrowserSource, EmbeddedBrowserSourceDelta,
    EmbeddedBrowserSourceSnapshot, EMBEDDED_BROWSER_CDP_ACCESS_TTL_MS,
    EMBEDDED_BROWSER_CDP_PROFILE, EMBEDDED_BROWSER_CREATION_TTL_MS,
    EMBEDDED_BROWSER_MAX_PAGES_PER_SOURCE, EMBEDDED_BROWSER_MAX_SOURCES,
    EMBEDDED_BROWSER_SNAPSHOT_MAX_PAGES_PER_CHUNK,
};
use rand::RngCore;
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, HashMap, HashSet, VecDeque},
    sync::Mutex,
    time::Duration as StdDuration,
};
use thiserror::Error;
use tokio::sync::watch;

const REGISTRY_HISTORY_LIMIT: usize = 1_024;
const EVENT_LIMIT: usize = 1_024;
const SOURCE_RECOVERY_WINDOW: Duration = Duration::seconds(60);
const DEFAULT_PAGE_LIMIT: usize = 50;
const MAX_PAGE_LIMIT: usize = EMBEDDED_BROWSER_SNAPSHOT_MAX_PAGES_PER_CHUNK;
const MAX_ACTIVE_CREATIONS: usize = EMBEDDED_BROWSER_MAX_SOURCES;

#[derive(Debug, Error)]
#[error("{code}: {message}")]
pub struct BrowserControlError {
    pub code: &'static str,
    pub message: String,
    pub status_code: u16,
}

impl BrowserControlError {
    pub(crate) fn new(code: &'static str, message: impl Into<String>, status_code: u16) -> Self {
        Self {
            code,
            message: message.into(),
            status_code,
        }
    }

    fn not_found(code: &'static str, message: impl Into<String>) -> Self {
        Self::new(code, message, 404)
    }

    fn conflict(code: &'static str, message: impl Into<String>) -> Self {
        Self::new(code, message, 409)
    }
}

#[derive(Debug, Clone)]
pub struct BrowserSourceRegistration {
    pub panel_id: String,
    pub owner_ref: String,
    pub display_name: String,
    pub host_label: Option<String>,
    pub publisher_ref: String,
    pub renderer_host_binding: Option<String>,
    pub page_host: EmbeddedBrowserPageHost,
    pub page_host_capabilities: EmbeddedBrowserPageHostCapabilities,
}

#[derive(Debug, Clone)]
pub struct BrowserControlEvent {
    pub event_type: &'static str,
    pub payload: Value,
}

#[derive(Debug, Clone)]
pub struct BrowserLeaseCommandTarget {
    pub lease: EmbeddedBrowserLease,
    pub page: EmbeddedBrowserPage,
    pub renderer_host_binding: Option<String>,
}

#[derive(Debug, Clone)]
pub struct BrowserControlSourceBinding {
    pub source_ref: String,
    pub generation: u64,
    pub page_host: EmbeddedBrowserPageHost,
    pub page_host_capabilities: EmbeddedBrowserPageHostCapabilities,
    pub state: String,
    pub source_revision: u64,
    pub registry_epoch: String,
    pub registry_revision: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum BrowserSourceState {
    Pending,
    Syncing,
    Ready,
    Disconnected,
    Expired,
    Revoked,
    Closed,
}

impl BrowserSourceState {
    fn as_str(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Syncing => "syncing",
            Self::Ready => "ready",
            Self::Disconnected => "disconnected",
            Self::Expired => "expired",
            Self::Revoked => "revoked",
            Self::Closed => "closed",
        }
    }
}

#[derive(Debug, Clone)]
struct SnapshotAssembly {
    snapshot_ref: String,
    source_revision: u64,
    registry_epoch: String,
    chunks: Vec<Option<Vec<EmbeddedBrowserPage>>>,
}

#[derive(Debug, Clone)]
struct SourceRecord {
    source_ref: String,
    generation: u64,
    registration: BrowserSourceRegistration,
    state: BrowserSourceState,
    source_revision: u64,
    pages: BTreeMap<String, EmbeddedBrowserPage>,
    snapshot: Option<SnapshotAssembly>,
    disconnected_at: Option<DateTime<Utc>>,
}

impl SourceRecord {
    fn public_source(&self) -> EmbeddedBrowserSource {
        EmbeddedBrowserSource {
            source_ref: self.source_ref.clone(),
            generation: self.generation,
            panel_id: self.registration.panel_id.clone(),
            display_name: self.registration.display_name.clone(),
            page_host: self.registration.page_host,
            page_host_capabilities: self.registration.page_host_capabilities,
            revision: self.source_revision,
        }
    }
}

#[derive(Debug, Clone)]
struct CreationRecord {
    view: EmbeddedBrowserCreationView,
    requester_session_ref: String,
    claimed_source_ref: Option<String>,
    claimed_generation: Option<u64>,
    claimed_renderer_host_binding: Option<String>,
    declined_source_refs: HashSet<String>,
    expires_at: DateTime<Utc>,
}

#[derive(Debug, Clone)]
struct LeaseRecord {
    lease: EmbeddedBrowserLease,
    session_ref: String,
    expires_at: DateTime<Utc>,
}

#[derive(Debug, Clone)]
struct CdpAccessTokenRecord {
    session_ref: String,
    access_revision: u64,
    expires_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Copy)]
struct InstanceAccessState {
    active: bool,
    revision: u64,
}

impl Default for InstanceAccessState {
    fn default() -> Self {
        Self {
            active: false,
            revision: 0,
        }
    }
}

#[derive(Debug, Clone)]
struct RegistryHistoryEntry {
    delta: EmbeddedBrowserRegistryDelta,
}

struct BrowserControlInner {
    registry_epoch: String,
    registry_revision: u64,
    sources: HashMap<String, SourceRecord>,
    source_by_publisher: HashMap<String, String>,
    creations: HashMap<String, CreationRecord>,
    leases: HashMap<String, LeaseRecord>,
    tab_lease: HashMap<String, String>,
    access: InstanceAccessState,
    cdp_tokens: HashMap<String, CdpAccessTokenRecord>,
    history: VecDeque<RegistryHistoryEntry>,
    events: VecDeque<BrowserControlEvent>,
    creation_revision: u64,
    creation_changed: watch::Sender<u64>,
}

pub struct BrowserControlService {
    inner: Mutex<BrowserControlInner>,
}

impl Default for BrowserControlService {
    fn default() -> Self {
        Self::new()
    }
}

impl BrowserControlService {
    pub fn new() -> Self {
        let (creation_changed, _) = watch::channel(0);
        Self {
            inner: Mutex::new(BrowserControlInner {
                registry_epoch: mint_entity_id("bep"),
                registry_revision: 0,
                sources: HashMap::new(),
                source_by_publisher: HashMap::new(),
                creations: HashMap::new(),
                leases: HashMap::new(),
                tab_lease: HashMap::new(),
                access: InstanceAccessState::default(),
                cdp_tokens: HashMap::new(),
                history: VecDeque::new(),
                events: VecDeque::new(),
                creation_revision: 0,
                creation_changed,
            }),
        }
    }

    pub fn registry_epoch(&self) -> String {
        self.lock().registry_epoch.clone()
    }

    pub fn registry_revision(&self) -> u64 {
        self.lock().registry_revision
    }

    pub fn register_source(
        &self,
        registration: BrowserSourceRegistration,
    ) -> Result<EmbeddedBrowserSource, BrowserControlError> {
        validate_registration(&registration)?;
        let now = Utc::now();
        let mut inner = self.lock();
        let existing_ref = inner
            .source_by_publisher
            .get(&registration.publisher_ref)
            .cloned();
        let (source_ref, reconnected) = if let Some(source_ref) = existing_ref {
            let existing = inner.sources.get_mut(&source_ref).ok_or_else(|| {
                BrowserControlError::not_found(
                    "BROWSER_SOURCE_NOT_FOUND",
                    "Browser source was not found.",
                )
            })?;
            if existing.registration.panel_id != registration.panel_id
                || existing.registration.owner_ref != registration.owner_ref
            {
                return Err(BrowserControlError::new(
                    "BROWSER_AUTHORIZATION_REQUIRED",
                    "Browser source belongs to another publisher.",
                    403,
                ));
            }
            existing.generation = existing.generation.saturating_add(1);
            existing.registration = registration;
            existing.state = BrowserSourceState::Pending;
            existing.snapshot = None;
            existing.disconnected_at = None;
            (source_ref, true)
        } else {
            if inner.sources.len() >= EMBEDDED_BROWSER_MAX_SOURCES {
                return Err(BrowserControlError::new(
                    "BROWSER_LIMIT_EXCEEDED",
                    "The browser source limit has been reached.",
                    409,
                ));
            }
            let source_ref = mint_entity_id("bsr");
            let record = SourceRecord {
                source_ref: source_ref.clone(),
                generation: 1,
                registration,
                state: BrowserSourceState::Pending,
                source_revision: 0,
                pages: BTreeMap::new(),
                snapshot: None,
                disconnected_at: None,
            };
            inner.source_by_publisher.insert(
                record.registration.publisher_ref.clone(),
                source_ref.clone(),
            );
            inner.sources.insert(source_ref.clone(), record);
            (source_ref, false)
        };
        if reconnected {
            // Every transport reconnect starts a new source generation. Retained
            // page-pool pages may only be shown as unavailable while the source is
            // disconnected; a new snapshot must re-establish page identity before
            // the source becomes ready again.
            fail_active_creations_for_source(&mut inner, &source_ref);
            remove_all_source_pages(&mut inner, &source_ref, "source-reconnected");
            remove_leases_for_source(&mut inner, &source_ref, now);
        }
        let source = inner
            .sources
            .get(&source_ref)
            .expect("registered source exists")
            .public_source();
        record_source_event(&mut inner, &source_ref, source.page_host, "pending");
        Ok(source)
    }

    pub fn commit_snapshot(
        &self,
        snapshot: EmbeddedBrowserSourceSnapshot,
    ) -> Result<(), BrowserControlError> {
        let now = Utc::now();
        let mut inner = self.lock();
        validate_snapshot(&inner, &snapshot)?;
        let source = inner.sources.get_mut(&snapshot.source_ref).ok_or_else(|| {
            BrowserControlError::not_found(
                "BROWSER_SOURCE_NOT_FOUND",
                "Browser source was not found.",
            )
        })?;
        let index = snapshot.chunk_index as usize;
        let assembly = source.snapshot.get_or_insert_with(|| SnapshotAssembly {
            snapshot_ref: snapshot.snapshot_ref.clone(),
            source_revision: snapshot.source_revision,
            registry_epoch: snapshot.registry_epoch.clone(),
            chunks: vec![None; snapshot.chunk_count as usize],
        });
        if assembly.snapshot_ref != snapshot.snapshot_ref
            || assembly.source_revision != snapshot.source_revision
            || assembly.registry_epoch != snapshot.registry_epoch
            || assembly.chunks.len() != snapshot.chunk_count as usize
        {
            return Err(BrowserControlError::conflict(
                "BROWSER_SOURCE_UNAVAILABLE",
                "Snapshot chunks do not belong to one snapshot transaction.",
            ));
        }
        if index >= assembly.chunks.len() {
            return Err(BrowserControlError::new(
                "BROWSER_SNAPSHOT_REQUIRED",
                "Snapshot chunk index is outside the snapshot manifest.",
                409,
            ));
        }
        assembly.chunks[index] = Some(snapshot.pages);
        if !assembly.chunks.iter().all(Option::is_some) || !snapshot.complete {
            source.state = BrowserSourceState::Syncing;
            return Ok(());
        }
        let mut pages = BTreeMap::new();
        for page in assembly.chunks.iter().flatten().flatten() {
            if page.source_ref != snapshot.source_ref || page.generation != snapshot.generation {
                return Err(BrowserControlError::conflict(
                    "BROWSER_SOURCE_UNAVAILABLE",
                    "Snapshot page does not belong to the declared source generation.",
                ));
            }
            pages.insert(page.tab_ref.clone(), page.clone());
        }
        if pages.len() > EMBEDDED_BROWSER_MAX_PAGES_PER_SOURCE {
            return Err(BrowserControlError::new(
                "BROWSER_LIMIT_EXCEEDED",
                "The browser page limit has been reached.",
                409,
            ));
        }
        let (page_host, removed, upserts) = {
            let removed = source
                .pages
                .keys()
                .filter(|tab_ref| !pages.contains_key(*tab_ref))
                .cloned()
                .collect::<Vec<_>>();
            let upserts = pages.values().cloned().collect::<Vec<_>>();
            source.pages = pages;
            source.source_revision = snapshot.source_revision;
            source.snapshot = None;
            source.state = BrowserSourceState::Syncing;
            (source.registration.page_host, removed, upserts)
        };
        remove_leases_for_tabs(&mut inner, &removed, now);
        record_registry_delta(
            &mut inner,
            &snapshot.source_ref,
            page_host,
            upserts,
            removed,
        );
        Ok(())
    }

    pub fn commit_delta(
        &self,
        delta: EmbeddedBrowserSourceDelta,
    ) -> Result<u64, BrowserControlError> {
        let now = Utc::now();
        let mut inner = self.lock();
        let source = inner.sources.get_mut(&delta.source_ref).ok_or_else(|| {
            BrowserControlError::not_found(
                "BROWSER_SOURCE_NOT_FOUND",
                "Browser source was not found.",
            )
        })?;
        if source.generation != delta.generation {
            return Err(BrowserControlError::conflict(
                "BROWSER_LEASE_STALE",
                "Source generation is stale.",
            ));
        }
        if source.state != BrowserSourceState::Syncing && source.state != BrowserSourceState::Ready
        {
            return Err(BrowserControlError::conflict(
                "BROWSER_SOURCE_UNAVAILABLE",
                "Browser source is not ready for deltas.",
            ));
        }
        if delta.base_revision != source.source_revision {
            return Err(BrowserControlError::conflict(
                "BROWSER_SNAPSHOT_REQUIRED",
                "Browser source revision is not contiguous.",
            ));
        }
        for page in &delta.upserts {
            if page.source_ref != delta.source_ref || page.generation != delta.generation {
                return Err(BrowserControlError::conflict(
                    "BROWSER_SOURCE_UNAVAILABLE",
                    "Delta page does not belong to the declared source generation.",
                ));
            }
        }
        let mut next_pages = source.pages.clone();
        for tab_ref in &delta.removes {
            next_pages.remove(tab_ref);
        }
        for page in &delta.upserts {
            next_pages.insert(page.tab_ref.clone(), page.clone());
        }
        if next_pages.len() > EMBEDDED_BROWSER_MAX_PAGES_PER_SOURCE {
            return Err(BrowserControlError::new(
                "BROWSER_LIMIT_EXCEEDED",
                "The browser page limit has been reached.",
                409,
            ));
        }
        source.pages = next_pages;
        source.source_revision = delta.revision;
        let page_host = source.registration.page_host;
        remove_leases_for_tabs(&mut inner, &delta.removes, now);
        record_registry_delta(
            &mut inner,
            &delta.source_ref,
            page_host,
            delta.upserts,
            delta.removes,
        );
        Ok(delta.revision)
    }

    pub fn mark_synced(
        &self,
        source_ref: &str,
        generation: u64,
        registry_epoch: &str,
        registry_revision: u64,
    ) -> Result<(), BrowserControlError> {
        if !self.sync_source_if_current(
            source_ref,
            generation,
            registry_epoch,
            registry_revision,
        )? {
            return Err(BrowserControlError::conflict(
                "BROWSER_SNAPSHOT_REQUIRED",
                "Browser registry revision changed before sync completed.",
            ));
        }
        Ok(())
    }

    pub fn sync_source_if_current(
        &self,
        source_ref: &str,
        generation: u64,
        registry_epoch: &str,
        registry_revision: u64,
    ) -> Result<bool, BrowserControlError> {
        let mut inner = self.lock();
        if inner.registry_epoch != registry_epoch || inner.registry_revision != registry_revision {
            return Ok(false);
        }
        let source = inner.sources.get_mut(source_ref).ok_or_else(|| {
            BrowserControlError::not_found(
                "BROWSER_SOURCE_NOT_FOUND",
                "Browser source was not found.",
            )
        })?;
        if source.generation != generation {
            return Err(BrowserControlError::conflict(
                "BROWSER_LEASE_STALE",
                "Source generation is stale.",
            ));
        }
        if source.state == BrowserSourceState::Ready {
            return Ok(true);
        }
        if source.state != BrowserSourceState::Syncing {
            return Err(BrowserControlError::conflict(
                "BROWSER_SOURCE_UNAVAILABLE",
                "Browser source is not waiting for sync confirmation.",
            ));
        }
        let page_host = source.registration.page_host;
        source.state = BrowserSourceState::Ready;
        record_source_event(&mut inner, source_ref, page_host, "ready");
        Ok(true)
    }

    pub fn source_binding(
        &self,
        source_ref: &str,
        generation: u64,
    ) -> Result<BrowserControlSourceBinding, BrowserControlError> {
        let inner = self.lock();
        let source = inner.sources.get(source_ref).ok_or_else(|| {
            BrowserControlError::not_found(
                "BROWSER_SOURCE_NOT_FOUND",
                "Browser source was not found.",
            )
        })?;
        if source.generation != generation {
            return Err(BrowserControlError::conflict(
                "BROWSER_LEASE_STALE",
                "Source generation is stale.",
            ));
        }
        Ok(BrowserControlSourceBinding {
            source_ref: source.source_ref.clone(),
            generation: source.generation,
            page_host: source.registration.page_host,
            page_host_capabilities: source.registration.page_host_capabilities,
            state: source.state.as_str().to_string(),
            source_revision: source.source_revision,
            registry_epoch: inner.registry_epoch.clone(),
            registry_revision: inner.registry_revision,
        })
    }

    pub fn source_generation(&self, source_ref: &str) -> Option<u64> {
        self.lock()
            .sources
            .get(source_ref)
            .map(|source| source.generation)
    }

    pub fn disconnect_source(
        &self,
        source_ref: &str,
        generation: u64,
    ) -> Result<(), BrowserControlError> {
        let now = Utc::now();
        let mut inner = self.lock();
        let (page_host, state) = {
            let source = inner.sources.get_mut(source_ref).ok_or_else(|| {
                BrowserControlError::not_found(
                    "BROWSER_SOURCE_NOT_FOUND",
                    "Browser source was not found.",
                )
            })?;
            if source.generation != generation {
                return Ok(());
            }
            source.snapshot = None;
            let page_host = source.registration.page_host;
            if page_host == EmbeddedBrowserPageHost::RendererWebview {
                source.state = BrowserSourceState::Closed;
            } else {
                source.state = BrowserSourceState::Disconnected;
                source.disconnected_at = Some(now);
            }
            (page_host, source.state)
        };
        remove_leases_for_source(&mut inner, source_ref, now);
        fail_active_creations_for_source(&mut inner, source_ref);
        if page_host == EmbeddedBrowserPageHost::RendererWebview {
            remove_all_source_pages(&mut inner, source_ref, "renderer-host-closed");
        } else {
            mark_source_pages_unavailable(&mut inner, source_ref);
        }
        record_source_event(&mut inner, source_ref, page_host, state.as_str());
        Ok(())
    }

    pub fn revoke_source(&self, source_ref: &str, reason: &str) -> Result<(), BrowserControlError> {
        let now = Utc::now();
        let mut inner = self.lock();
        let page_host = {
            let source = inner.sources.get_mut(source_ref).ok_or_else(|| {
                BrowserControlError::not_found(
                    "BROWSER_SOURCE_NOT_FOUND",
                    "Browser source was not found.",
                )
            })?;
            source.state = BrowserSourceState::Revoked;
            source.snapshot = None;
            source.registration.page_host
        };
        remove_leases_for_source(&mut inner, source_ref, now);
        fail_active_creations_for_source(&mut inner, source_ref);
        remove_all_source_pages(&mut inner, source_ref, reason);
        record_source_event(&mut inner, source_ref, page_host, "revoked");
        Ok(())
    }

    pub fn prune(&self, now: DateTime<Utc>) -> usize {
        let mut inner = self.lock();
        let expired_sources = inner
            .sources
            .values()
            .filter(|source| {
                source.state == BrowserSourceState::Disconnected
                    && source
                        .disconnected_at
                        .is_some_and(|at| now - at >= SOURCE_RECOVERY_WINDOW)
            })
            .map(|source| (source.source_ref.clone(), source.registration.page_host))
            .collect::<Vec<_>>();
        for (source_ref, page_host) in &expired_sources {
            if let Some(source) = inner.sources.get_mut(source_ref) {
                source.state = BrowserSourceState::Expired;
                source.snapshot = None;
            }
            remove_leases_for_source(&mut inner, source_ref, now);
            fail_active_creations_for_source(&mut inner, source_ref);
            remove_all_source_pages(&mut inner, source_ref, "source-expired");
            record_source_event(&mut inner, source_ref, *page_host, "expired");
        }
        let expired_creations = inner
            .creations
            .iter()
            .filter(|(_, creation)| {
                matches!(
                    creation.view.state,
                    EmbeddedBrowserCreationStatus::Pending
                        | EmbeddedBrowserCreationStatus::Claimed
                        | EmbeddedBrowserCreationStatus::Creating
                ) && creation.expires_at <= now
            })
            .map(|(creation_ref, _)| creation_ref.clone())
            .collect::<Vec<_>>();
        for creation_ref in &expired_creations {
            let view = {
                let Some(creation) = inner.creations.get_mut(creation_ref) else {
                    continue;
                };
                creation.view.state = EmbeddedBrowserCreationStatus::Expired;
                creation.view.revision = creation.view.revision.saturating_add(1);
                creation.view.clone()
            };
            record_creation_event(&mut inner, &view);
        }
        remove_expired_leases(&mut inner, now);
        expired_sources.len() + expired_creations.len()
    }

    pub fn access(&self) -> EmbeddedBrowserAccessView {
        let inner = self.lock();
        EmbeddedBrowserAccessView {
            active: inner.access.active,
            revision: inner.access.revision,
        }
    }

    pub fn grant_instance_access(&self) -> EmbeddedBrowserAccessView {
        let mut inner = self.lock();
        let mut changed = false;
        if !inner.access.active {
            inner.access.active = true;
            inner.access.revision = inner.access.revision.saturating_add(1);
            changed = true;
        }
        let view = EmbeddedBrowserAccessView {
            active: inner.access.active,
            revision: inner.access.revision,
        };
        if changed {
            push_event(
                &mut inner,
                "browser.access.changed",
                json!({ "active": view.active, "revision": view.revision }),
            );
        }
        view
    }

    pub fn issue_cdp_token(
        &self,
        session_ref: &str,
    ) -> Result<(String, DateTime<Utc>), BrowserControlError> {
        let now = Utc::now();
        let mut inner = self.lock();
        if !inner.access.active {
            return Err(BrowserControlError::new(
                "BROWSER_AUTHORIZATION_REQUIRED",
                "Agent browser access is not enabled for this controlled instance.",
                403,
            ));
        }
        inner.cdp_tokens.retain(|_, record| record.expires_at > now);
        let mut bytes = [0_u8; 32];
        rand::rng().fill_bytes(&mut bytes);
        use base64::Engine as _;
        let token = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes);
        let expires_at = now + Duration::milliseconds(EMBEDDED_BROWSER_CDP_ACCESS_TTL_MS as i64);
        let access_revision = inner.access.revision;
        inner.cdp_tokens.insert(
            token.clone(),
            CdpAccessTokenRecord {
                session_ref: session_ref.to_string(),
                access_revision,
                expires_at,
            },
        );
        Ok((token, expires_at))
    }

    pub fn validate_cdp_token(&self, token: &str) -> Option<String> {
        let now = Utc::now();
        let mut inner = self.lock();
        inner.cdp_tokens.retain(|_, record| record.expires_at > now);
        if !inner.access.active {
            return None;
        }
        inner
            .cdp_tokens
            .get(token)
            .filter(|record| record.access_revision == inner.access.revision)
            .map(|record| record.session_ref.clone())
    }

    pub fn revoke_instance_access(&self) -> usize {
        let now = Utc::now();
        let mut inner = self.lock();
        inner.access.active = false;
        inner.access.revision = inner.access.revision.saturating_add(1);
        inner.cdp_tokens.clear();
        let leases = inner.leases.keys().cloned().collect::<Vec<_>>();
        for lease_ref in &leases {
            remove_lease(&mut inner, lease_ref, now);
        }
        let active = inner.access.active;
        let revision = inner.access.revision;
        push_event(
            &mut inner,
            "browser.access.changed",
            json!({ "active": active, "revision": revision }),
        );
        leases.len()
    }

    pub fn cleanup_session(&self, session_ref: &str) -> usize {
        let now = Utc::now();
        let mut inner = self.lock();
        inner
            .cdp_tokens
            .retain(|_, record| record.session_ref != session_ref);
        let leases = inner
            .leases
            .iter()
            .filter(|(_, lease)| lease.session_ref == session_ref)
            .map(|(lease_ref, _)| lease_ref.clone())
            .collect::<Vec<_>>();
        for lease_ref in &leases {
            remove_lease(&mut inner, lease_ref, now);
        }
        leases.len()
    }

    pub fn session_has_cdp_tokens(&self, session_ref: &str) -> bool {
        let now = Utc::now();
        self.lock()
            .cdp_tokens
            .values()
            .any(|record| record.session_ref == session_ref && record.expires_at > now)
    }

    pub fn list_sources(&self) -> Vec<EmbeddedBrowserSource> {
        self.lock()
            .sources
            .values()
            .filter(|source| source.state == BrowserSourceState::Ready)
            .map(SourceRecord::public_source)
            .collect()
    }

    pub fn source_owner(&self, source_ref: &str) -> Option<(String, String)> {
        self.lock().sources.get(source_ref).map(|source| {
            (
                source.registration.panel_id.clone(),
                source.registration.owner_ref.clone(),
            )
        })
    }

    pub fn list_pages(
        &self,
        cursor: Option<&str>,
        limit: Option<usize>,
    ) -> Result<EmbeddedBrowserPageListResponse, BrowserControlError> {
        let inner = self.lock();
        let pages = ready_pages(&inner);
        let offset = parse_cursor(cursor, &inner.registry_epoch)?;
        let limit = limit.unwrap_or(DEFAULT_PAGE_LIMIT).clamp(1, MAX_PAGE_LIMIT);
        let items = pages
            .iter()
            .cloned()
            .skip(offset)
            .take(limit)
            .collect::<Vec<_>>();
        let has_more = pages.len() > offset + items.len();
        Ok(EmbeddedBrowserPageListResponse {
            registry_epoch: inner.registry_epoch.clone(),
            registry_revision: inner.registry_revision,
            items,
            cursor: has_more.then(|| format!("{}:{}", inner.registry_epoch, offset + limit)),
        })
    }

    pub fn all_pages(&self) -> Vec<EmbeddedBrowserPage> {
        ready_pages(&self.lock())
    }

    pub fn page(&self, tab_ref: &str) -> Result<EmbeddedBrowserPage, BrowserControlError> {
        let inner = self.lock();
        locate_page(&inner, tab_ref)
            .map(|(_, _, page)| page)
            .ok_or_else(|| {
                BrowserControlError::not_found(
                    "BROWSER_TAB_NOT_FOUND",
                    "Browser tab was not found.",
                )
            })
    }

    pub fn registry_delta_since(
        &self,
        registry_epoch: &str,
        after_revision: u64,
    ) -> Result<EmbeddedBrowserRegistryDelta, BrowserControlError> {
        let inner = self.lock();
        if inner.registry_epoch != registry_epoch {
            return Err(BrowserControlError::conflict(
                "BROWSER_SNAPSHOT_REQUIRED",
                "Browser registry epoch changed.",
            ));
        }
        if after_revision == inner.registry_revision {
            return Ok(EmbeddedBrowserRegistryDelta {
                registry_epoch: registry_epoch.to_string(),
                base_revision: after_revision,
                revision: after_revision,
                upserts: Vec::new(),
                removes: Vec::new(),
                cursor: None,
            });
        }
        if after_revision > inner.registry_revision {
            return Err(BrowserControlError::conflict(
                "BROWSER_SNAPSHOT_REQUIRED",
                "Browser registry revision is ahead of the instance.",
            ));
        }
        let relevant = inner
            .history
            .iter()
            .filter(|entry| entry.delta.revision > after_revision)
            .collect::<Vec<_>>();
        let Some(first) = relevant.first() else {
            return Err(BrowserControlError::conflict(
                "BROWSER_SNAPSHOT_REQUIRED",
                "Browser registry delta history is unavailable.",
            ));
        };
        if first.delta.base_revision != after_revision {
            return Err(BrowserControlError::conflict(
                "BROWSER_SNAPSHOT_REQUIRED",
                "Browser registry delta has a revision gap.",
            ));
        }
        let mut upserts = BTreeMap::new();
        let mut removes = HashSet::new();
        let mut revision = after_revision;
        for entry in relevant {
            if entry.delta.base_revision != revision {
                break;
            }
            if upserts.len() + entry.delta.upserts.len() > MAX_PAGE_LIMIT {
                break;
            }
            revision = entry.delta.revision;
            for page in &entry.delta.upserts {
                removes.remove(&page.tab_ref);
                upserts.insert(page.tab_ref.clone(), page.clone());
            }
            for tab_ref in &entry.delta.removes {
                upserts.remove(tab_ref);
                removes.insert(tab_ref.clone());
            }
        }
        Ok(EmbeddedBrowserRegistryDelta {
            registry_epoch: registry_epoch.to_string(),
            base_revision: after_revision,
            revision,
            upserts: upserts.into_values().collect(),
            removes: removes.into_iter().collect(),
            cursor: None,
        })
    }

    pub fn request_creation(
        &self,
        session_ref: &str,
        url: &str,
        title: Option<&str>,
    ) -> Result<EmbeddedBrowserCreationView, BrowserControlError> {
        let now = Utc::now();
        let mut inner = self.lock();
        if inner
            .creations
            .values()
            .filter(|creation| {
                matches!(
                    creation.view.state,
                    EmbeddedBrowserCreationStatus::Pending
                        | EmbeddedBrowserCreationStatus::Claimed
                        | EmbeddedBrowserCreationStatus::Creating
                )
            })
            .count()
            >= MAX_ACTIVE_CREATIONS
        {
            return Err(BrowserControlError::new(
                "BROWSER_LIMIT_EXCEEDED",
                "Too many browser creation requests are active.",
                409,
            ));
        }
        let candidates = creation_candidates(&inner);
        if candidates.is_empty() {
            return Err(BrowserControlError::new(
                "BROWSER_CREATION_NO_CANDIDATE",
                "No desktop source can create a browser page.",
                409,
            ));
        }
        let creation_ref = mint_entity_id("bcr");
        let view = EmbeddedBrowserCreationView {
            creation_ref: creation_ref.clone(),
            requested_url: normalized_text(url, 4_096, "about:blank"),
            title: title
                .map(|value| normalized_text(value, 512, ""))
                .filter(|value| !value.is_empty()),
            state: EmbeddedBrowserCreationStatus::Pending,
            expires_at: rfc3339(
                now + Duration::milliseconds(EMBEDDED_BROWSER_CREATION_TTL_MS as i64),
            ),
            candidates,
            tab_ref: None,
            revision: 1,
        };
        inner.creations.insert(
            creation_ref,
            CreationRecord {
                view: view.clone(),
                requester_session_ref: session_ref.to_string(),
                claimed_source_ref: None,
                claimed_generation: None,
                claimed_renderer_host_binding: None,
                declined_source_refs: HashSet::new(),
                expires_at: now + Duration::milliseconds(EMBEDDED_BROWSER_CREATION_TTL_MS as i64),
            },
        );
        record_creation_event(&mut inner, &view);
        Ok(view)
    }

    pub fn get_creation(
        &self,
        session_ref: &str,
        creation_ref: &str,
    ) -> Result<EmbeddedBrowserCreationView, BrowserControlError> {
        let now = Utc::now();
        let mut inner = self.lock();
        expire_creation_if_needed(&mut inner, creation_ref, now);
        let creation = inner.creations.get(creation_ref).ok_or_else(|| {
            BrowserControlError::not_found(
                "BROWSER_CREATION_NOT_FOUND",
                "Browser creation request was not found.",
            )
        })?;
        if creation.requester_session_ref != session_ref {
            return Err(BrowserControlError::not_found(
                "BROWSER_CREATION_NOT_FOUND",
                "Browser creation request was not found.",
            ));
        }
        Ok(creation.view.clone())
    }

    pub async fn wait_for_creation(
        &self,
        session_ref: &str,
        creation_ref: &str,
        timeout: StdDuration,
    ) -> Result<EmbeddedBrowserCreationView, BrowserControlError> {
        // Subscribe before reading the current state so a transition between the
        // read and the wait cannot be lost. This is an in-memory wake-up for one
        // instance-owned state machine, not product-state polling.
        let mut changed = self
            .inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .creation_changed
            .subscribe();
        let deadline = tokio::time::Instant::now() + timeout;
        loop {
            let view = self.get_creation(session_ref, creation_ref)?;
            if matches!(
                view.state,
                EmbeddedBrowserCreationStatus::Ready
                    | EmbeddedBrowserCreationStatus::Failed
                    | EmbeddedBrowserCreationStatus::Declined
                    | EmbeddedBrowserCreationStatus::Expired
            ) {
                return Ok(view);
            }
            let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
            if remaining.is_zero() {
                return Ok(view);
            }
            if tokio::time::timeout(remaining, changed.changed())
                .await
                .is_err()
            {
                return self.get_creation(session_ref, creation_ref);
            }
        }
    }

    pub fn list_creation_approvals_for_source_owner(
        &self,
        panel_id: &str,
        owner_ref: &str,
    ) -> EmbeddedBrowserCreationApprovalListResponse {
        let now = Utc::now();
        let mut inner = self.lock();
        let creation_refs = inner.creations.keys().cloned().collect::<Vec<_>>();
        for creation_ref in creation_refs {
            expire_creation_if_needed(&mut inner, &creation_ref, now);
        }
        let mut items = inner
            .creations
            .values()
            .filter(|creation| creation.view.state == EmbeddedBrowserCreationStatus::Pending)
            .filter(|creation| {
                creation.view.candidates.iter().any(|candidate| {
                    inner
                        .sources
                        .get(&candidate.source_ref)
                        .is_some_and(|source| {
                            source.registration.panel_id == panel_id
                                && source.registration.owner_ref == owner_ref
                                && creation_candidate_for_source(&inner, &candidate.source_ref)
                                    .is_some_and(|current| current.can_create)
                        })
                })
            })
            .map(|creation| EmbeddedBrowserCreationApprovalView {
                request: creation.view.clone(),
                requester_session_ref: creation.requester_session_ref.clone(),
            })
            .collect::<Vec<_>>();
        items.sort_by(|left, right| {
            left.request
                .expires_at
                .cmp(&right.request.expires_at)
                .then_with(|| left.request.creation_ref.cmp(&right.request.creation_ref))
        });
        items.truncate(MAX_ACTIVE_CREATIONS);
        EmbeddedBrowserCreationApprovalListResponse {
            creation_revision: inner.creation_revision,
            items,
        }
    }

    pub fn claim_creation(
        &self,
        source_ref: &str,
        creation_ref: &str,
        expected_revision: u64,
    ) -> Result<EmbeddedBrowserCreationView, BrowserControlError> {
        let now = Utc::now();
        let mut inner = self.lock();
        expire_creation_if_needed(&mut inner, creation_ref, now);
        let candidate = creation_candidate_for_source(&inner, source_ref).ok_or_else(|| {
            BrowserControlError::conflict(
                "BROWSER_CREATION_NO_CANDIDATE",
                "Browser source cannot create a page.",
            )
        })?;
        if !candidate.can_create {
            return Err(BrowserControlError::conflict(
                "BROWSER_WINDOW_UNAVAILABLE",
                "Browser source has no live renderer host.",
            ));
        }
        let (page_host, generation, renderer_host_binding) = inner
            .sources
            .get(source_ref)
            .map(|source| {
                (
                    source.registration.page_host,
                    source.generation,
                    source.registration.renderer_host_binding.clone(),
                )
            })
            .ok_or_else(|| {
                BrowserControlError::not_found(
                    "BROWSER_SOURCE_NOT_FOUND",
                    "Browser source was not found.",
                )
            })?;
        let creation = inner.creations.get_mut(creation_ref).ok_or_else(|| {
            BrowserControlError::not_found(
                "BROWSER_CREATION_NOT_FOUND",
                "Browser creation request was not found.",
            )
        })?;
        match creation.view.state {
            EmbeddedBrowserCreationStatus::Expired => {
                return Err(BrowserControlError::conflict(
                    "BROWSER_CREATION_EXPIRED",
                    "Browser creation request expired.",
                ));
            }
            EmbeddedBrowserCreationStatus::Pending => {}
            _ => {
                return Err(BrowserControlError::conflict(
                    "BROWSER_CREATION_CONFLICT",
                    "Browser creation request was already claimed.",
                ));
            }
        }
        if creation.view.revision != expected_revision {
            return Err(BrowserControlError::conflict(
                "BROWSER_CREATION_CONFLICT",
                "Browser creation revision is stale.",
            ));
        }
        creation.view.state = EmbeddedBrowserCreationStatus::Claimed;
        creation.view.revision = creation.view.revision.saturating_add(1);
        creation.claimed_source_ref = Some(source_ref.to_string());
        creation.claimed_generation = Some(generation);
        creation.claimed_renderer_host_binding = renderer_host_binding;
        debug_assert!(matches!(
            page_host,
            EmbeddedBrowserPageHost::RendererWebview | EmbeddedBrowserPageHost::MainPagePool
        ));
        let view = creation.view.clone();
        record_creation_event(&mut inner, &view);
        Ok(view)
    }

    pub fn mark_creation_creating(
        &self,
        source_ref: &str,
        creation_ref: &str,
    ) -> Result<EmbeddedBrowserCreationView, BrowserControlError> {
        let mut inner = self.lock();
        let creation = inner.creations.get_mut(creation_ref).ok_or_else(|| {
            BrowserControlError::not_found(
                "BROWSER_CREATION_NOT_FOUND",
                "Browser creation request was not found.",
            )
        })?;
        if creation.claimed_source_ref.as_deref() != Some(source_ref)
            || creation.view.state != EmbeddedBrowserCreationStatus::Claimed
        {
            return Err(BrowserControlError::conflict(
                "BROWSER_CREATION_CONFLICT",
                "Browser creation request is not claimable by this source.",
            ));
        }
        creation.view.state = EmbeddedBrowserCreationStatus::Creating;
        creation.view.revision = creation.view.revision.saturating_add(1);
        let view = creation.view.clone();
        record_creation_event(&mut inner, &view);
        Ok(view)
    }

    pub fn complete_creation(
        &self,
        source_ref: &str,
        creation_ref: &str,
        tab_ref: &str,
    ) -> Result<EmbeddedBrowserCreationView, BrowserControlError> {
        let mut inner = self.lock();
        if !inner.creations.contains_key(creation_ref) {
            return Err(BrowserControlError::not_found(
                "BROWSER_CREATION_NOT_FOUND",
                "Browser creation request was not found.",
            ));
        }
        let page_exists = inner
            .sources
            .get(source_ref)
            .is_some_and(|source| source.pages.contains_key(tab_ref));
        if !page_exists {
            return Err(BrowserControlError::conflict(
                "BROWSER_TAB_NOT_FOUND",
                "Browser tab was not registered by the source.",
            ));
        }
        let creation = inner.creations.get_mut(creation_ref).ok_or_else(|| {
            BrowserControlError::not_found(
                "BROWSER_CREATION_NOT_FOUND",
                "Browser creation request was not found.",
            )
        })?;
        if creation.view.state == EmbeddedBrowserCreationStatus::Ready
            && creation.view.tab_ref.as_deref() == Some(tab_ref)
        {
            return Ok(creation.view.clone());
        }
        if creation.claimed_source_ref.as_deref() != Some(source_ref)
            || !matches!(
                creation.view.state,
                EmbeddedBrowserCreationStatus::Claimed | EmbeddedBrowserCreationStatus::Creating
            )
        {
            return Err(BrowserControlError::conflict(
                "BROWSER_CREATION_CONFLICT",
                "Browser creation request was not claimed by this source.",
            ));
        }
        let view = {
            creation.view.state = EmbeddedBrowserCreationStatus::Ready;
            creation.view.tab_ref = Some(tab_ref.to_string());
            creation.view.revision = creation.view.revision.saturating_add(1);
            creation.view.clone()
        };
        record_creation_event(&mut inner, &view);
        Ok(view)
    }

    pub fn fail_creation(
        &self,
        source_ref: &str,
        creation_ref: &str,
        _reason: &str,
    ) -> Result<EmbeddedBrowserCreationView, BrowserControlError> {
        let mut inner = self.lock();
        let creation = inner.creations.get_mut(creation_ref).ok_or_else(|| {
            BrowserControlError::not_found(
                "BROWSER_CREATION_NOT_FOUND",
                "Browser creation request was not found.",
            )
        })?;
        if creation.claimed_source_ref.as_deref() != Some(source_ref) {
            return Err(BrowserControlError::conflict(
                "BROWSER_CREATION_CONFLICT",
                "Browser creation request was not claimed by this source.",
            ));
        }
        creation.view.state = EmbeddedBrowserCreationStatus::Failed;
        creation.view.revision = creation.view.revision.saturating_add(1);
        let view = creation.view.clone();
        record_creation_event(&mut inner, &view);
        Ok(view)
    }

    pub fn fail_creation_if_active(
        &self,
        source_ref: &str,
        creation_ref: &str,
        reason: &str,
    ) -> Result<Option<EmbeddedBrowserCreationView>, BrowserControlError> {
        let active = {
            let inner = self.lock();
            inner.creations.get(creation_ref).is_some_and(|creation| {
                creation.claimed_source_ref.as_deref() == Some(source_ref)
                    && matches!(
                        creation.view.state,
                        EmbeddedBrowserCreationStatus::Claimed
                            | EmbeddedBrowserCreationStatus::Creating
                    )
            })
        };
        if !active {
            return Ok(None);
        }
        self.fail_creation(source_ref, creation_ref, reason)
            .map(Some)
    }

    pub fn decline_creation(
        &self,
        source_ref: &str,
        creation_ref: &str,
        expected_revision: u64,
    ) -> Result<EmbeddedBrowserCreationView, BrowserControlError> {
        let mut inner = self.lock();
        let candidate_exists = creation_candidate_for_source(&inner, source_ref).is_some();
        if !candidate_exists {
            return Err(BrowserControlError::conflict(
                "BROWSER_CREATION_NO_CANDIDATE",
                "Browser source is not a creation candidate.",
            ));
        }
        let creation = inner.creations.get_mut(creation_ref).ok_or_else(|| {
            BrowserControlError::not_found(
                "BROWSER_CREATION_NOT_FOUND",
                "Browser creation request was not found.",
            )
        })?;
        if creation.view.state != EmbeddedBrowserCreationStatus::Pending {
            return Err(BrowserControlError::conflict(
                "BROWSER_CREATION_CONFLICT",
                "Browser creation request is no longer pending.",
            ));
        }
        if creation.view.revision != expected_revision {
            return Err(BrowserControlError::conflict(
                "BROWSER_CREATION_CONFLICT",
                "Browser creation revision is stale.",
            ));
        }
        creation.declined_source_refs.insert(source_ref.to_string());
        let all_declined = creation
            .view
            .candidates
            .iter()
            .filter(|candidate| candidate.can_create)
            .all(|candidate| {
                creation
                    .declined_source_refs
                    .contains(&candidate.source_ref)
            });
        if all_declined {
            creation.view.state = EmbeddedBrowserCreationStatus::Declined;
        }
        creation.view.revision = creation.view.revision.saturating_add(1);
        let view = creation.view.clone();
        record_creation_event(&mut inner, &view);
        Ok(view)
    }

    pub fn attach_tab(
        &self,
        session_ref: &str,
        tab_ref: &str,
    ) -> Result<EmbeddedBrowserLease, BrowserControlError> {
        self.attach_tab_with_ttl(session_ref, tab_ref, Duration::minutes(30))
    }

    fn attach_tab_with_ttl(
        &self,
        session_ref: &str,
        tab_ref: &str,
        ttl: Duration,
    ) -> Result<EmbeddedBrowserLease, BrowserControlError> {
        let now = Utc::now();
        let mut inner = self.lock();
        if !inner.access.active {
            return Err(BrowserControlError::new(
                "BROWSER_AUTHORIZATION_REQUIRED",
                "Agent browser access is not enabled for this controlled instance.",
                403,
            ));
        }
        remove_expired_leases(&mut inner, now);
        let (source_ref, generation, _page) = locate_page(&inner, tab_ref).ok_or_else(|| {
            BrowserControlError::not_found("BROWSER_TAB_NOT_FOUND", "Browser tab was not found.")
        })?;
        if let Some(existing_lease_ref) = inner.tab_lease.get(tab_ref) {
            if let Some(existing) = inner.leases.get(existing_lease_ref) {
                if existing.session_ref != session_ref {
                    return Err(BrowserControlError::conflict(
                        "BROWSER_TARGET_BUSY",
                        "Browser tab is controlled by another AI Session.",
                    ));
                }
                return Ok(existing.lease.clone());
            }
        }
        let lease_ref = mint_entity_id("blr");
        let lease = EmbeddedBrowserLease {
            lease_ref: lease_ref.clone(),
            tab_ref: tab_ref.to_string(),
            source_ref,
            generation,
            expires_at: rfc3339(now + ttl),
        };
        inner.leases.insert(
            lease_ref.clone(),
            LeaseRecord {
                lease: lease.clone(),
                session_ref: session_ref.to_string(),
                expires_at: now + ttl,
            },
        );
        inner.tab_lease.insert(tab_ref.to_string(), lease_ref);
        record_lease_event(&mut inner, &lease, "attached");
        Ok(lease)
    }

    pub fn register_tab(
        &self,
        instance_id: &str,
        source_ref: &str,
        generation: u64,
        tab_ref: &str,
        title: &str,
        url: &str,
        state: &str,
    ) -> Result<EmbeddedBrowserPage, BrowserControlError> {
        let mut inner = self.lock();
        let source = inner.sources.get_mut(source_ref).ok_or_else(|| {
            BrowserControlError::not_found(
                "BROWSER_SOURCE_NOT_FOUND",
                "Browser source was not found.",
            )
        })?;
        if source.generation != generation {
            return Err(BrowserControlError::conflict(
                "BROWSER_LEASE_STALE",
                "Source generation is stale.",
            ));
        }
        if source.state != BrowserSourceState::Ready {
            return Err(BrowserControlError::conflict(
                "BROWSER_SOURCE_UNAVAILABLE",
                "Browser source is not ready.",
            ));
        }
        let tab_ref = normalized_text(tab_ref, 240, "");
        if tab_ref.is_empty() {
            return Err(BrowserControlError::new(
                "BROWSER_OPERATION_UNSUPPORTED",
                "Browser tab identity is invalid.",
                409,
            ));
        }
        if let Some(existing) = source.pages.get(&tab_ref) {
            return Ok(existing.clone());
        }
        source.source_revision = source.source_revision.saturating_add(1);
        let page = EmbeddedBrowserPage {
            source_ref: source_ref.to_string(),
            generation,
            tab_ref: tab_ref.clone(),
            instance_id: instance_id.to_string(),
            page_host: source.registration.page_host,
            page_host_capabilities: source.registration.page_host_capabilities,
            title: normalized_text(title, 512, ""),
            url: normalized_text(url, 4_096, "about:blank"),
            state: normalized_text(state, 40, "ready"),
            revision: source.source_revision,
        };
        source.pages.insert(tab_ref, page.clone());
        let page_host = source.registration.page_host;
        record_registry_delta(
            &mut inner,
            source_ref,
            page_host,
            vec![page.clone()],
            Vec::new(),
        );
        Ok(page)
    }

    pub fn lease_command_target(
        &self,
        session_ref: &str,
        lease_ref: &str,
    ) -> Result<BrowserLeaseCommandTarget, BrowserControlError> {
        let now = Utc::now();
        let mut inner = self.lock();
        remove_expired_leases(&mut inner, now);
        let lease = inner.leases.get(lease_ref).ok_or_else(|| {
            BrowserControlError::not_found("BROWSER_LEASE_STALE", "Browser lease is stale.")
        })?;
        if lease.session_ref != session_ref {
            return Err(BrowserControlError::not_found(
                "BROWSER_LEASE_STALE",
                "Browser lease is stale.",
            ));
        }
        let (source_ref, generation, page) =
            locate_page(&inner, &lease.lease.tab_ref).ok_or_else(|| {
                BrowserControlError::not_found(
                    "BROWSER_TAB_NOT_FOUND",
                    "Browser tab was not found.",
                )
            })?;
        if source_ref != lease.lease.source_ref || generation != lease.lease.generation {
            return Err(BrowserControlError::conflict(
                "BROWSER_LEASE_STALE",
                "Browser page generation changed after attach.",
            ));
        }
        let renderer_host_binding = inner
            .sources
            .get(&source_ref)
            .and_then(|source| source.registration.renderer_host_binding.clone());
        Ok(BrowserLeaseCommandTarget {
            lease: lease.lease.clone(),
            page,
            renderer_host_binding,
        })
    }

    pub fn detach_lease(&self, session_ref: &str, lease_ref: &str) -> bool {
        let now = Utc::now();
        let mut inner = self.lock();
        let Some(lease) = inner.leases.get(lease_ref) else {
            return false;
        };
        if lease.session_ref != session_ref {
            return false;
        }
        remove_lease(&mut inner, lease_ref, now)
    }

    pub fn lease_refs_for_session(&self, session_ref: &str) -> Vec<String> {
        let now = Utc::now();
        let mut inner = self.lock();
        remove_expired_leases(&mut inner, now);
        inner
            .leases
            .iter()
            .filter(|(_, lease)| lease.session_ref == session_ref)
            .map(|(lease_ref, _)| lease_ref.clone())
            .collect()
    }

    pub fn lease_targets_all(&self) -> Vec<(String, String)> {
        let now = Utc::now();
        let mut inner = self.lock();
        remove_expired_leases(&mut inner, now);
        inner
            .leases
            .iter()
            .map(|(lease_ref, lease)| (lease.session_ref.clone(), lease_ref.clone()))
            .collect()
    }

    pub fn lease_session(
        &self,
        lease_ref: &str,
        tab_ref: &str,
        source_ref: &str,
        generation: u64,
    ) -> Option<String> {
        let inner = self.lock();
        let record = inner.leases.get(lease_ref)?;
        if record.lease.tab_ref != tab_ref
            || record.lease.source_ref != source_ref
            || record.lease.generation != generation
        {
            return None;
        }
        Some(record.session_ref.clone())
    }

    pub fn invalidate_lease(&self, lease_ref: &str) -> bool {
        let now = Utc::now();
        let mut inner = self.lock();
        remove_lease(&mut inner, lease_ref, now)
    }

    pub fn destroy_tab(
        &self,
        source_ref: &str,
        generation: u64,
        tab_ref: &str,
        reason: &str,
    ) -> Result<(), BrowserControlError> {
        let now = Utc::now();
        let mut inner = self.lock();
        let source = inner.sources.get_mut(source_ref).ok_or_else(|| {
            BrowserControlError::not_found(
                "BROWSER_SOURCE_NOT_FOUND",
                "Browser source was not found.",
            )
        })?;
        if source.generation != generation {
            return Ok(());
        }
        if source.pages.remove(tab_ref).is_none() {
            return Ok(());
        }
        source.source_revision = source.source_revision.saturating_add(1);
        let page_host = source.registration.page_host;
        remove_leases_for_tabs(&mut inner, &[tab_ref.to_string()], now);
        record_registry_delta(
            &mut inner,
            source_ref,
            page_host,
            Vec::new(),
            vec![tab_ref.to_string()],
        );
        record_source_event(&mut inner, source_ref, page_host, reason);
        Ok(())
    }

    pub fn take_events(&self) -> Vec<BrowserControlEvent> {
        self.lock().events.drain(..).collect()
    }

    pub fn creation_candidates(&self) -> Vec<EmbeddedBrowserCreationCandidate> {
        creation_candidates(&self.lock())
    }

    pub fn is_page_host_ready(&self, page_host: EmbeddedBrowserPageHost) -> bool {
        self.lock().sources.values().any(|source| {
            source.state == BrowserSourceState::Ready && source.registration.page_host == page_host
        })
    }

    pub fn page_profile(&self) -> &'static str {
        EMBEDDED_BROWSER_CDP_PROFILE
    }

    pub fn capabilities(&self) -> EmbeddedBrowserChannelCapabilities {
        EmbeddedBrowserChannelCapabilities::supported()
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, BrowserControlInner> {
        self.inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

fn validate_registration(
    registration: &BrowserSourceRegistration,
) -> Result<(), BrowserControlError> {
    if normalized_text(&registration.panel_id, 240, "").is_empty()
        || normalized_text(&registration.owner_ref, 240, "").is_empty()
        || normalized_text(&registration.display_name, 160, "").is_empty()
        || normalized_text(&registration.publisher_ref, 240, "").is_empty()
    {
        return Err(BrowserControlError::new(
            "BROWSER_AUTHORIZATION_REQUIRED",
            "Browser source identity is incomplete.",
            403,
        ));
    }
    registration
        .page_host_capabilities
        .validate_for(registration.page_host)
        .map_err(|_| {
            BrowserControlError::new(
                "BROWSER_OPERATION_UNSUPPORTED",
                "Browser source capability declaration does not match its page host.",
                409,
            )
        })?;
    if registration.page_host == EmbeddedBrowserPageHost::RendererWebview
        && registration.renderer_host_binding.is_none()
    {
        return Err(BrowserControlError::new(
            "BROWSER_WINDOW_UNAVAILABLE",
            "A renderer-webview source requires a live renderer host binding.",
            409,
        ));
    }
    Ok(())
}

fn validate_snapshot(
    inner: &BrowserControlInner,
    snapshot: &EmbeddedBrowserSourceSnapshot,
) -> Result<(), BrowserControlError> {
    if inner.registry_epoch != snapshot.registry_epoch {
        return Err(BrowserControlError::conflict(
            "BROWSER_SNAPSHOT_REQUIRED",
            "Browser registry epoch changed.",
        ));
    }
    let source = inner.sources.get(&snapshot.source_ref).ok_or_else(|| {
        BrowserControlError::not_found("BROWSER_SOURCE_NOT_FOUND", "Browser source was not found.")
    })?;
    if source.generation != snapshot.generation {
        return Err(BrowserControlError::conflict(
            "BROWSER_LEASE_STALE",
            "Source generation is stale.",
        ));
    }
    if source.state != BrowserSourceState::Pending
        && source.state != BrowserSourceState::Syncing
        && source.state != BrowserSourceState::Ready
    {
        return Err(BrowserControlError::conflict(
            "BROWSER_SOURCE_UNAVAILABLE",
            "Browser source is not accepting snapshots.",
        ));
    }
    if snapshot.chunk_count == 0
        || snapshot.pages.len() > EMBEDDED_BROWSER_SNAPSHOT_MAX_PAGES_PER_CHUNK
    {
        return Err(BrowserControlError::new(
            "BROWSER_LIMIT_EXCEEDED",
            "Browser snapshot chunk exceeds the limit.",
            409,
        ));
    }
    Ok(())
}

fn locate_page(
    inner: &BrowserControlInner,
    tab_ref: &str,
) -> Option<(String, u64, EmbeddedBrowserPage)> {
    inner.sources.values().find_map(|source| {
        source
            .pages
            .get(tab_ref)
            .map(|page| (source.source_ref.clone(), source.generation, page.clone()))
    })
}

fn ready_pages(inner: &BrowserControlInner) -> Vec<EmbeddedBrowserPage> {
    let mut pages = inner
        .sources
        .values()
        .filter(|source| source.state == BrowserSourceState::Ready)
        .flat_map(|source| source.pages.values())
        .cloned()
        .collect::<Vec<_>>();
    pages.sort_by(|left, right| left.tab_ref.cmp(&right.tab_ref));
    pages
}

fn creation_candidates(inner: &BrowserControlInner) -> Vec<EmbeddedBrowserCreationCandidate> {
    let mut candidates = inner
        .sources
        .values()
        .filter(|source| source.state == BrowserSourceState::Ready)
        .filter_map(creation_candidate_for_source_record)
        .filter(|candidate| candidate.can_create)
        .collect::<Vec<_>>();
    candidates.sort_by(|left, right| left.source_ref.cmp(&right.source_ref));
    candidates
}

fn creation_candidate_for_source(
    inner: &BrowserControlInner,
    source_ref: &str,
) -> Option<EmbeddedBrowserCreationCandidate> {
    inner
        .sources
        .get(source_ref)
        .and_then(creation_candidate_for_source_record)
}

fn creation_candidate_for_source_record(
    source: &SourceRecord,
) -> Option<EmbeddedBrowserCreationCandidate> {
    if source.state != BrowserSourceState::Ready {
        return None;
    }
    let can_create = match source.registration.page_host {
        EmbeddedBrowserPageHost::RendererWebview => {
            source
                .registration
                .renderer_host_binding
                .as_deref()
                .is_some_and(|binding| !binding.trim().is_empty())
                && source
                    .registration
                    .host_label
                    .as_deref()
                    .is_some_and(|label| !label.trim().is_empty())
        }
        EmbeddedBrowserPageHost::MainPagePool => {
            source
                .registration
                .page_host_capabilities
                .background_creation
        }
    };
    Some(EmbeddedBrowserCreationCandidate {
        source_ref: source.source_ref.clone(),
        panel_label: source.registration.panel_id.clone(),
        desktop_label: source.registration.display_name.clone(),
        host_label: source.registration.host_label.clone(),
        page_host: source.registration.page_host,
        state: source.state.as_str().to_string(),
        can_create,
    })
}

fn record_registry_delta(
    inner: &mut BrowserControlInner,
    source_ref: &str,
    page_host: EmbeddedBrowserPageHost,
    upserts: Vec<EmbeddedBrowserPage>,
    removes: Vec<String>,
) {
    if upserts.is_empty() && removes.is_empty() {
        // An empty delta still acknowledges that the source caught up with the
        // registry revision. The relay listens for this event to retry the
        // syncing -> ready transition without polling.
        push_event(
            inner,
            "browser.registry.changed",
            json!({
                "sourceRef": source_ref,
                "pageHost": page_host,
                "registryEpoch": inner.registry_epoch,
                "registryRevision": inner.registry_revision,
            }),
        );
        return;
    }
    let base_revision = inner.registry_revision;
    inner.registry_revision = inner.registry_revision.saturating_add(1);
    let delta = EmbeddedBrowserRegistryDelta {
        registry_epoch: inner.registry_epoch.clone(),
        base_revision,
        revision: inner.registry_revision,
        upserts,
        removes,
        cursor: None,
    };
    inner.history.push_back(RegistryHistoryEntry { delta });
    while inner.history.len() > REGISTRY_HISTORY_LIMIT {
        inner.history.pop_front();
    }
    push_event(
        inner,
        "browser.registry.changed",
        json!({
            "sourceRef": source_ref,
            "pageHost": page_host,
            "registryEpoch": inner.registry_epoch,
            "registryRevision": inner.registry_revision,
        }),
    );
}

fn record_source_event(
    inner: &mut BrowserControlInner,
    source_ref: &str,
    page_host: EmbeddedBrowserPageHost,
    state: &str,
) {
    push_event(
        inner,
        "browser.source.changed",
        json!({
            "sourceRef": source_ref,
            "pageHost": page_host,
            "state": state,
            "registryEpoch": inner.registry_epoch,
            "registryRevision": inner.registry_revision,
        }),
    );
}

fn record_creation_event(inner: &mut BrowserControlInner, view: &EmbeddedBrowserCreationView) {
    let requester_session_ref = inner
        .creations
        .get(&view.creation_ref)
        .map(|creation| creation.requester_session_ref.clone())
        .unwrap_or_default();
    inner.creation_revision = inner.creation_revision.saturating_add(1);
    let creation_revision = inner.creation_revision;
    push_event(
        inner,
        "browser.creation.changed",
        json!({
            "creationRef": view.creation_ref,
            "state": view.state,
            "revision": view.revision,
            "tabRef": view.tab_ref,
            "creationRevision": creation_revision,
            "requesterSessionRef": requester_session_ref,
            "requestedUrl": view.requested_url,
            "title": view.title,
            "expiresAt": view.expires_at,
            "candidates": view.candidates,
        }),
    );
    inner
        .creation_changed
        .send_modify(|revision| *revision = revision.wrapping_add(1));
}

fn record_lease_event(inner: &mut BrowserControlInner, lease: &EmbeddedBrowserLease, state: &str) {
    push_event(
        inner,
        "browser.lease.changed",
        json!({
            "leaseRef": lease.lease_ref,
            "tabRef": lease.tab_ref,
            "state": state,
        }),
    );
}

fn push_event(inner: &mut BrowserControlInner, event_type: &'static str, payload: Value) {
    inner.events.push_back(BrowserControlEvent {
        event_type,
        payload,
    });
    while inner.events.len() > EVENT_LIMIT {
        inner.events.pop_front();
    }
}

fn remove_all_source_pages(inner: &mut BrowserControlInner, source_ref: &str, reason: &str) {
    let Some(source) = inner.sources.get_mut(source_ref) else {
        return;
    };
    let removes = source.pages.keys().cloned().collect::<Vec<_>>();
    let page_host = source.registration.page_host;
    source.pages.clear();
    if removes.is_empty() {
        return;
    }
    remove_leases_for_tabs(inner, &removes, Utc::now());
    record_registry_delta(inner, source_ref, page_host, Vec::new(), removes);
    record_source_event(inner, source_ref, page_host, reason);
}

fn mark_source_pages_unavailable(inner: &mut BrowserControlInner, source_ref: &str) {
    let Some(source) = inner.sources.get_mut(source_ref) else {
        return;
    };
    let page_host = source.registration.page_host;
    let mut upserts = Vec::new();
    for page in source.pages.values_mut() {
        if page.state != "unavailable" {
            page.state = "unavailable".to_string();
            page.revision = page.revision.saturating_add(1);
            upserts.push(page.clone());
        }
    }
    if !upserts.is_empty() {
        record_registry_delta(inner, source_ref, page_host, upserts, Vec::new());
    }
}

fn remove_leases_for_source(inner: &mut BrowserControlInner, source_ref: &str, now: DateTime<Utc>) {
    let lease_refs = inner
        .leases
        .iter()
        .filter(|(_, record)| record.lease.source_ref == source_ref)
        .map(|(lease_ref, _)| lease_ref.clone())
        .collect::<Vec<_>>();
    for lease_ref in lease_refs {
        remove_lease(inner, &lease_ref, now);
    }
}

fn fail_active_creations_for_source(inner: &mut BrowserControlInner, source_ref: &str) {
    let creation_refs = inner
        .creations
        .iter()
        .filter(|(_, creation)| {
            creation.claimed_source_ref.as_deref() == Some(source_ref)
                && matches!(
                    creation.view.state,
                    EmbeddedBrowserCreationStatus::Claimed
                        | EmbeddedBrowserCreationStatus::Creating
                )
        })
        .map(|(creation_ref, _)| creation_ref.clone())
        .collect::<Vec<_>>();
    for creation_ref in creation_refs {
        let view = {
            let Some(creation) = inner.creations.get_mut(&creation_ref) else {
                continue;
            };
            creation.view.state = EmbeddedBrowserCreationStatus::Failed;
            creation.view.revision = creation.view.revision.saturating_add(1);
            creation.view.clone()
        };
        record_creation_event(inner, &view);
    }
}

fn remove_leases_for_tabs(
    inner: &mut BrowserControlInner,
    tab_refs: &[String],
    now: DateTime<Utc>,
) {
    let lease_refs = tab_refs
        .iter()
        .filter_map(|tab_ref| inner.tab_lease.get(tab_ref).cloned())
        .collect::<Vec<_>>();
    for lease_ref in lease_refs {
        remove_lease(inner, &lease_ref, now);
    }
}

fn remove_lease(inner: &mut BrowserControlInner, lease_ref: &str, _now: DateTime<Utc>) -> bool {
    let Some(record) = inner.leases.remove(lease_ref) else {
        return false;
    };
    if inner
        .tab_lease
        .get(&record.lease.tab_ref)
        .is_some_and(|value| value == lease_ref)
    {
        inner.tab_lease.remove(&record.lease.tab_ref);
    }
    record_lease_event(inner, &record.lease, "detached");
    true
}

fn remove_expired_leases(inner: &mut BrowserControlInner, now: DateTime<Utc>) {
    let expired = inner
        .leases
        .iter()
        .filter(|(_, record)| record.expires_at <= now)
        .map(|(lease_ref, _)| lease_ref.clone())
        .collect::<Vec<_>>();
    for lease_ref in expired {
        remove_lease(inner, &lease_ref, now);
    }
}

fn expire_creation_if_needed(
    inner: &mut BrowserControlInner,
    creation_ref: &str,
    now: DateTime<Utc>,
) {
    let view = {
        let Some(creation) = inner.creations.get_mut(creation_ref) else {
            return;
        };
        if !matches!(
            creation.view.state,
            EmbeddedBrowserCreationStatus::Pending
                | EmbeddedBrowserCreationStatus::Claimed
                | EmbeddedBrowserCreationStatus::Creating
        ) || creation.expires_at > now
        {
            return;
        }
        creation.view.state = EmbeddedBrowserCreationStatus::Expired;
        creation.view.revision = creation.view.revision.saturating_add(1);
        creation.view.clone()
    };
    record_creation_event(inner, &view);
}

fn parse_cursor(cursor: Option<&str>, registry_epoch: &str) -> Result<usize, BrowserControlError> {
    let Some(cursor) = cursor.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(0);
    };
    let Some((epoch, offset)) = cursor.rsplit_once(':') else {
        return Err(BrowserControlError::conflict(
            "BROWSER_SNAPSHOT_REQUIRED",
            "Browser page cursor is invalid.",
        ));
    };
    if epoch != registry_epoch {
        return Err(BrowserControlError::conflict(
            "BROWSER_SNAPSHOT_REQUIRED",
            "Browser registry epoch changed.",
        ));
    }
    offset.parse::<usize>().map_err(|_| {
        BrowserControlError::conflict(
            "BROWSER_SNAPSHOT_REQUIRED",
            "Browser page cursor is invalid.",
        )
    })
}

fn normalized_text(value: &str, max: usize, fallback: &str) -> String {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        fallback.to_string()
    } else {
        trimmed.chars().take(max).collect()
    }
}

fn rfc3339(value: DateTime<Utc>) -> String {
    value.to_rfc3339_opts(SecondsFormat::Millis, true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    fn renderer_source() -> BrowserSourceRegistration {
        BrowserSourceRegistration {
            panel_id: "control_plane_1".to_string(),
            owner_ref: "user_1".to_string(),
            display_name: "Desktop A".to_string(),
            host_label: Some("Window 1".to_string()),
            publisher_ref: "renderer-host-a".to_string(),
            renderer_host_binding: Some("private-renderer-host-a".to_string()),
            page_host: EmbeddedBrowserPageHost::RendererWebview,
            page_host_capabilities: EmbeddedBrowserPageHostCapabilities::default(),
        }
    }

    fn main_pool_source() -> BrowserSourceRegistration {
        BrowserSourceRegistration {
            panel_id: "control_plane_2".to_string(),
            owner_ref: "user_2".to_string(),
            display_name: "Desktop B".to_string(),
            host_label: None,
            publisher_ref: "main-pool-b".to_string(),
            renderer_host_binding: None,
            page_host: EmbeddedBrowserPageHost::MainPagePool,
            page_host_capabilities: EmbeddedBrowserPageHostCapabilities {
                background_creation: true,
                survive_host_window_close: true,
                cross_window_adopt: true,
            },
        }
    }

    fn page(source: &EmbeddedBrowserSource, tab_ref: &str) -> EmbeddedBrowserPage {
        EmbeddedBrowserPage {
            source_ref: source.source_ref.clone(),
            generation: source.generation,
            tab_ref: tab_ref.to_string(),
            instance_id: "instance_1".to_string(),
            page_host: source.page_host,
            page_host_capabilities: source.page_host_capabilities,
            title: tab_ref.to_string(),
            url: format!("https://example.com/{tab_ref}"),
            state: "ready".to_string(),
            revision: 1,
        }
    }

    fn sync_source(
        service: &BrowserControlService,
        source: &EmbeddedBrowserSource,
        pages: Vec<EmbeddedBrowserPage>,
    ) {
        let snapshot = EmbeddedBrowserSourceSnapshot {
            source_ref: source.source_ref.clone(),
            generation: source.generation,
            source_revision: 1,
            registry_epoch: service.registry_epoch(),
            snapshot_ref: format!("snapshot-{}", source.generation),
            chunk_index: 0,
            chunk_count: 1,
            complete: true,
            pages,
        };
        service.commit_snapshot(snapshot).unwrap();
        service
            .mark_synced(
                &source.source_ref,
                source.generation,
                &service.registry_epoch(),
                service.registry_revision(),
            )
            .unwrap();
    }

    #[test]
    fn renderer_sources_require_a_live_host_and_snapshot_sync() {
        let service = BrowserControlService::new();
        let mut registration = renderer_source();
        registration.renderer_host_binding = None;
        assert_eq!(
            service.register_source(registration).unwrap_err().code,
            "BROWSER_WINDOW_UNAVAILABLE"
        );

        let source = service.register_source(renderer_source()).unwrap();
        assert_eq!(source.page_host, EmbeddedBrowserPageHost::RendererWebview);
        let page = page(&source, "browser_tab_1");
        sync_source(&service, &source, vec![page.clone()]);
        let access = service.grant_instance_access();
        assert!(access.active);
        let pages = service.list_pages(None, None).unwrap();
        assert_eq!(pages.items, vec![page]);
    }

    #[test]
    fn source_reconnect_cannot_hijack_another_publishers_identity() {
        let service = BrowserControlService::new();
        service.register_source(renderer_source()).unwrap();
        let mut takeover = renderer_source();
        takeover.owner_ref = "user_2".to_string();
        assert_eq!(
            service.register_source(takeover).unwrap_err().code,
            "BROWSER_AUTHORIZATION_REQUIRED"
        );
    }

    #[test]
    fn fallback_disconnect_removes_pages_and_revokes_leases() {
        let service = BrowserControlService::new();
        let source = service.register_source(renderer_source()).unwrap();
        let page = page(&source, "browser_tab_1");
        sync_source(&service, &source, vec![page]);
        service.grant_instance_access();
        let lease = service.attach_tab("session_1", "browser_tab_1").unwrap();
        assert_eq!(lease.generation, source.generation);

        service
            .disconnect_source(&source.source_ref, source.generation)
            .unwrap();
        assert!(service.list_pages(None, None).unwrap().items.is_empty());
        assert_eq!(
            service
                .lease_command_target("session_1", &lease.lease_ref)
                .unwrap_err()
                .code,
            "BROWSER_LEASE_STALE"
        );
    }

    #[test]
    fn main_page_pool_disconnect_keeps_pages_but_marks_them_unavailable() {
        let service = BrowserControlService::new();
        let source = service.register_source(main_pool_source()).unwrap();
        let page = page(&source, "browser_tab_1");
        sync_source(&service, &source, vec![page]);
        service.grant_instance_access();
        service
            .disconnect_source(&source.source_ref, source.generation)
            .unwrap();
        let pages = service.list_pages(None, None).unwrap();
        assert!(pages.items.is_empty());
        let replacement = service.register_source(main_pool_source()).unwrap();
        assert_eq!(replacement.source_ref, source.source_ref);
        assert_eq!(replacement.generation, source.generation + 1);
    }

    #[test]
    fn main_page_pool_reconnect_replaces_page_generation_and_old_leases() {
        let service = BrowserControlService::new();
        let first = service.register_source(main_pool_source()).unwrap();
        sync_source(&service, &first, vec![page(&first, "browser_tab_1")]);
        service.grant_instance_access();
        let lease = service.attach_tab("session_1", "browser_tab_1").unwrap();

        let replacement = service.register_source(main_pool_source()).unwrap();
        assert_eq!(replacement.source_ref, first.source_ref);
        assert_eq!(replacement.generation, first.generation + 1);
        assert_eq!(
            service
                .attach_tab("session_1", "browser_tab_1")
                .unwrap_err()
                .code,
            "BROWSER_TAB_NOT_FOUND"
        );
        assert_eq!(
            service
                .lease_command_target("session_1", &lease.lease_ref)
                .unwrap_err()
                .code,
            "BROWSER_LEASE_STALE"
        );

        let replacement_page = page(&replacement, "browser_tab_1");
        sync_source(&service, &replacement, vec![replacement_page.clone()]);
        let pages = service.list_pages(None, None).unwrap();
        assert_eq!(pages.items, vec![replacement_page]);
        let replacement_lease = service.attach_tab("session_1", "browser_tab_1").unwrap();
        assert_eq!(replacement_lease.generation, replacement.generation);
    }

    #[test]
    fn creation_candidates_only_include_sources_that_can_create() {
        let service = BrowserControlService::new();
        let mut registration = main_pool_source();
        registration.publisher_ref = "main-pool-no-background".to_string();
        registration.page_host_capabilities.background_creation = false;
        let source = service.register_source(registration).unwrap();
        sync_source(&service, &source, Vec::new());

        assert!(service.creation_candidates().is_empty());
        assert_eq!(
            service
                .request_creation("session_1", "https://example.com", None)
                .unwrap_err()
                .code,
            "BROWSER_CREATION_NO_CANDIDATE"
        );
    }

    #[test]
    fn renderer_creation_candidate_requires_a_host_label() {
        let service = BrowserControlService::new();
        let mut registration = renderer_source();
        registration.host_label = Some("   ".to_string());
        let source = service.register_source(registration).unwrap();
        sync_source(&service, &source, Vec::new());

        assert!(service.creation_candidates().is_empty());
        assert_eq!(
            service
                .request_creation("session_1", "https://example.com", None)
                .unwrap_err()
                .code,
            "BROWSER_CREATION_NO_CANDIDATE"
        );
    }

    #[test]
    fn creation_claim_is_atomic_and_first_writer_wins() {
        let service = BrowserControlService::new();
        let left = service.register_source(renderer_source()).unwrap();
        sync_source(&service, &left, Vec::new());
        let mut right_registration = main_pool_source();
        right_registration.panel_id = "control_plane_1".to_string();
        right_registration.display_name = "Desktop C".to_string();
        right_registration.publisher_ref = "main-pool-c".to_string();
        let right = service.register_source(right_registration).unwrap();
        sync_source(&service, &right, Vec::new());

        let creation = service
            .request_creation("session_1", "https://example.com", Some("Example"))
            .unwrap();
        assert_eq!(creation.candidates.len(), 2);
        let claimed = service
            .claim_creation(&left.source_ref, &creation.creation_ref, creation.revision)
            .unwrap();
        assert_eq!(claimed.state, EmbeddedBrowserCreationStatus::Claimed);
        let conflict = service
            .claim_creation(&right.source_ref, &creation.creation_ref, claimed.revision)
            .unwrap_err();
        assert_eq!(conflict.code, "BROWSER_CREATION_CONFLICT");

        let creating = service
            .mark_creation_creating(&left.source_ref, &creation.creation_ref)
            .unwrap();
        assert_eq!(creating.state, EmbeddedBrowserCreationStatus::Creating);
        let created_page = page(&left, "browser_tab_created");
        service
            .commit_delta(EmbeddedBrowserSourceDelta {
                source_ref: left.source_ref.clone(),
                generation: left.generation,
                base_revision: 1,
                revision: 2,
                upserts: vec![created_page],
                removes: Vec::new(),
            })
            .unwrap();
        let ready = service
            .complete_creation(
                &left.source_ref,
                &creation.creation_ref,
                "browser_tab_created",
            )
            .unwrap();
        assert_eq!(ready.state, EmbeddedBrowserCreationStatus::Ready);
        assert_eq!(ready.tab_ref.as_deref(), Some("browser_tab_created"));
        let repeated = service
            .complete_creation(
                &left.source_ref,
                &creation.creation_ref,
                "browser_tab_created",
            )
            .unwrap();
        assert_eq!(repeated.revision, ready.revision);
        let pages = service.list_pages(None, None).unwrap();
        assert_eq!(pages.items.len(), 1);
        assert_eq!(pages.items[0].tab_ref, "browser_tab_created");
    }

    #[test]
    fn creation_approval_snapshot_is_scoped_to_the_source_owner() {
        let service = BrowserControlService::new();
        let renderer = service.register_source(renderer_source()).unwrap();
        sync_source(&service, &renderer, Vec::new());
        let pool = service.register_source(main_pool_source()).unwrap();
        sync_source(&service, &pool, Vec::new());

        let creation = service
            .request_creation("session_1", "https://example.com", Some("Example"))
            .unwrap();
        let first = service.list_creation_approvals_for_source_owner("control_plane_1", "user_1");
        assert_eq!(first.items.len(), 1);
        assert_eq!(first.items[0].request.creation_ref, creation.creation_ref);
        assert_eq!(first.items[0].requester_session_ref, "session_1");

        let second = service.list_creation_approvals_for_source_owner("control_plane_2", "user_2");
        assert_eq!(second.items.len(), 1);
        assert_eq!(second.items[0].request.creation_ref, creation.creation_ref);

        assert!(service
            .list_creation_approvals_for_source_owner("control_plane_2", "user_1")
            .items
            .is_empty());
    }

    #[test]
    fn disconnecting_a_claimed_source_fails_creation_without_reselecting() {
        let service = BrowserControlService::new();
        let left = service.register_source(renderer_source()).unwrap();
        sync_source(&service, &left, Vec::new());
        let right = service.register_source(main_pool_source()).unwrap();
        sync_source(&service, &right, Vec::new());

        let creation = service
            .request_creation("session_1", "https://example.com", None)
            .unwrap();
        let claimed = service
            .claim_creation(&left.source_ref, &creation.creation_ref, creation.revision)
            .unwrap();
        service
            .mark_creation_creating(&left.source_ref, &creation.creation_ref)
            .unwrap();

        service
            .disconnect_source(&left.source_ref, left.generation)
            .unwrap();

        let failed = service
            .get_creation("session_1", &creation.creation_ref)
            .unwrap();
        assert_eq!(failed.state, EmbeddedBrowserCreationStatus::Failed);
        assert!(failed.revision > claimed.revision);
        let conflict = service
            .claim_creation(&right.source_ref, &creation.creation_ref, failed.revision)
            .unwrap_err();
        assert_eq!(conflict.code, "BROWSER_CREATION_CONFLICT");
    }

    #[test]
    fn reconnecting_a_claimed_source_fails_creation_before_the_old_connection_closes() {
        let service = BrowserControlService::new();
        let source = service.register_source(renderer_source()).unwrap();
        sync_source(&service, &source, Vec::new());
        let creation = service
            .request_creation("session_1", "https://example.com", None)
            .unwrap();
        service
            .claim_creation(
                &source.source_ref,
                &creation.creation_ref,
                creation.revision,
            )
            .unwrap();
        service
            .mark_creation_creating(&source.source_ref, &creation.creation_ref)
            .unwrap();

        let replacement = service.register_source(renderer_source()).unwrap();
        assert_eq!(replacement.source_ref, source.source_ref);
        assert!(replacement.generation > source.generation);

        let failed = service
            .get_creation("session_1", &creation.creation_ref)
            .unwrap();
        assert_eq!(failed.state, EmbeddedBrowserCreationStatus::Failed);
    }

    #[tokio::test]
    async fn creation_wait_wakes_on_state_transition_without_polling() {
        let service = Arc::new(BrowserControlService::new());
        let source = service.register_source(renderer_source()).unwrap();
        sync_source(&service, &source, Vec::new());
        let creation = service
            .request_creation("session_1", "https://example.com", None)
            .unwrap();

        let waiting = {
            let service = service.clone();
            let creation_ref = creation.creation_ref.clone();
            tokio::spawn(async move {
                service
                    .wait_for_creation("session_1", &creation_ref, StdDuration::from_secs(5))
                    .await
                    .unwrap()
            })
        };
        tokio::task::yield_now().await;
        service
            .decline_creation(
                &source.source_ref,
                &creation.creation_ref,
                creation.revision,
            )
            .unwrap();

        let resolved = waiting.await.unwrap();
        assert_eq!(resolved.state, EmbeddedBrowserCreationStatus::Declined);
    }

    #[test]
    fn tab_lease_is_single_writer_and_fenced_by_source_generation() {
        let service = BrowserControlService::new();
        let source = service.register_source(main_pool_source()).unwrap();
        let page = page(&source, "browser_tab_1");
        sync_source(&service, &source, vec![page]);
        assert_eq!(
            service
                .attach_tab("session_1", "browser_tab_1")
                .unwrap_err()
                .code,
            "BROWSER_AUTHORIZATION_REQUIRED"
        );
        service.grant_instance_access();
        let lease = service.attach_tab("session_1", "browser_tab_1").unwrap();
        assert_eq!(
            service
                .attach_tab("session_2", "browser_tab_1")
                .unwrap_err()
                .code,
            "BROWSER_TARGET_BUSY"
        );
        assert_eq!(
            service
                .lease_command_target("session_2", &lease.lease_ref)
                .unwrap_err()
                .code,
            "BROWSER_LEASE_STALE"
        );
        assert!(service.detach_lease("session_2", &lease.lease_ref) == false);
        assert!(service.detach_lease("session_1", &lease.lease_ref));
        assert!(service.attach_tab("session_2", "browser_tab_1").is_ok());
    }

    #[test]
    fn all_pages_returns_the_complete_instance_registry() {
        let service = BrowserControlService::new();
        let source = service.register_source(main_pool_source()).unwrap();
        let pages = (0..75)
            .map(|index| page(&source, &format!("browser_tab_{index:03}")))
            .collect::<Vec<_>>();
        sync_source(&service, &source, pages.clone());

        let paged = service.list_pages(None, None).unwrap();
        assert_eq!(paged.items.len(), DEFAULT_PAGE_LIMIT);
        assert!(paged.cursor.is_some());
        assert_eq!(service.all_pages(), pages);
    }

    #[test]
    fn registry_delta_requires_a_contiguous_revision() {
        let service = BrowserControlService::new();
        let source = service.register_source(main_pool_source()).unwrap();
        sync_source(&service, &source, vec![page(&source, "browser_tab_1")]);
        let epoch = service.registry_epoch();
        let revision = service.registry_revision();
        let delta = service.registry_delta_since(&epoch, 0).unwrap();
        assert_eq!(delta.base_revision, 0);
        assert_eq!(delta.revision, revision);
        assert_eq!(
            service
                .registry_delta_since(&epoch, revision + 10)
                .unwrap_err()
                .code,
            "BROWSER_SNAPSHOT_REQUIRED"
        );
        assert_eq!(
            service
                .registry_delta_since("another-epoch", revision)
                .unwrap_err()
                .code,
            "BROWSER_SNAPSHOT_REQUIRED"
        );
    }

    #[test]
    fn register_and_destroy_notifications_are_idempotent_after_delta_commit() {
        let service = BrowserControlService::new();
        let source = service.register_source(main_pool_source()).unwrap();
        sync_source(&service, &source, Vec::new());
        let page = page(&source, "browser_tab_1");
        service
            .commit_delta(EmbeddedBrowserSourceDelta {
                source_ref: source.source_ref.clone(),
                generation: source.generation,
                base_revision: 1,
                revision: 2,
                upserts: vec![page.clone()],
                removes: Vec::new(),
            })
            .unwrap();
        let revision = service.registry_revision();
        service
            .register_tab(
                "instance_1",
                &source.source_ref,
                source.generation,
                &page.tab_ref,
                &page.title,
                &page.url,
                &page.state,
            )
            .unwrap();
        assert_eq!(service.registry_revision(), revision);

        service
            .destroy_tab(
                &source.source_ref,
                source.generation,
                &page.tab_ref,
                "closed",
            )
            .unwrap();
        let removed = service.registry_revision();
        assert_eq!(removed, revision + 1);
        service
            .destroy_tab(
                &source.source_ref,
                source.generation,
                &page.tab_ref,
                "closed-again",
            )
            .unwrap();
        assert_eq!(service.registry_revision(), removed);
    }

    #[test]
    fn empty_delta_emits_registry_progress_for_relay_sync_retry() {
        let service = BrowserControlService::new();
        let source = service.register_source(main_pool_source()).unwrap();
        sync_source(&service, &source, Vec::new());
        service.take_events();
        service
            .commit_delta(EmbeddedBrowserSourceDelta {
                source_ref: source.source_ref.clone(),
                generation: source.generation,
                base_revision: 1,
                revision: 2,
                upserts: Vec::new(),
                removes: Vec::new(),
            })
            .unwrap();
        assert!(service
            .take_events()
            .iter()
            .any(|event| event.event_type == "browser.registry.changed"));
    }

    #[test]
    fn instance_revocation_removes_tokens_and_leases() {
        let service = BrowserControlService::new();
        let source = service.register_source(main_pool_source()).unwrap();
        sync_source(&service, &source, vec![page(&source, "browser_tab_1")]);
        service.grant_instance_access();
        let (token, _) = service.issue_cdp_token("session_1").unwrap();
        let lease = service.attach_tab("session_1", "browser_tab_1").unwrap();
        assert_eq!(
            service.lease_refs_for_session("session_1"),
            vec![lease.lease_ref.clone()]
        );
        assert!(service.lease_refs_for_session("session_2").is_empty());
        assert_eq!(service.revoke_instance_access(), 1);
        assert!(service.validate_cdp_token(&token).is_none());
        assert_eq!(
            service
                .lease_command_target("session_1", &lease.lease_ref)
                .unwrap_err()
                .code,
            "BROWSER_LEASE_STALE"
        );
    }

    #[test]
    fn instance_access_is_shared_by_all_sessions_and_scoped_tokens() {
        let service = BrowserControlService::new();
        assert!(!service.access().active);
        assert_eq!(
            service.issue_cdp_token("session_1").unwrap_err().code,
            "BROWSER_AUTHORIZATION_REQUIRED"
        );

        let granted = service.grant_instance_access();
        assert!(granted.active);
        let (session_one_token, _) = service.issue_cdp_token("session_1").unwrap();
        let (session_two_token, _) = service.issue_cdp_token("session_2").unwrap();
        assert_eq!(
            service.validate_cdp_token(&session_one_token).as_deref(),
            Some("session_1")
        );
        assert_eq!(
            service.validate_cdp_token(&session_two_token).as_deref(),
            Some("session_2")
        );

        service.cleanup_session("session_1");
        assert!(service.validate_cdp_token(&session_one_token).is_none());
        assert!(service.validate_cdp_token(&session_two_token).is_some());
        assert!(service.access().active);

        service.revoke_instance_access();
        assert!(!service.access().active);
        assert!(service.validate_cdp_token(&session_two_token).is_none());
        assert!(service.access().revision > granted.revision);
    }
}
