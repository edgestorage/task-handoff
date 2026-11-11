//! The component's single session authority. Monotonic deadlines are independent
//! of wall-clock changes; wall deadlines are projections for consumers only.
use controlled_instance_protocol::mint_entity_id;
use rand::RngCore;
use std::{
    collections::{HashMap, VecDeque},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use subtle::ConstantTimeEq;

pub const STARTING: Duration = Duration::from_secs(30);
pub const NEGOTIATING: Duration = Duration::from_secs(20);
pub const DRAINING: Duration = Duration::from_secs(5);
pub const SIGNAL_LIVENESS: Duration = Duration::from_secs(6);
pub const INPUT_LIVENESS: Duration = Duration::from_millis(1500);
pub const HIDDEN: Duration = Duration::from_secs(30 * 60);
pub const MAX_SESSION: Duration = Duration::from_secs(8 * 60 * 60);
pub const ICE_RECOVERY: Duration = Duration::from_secs(15);
pub const MAX_VIEWERS: usize = 4;

pub fn secret() -> String {
    let mut bytes = [0u8; 32];
    rand::rng().fill_bytes(&mut bytes);
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

pub use remote_desktop_protocol::model::{
    CaptureGeometry, CaptureSelection, Owner, Phase, Snapshot,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum Error {
    #[error("REMOTE_DESKTOP_BUSY")]
    Busy,
    #[error("REMOTE_DESKTOP_NOT_FOUND")]
    NotFound,
    #[error("REMOTE_DESKTOP_FORBIDDEN")]
    Forbidden,
    #[error("REMOTE_DESKTOP_ATTACH_INVALID")]
    InvalidAttach,
    #[error("REMOTE_DESKTOP_INVALID_STATE")]
    InvalidState,
    #[error("REMOTE_DESKTOP_STALE_EPOCH")]
    StaleEpoch,
    #[error("REMOTE_DESKTOP_REQUEST_CONFLICT")]
    RequestConflict,
    #[error("REMOTE_DESKTOP_UNSUPPORTED_TARGET")]
    UnsupportedTarget,
    #[error("REMOTE_DESKTOP_INVALID_REQUEST")]
    InvalidRequest,
    #[error("REMOTE_DESKTOP_RATE_LIMITED")]
    RateLimited,
}

struct Session {
    snapshot: Snapshot,
    owner: Owner,
    attach_token: Option<String>,
    stage_deadline: Option<Instant>,
    max_deadline: Instant,
    idle_deadline: Option<Instant>,
    signal_deadline: Option<Instant>,
    input_deadline: Option<Instant>,
    ice_deadline: Option<Instant>,
    epoch: u64,
    terminal_failed: bool,
}

/// Effects must be applied before publishing the new snapshot. In particular,
/// release_input is delivered to the independent actuator, never just local RAII.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Effects {
    pub release_input: bool,
    pub close_peer: bool,
    pub request_idr: bool,
}

struct ReservationMemo {
    request_id: String,
    owner: Owner,
    selection: CaptureSelection,
    replacement: Option<String>,
    session_id: String,
    expires: Instant,
}

pub struct Registry {
    boot_id: String,
    sessions: HashMap<String, Session>,
    events: VecDeque<Snapshot>,
    reservations: VecDeque<ReservationMemo>,
    control_holder: Option<String>,
    control_revision: u64,
    /// The input guard is process-wide, so epochs must remain monotonic across
    /// control transfers between viewers instead of restarting per session.
    next_input_epoch: u64,
}

impl Default for Registry {
    fn default() -> Self {
        Self::new()
    }
}

impl Registry {
    pub fn new() -> Self {
        Self {
            boot_id: secret(),
            sessions: HashMap::new(),
            events: VecDeque::new(),
            reservations: VecDeque::new(),
            control_holder: None,
            control_revision: 0,
            next_input_epoch: 0,
        }
    }

    pub fn attach_expires_at(&self, id: &str, now: Instant) -> Result<u64, Error> {
        let session = self.sessions.get(id).ok_or(Error::InvalidState)?;
        let remaining = session
            .stage_deadline
            .ok_or(Error::InvalidState)?
            .saturating_duration_since(now);
        let wall = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64;
        Ok(wall.saturating_add(remaining.as_millis() as u64))
    }

    pub fn boot_id(&self) -> &str {
        &self.boot_id
    }

    pub fn drain_events(&mut self) -> impl Iterator<Item = Snapshot> + '_ {
        self.events.drain(..)
    }

    fn terminal(phase: Phase) -> bool {
        matches!(phase, Phase::Stopped | Phase::Failed)
    }

    fn viewer_count(&self, id: &str) -> u64 {
        let Some(selection) = self.sessions.get(id).map(|s| &s.snapshot.capture_selection) else {
            return 0;
        };
        self.sessions
            .values()
            .filter(|s| {
                !Self::terminal(s.snapshot.phase) && &s.snapshot.capture_selection == selection
            })
            .count() as u64
    }

    fn live_holder(&self) -> Option<String> {
        self.control_holder
            .as_ref()
            .filter(|id| {
                self.sessions
                    .get(*id)
                    .is_some_and(|s| !Self::terminal(s.snapshot.phase))
            })
            .cloned()
    }

    fn is_holder(&self, id: &str) -> bool {
        self.live_holder().as_deref() == Some(id)
    }

    fn publish(&mut self, id: &str) {
        let is_controller = self.is_holder(id);
        let has_controller = self.live_holder().is_some();
        let viewer_count = self.viewer_count(id);
        let control_revision = self.control_revision;
        let Some(session) = self.sessions.get_mut(id) else {
            return;
        };
        session.snapshot.session_revision += 1;
        session.snapshot.control_revision = control_revision;
        session.snapshot.is_controller = is_controller;
        session.snapshot.has_controller = has_controller;
        session.snapshot.viewer_count = viewer_count;
        let snapshot = session.snapshot.clone();
        if self.events.len() == 128 {
            self.events.pop_front();
        }
        self.events.push_back(snapshot);
    }

    fn changed(&mut self, id: &str) {
        self.publish(id);
    }

    fn changed_all(&mut self) {
        let ids: Vec<String> = self.sessions.keys().cloned().collect();
        for id in ids {
            self.publish(&id);
        }
    }

    fn prune_terminal(&mut self) {
        self.sessions
            .retain(|_, session| !Self::terminal(session.snapshot.phase));
        if self
            .control_holder
            .as_ref()
            .is_some_and(|id| !self.sessions.contains_key(id))
        {
            self.control_holder = None;
        }
    }

    pub fn reserve(
        &mut self,
        request_id: &str,
        owner: Owner,
        selection: CaptureSelection,
        now: Instant,
    ) -> Result<(Snapshot, String), Error> {
        self.reserve_for(request_id, owner, selection, None, now)
    }

    pub fn reserve_for(
        &mut self,
        request_id: &str,
        owner: Owner,
        selection: CaptureSelection,
        replacement: Option<&str>,
        now: Instant,
    ) -> Result<(Snapshot, String), Error> {
        if request_id.is_empty()
            || request_id.len() > 128
            || owner.actor_id.is_empty()
            || owner.device_session_id.is_empty()
        {
            return Err(Error::InvalidRequest);
        }
        self.reservations.retain(|memo| memo.expires > now);
        if let Some(memo) = self
            .reservations
            .iter()
            .find(|memo| memo.owner == owner && memo.request_id == request_id)
        {
            if memo.selection != selection || memo.replacement.as_deref() != replacement {
                return Err(Error::RequestConflict);
            }
            let Some(session) = self.sessions.get(&memo.session_id) else {
                return Err(Error::RequestConflict);
            };
            if let Some(token) = &session.attach_token {
                if session.stage_deadline.is_some_and(|t| now < t) {
                    return Ok((session.snapshot.clone(), token.clone()));
                }
            }
            return Err(Error::RequestConflict);
        }
        if self.reservations.len() >= 128 {
            return Err(Error::RateLimited);
        }
        if replacement.is_some_and(|id| {
            !self
                .sessions
                .get(id)
                .is_some_and(|session| Self::terminal(session.snapshot.phase))
        }) {
            return Err(Error::InvalidState);
        }
        if let Some(replacement) = replacement {
            let session = self.sessions.get(replacement).ok_or(Error::NotFound)?;
            if session.owner.actor_id != owner.actor_id {
                return Err(Error::Forbidden);
            }
            if session.snapshot.capture_selection != selection {
                return Err(Error::UnsupportedTarget);
            }
        }
        self.prune_terminal();
        let active = self
            .sessions
            .values()
            .filter(|session| !Self::terminal(session.snapshot.phase))
            .collect::<Vec<_>>();
        if active.len() >= MAX_VIEWERS {
            return Err(Error::Busy);
        }
        let token = secret();
        let wall = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64;
        let id = mint_entity_id("rdv");
        let needs_holder = self.live_holder().is_none();
        if needs_holder {
            self.control_holder = Some(id.clone());
            self.control_revision = self.control_revision.saturating_add(1);
        }
        self.sessions.insert(
            id.clone(),
            Session {
                snapshot: Snapshot {
                    viewer_session_id: id.clone(),
                    session_revision: 0,
                    control_revision: self.control_revision,
                    is_controller: needs_holder,
                    has_controller: needs_holder,
                    viewer_count: 0,
                    transport_generation: 0,
                    transport: "webrtc".into(),
                    phase: Phase::Starting,
                    capture_selection: selection.clone(),
                    session_expires_at: wall + MAX_SESSION.as_millis() as u64,
                    idle_expires_at: None,
                    input_epoch: None,
                    capture_geometry: None,
                    media_paused: true,
                    reason: None,
                },
                owner: owner.clone(),
                attach_token: Some(token.clone()),
                stage_deadline: Some(now + STARTING),
                max_deadline: now + MAX_SESSION,
                idle_deadline: None,
                signal_deadline: None,
                input_deadline: None,
                ice_deadline: None,
                epoch: 0,
                terminal_failed: false,
            },
        );
        self.reservations.push_back(ReservationMemo {
            request_id: request_id.into(),
            replacement: replacement.map(str::to_owned),
            owner,
            selection,
            session_id: id.clone(),
            expires: now + STARTING,
        });
        self.changed_all();
        Ok((self.sessions.get(&id).unwrap().snapshot.clone(), token))
    }

    fn owned(&self, id: &str, owner: &Owner) -> Result<&Session, Error> {
        let session = self.sessions.get(id).ok_or(Error::NotFound)?;
        if &session.owner != owner {
            return Err(Error::Forbidden);
        }
        Ok(session)
    }

    pub fn snapshot(&self, id: &str, owner: &Owner) -> Result<Snapshot, Error> {
        Ok(self.owned(id, owner)?.snapshot.clone())
    }

    pub fn attach(
        &mut self,
        id: &str,
        owner: &Owner,
        selection: &CaptureSelection,
        token: &str,
        now: Instant,
    ) -> Result<Snapshot, Error> {
        let session = self.owned(id, owner)?;
        if session.snapshot.phase != Phase::Starting
            || session.stage_deadline.is_some_and(|t| now >= t)
            || &session.snapshot.capture_selection != selection
            || !session
                .attach_token
                .as_ref()
                .is_some_and(|t| bool::from(t.as_bytes().ct_eq(token.as_bytes())))
        {
            return Err(Error::InvalidAttach);
        }
        let session = self.sessions.get_mut(id).unwrap();
        session.attach_token = None;
        session.snapshot.phase = Phase::Negotiating;
        session.stage_deadline = Some(now + NEGOTIATING);
        session.signal_deadline = Some(now + SIGNAL_LIVENESS);
        self.changed(id);
        Ok(self.sessions.get(id).unwrap().snapshot.clone())
    }

    fn check_live_deadlines(&self, id: &str, now: Instant) -> Result<(), Error> {
        let session = self.sessions.get(id).ok_or(Error::NotFound)?;
        if now >= session.max_deadline
            || [
                session.stage_deadline,
                session.idle_deadline,
                session.signal_deadline,
                session.ice_deadline,
            ]
            .into_iter()
            .flatten()
            .any(|t| now >= t)
        {
            return Err(Error::InvalidState);
        }
        Ok(())
    }

    pub fn connected(&mut self, id: &str, now: Instant) -> Result<(), Error> {
        self.check_live_deadlines(id, now)?;
        let session = self
            .sessions
            .get_mut(id)
            .filter(|s| matches!(s.snapshot.phase, Phase::Negotiating | Phase::Active))
            .ok_or(Error::InvalidState)?;
        if session.snapshot.phase != Phase::Negotiating {
            return Err(Error::InvalidState);
        }
        session.snapshot.phase = Phase::Active;
        session.snapshot.media_paused = false;
        session.stage_deadline = None;
        self.changed(id);
        Ok(())
    }

    pub fn signal_alive(&mut self, id: &str, now: Instant) -> Result<(), Error> {
        self.check_live_deadlines(id, now)?;
        let session = self.live_mut(id)?;
        // Liveness received after the deadline cannot resurrect a dead connection.
        if session.signal_deadline.is_none_or(|t| now >= t) {
            return Err(Error::InvalidState);
        }
        session.signal_deadline = Some(now + SIGNAL_LIVENESS);
        Ok(())
    }

    fn live_mut(&mut self, id: &str) -> Result<&mut Session, Error> {
        self.sessions
            .get_mut(id)
            .filter(|s| matches!(s.snapshot.phase, Phase::Negotiating | Phase::Active))
            .ok_or(Error::InvalidState)
    }

    fn suspend(session: &mut Session) {
        session.snapshot.input_epoch = None;
        session.input_deadline = None;
    }

    pub fn suspend_input(&mut self, id: &str) -> Result<Effects, Error> {
        let was_holder = self.is_holder(id);
        let session = self.live_mut(id)?;
        Self::suspend(session);
        self.changed(id);
        Ok(Effects {
            release_input: was_holder,
            ..Default::default()
        })
    }

    pub fn capture_geometry(
        &mut self,
        id: &str,
        geometry: crate::traits::Geometry,
    ) -> Result<(), Error> {
        let session = self.live_mut(id)?;
        session.snapshot.capture_geometry = Some(CaptureGeometry {
            width: geometry.width,
            height: geometry.height,
        });
        Self::suspend(session);
        self.changed(id);
        Ok(())
    }

    /// Allocate a guard epoch before publishing authority. Failed native focus
    /// attempts consume it too, so a delayed arm can never reuse an old epoch.
    pub fn prepare_input(&mut self, id: &str, now: Instant) -> Result<u64, Error> {
        if !self.is_holder(id) {
            return Err(Error::InvalidState);
        }
        self.check_live_deadlines(id, now)?;
        {
            let session = self.live_mut(id)?;
            if session.snapshot.phase != Phase::Active
                || session.snapshot.media_paused
                || session.ice_deadline.is_some()
                || session.snapshot.input_epoch.is_some()
            {
                return Err(Error::InvalidState);
            }
        }
        self.next_input_epoch = self.next_input_epoch.saturating_add(1);
        let epoch = self.next_input_epoch;
        self.sessions.get_mut(id).ok_or(Error::NotFound)?.epoch = epoch;
        Ok(epoch)
    }

    pub fn commit_input(&mut self, id: &str, epoch: u64, now: Instant) -> Result<(), Error> {
        if !self.is_holder(id) {
            return Err(Error::InvalidState);
        }
        self.check_live_deadlines(id, now)?;
        let session = self.live_mut(id)?;
        if session.epoch != epoch
            || session.snapshot.input_epoch.is_some()
            || session.snapshot.media_paused
            || session.ice_deadline.is_some()
        {
            return Err(Error::InvalidState);
        }
        session.snapshot.input_epoch = Some(epoch);
        session.input_deadline = Some(now + INPUT_LIVENESS);
        self.changed(id);
        Ok(())
    }

    pub fn resume_input(&mut self, id: &str, now: Instant) -> Result<u64, Error> {
        let epoch = self.prepare_input(id, now)?;
        self.commit_input(id, epoch, now)?;
        Ok(epoch)
    }

    pub fn live_input_epoch(&self, id: &str, now: Instant) -> Option<u64> {
        let epoch = self.sessions.get(id)?.snapshot.input_epoch?;
        self.check_epoch(id, epoch, now).ok().map(|()| epoch)
    }

    pub fn input_alive(&mut self, id: &str, epoch: u64, now: Instant) -> Result<(), Error> {
        if !self.is_holder(id) {
            return Err(Error::StaleEpoch);
        }
        self.check_live_deadlines(id, now)?;
        self.check_epoch(id, epoch, now)?;
        self.sessions.get_mut(id).unwrap().input_deadline = Some(now + INPUT_LIVENESS);
        Ok(())
    }

    pub fn check_epoch(&self, id: &str, epoch: u64, now: Instant) -> Result<(), Error> {
        if !self.is_holder(id) {
            return Err(Error::StaleEpoch);
        }
        self.check_live_deadlines(id, now)
            .map_err(|_| Error::StaleEpoch)?;
        let session = self.sessions.get(id).ok_or(Error::NotFound)?;
        if session.snapshot.phase != Phase::Active
            || session.snapshot.input_epoch != Some(epoch)
            || session.input_deadline.is_none_or(|t| now >= t)
        {
            return Err(Error::StaleEpoch);
        }
        Ok(())
    }

    pub fn visibility(&mut self, id: &str, hidden: bool, now: Instant) -> Result<Effects, Error> {
        self.check_live_deadlines(id, now)?;
        let was_holder = self.is_holder(id);
        let session = self.live_mut(id)?;
        if session.snapshot.phase != Phase::Active {
            return Err(Error::InvalidState);
        }
        // Duplicate hidden messages cannot extend the idle deadline.
        if hidden && session.idle_deadline.is_none() {
            session.idle_deadline = Some(now + HIDDEN);
            let remaining = session
                .max_deadline
                .saturating_duration_since(now)
                .as_millis() as u64;
            session.snapshot.idle_expires_at = Some(
                session
                    .snapshot
                    .session_expires_at
                    .saturating_sub(remaining)
                    + HIDDEN.as_millis() as u64,
            );
        } else if !hidden {
            session.idle_deadline = None;
            session.snapshot.idle_expires_at = None;
        }
        session.snapshot.media_paused = hidden;
        Self::suspend(session);
        self.changed(id);
        Ok(Effects {
            release_input: was_holder,
            request_idr: !hidden,
            close_peer: false,
        })
    }

    pub fn ice_disconnected(&mut self, id: &str, now: Instant) -> Result<Effects, Error> {
        self.check_live_deadlines(id, now)?;
        let was_holder = self.is_holder(id);
        let session = self.live_mut(id)?;
        if session.ice_deadline.is_none() {
            session.ice_deadline = Some(now + ICE_RECOVERY);
        }
        Self::suspend(session);
        self.changed(id);
        Ok(Effects {
            release_input: was_holder,
            ..Default::default()
        })
    }

    pub fn ice_recovered(&mut self, id: &str, now: Instant) -> Result<(), Error> {
        self.check_live_deadlines(id, now)?;
        let session = self.live_mut(id)?;
        if session.ice_deadline.is_some_and(|t| now >= t) {
            return Err(Error::InvalidState);
        }
        session.ice_deadline = None;
        self.changed(id);
        Ok(())
    }

    /// Credential rotation is complete only when the replacement ICE generation
    /// reaches a connected pair. A configuration ACK or input-only snapshot is
    /// not proof; this counter is published with the same snapshot revision.
    pub fn transport_recovered(&mut self, id: &str, now: Instant) -> Result<(), Error> {
        self.check_live_deadlines(id, now)?;
        let session = self.live_mut(id)?;
        if session.ice_deadline.is_some_and(|t| now >= t) {
            return Err(Error::InvalidState);
        }
        session.ice_deadline = None;
        session.snapshot.transport_generation =
            session.snapshot.transport_generation.saturating_add(1);
        self.changed(id);
        Ok(())
    }

    /// Fallback is an active media path even when ICE never reached Connected.
    /// This transition owns the session phase, media gate and transport label;
    /// CP/UI never derive them from local PeerConnection state.
    pub fn fallback_activated(&mut self, id: &str) -> Result<(), Error> {
        let session = self
            .sessions
            .get_mut(id)
            .filter(|session| matches!(session.snapshot.phase, Phase::Negotiating | Phase::Active))
            .ok_or(Error::InvalidState)?;
        session.snapshot.phase = Phase::Active;
        session.snapshot.media_paused = false;
        session.snapshot.transport = "websocket-fallback".into();
        session.stage_deadline = None;
        session.ice_deadline = None;
        self.changed(id);
        Ok(())
    }

    /// Progressive fallback stays live while WebRTC negotiates in the
    /// background. Only the component can commit the upgrade after the browser
    /// confirms both a connected peer and a decoded WebRTC video frame. The
    /// session keeps its identity, capture target and control lease.
    pub fn webrtc_upgraded(&mut self, id: &str) -> Result<Effects, Error> {
        let was_holder = self.is_holder(id);
        let session = self
            .sessions
            .get_mut(id)
            .filter(|session| {
                session.snapshot.phase == Phase::Active
                    && session.snapshot.transport == "websocket-fallback"
            })
            .ok_or(Error::InvalidState)?;
        session.snapshot.transport = "webrtc".into();
        session.snapshot.media_paused = false;
        session.ice_deadline = None;
        Self::suspend(session);
        self.changed(id);
        Ok(Effects {
            release_input: was_holder,
            request_idr: true,
            close_peer: false,
        })
    }

    /// Atomically rotate the single input lease to an active viewer. The previous
    /// holder is returned so the service can suspend its actuator immediately.
    pub fn request_control(&mut self, id: &str, now: Instant) -> Result<Option<String>, Error> {
        self.check_live_deadlines(id, now)?;
        let session = self.sessions.get(id).ok_or(Error::NotFound)?;
        if session.snapshot.phase != Phase::Active {
            return Err(Error::InvalidState);
        }
        if self.is_holder(id) {
            return Ok(None);
        }
        let previous = self.live_holder();
        if let Some(previous_id) = &previous {
            if let Some(session) = self.sessions.get_mut(previous_id) {
                Self::suspend(session);
            }
        }
        self.control_holder = Some(id.to_owned());
        self.control_revision = self.control_revision.saturating_add(1);
        self.changed_all();
        Ok(previous)
    }

    pub fn validate_takeover_target(
        &self,
        id: &str,
        owner: &Owner,
        selection: &CaptureSelection,
    ) -> Result<(), Error> {
        let session = self.sessions.get(id).ok_or(Error::NotFound)?;
        if session.owner.actor_id != owner.actor_id {
            return Err(Error::Forbidden);
        }
        if &session.snapshot.capture_selection != selection {
            return Err(Error::UnsupportedTarget);
        }
        Ok(())
    }

    pub fn prepare_takeover(
        &mut self,
        request_id: &str,
        id: &str,
        owner: &Owner,
        selection: &CaptureSelection,
        now: Instant,
    ) -> Result<Effects, Error> {
        self.reservations.retain(|memo| memo.expires > now);
        if let Some(memo) = self
            .reservations
            .iter()
            .find(|memo| memo.owner == *owner && memo.request_id == request_id)
        {
            if memo.replacement.as_deref() != Some(id) || memo.selection != *selection {
                return Err(Error::RequestConflict);
            }
            return Ok(Effects::default());
        }
        if owner.actor_id.is_empty() || owner.device_session_id.is_empty() {
            return Err(Error::InvalidRequest);
        }
        if self.reservations.len() >= 128 {
            return Err(Error::RateLimited);
        }
        self.validate_takeover_target(id, owner, selection)?;
        Ok(self.begin_drain(id, now, None))
    }

    pub fn force_stop(&mut self, id: &str, now: Instant) -> Result<Effects, Error> {
        self.sessions.get(id).ok_or(Error::NotFound)?;
        Ok(self.begin_drain(id, now, None))
    }

    pub fn stop(&mut self, id: &str, owner: &Owner, now: Instant) -> Result<Effects, Error> {
        self.owned(id, owner)?;
        Ok(self.begin_drain(id, now, None))
    }

    pub fn signal_closed(&mut self, id: &str, now: Instant) -> Result<Effects, Error> {
        self.live_mut(id)?;
        Ok(self.begin_drain(id, now, Some("REMOTE_DESKTOP_SIGNAL_CLOSED")))
    }

    pub fn peer_failed(&mut self, id: &str, now: Instant) -> Result<Effects, Error> {
        self.live_mut(id)?;
        Ok(self.begin_drain(id, now, Some("REMOTE_DESKTOP_PEER_FAILED")))
    }

    pub fn backend_failed(
        &mut self,
        id: &str,
        cause: crate::error::BackendError,
        now: Instant,
    ) -> Result<Effects, Error> {
        self.live_mut(id)?;
        Ok(self.begin_drain(id, now, Some(&cause.to_string())))
    }

    fn begin_drain(&mut self, id: &str, now: Instant, reason: Option<&str>) -> Effects {
        let Some(session) = self.sessions.get_mut(id) else {
            return Effects::default();
        };
        if matches!(
            session.snapshot.phase,
            Phase::Draining | Phase::Stopped | Phase::Failed
        ) {
            return Effects::default();
        }
        let held_input = session.snapshot.input_epoch.is_some();
        let failed = reason.is_some();
        Self::suspend(session);
        session.attach_token = None;
        session.snapshot.media_paused = true;
        if failed {
            session.snapshot.transport = "failed".into();
        }
        session.snapshot.phase = Phase::Draining;
        session.snapshot.reason = reason.map(str::to_owned);
        session.terminal_failed = reason.is_some();
        session.stage_deadline = Some(now + DRAINING);
        let released_control = self.control_holder.as_deref() == Some(id);
        if released_control {
            self.control_holder = None;
            self.control_revision = self.control_revision.saturating_add(1);
            self.changed_all();
        } else {
            self.changed(id);
        }
        Effects {
            release_input: released_control || held_input,
            close_peer: true,
            request_idr: false,
        }
    }

    pub fn drained(&mut self, id: &str) -> Result<(), Error> {
        let session = self.sessions.get_mut(id).ok_or(Error::NotFound)?;
        if session.snapshot.phase != Phase::Draining {
            return Err(Error::InvalidState);
        }
        session.snapshot.phase = if session.terminal_failed {
            Phase::Failed
        } else {
            Phase::Stopped
        };
        session.stage_deadline = None;
        self.changed_all();
        Ok(())
    }

    pub fn next_deadline(&self) -> Option<Instant> {
        self.sessions
            .values()
            .filter(|s| !Self::terminal(s.snapshot.phase))
            .filter_map(|session| match session.snapshot.phase {
                Phase::Stopped | Phase::Failed => None,
                Phase::Draining => session.stage_deadline,
                _ => [
                    session.stage_deadline,
                    Some(session.max_deadline),
                    session.idle_deadline,
                    session.signal_deadline,
                    session.input_deadline,
                    session.ice_deadline,
                ]
                .into_iter()
                .flatten()
                .min(),
            })
            .min()
    }

    pub fn tick(&mut self, now: Instant) -> Vec<(String, Effects)> {
        let ids: Vec<String> = self.sessions.keys().cloned().collect();
        let mut effects = Vec::new();
        for id in ids {
            let Some(session) = self.sessions.get(&id) else {
                continue;
            };
            if session.snapshot.phase == Phase::Draining
                && session
                    .stage_deadline
                    .is_some_and(|deadline| now >= deadline)
            {
                let _ = self.drained(&id);
                continue;
            }
            if Session::deadline_expired(session, now) {
                effects.push((
                    id.clone(),
                    self.begin_drain(&id, now, Some("REMOTE_DESKTOP_DEADLINE_EXCEEDED")),
                ));
                continue;
            }
            if session
                .input_deadline
                .is_some_and(|deadline| now >= deadline)
            {
                let was_holder = self.is_holder(&id);
                if let Some(session) = self.sessions.get_mut(&id) {
                    Self::suspend(session);
                }
                self.changed(&id);
                effects.push((
                    id,
                    Effects {
                        release_input: was_holder,
                        ..Default::default()
                    },
                ));
            }
        }
        effects
    }
}

impl Session {
    fn deadline_expired(session: &Session, now: Instant) -> bool {
        let expired = |deadline: Option<Instant>| deadline.is_some_and(|t| now >= t);
        if session.snapshot.phase == Phase::Draining {
            if expired(session.stage_deadline) {
                return true;
            }
            return false;
        }
        if Registry::terminal(session.snapshot.phase) {
            return false;
        }
        now >= session.max_deadline
            || expired(session.idle_deadline)
            || expired(session.stage_deadline)
            || expired(session.signal_deadline)
            || expired(session.ice_deadline)
    }
}
