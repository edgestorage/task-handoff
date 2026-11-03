use chrono::{DateTime, SecondsFormat, Utc};
use controlled_instance_core::atomic::write_atomic;
use controlled_instance_protocol::{
    AiSessionAttachmentContentState, AiSessionAttachmentDraft, AiSessionAttachmentKind,
    AiSessionAttachmentScopeType, AiSessionConversationAttachment, AiSessionMessageAttachmentMeta,
    AiSessionMessageAttachmentSourceType, AI_SESSION_ATTACHMENT_DRAFT_STREAM_TTL_MS,
    AI_SESSION_ATTACHMENT_RETENTION_DEFAULT_DAYS, AI_SESSION_DEFAULT_MAX_FILE_ATTACHMENT_BYTES,
    AI_SESSION_MAX_ATTACHMENT_BYTES, AI_SESSION_MAX_CONFIGURABLE_FILE_ATTACHMENT_BYTES,
    AI_SESSION_MAX_MESSAGE_ATTACHMENTS, AI_SESSION_MAX_MESSAGE_ATTACHMENT_BYTES,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet, HashMap},
    ffi::OsStr,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU32, AtomicU64, Ordering},
        Arc, Mutex,
    },
};
use thiserror::Error;
use uuid::Uuid;

const DEFAULT_MAX_STORAGE_BYTES: u64 = 2 * 1024 * 1024 * 1024;
const DAY_MS: i64 = 24 * 60 * 60 * 1000;

#[derive(Debug, Clone, Error)]
#[error("{message}")]
pub struct AiSessionAttachmentError {
    pub code: String,
    pub message: String,
    pub status_code: u16,
}

impl AiSessionAttachmentError {
    fn new(code: &str, message: impl Into<String>, status_code: u16) -> Self {
        Self {
            code: code.to_string(),
            message: message.into(),
            status_code,
        }
    }
}

#[derive(Debug, Clone)]
pub struct AiSessionAttachmentDraftInput {
    pub id: Option<String>,
    pub scope_type: AiSessionAttachmentScopeType,
    pub scope_id: String,
    pub kind: AiSessionAttachmentKind,
    pub name: String,
    pub mime: String,
    pub size: u64,
    pub content: Vec<u8>,
}

#[derive(Debug, Clone)]
pub enum AiSessionMessageAttachmentInput {
    Inline {
        id: String,
        kind: AiSessionAttachmentKind,
        name: String,
        mime: String,
        size: u64,
        data: Vec<u8>,
    },
    RuntimePath {
        id: String,
        kind: AiSessionAttachmentKind,
        name: String,
        mime: String,
        size: u64,
        path: PathBuf,
    },
}

#[derive(Debug, Clone)]
pub struct StageMessageAttachmentsInput {
    pub session_id: String,
    pub message_id: String,
    pub attachments: Vec<AiSessionMessageAttachmentInput>,
    pub retained_attachment_ids: Vec<String>,
    pub runtime_path_root: Option<PathBuf>,
    pub draft_scope_type: Option<AiSessionAttachmentScopeType>,
    pub draft_scope_id: Option<String>,
    pub draft_attachment_ids: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct RetainedAiSessionMessageAttachment {
    pub meta: AiSessionMessageAttachmentMeta,
    pub retained_path: PathBuf,
    pub source: ProviderAttachmentSource,
    pub runtime_path: Option<PathBuf>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProviderAttachmentSource {
    Inline,
    RuntimePath,
    Retained,
}

#[derive(Debug, Clone)]
pub struct StagedAiSessionMessageAttachments {
    pub message_id: String,
    pub attachments: Vec<AiSessionConversationAttachment>,
    pub provider_attachments: Vec<RetainedAiSessionMessageAttachment>,
}

#[derive(Debug, Clone)]
pub struct AiSessionAttachmentContent {
    pub attachment: AiSessionConversationAttachment,
    pub path: PathBuf,
    pub etag: String,
    pub cache_until: i64,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
enum StoredAttachmentState {
    Draft,
    Staged,
    Committed,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
enum ContentDeletionReason {
    Expired,
    Released,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredDraftScope {
    #[serde(rename = "type")]
    scope_type: AiSessionAttachmentScopeType,
    id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AttachmentManifest {
    schema_version: u8,
    id: String,
    input_id: String,
    session_id: String,
    message_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    turn_id: Option<String>,
    kind: AiSessionAttachmentKind,
    name: String,
    mime: String,
    size: u64,
    blob_hash: String,
    source_type: AiSessionMessageAttachmentSourceType,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    draft_scope: Option<StoredDraftScope>,
    state: StoredAttachmentState,
    created_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    committed_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    content_deleted_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    content_deletion_reason: Option<ContentDeletionReason>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DraftManifest {
    schema_version: u8,
    id: String,
    scope_type: AiSessionAttachmentScopeType,
    scope_id: String,
    kind: AiSessionAttachmentKind,
    name: String,
    mime: String,
    size: u64,
    blob_hash: String,
    created_at: String,
    expires_at: String,
}

#[derive(Default)]
struct AttachmentState {
    manifests: BTreeMap<String, AttachmentManifest>,
    drafts: BTreeMap<String, DraftManifest>,
}

pub struct AiSessionConversationAttachmentStore {
    root: PathBuf,
    blob_dir: PathBuf,
    manifest_dir: PathBuf,
    draft_dir: PathBuf,
    now: fn() -> i64,
    retention_days: AtomicU32,
    max_bytes: u64,
    max_file_attachment_bytes: AtomicU64,
    state: Mutex<AttachmentState>,
}

impl AiSessionConversationAttachmentStore {
    pub fn new(data_dir: &Path) -> Self {
        Self::with_limits(
            data_dir,
            AI_SESSION_ATTACHMENT_RETENTION_DEFAULT_DAYS,
            DEFAULT_MAX_STORAGE_BYTES,
            AI_SESSION_DEFAULT_MAX_FILE_ATTACHMENT_BYTES,
        )
    }

    pub fn with_limits(
        data_dir: &Path,
        retention_days: u32,
        max_bytes: u64,
        max_file_attachment_bytes: u64,
    ) -> Self {
        let root = data_dir.join("ai-session-attachments");
        let mut store = Self {
            blob_dir: root.join("blobs"),
            manifest_dir: root.join("manifests"),
            draft_dir: root.join("drafts"),
            root,
            now: now_millis,
            retention_days: AtomicU32::new(retention_days.min(365)),
            max_bytes,
            max_file_attachment_bytes: AtomicU64::new(
                max_file_attachment_bytes
                    .clamp(1, AI_SESSION_MAX_CONFIGURABLE_FILE_ATTACHMENT_BYTES),
            ),
            state: Mutex::new(AttachmentState::default()),
        };
        for directory in [&store.blob_dir, &store.manifest_dir, &store.draft_dir] {
            let _ = std::fs::create_dir_all(directory);
            let _ = controlled_instance_core::fs_permissions::restrict_path(directory, 0o700);
        }
        store.restore();
        store
    }

    pub fn draft_streams(self: &Arc<Self>) -> AiSessionAttachmentDraftStreams {
        AiSessionAttachmentDraftStreams::new(Arc::clone(self))
    }

    pub fn set_retention_days(&self, days: u32) -> (usize, usize) {
        self.retention_days.store(
            days.min(controlled_instance_protocol::AI_SESSION_ATTACHMENT_RETENTION_MAX_DAYS),
            Ordering::SeqCst,
        );
        self.gc()
    }

    pub fn set_max_file_attachment_bytes(
        &self,
        bytes: u64,
    ) -> Result<(), AiSessionAttachmentError> {
        if bytes == 0 || bytes > AI_SESSION_MAX_CONFIGURABLE_FILE_ATTACHMENT_BYTES {
            return Err(AiSessionAttachmentError::new(
                "AI_SESSION_ATTACHMENT_INVALID",
                format!(
                    "maxFileAttachmentBytes must be between 1 and {}.",
                    AI_SESSION_MAX_CONFIGURABLE_FILE_ATTACHMENT_BYTES
                ),
                400,
            ));
        }
        self.max_file_attachment_bytes
            .store(bytes, Ordering::SeqCst);
        Ok(())
    }

    pub fn retention_days(&self) -> u32 {
        self.retention_days.load(Ordering::SeqCst)
    }

    pub fn max_file_attachment_bytes(&self) -> u64 {
        self.max_file_attachment_bytes.load(Ordering::SeqCst)
    }

    pub fn create_draft(
        &self,
        input: AiSessionAttachmentDraftInput,
    ) -> Result<AiSessionAttachmentDraft, AiSessionAttachmentError> {
        self.gc();
        self.validate_draft_size(input.kind, input.size)?;
        self.assert_uploaded_file_size(input.kind, input.size)?;
        if input.content.len() as u64 != input.size {
            return Err(AiSessionAttachmentError::new(
                "AI_SESSION_ATTACHMENT_SIZE_MISMATCH",
                "Attachment content did not match its declared size.",
                400,
            ));
        }
        if input.scope_id.trim().is_empty() || input.scope_id.chars().count() > 160 {
            return Err(AiSessionAttachmentError::new(
                "AI_SESSION_ATTACHMENT_INVALID",
                "AI session attachment scope is invalid.",
                400,
            ));
        }
        let id = input
            .id
            .unwrap_or_else(|| format!("att_{}", random_hex(24)));
        if !valid_attachment_id(&id) {
            return Err(AiSessionAttachmentError::new(
                "AI_SESSION_ATTACHMENT_INVALID",
                "AI session attachment id is invalid or already exists.",
                409,
            ));
        }
        {
            let state = self.lock();
            if state.drafts.contains_key(&id) || state.manifests.contains_key(&id) {
                return Err(AiSessionAttachmentError::new(
                    "AI_SESSION_ATTACHMENT_INVALID",
                    "AI session attachment id is invalid or already exists.",
                    409,
                ));
            }
            if self.used_bytes(&state) + input.size > self.max_bytes {
                return Err(AiSessionAttachmentError::new(
                    "AI_SESSION_ATTACHMENT_STORAGE_FULL",
                    "AI session attachment storage is full.",
                    507,
                ));
            }
        }
        let blob_hash = hex::encode(Sha256::digest(&input.content));
        self.write_blob(&blob_hash, &input.content)?;
        let created_at = iso_from_millis((self.now)());
        let draft = DraftManifest {
            schema_version: 1,
            id: id.clone(),
            scope_type: input.scope_type,
            scope_id: input.scope_id.trim().to_string(),
            kind: input.kind,
            name: safe_file_name(&input.name),
            mime: input.mime.trim().to_ascii_lowercase(),
            size: input.size,
            blob_hash,
            created_at,
            expires_at: iso_from_millis((self.now)() + AI_SESSION_ATTACHMENT_DRAFT_STREAM_TTL_MS),
        };
        self.save_draft(&draft)?;
        self.lock().drafts.insert(id, draft.clone());
        Ok(public_draft(&draft))
    }

    pub fn cancel_draft(
        &self,
        scope_type: AiSessionAttachmentScopeType,
        scope_id: &str,
        attachment_id: &str,
    ) -> Result<bool, AiSessionAttachmentError> {
        let mut state = self.lock();
        let Some(draft) = state.drafts.get(attachment_id).cloned() else {
            return Ok(false);
        };
        if draft.scope_type != scope_type || draft.scope_id != scope_id.trim() {
            return Ok(false);
        }
        state.drafts.remove(attachment_id);
        drop(state);
        let _ = std::fs::remove_file(self.draft_path(attachment_id));
        self.remove_blob_if_unreferenced(&draft.blob_hash);
        Ok(true)
    }

    pub fn stage_message(
        &self,
        input: StageMessageAttachmentsInput,
    ) -> Result<StagedAiSessionMessageAttachments, AiSessionAttachmentError> {
        if input.attachments.len()
            + input.retained_attachment_ids.len()
            + input.draft_attachment_ids.len()
            > AI_SESSION_MAX_MESSAGE_ATTACHMENTS
        {
            return Err(AiSessionAttachmentError::new(
                "AI_SESSION_ATTACHMENT_TOO_MANY",
                format!(
                    "Messages may contain at most {AI_SESSION_MAX_MESSAGE_ATTACHMENTS} attachments."
                ),
                400,
            ));
        }
        if input.attachments.is_empty()
            && input.retained_attachment_ids.is_empty()
            && input.draft_attachment_ids.is_empty()
        {
            return Ok(StagedAiSessionMessageAttachments {
                message_id: input.message_id,
                attachments: Vec::new(),
                provider_attachments: Vec::new(),
            });
        }
        if !input.session_id.trim().is_empty() && !input.message_id.trim().is_empty() {
            let existing = self.message_manifests(&input.session_id, &input.message_id);
            if !existing.is_empty() {
                return Ok(staged_from_manifests(&input.message_id, &existing, self));
            }
        }
        self.gc();
        let retained = input
            .retained_attachment_ids
            .iter()
            .map(|id| {
                let state = self.lock();
                let manifest = state.manifests.get(id).cloned();
                drop(state);
                match manifest {
                    Some(manifest)
                        if manifest.session_id == input.session_id
                            && self.blob_available(&manifest) =>
                    {
                        Ok(manifest)
                    }
                    _ => Err(AiSessionAttachmentError::new(
                        "AI_SESSION_ATTACHMENT_NOT_FOUND",
                        "AI session attachment content is unavailable.",
                        404,
                    )),
                }
            })
            .collect::<Result<Vec<_>, _>>()?;
        let drafts = input
            .draft_attachment_ids
            .iter()
            .map(|id| {
                let state = self.lock();
                let draft = state.drafts.get(id).cloned();
                drop(state);
                match draft {
                    Some(draft)
                        if input.draft_scope_type == Some(draft.scope_type)
                            && input.draft_scope_id.as_deref() == Some(draft.scope_id.as_str())
                            && parse_iso(&draft.expires_at)
                                .is_some_and(|expires| expires > (self.now)()) =>
                    {
                        Ok(draft)
                    }
                    _ => Err(AiSessionAttachmentError::new(
                        "AI_SESSION_ATTACHMENT_DRAFT_NOT_FOUND",
                        "AI session attachment draft not found or expired.",
                        404,
                    )),
                }
            })
            .collect::<Result<Vec<_>, _>>()?;
        let snapshots = input
            .attachments
            .iter()
            .map(|attachment| self.snapshot(attachment, input.runtime_path_root.as_deref()))
            .collect::<Result<Vec<_>, _>>()?;
        for snapshot in &snapshots {
            if snapshot.source_type == AiSessionMessageAttachmentSourceType::Inline {
                self.assert_uploaded_file_size(snapshot.kind, snapshot.size)?;
            }
        }
        let total = retained.iter().map(|manifest| manifest.size).sum::<u64>()
            + drafts.iter().map(|draft| draft.size).sum::<u64>()
            + snapshots.iter().map(|snapshot| snapshot.size).sum::<u64>();
        if total > AI_SESSION_MAX_MESSAGE_ATTACHMENT_BYTES {
            return Err(AiSessionAttachmentError::new(
                "AI_SESSION_ATTACHMENT_MESSAGE_TOO_LARGE",
                format!(
                    "Attachments must be {AI_SESSION_MAX_MESSAGE_ATTACHMENT_BYTES} bytes or less in total."
                ),
                400,
            ));
        }
        self.assert_capacity(&snapshots)?;
        let mut created = Vec::<AttachmentManifest>::new();
        let mut provider_sources = Vec::<(ProviderAttachmentSource, Option<PathBuf>)>::new();
        let staged = (|| -> Result<(), AiSessionAttachmentError> {
            for source in retained {
                let manifest = AttachmentManifest {
                    schema_version: 1,
                    id: format!("att_{}", random_hex(24)),
                    input_id: source.input_id,
                    session_id: input.session_id.clone(),
                    message_id: input.message_id.clone(),
                    turn_id: None,
                    kind: source.kind,
                    name: source.name,
                    mime: source.mime,
                    size: source.size,
                    blob_hash: source.blob_hash,
                    source_type: source.source_type,
                    draft_scope: None,
                    state: StoredAttachmentState::Staged,
                    created_at: iso_from_millis((self.now)()),
                    committed_at: None,
                    content_deleted_at: None,
                    content_deletion_reason: None,
                };
                self.save_manifest(&manifest)?;
                provider_sources.push((ProviderAttachmentSource::Retained, None));
                created.push(manifest);
            }
            for draft in &drafts {
                let manifest = AttachmentManifest {
                    schema_version: 1,
                    id: draft.id.clone(),
                    input_id: draft.id.clone(),
                    session_id: input.session_id.clone(),
                    message_id: input.message_id.clone(),
                    turn_id: None,
                    kind: draft.kind,
                    name: draft.name.clone(),
                    mime: draft.mime.clone(),
                    size: draft.size,
                    blob_hash: draft.blob_hash.clone(),
                    source_type: AiSessionMessageAttachmentSourceType::Inline,
                    draft_scope: Some(StoredDraftScope {
                        scope_type: draft.scope_type,
                        id: draft.scope_id.clone(),
                    }),
                    state: StoredAttachmentState::Staged,
                    created_at: draft.created_at.clone(),
                    committed_at: None,
                    content_deleted_at: None,
                    content_deletion_reason: None,
                };
                self.save_manifest(&manifest)?;
                provider_sources.push((ProviderAttachmentSource::Retained, None));
                created.push(manifest);
            }
            for snapshot in snapshots {
                let provider_source = match snapshot.source_type {
                    AiSessionMessageAttachmentSourceType::Inline => {
                        ProviderAttachmentSource::Inline
                    }
                    AiSessionMessageAttachmentSourceType::RuntimePath => {
                        ProviderAttachmentSource::RuntimePath
                    }
                };
                let runtime_path = snapshot.runtime_path.clone();
                let blob_hash = hex::encode(Sha256::digest(&snapshot.content));
                self.write_blob(&blob_hash, &snapshot.content)?;
                let manifest = AttachmentManifest {
                    schema_version: 1,
                    id: format!("att_{}", random_hex(24)),
                    input_id: snapshot.id,
                    session_id: input.session_id.clone(),
                    message_id: input.message_id.clone(),
                    turn_id: None,
                    kind: snapshot.kind,
                    name: safe_file_name(&snapshot.name),
                    mime: snapshot.mime.to_ascii_lowercase(),
                    size: snapshot.size,
                    blob_hash,
                    source_type: snapshot.source_type,
                    draft_scope: None,
                    state: StoredAttachmentState::Staged,
                    created_at: iso_from_millis((self.now)()),
                    committed_at: None,
                    content_deleted_at: None,
                    content_deletion_reason: None,
                };
                self.save_manifest(&manifest)?;
                provider_sources.push((provider_source, runtime_path));
                created.push(manifest);
            }
            Ok(())
        })();
        if let Err(error) = staged {
            for manifest in &created {
                self.remove_manifest(&manifest.id);
            }
            self.cleanup_unreferenced_blobs();
            return Err(error);
        }
        for draft in &drafts {
            self.remove_draft_owner(&draft.id);
        }
        Ok(staged_from_manifests_with_sources(
            &input.message_id,
            &created,
            &provider_sources,
            self,
        ))
    }

    pub fn commit_message(&self, session_id: &str, message_id: &str, turn_id: Option<&str>) {
        let committed_at = iso_from_millis((self.now)());
        for mut manifest in self.message_manifests(session_id, message_id) {
            manifest.state = StoredAttachmentState::Committed;
            manifest.turn_id = turn_id.map(ToString::to_string).or(manifest.turn_id);
            manifest.committed_at = Some(manifest.committed_at.unwrap_or(committed_at.clone()));
            if manifest.draft_scope.take().is_some() {
                self.lock().drafts.remove(&manifest.id);
                let _ = std::fs::remove_file(self.draft_path(&manifest.id));
            }
            let _ = self.save_manifest(&manifest);
        }
        self.gc();
    }

    pub fn message_attachment_metas(
        &self,
        session_id: &str,
        message_id: &str,
    ) -> Vec<AiSessionMessageAttachmentMeta> {
        self.message_manifests(session_id, message_id)
            .into_iter()
            .map(|manifest| AiSessionMessageAttachmentMeta {
                id: manifest.id,
                kind: manifest.kind,
                name: manifest.name,
                mime: manifest.mime,
                size: manifest.size,
                source_type: manifest.source_type,
            })
            .collect()
    }

    pub fn rollback_message(&self, session_id: &str, message_id: &str) -> usize {
        let mut rolled_back = 0;
        for mut manifest in self.message_manifests(session_id, message_id) {
            if manifest.state != StoredAttachmentState::Staged {
                continue;
            }
            if let Some(draft_scope) = manifest.draft_scope.clone() {
                let draft = DraftManifest {
                    schema_version: 1,
                    id: manifest.id.clone(),
                    scope_type: draft_scope.scope_type,
                    scope_id: draft_scope.id,
                    kind: manifest.kind,
                    name: manifest.name.clone(),
                    mime: manifest.mime.clone(),
                    size: manifest.size,
                    blob_hash: manifest.blob_hash.clone(),
                    created_at: manifest.created_at.clone(),
                    expires_at: iso_from_millis(
                        parse_iso(&manifest.created_at).unwrap_or_else(|| (self.now)())
                            + AI_SESSION_ATTACHMENT_DRAFT_STREAM_TTL_MS,
                    ),
                };
                let _ = self.save_draft(&draft);
                self.lock().drafts.insert(draft.id.clone(), draft);
                self.remove_manifest(&manifest.id);
            } else {
                manifest.state = StoredAttachmentState::Draft;
                let _ = self.save_manifest(&manifest);
            }
            rolled_back += 1;
        }
        rolled_back
    }

    pub fn attachments_for_message(
        &self,
        session_id: &str,
        message_id: &str,
    ) -> Vec<AiSessionConversationAttachment> {
        self.gc();
        self.message_manifests(session_id, message_id)
            .iter()
            .map(|manifest| self.public_attachment(manifest))
            .collect()
    }

    pub fn message_id_for_attachments(
        &self,
        session_id: &str,
        attachment_ids: &[String],
    ) -> Option<String> {
        if attachment_ids.is_empty() {
            return None;
        }
        let state = self.lock();
        let manifests = attachment_ids
            .iter()
            .map(|id| state.manifests.get(id))
            .collect::<Option<Vec<_>>>()?;
        if manifests
            .iter()
            .any(|manifest| manifest.session_id != session_id)
        {
            return None;
        }
        let message_id = manifests.first()?.message_id.clone();
        manifests
            .iter()
            .all(|manifest| manifest.message_id == message_id)
            .then_some(message_id)
    }

    pub fn resolve_message_attachments(
        &self,
        session_id: &str,
        message_id: &str,
        attachments: &[AiSessionConversationAttachment],
    ) -> Vec<AiSessionConversationAttachment> {
        self.gc();
        let manifests = self.message_manifests(session_id, message_id);
        if manifests.is_empty() {
            return attachments
                .iter()
                .cloned()
                .map(|mut attachment| {
                    attachment.content_state = AiSessionAttachmentContentState::Missing;
                    attachment
                })
                .collect();
        }
        let published = manifests
            .iter()
            .map(|manifest| (manifest.id.as_str(), self.public_attachment(manifest)))
            .collect::<BTreeMap<_, _>>();
        let mut used = BTreeSet::new();
        attachments
            .iter()
            .enumerate()
            .map(|(index, attachment)| {
                if let Some(exact) = published.get(attachment.id.as_str()) {
                    used.insert(exact.id.clone());
                    return exact.clone();
                }
                let mut matching = manifests.iter().filter(|manifest| {
                    !used.contains(&manifest.id)
                        && manifest.kind == attachment.kind
                        && manifest.name == attachment.name
                        && manifest.mime == attachment.mime
                });
                let fallback = matching.next().filter(|_| matching.next().is_none());
                let fallback = fallback.or_else(|| {
                    (manifests.len() == attachments.len())
                        .then(|| manifests.get(index))
                        .flatten()
                        .filter(|manifest| !used.contains(&manifest.id))
                });
                if let Some(manifest) = fallback {
                    used.insert(manifest.id.clone());
                    self.public_attachment(manifest)
                } else {
                    let mut missing = attachment.clone();
                    missing.content_state = AiSessionAttachmentContentState::Missing;
                    missing
                }
            })
            .collect()
    }

    pub fn content(
        &self,
        session_id: &str,
        message_id: &str,
        attachment_id: &str,
    ) -> Result<AiSessionAttachmentContent, AiSessionAttachmentError> {
        self.gc();
        let state = self.lock();
        let manifest = state.manifests.get(attachment_id).cloned();
        drop(state);
        let Some(manifest) = manifest else {
            return Err(AiSessionAttachmentError::new(
                "AI_SESSION_ATTACHMENT_NOT_FOUND",
                "AI session attachment not found.",
                404,
            ));
        };
        if manifest.session_id != session_id
            || manifest.message_id != message_id
            || !matches!(
                manifest.state,
                StoredAttachmentState::Committed | StoredAttachmentState::Staged
            )
        {
            return Err(AiSessionAttachmentError::new(
                "AI_SESSION_ATTACHMENT_NOT_FOUND",
                "AI session attachment not found.",
                404,
            ));
        }
        let attachment = self.public_attachment(&manifest);
        match attachment.content_state {
            AiSessionAttachmentContentState::Expired => {
                return Err(AiSessionAttachmentError::new(
                    "AI_SESSION_ATTACHMENT_EXPIRED",
                    "AI session attachment content has expired.",
                    410,
                ));
            }
            AiSessionAttachmentContentState::Missing => {
                return Err(AiSessionAttachmentError::new(
                    "AI_SESSION_ATTACHMENT_NOT_FOUND",
                    "AI session attachment not found.",
                    404,
                ));
            }
            AiSessionAttachmentContentState::Available => {}
        }
        let cache_until = manifest
            .committed_at
            .as_deref()
            .and_then(parse_iso)
            .map(|committed| committed + self.retention_days() as i64 * DAY_MS)
            .unwrap_or_else(|| (self.now)());
        let etag = format!(
            "\"att-{}\"",
            &hex::encode(Sha256::digest(
                format!("{}:{}", manifest.id, manifest.blob_hash).as_bytes()
            ))[..32]
        );
        Ok(AiSessionAttachmentContent {
            attachment,
            path: self.blob_path(&manifest.blob_hash),
            etag,
            cache_until,
        })
    }

    pub fn release_session(&self, session_id: &str) -> usize {
        let ids = self
            .lock()
            .manifests
            .values()
            .filter(|manifest| manifest.session_id == session_id)
            .map(|manifest| manifest.id.clone())
            .collect::<Vec<_>>();
        for id in &ids {
            self.remove_manifest(id);
        }
        ids.len()
    }

    pub fn gc(&self) -> (usize, usize) {
        let now = (self.now)();
        let drafts = self
            .lock()
            .drafts
            .values()
            .filter(|draft| parse_iso(&draft.expires_at).is_none_or(|expires| expires <= now))
            .map(|draft| draft.id.clone())
            .collect::<Vec<_>>();
        let mut removed_drafts = 0;
        for id in drafts {
            let mut state = self.lock();
            if let Some(draft) = state.drafts.remove(&id) {
                drop(state);
                let _ = std::fs::remove_file(self.draft_path(&id));
                self.remove_blob_if_unreferenced(&draft.blob_hash);
                removed_drafts += 1;
            }
        }
        let expired = self
            .lock()
            .manifests
            .values()
            .filter(|manifest| {
                manifest.state == StoredAttachmentState::Committed
                    && manifest.content_deleted_at.is_none()
                    && manifest
                        .committed_at
                        .as_deref()
                        .and_then(parse_iso)
                        .is_some_and(|committed| {
                            now - committed >= self.retention_days() as i64 * DAY_MS
                        })
            })
            .cloned()
            .collect::<Vec<_>>();
        let mut expired_count = 0;
        for mut manifest in expired {
            manifest.content_deleted_at = Some(iso_from_millis(now));
            manifest.content_deletion_reason = Some(ContentDeletionReason::Expired);
            let _ = self.save_manifest(&manifest);
            self.remove_blob_if_unreferenced(&manifest.blob_hash);
            expired_count += 1;
        }
        (removed_drafts, expired_count)
    }

    fn snapshot(
        &self,
        attachment: &AiSessionMessageAttachmentInput,
        runtime_path_root: Option<&Path>,
    ) -> Result<AttachmentSnapshot, AiSessionAttachmentError> {
        match attachment {
            AiSessionMessageAttachmentInput::Inline {
                id,
                kind,
                name,
                mime,
                size,
                data,
            } => {
                if *size == 0 || *size > AI_SESSION_MAX_ATTACHMENT_BYTES {
                    return Err(AiSessionAttachmentError::new(
                        "AI_SESSION_ATTACHMENT_INVALID",
                        "AI session attachment has an invalid size.",
                        400,
                    ));
                }
                if data.len() as u64 != *size {
                    return Err(AiSessionAttachmentError::new(
                        "AI_SESSION_ATTACHMENT_INVALID",
                        "AI session attachment has an invalid size.",
                        400,
                    ));
                }
                Ok(AttachmentSnapshot {
                    id: id.clone(),
                    kind: *kind,
                    name: name.clone(),
                    mime: mime.clone(),
                    source_type: AiSessionMessageAttachmentSourceType::Inline,
                    size: data.len() as u64,
                    content: data.clone(),
                    runtime_path: None,
                })
            }
            AiSessionMessageAttachmentInput::RuntimePath {
                id,
                kind,
                name,
                mime,
                size,
                path,
            } => {
                if !path.is_absolute() {
                    return Err(AiSessionAttachmentError::new(
                        "AI_SESSION_RUNTIME_PATH_NOT_FOUND",
                        format!(
                            "Runtime attachment path must be absolute: {}",
                            path.display()
                        ),
                        400,
                    ));
                }
                let Some(root) = runtime_path_root else {
                    return Err(AiSessionAttachmentError::new(
                        "AI_SESSION_RUNTIME_PATH_ROOT_UNAVAILABLE",
                        "Runtime path attachments require an absolute AI session workspace.",
                        400,
                    ));
                };
                if !root.is_absolute() {
                    return Err(AiSessionAttachmentError::new(
                        "AI_SESSION_RUNTIME_PATH_ROOT_UNAVAILABLE",
                        "Runtime path attachments require an absolute AI session workspace.",
                        400,
                    ));
                }
                let canonical_root = root.canonicalize().map_err(|_| {
                    AiSessionAttachmentError::new(
                        "AI_SESSION_RUNTIME_PATH_ROOT_NOT_FOUND",
                        "AI session workspace does not exist.",
                        400,
                    )
                })?;
                if !canonical_root.is_dir() {
                    return Err(AiSessionAttachmentError::new(
                        "AI_SESSION_RUNTIME_PATH_ROOT_INVALID",
                        format!(
                            "AI session workspace is not a directory: {}",
                            root.display()
                        ),
                        400,
                    ));
                }
                let canonical_path = path.canonicalize().map_err(|_| {
                    AiSessionAttachmentError::new(
                        "AI_SESSION_RUNTIME_PATH_NOT_FOUND",
                        "Runtime attachment path does not exist.",
                        400,
                    )
                })?;
                if !canonical_path.starts_with(&canonical_root) {
                    return Err(AiSessionAttachmentError::new(
                        "AI_SESSION_RUNTIME_PATH_OUTSIDE_WORKSPACE",
                        format!(
                            "Runtime attachment path is outside the AI session workspace: {}",
                            path.display()
                        ),
                        400,
                    ));
                }
                let metadata = std::fs::metadata(&canonical_path).map_err(|_| {
                    AiSessionAttachmentError::new(
                        "AI_SESSION_RUNTIME_PATH_NOT_FOUND",
                        "Runtime attachment path does not exist.",
                        400,
                    )
                })?;
                if !metadata.is_file() {
                    return Err(AiSessionAttachmentError::new(
                        "AI_SESSION_RUNTIME_PATH_NOT_FILE",
                        format!("Runtime attachment path is not a file: {}", path.display()),
                        400,
                    ));
                }
                if *size == 0 || *size > AI_SESSION_MAX_ATTACHMENT_BYTES {
                    return Err(AiSessionAttachmentError::new(
                        "AI_SESSION_ATTACHMENT_INVALID",
                        "AI session attachment has an invalid size.",
                        400,
                    ));
                }
                if metadata.len() != *size {
                    return Err(AiSessionAttachmentError::new(
                        "AI_SESSION_ATTACHMENT_SIZE_MISMATCH",
                        "Runtime attachment size changed before it was accepted.",
                        409,
                    ));
                }
                let content = std::fs::read(&canonical_path).map_err(|error| {
                    AiSessionAttachmentError::new(
                        "AI_SESSION_ATTACHMENT_NOT_FOUND",
                        error.to_string(),
                        404,
                    )
                })?;
                Ok(AttachmentSnapshot {
                    id: id.clone(),
                    kind: *kind,
                    name: name.clone(),
                    mime: mime.clone(),
                    source_type: AiSessionMessageAttachmentSourceType::RuntimePath,
                    size: *size,
                    content,
                    runtime_path: Some(canonical_path),
                })
            }
        }
    }

    fn validate_draft_size(
        &self,
        kind: AiSessionAttachmentKind,
        size: u64,
    ) -> Result<(), AiSessionAttachmentError> {
        if size == 0 || size > AI_SESSION_MAX_ATTACHMENT_BYTES {
            return Err(AiSessionAttachmentError::new(
                "AI_SESSION_ATTACHMENT_INVALID",
                "AI session attachment has an invalid size.",
                400,
            ));
        }
        let _ = kind;
        Ok(())
    }

    fn assert_uploaded_file_size(
        &self,
        kind: AiSessionAttachmentKind,
        size: u64,
    ) -> Result<(), AiSessionAttachmentError> {
        let maximum = self.max_file_attachment_bytes();
        if kind != AiSessionAttachmentKind::File || size < maximum {
            return Ok(());
        }
        Err(AiSessionAttachmentError::new(
            "AI_SESSION_ATTACHMENTS_TOO_LARGE",
            format!("File attachment must be smaller than {maximum} bytes."),
            413,
        ))
    }

    fn assert_capacity(
        &self,
        snapshots: &[AttachmentSnapshot],
    ) -> Result<(), AiSessionAttachmentError> {
        let mut hashes = HashMap::<String, u64>::new();
        for snapshot in snapshots {
            hashes.insert(
                hex::encode(Sha256::digest(&snapshot.content)),
                snapshot.content.len() as u64,
            );
        }
        let required = hashes
            .into_iter()
            .filter(|(hash, _)| !self.blob_path(hash).exists())
            .map(|(_, size)| size)
            .sum::<u64>();
        if self.used_bytes(&self.lock()) + required > self.max_bytes {
            return Err(AiSessionAttachmentError::new(
                "AI_SESSION_ATTACHMENT_STORAGE_FULL",
                "AI session attachment storage is full.",
                507,
            ));
        }
        Ok(())
    }

    fn validate_stream_begin(
        &self,
        input: &AiSessionAttachmentDraftStreamBegin,
    ) -> Result<(), AiSessionAttachmentError> {
        self.gc();
        self.validate_draft_size(input.kind, input.size)?;
        self.assert_uploaded_file_size(input.kind, input.size)?;
        let state = self.lock();
        if self.used_bytes(&state) + input.size > self.max_bytes {
            return Err(AiSessionAttachmentError::new(
                "AI_SESSION_ATTACHMENT_STORAGE_FULL",
                "AI session attachment storage is full.",
                507,
            ));
        }
        if !valid_stream_id(&input.attachment_id)
            || state.drafts.contains_key(&input.attachment_id)
            || state.manifests.contains_key(&input.attachment_id)
        {
            return Err(AiSessionAttachmentError::new(
                "AI_SESSION_ATTACHMENT_INVALID",
                "AI session attachment id is invalid or already exists.",
                409,
            ));
        }
        Ok(())
    }

    fn remove_draft_owner(&self, id: &str) {
        self.lock().drafts.remove(id);
        let _ = std::fs::remove_file(self.draft_path(id));
    }

    fn restore(&mut self) {
        let mut drafts_to_save = Vec::new();
        let mut manifests_to_save = Vec::new();
        {
            let state = self
                .state
                .get_mut()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            for entry in std::fs::read_dir(&self.draft_dir)
                .into_iter()
                .flatten()
                .flatten()
            {
                if entry.path().extension() != Some(OsStr::new("json")) {
                    continue;
                }
                let Ok(bytes) = std::fs::read(entry.path()) else {
                    continue;
                };
                let Ok(draft) = serde_json::from_slice::<DraftManifest>(&bytes) else {
                    tracing::warn!(path = %entry.path().display(), "ignoring invalid AI Session attachment draft");
                    continue;
                };
                state.drafts.insert(draft.id.clone(), draft);
            }
            for entry in std::fs::read_dir(&self.manifest_dir)
                .into_iter()
                .flatten()
                .flatten()
            {
                if entry.path().extension() != Some(OsStr::new("json")) {
                    continue;
                }
                let Ok(bytes) = std::fs::read(entry.path()) else {
                    continue;
                };
                let Ok(mut manifest) = serde_json::from_slice::<AttachmentManifest>(&bytes) else {
                    tracing::warn!(path = %entry.path().display(), "ignoring invalid AI Session attachment manifest");
                    continue;
                };
                if manifest.state == StoredAttachmentState::Staged {
                    manifest.state = StoredAttachmentState::Draft;
                    if let Some(scope) = manifest.draft_scope.clone() {
                        let draft = DraftManifest {
                            schema_version: 1,
                            id: manifest.id.clone(),
                            scope_type: scope.scope_type,
                            scope_id: scope.id,
                            kind: manifest.kind,
                            name: manifest.name.clone(),
                            mime: manifest.mime.clone(),
                            size: manifest.size,
                            blob_hash: manifest.blob_hash.clone(),
                            created_at: manifest.created_at.clone(),
                            expires_at: iso_from_millis(
                                parse_iso(&manifest.created_at).unwrap_or_else(|| (self.now)())
                                    + AI_SESSION_ATTACHMENT_DRAFT_STREAM_TTL_MS,
                            ),
                        };
                        state.drafts.insert(draft.id.clone(), draft.clone());
                        drafts_to_save.push(draft);
                    }
                    manifests_to_save.push(manifest.clone());
                }
                state.manifests.insert(manifest.id.clone(), manifest);
            }
        }
        for draft in drafts_to_save {
            let _ = self.save_draft(&draft);
        }
        for manifest in manifests_to_save {
            let _ = self.save_manifest(&manifest);
        }
        self.cleanup_unreferenced_blobs();
        self.gc();
    }

    fn message_manifests(&self, session_id: &str, message_id: &str) -> Vec<AttachmentManifest> {
        let state = self.lock();
        let mut manifests = state
            .manifests
            .values()
            .filter(|manifest| {
                manifest.session_id == session_id && manifest.message_id == message_id
            })
            .cloned()
            .collect::<Vec<_>>();
        drop(state);
        manifests.sort_by(|left, right| {
            left.created_at
                .cmp(&right.created_at)
                .then_with(|| left.id.cmp(&right.id))
        });
        manifests
    }

    fn public_attachment(&self, manifest: &AttachmentManifest) -> AiSessionConversationAttachment {
        let content_state = if manifest.content_deleted_at.is_some() {
            AiSessionAttachmentContentState::Expired
        } else if self.blob_available(manifest) {
            AiSessionAttachmentContentState::Available
        } else {
            AiSessionAttachmentContentState::Missing
        };
        AiSessionConversationAttachment {
            id: manifest.id.clone(),
            kind: manifest.kind,
            name: manifest.name.clone(),
            mime: manifest.mime.clone(),
            size: manifest.size,
            content_state,
        }
    }

    fn provider_attachment(
        &self,
        manifest: &AttachmentManifest,
    ) -> RetainedAiSessionMessageAttachment {
        self.provider_attachment_with_source(manifest, ProviderAttachmentSource::Retained, None)
    }

    fn provider_attachment_with_source(
        &self,
        manifest: &AttachmentManifest,
        source: ProviderAttachmentSource,
        runtime_path: Option<PathBuf>,
    ) -> RetainedAiSessionMessageAttachment {
        RetainedAiSessionMessageAttachment {
            meta: AiSessionMessageAttachmentMeta {
                id: manifest.id.clone(),
                kind: manifest.kind,
                name: manifest.name.clone(),
                mime: manifest.mime.clone(),
                size: manifest.size,
                source_type: manifest.source_type,
            },
            retained_path: self.blob_path(&manifest.blob_hash),
            source,
            runtime_path,
        }
    }

    fn blob_available(&self, manifest: &AttachmentManifest) -> bool {
        if manifest.content_deleted_at.is_some() {
            return false;
        }
        std::fs::metadata(self.blob_path(&manifest.blob_hash))
            .is_ok_and(|metadata| metadata.is_file() && metadata.len() == manifest.size)
    }

    fn save_manifest(&self, manifest: &AttachmentManifest) -> Result<(), AiSessionAttachmentError> {
        let bytes = attachment_json(manifest)?;
        write_atomic(&self.manifest_path(&manifest.id), &bytes, Some(0o600)).map_err(io_error)?;
        self.lock()
            .manifests
            .insert(manifest.id.clone(), manifest.clone());
        Ok(())
    }

    fn remove_manifest(&self, id: &str) -> bool {
        let manifest = self.lock().manifests.remove(id);
        let Some(manifest) = manifest else {
            return false;
        };
        let _ = std::fs::remove_file(self.manifest_path(id));
        self.remove_blob_if_unreferenced(&manifest.blob_hash);
        true
    }

    fn save_draft(&self, draft: &DraftManifest) -> Result<(), AiSessionAttachmentError> {
        let bytes = attachment_json(draft)?;
        write_atomic(&self.draft_path(&draft.id), &bytes, Some(0o600)).map_err(io_error)?;
        Ok(())
    }

    fn write_blob(&self, hash: &str, content: &[u8]) -> Result<(), AiSessionAttachmentError> {
        write_atomic(&self.blob_path(hash), content, Some(0o600)).map_err(io_error)
    }

    fn remove_blob_if_unreferenced(&self, hash: &str) {
        let state = self.lock();
        if state
            .manifests
            .values()
            .any(|manifest| manifest.blob_hash == hash && manifest.content_deleted_at.is_none())
            || state.drafts.values().any(|draft| draft.blob_hash == hash)
        {
            return;
        }
        drop(state);
        let _ = std::fs::remove_file(self.blob_path(hash));
    }

    fn cleanup_unreferenced_blobs(&self) {
        let state = self.lock();
        let mut referenced = state
            .manifests
            .values()
            .filter(|manifest| manifest.content_deleted_at.is_none())
            .map(|manifest| manifest.blob_hash.clone())
            .collect::<BTreeSet<_>>();
        referenced.extend(state.drafts.values().map(|draft| draft.blob_hash.clone()));
        drop(state);
        for entry in std::fs::read_dir(&self.blob_dir)
            .into_iter()
            .flatten()
            .flatten()
        {
            let Some(name) = entry.file_name().to_str().map(ToString::to_string) else {
                continue;
            };
            if referenced.contains(&name) {
                continue;
            }
            let _ = std::fs::remove_file(entry.path());
        }
    }

    fn used_bytes(&self, state: &AttachmentState) -> u64 {
        let referenced = state
            .manifests
            .values()
            .filter(|manifest| manifest.content_deleted_at.is_none())
            .map(|manifest| manifest.blob_hash.as_str())
            .chain(state.drafts.values().map(|draft| draft.blob_hash.as_str()))
            .collect::<BTreeSet<_>>();
        referenced
            .into_iter()
            .filter_map(|hash| std::fs::metadata(self.blob_path(hash)).ok())
            .map(|metadata| metadata.len())
            .sum()
    }

    fn blob_path(&self, hash: &str) -> PathBuf {
        self.blob_dir.join(hash)
    }

    fn manifest_path(&self, id: &str) -> PathBuf {
        self.manifest_dir.join(format!("{id}.json"))
    }

    fn draft_path(&self, id: &str) -> PathBuf {
        self.draft_dir.join(format!("{id}.json"))
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, AttachmentState> {
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

struct AttachmentSnapshot {
    id: String,
    kind: AiSessionAttachmentKind,
    name: String,
    mime: String,
    source_type: AiSessionMessageAttachmentSourceType,
    size: u64,
    content: Vec<u8>,
    runtime_path: Option<PathBuf>,
}

fn staged_from_manifests(
    message_id: &str,
    manifests: &[AttachmentManifest],
    store: &AiSessionConversationAttachmentStore,
) -> StagedAiSessionMessageAttachments {
    StagedAiSessionMessageAttachments {
        message_id: message_id.to_string(),
        attachments: manifests
            .iter()
            .map(|manifest| store.public_attachment(manifest))
            .collect(),
        provider_attachments: manifests
            .iter()
            .map(|manifest| store.provider_attachment(manifest))
            .collect(),
    }
}

fn staged_from_manifests_with_sources(
    message_id: &str,
    manifests: &[AttachmentManifest],
    sources: &[(ProviderAttachmentSource, Option<PathBuf>)],
    store: &AiSessionConversationAttachmentStore,
) -> StagedAiSessionMessageAttachments {
    StagedAiSessionMessageAttachments {
        message_id: message_id.to_string(),
        attachments: manifests
            .iter()
            .map(|manifest| store.public_attachment(manifest))
            .collect(),
        provider_attachments: manifests
            .iter()
            .zip(sources)
            .map(|(manifest, (source, runtime_path))| {
                store.provider_attachment_with_source(manifest, *source, runtime_path.clone())
            })
            .collect(),
    }
}

pub struct AiSessionAttachmentDraftStreamBegin {
    pub attachment_id: String,
    pub scope_type: AiSessionAttachmentScopeType,
    pub scope_id: String,
    pub kind: AiSessionAttachmentKind,
    pub name: String,
    pub mime: String,
    pub size: u64,
}

struct DraftStream {
    input: AiSessionAttachmentDraftStreamBegin,
    written: u64,
    failure: Option<AiSessionAttachmentError>,
    path: PathBuf,
    expires_at: i64,
}

pub struct AiSessionAttachmentDraftStreams {
    store: Arc<AiSessionConversationAttachmentStore>,
    upload_dir: PathBuf,
    streams: Mutex<BTreeMap<String, DraftStream>>,
}

impl AiSessionAttachmentDraftStreams {
    fn new(store: Arc<AiSessionConversationAttachmentStore>) -> Self {
        let upload_dir = store.root.join("uploads");
        let _ = std::fs::create_dir_all(&upload_dir);
        let _ = controlled_instance_core::fs_permissions::restrict_path(&upload_dir, 0o700);
        Self {
            store,
            upload_dir,
            streams: Mutex::new(BTreeMap::new()),
        }
    }

    pub fn begin(
        &self,
        input: AiSessionAttachmentDraftStreamBegin,
    ) -> Result<Value, AiSessionAttachmentError> {
        let mut streams = self
            .streams
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        self.cleanup_expired(&mut streams);
        if streams.contains_key(&input.attachment_id) {
            return Err(AiSessionAttachmentError::new(
                "AI_SESSION_ATTACHMENT_UPLOAD_EXISTS",
                "AI session attachment upload already exists.",
                409,
            ));
        }
        self.store().validate_stream_begin(&input)?;
        let path = self
            .upload_dir
            .join(format!("{}.upload", input.attachment_id));
        let _ = std::fs::remove_file(&path);
        std::fs::File::create(&path).map_err(io_error)?;
        let attachment_id = input.attachment_id.clone();
        streams.insert(
            attachment_id.clone(),
            DraftStream {
                input,
                written: 0,
                failure: None,
                path,
                expires_at: (now_millis)() + AI_SESSION_ATTACHMENT_DRAFT_STREAM_TTL_MS,
            },
        );
        Ok(serde_json::json!({ "attachmentId": attachment_id, "offset": 0 }))
    }

    pub fn append(
        &self,
        attachment_id: &str,
        offset: u64,
        chunk: &[u8],
    ) -> Result<Value, AiSessionAttachmentError> {
        let mut streams = self
            .streams
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        self.cleanup_expired(&mut streams);
        let stream = streams.get_mut(attachment_id).ok_or_else(|| {
            AiSessionAttachmentError::new(
                "AI_SESSION_ATTACHMENT_UPLOAD_NOT_FOUND",
                "AI session attachment upload not found.",
                404,
            )
        })?;
        if let Some(failure) = stream.failure.as_ref() {
            return Err(failure.clone());
        }
        if offset != stream.written {
            return Err(AiSessionAttachmentError::new(
                "AI_SESSION_ATTACHMENT_OFFSET_MISMATCH",
                "AI session attachment upload offset does not match.",
                409,
            ));
        }
        let next = stream.written.saturating_add(chunk.len() as u64);
        if next > stream.input.size || chunk.len() > 512 * 1024 {
            let error = AiSessionAttachmentError::new(
                "AI_SESSION_ATTACHMENT_SIZE_MISMATCH",
                "Attachment content exceeded its declared size.",
                400,
            );
            stream.failure = Some(error.clone());
            let _ = std::fs::remove_file(&stream.path);
            return Err(error);
        }
        use std::io::Write;
        let mut file = std::fs::OpenOptions::new()
            .append(true)
            .open(&stream.path)
            .map_err(io_error)?;
        if let Err(error) = file.write_all(chunk) {
            let error = io_error(error);
            stream.failure = Some(error.clone());
            let _ = std::fs::remove_file(&stream.path);
            return Err(error);
        }
        stream.written = next;
        Ok(serde_json::json!({ "attachmentId": attachment_id, "offset": next }))
    }

    pub fn complete(
        &self,
        attachment_id: &str,
    ) -> Result<AiSessionAttachmentDraft, AiSessionAttachmentError> {
        let mut streams = self
            .streams
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        self.cleanup_expired(&mut streams);
        if let Some(stream) = streams.get(attachment_id) {
            if let Some(failure) = stream.failure.clone() {
                let path = stream.path.clone();
                streams.remove(attachment_id);
                let _ = std::fs::remove_file(path);
                return Err(failure);
            }
        }
        let stream = streams.remove(attachment_id).ok_or_else(|| {
            AiSessionAttachmentError::new(
                "AI_SESSION_ATTACHMENT_UPLOAD_NOT_FOUND",
                "AI session attachment upload not found.",
                404,
            )
        })?;
        drop(streams);
        if stream.written != stream.input.size {
            let _ = std::fs::remove_file(&stream.path);
            return Err(AiSessionAttachmentError::new(
                "AI_SESSION_ATTACHMENT_SIZE_MISMATCH",
                "Attachment content did not match its declared size.",
                400,
            ));
        }
        let content = std::fs::read(&stream.path).map_err(io_error)?;
        let _ = std::fs::remove_file(&stream.path);
        self.store().create_draft(AiSessionAttachmentDraftInput {
            id: Some(stream.input.attachment_id),
            scope_type: stream.input.scope_type,
            scope_id: stream.input.scope_id,
            kind: stream.input.kind,
            name: stream.input.name,
            mime: stream.input.mime,
            size: stream.input.size,
            content,
        })
    }

    pub fn cancel(&self, attachment_id: &str) -> Result<Value, AiSessionAttachmentError> {
        let mut streams = self
            .streams
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        self.cleanup_expired(&mut streams);
        let stream = streams.remove(attachment_id).ok_or_else(|| {
            AiSessionAttachmentError::new(
                "AI_SESSION_ATTACHMENT_UPLOAD_NOT_FOUND",
                "AI session attachment upload not found.",
                404,
            )
        })?;
        drop(streams);
        let _ = std::fs::remove_file(stream.path);
        Ok(serde_json::json!({ "removed": true }))
    }

    fn cleanup_expired(&self, streams: &mut BTreeMap<String, DraftStream>) {
        let now = now_millis();
        let expired = streams
            .iter()
            .filter(|(_, stream)| stream.expires_at <= now)
            .map(|(id, _)| id.clone())
            .collect::<Vec<_>>();
        for id in expired {
            if let Some(stream) = streams.remove(&id) {
                let _ = std::fs::remove_file(stream.path);
            }
        }
    }

    fn store(&self) -> &AiSessionConversationAttachmentStore {
        &self.store
    }
}

fn attachment_json<T: Serialize>(value: &T) -> Result<Vec<u8>, AiSessionAttachmentError> {
    let mut bytes = serde_json::to_vec_pretty(value).map_err(|error| {
        AiSessionAttachmentError::new("AI_SESSION_ATTACHMENT_INVALID", error.to_string(), 500)
    })?;
    bytes.push(b'\n');
    Ok(bytes)
}

fn io_error(error: std::io::Error) -> AiSessionAttachmentError {
    AiSessionAttachmentError::new("AI_SESSION_ATTACHMENT_IO_FAILED", error.to_string(), 500)
}

fn public_draft(draft: &DraftManifest) -> AiSessionAttachmentDraft {
    AiSessionAttachmentDraft {
        id: draft.id.clone(),
        kind: draft.kind,
        name: draft.name.clone(),
        mime: draft.mime.clone(),
        size: draft.size,
        expires_at: draft.expires_at.clone(),
    }
}

fn valid_attachment_id(id: &str) -> bool {
    let Some(suffix) = id.strip_prefix("att_").or_else(|| id.strip_prefix("cia_")) else {
        return false;
    };
    suffix.len() == 24
        && suffix
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

fn valid_stream_id(id: &str) -> bool {
    id.strip_prefix("cia_").is_some_and(|suffix| {
        suffix.len() == 24
            && suffix
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
    })
}

fn random_hex(length: usize) -> String {
    let mut value = String::new();
    while value.len() < length {
        value.push_str(&Uuid::new_v4().simple().to_string());
    }
    value.truncate(length);
    value
}

fn safe_file_name(name: &str) -> String {
    let base_name = name.replace('\\', "/");
    let base_name = base_name.rsplit('/').next().unwrap_or_default();
    let mut cleaned = base_name
        .chars()
        .map(|character| {
            if character.is_control()
                || matches!(
                    character,
                    '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*'
                )
            {
                '_'
            } else {
                character
            }
        })
        .collect::<String>()
        .trim()
        .to_string();
    while cleaned.ends_with('.') || cleaned.ends_with(' ') {
        cleaned.pop();
    }
    let stem = cleaned
        .split('.')
        .next()
        .unwrap_or_default()
        .to_ascii_lowercase();
    if matches!(stem.as_str(), "con" | "prn" | "aux" | "nul")
        || (stem.len() == 4
            && (stem.starts_with("com") || stem.starts_with("lpt"))
            && stem.as_bytes()[3].is_ascii_digit())
    {
        cleaned.insert(0, '_');
    }
    let mut limited = String::new();
    for character in cleaned.chars() {
        if limited.encode_utf16().count() + character.len_utf16() > 240
            || limited.len() + character.len_utf8() > 240
        {
            break;
        }
        limited.push(character);
    }
    while limited.ends_with('.') || limited.ends_with(' ') {
        limited.pop();
    }
    if limited.is_empty() || limited == "." || limited == ".." {
        "attachment".to_string()
    } else {
        limited
    }
}

fn now_millis() -> i64 {
    Utc::now().timestamp_millis()
}

fn iso_from_millis(value: i64) -> String {
    DateTime::<Utc>::from_timestamp_millis(value)
        .unwrap_or_else(Utc::now)
        .to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn parse_iso(value: &str) -> Option<i64> {
    DateTime::parse_from_rfc3339(value)
        .ok()
        .map(|value| value.timestamp_millis())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_store() -> (AiSessionConversationAttachmentStore, tempfile::TempDir) {
        let root = tempfile::tempdir().expect("tempdir");
        (AiSessionConversationAttachmentStore::new(root.path()), root)
    }

    fn draft_input(id: &str, scope_id: &str, content: &[u8]) -> AiSessionAttachmentDraftInput {
        AiSessionAttachmentDraftInput {
            id: Some(id.to_string()),
            scope_type: AiSessionAttachmentScopeType::Session,
            scope_id: scope_id.to_string(),
            kind: AiSessionAttachmentKind::File,
            name: "notes.txt".to_string(),
            mime: "text/plain".to_string(),
            size: content.len() as u64,
            content: content.to_vec(),
        }
    }

    #[test]
    fn draft_stage_commit_and_content_round_trip() {
        let (store, _root) = test_store();
        let draft = store
            .create_draft(draft_input(
                "att_0123456789abcdef01234567",
                "ses_1",
                b"hello",
            ))
            .expect("draft");
        assert_eq!(draft.size, 5);
        let staged = store
            .stage_message(StageMessageAttachmentsInput {
                session_id: "ses_1".to_string(),
                message_id: "msg_1".to_string(),
                attachments: Vec::new(),
                retained_attachment_ids: Vec::new(),
                runtime_path_root: None,
                draft_scope_type: Some(AiSessionAttachmentScopeType::Session),
                draft_scope_id: Some("ses_1".to_string()),
                draft_attachment_ids: vec![draft.id.clone()],
            })
            .expect("stage");
        assert_eq!(staged.attachments.len(), 1);
        assert!(store.lock().drafts.is_empty());
        store.commit_message("ses_1", "msg_1", Some("turn-1"));
        let content = store.content("ses_1", "msg_1", &draft.id).expect("content");
        assert_eq!(content.attachment.id, draft.id);
        assert_eq!(
            content.attachment.content_state,
            AiSessionAttachmentContentState::Available
        );
        assert_eq!(
            std::fs::read(&content.path).expect("content bytes"),
            b"hello"
        );
    }

    #[test]
    fn draft_stream_appends_chunks_and_rejects_offsets() {
        let (store, _root) = test_store();
        let store = Arc::new(store);
        let streams = store.draft_streams();
        streams
            .begin(AiSessionAttachmentDraftStreamBegin {
                attachment_id: "cia_0123456789abcdef01234567".to_string(),
                scope_type: AiSessionAttachmentScopeType::Session,
                scope_id: "ses_1".to_string(),
                kind: AiSessionAttachmentKind::File,
                name: "notes.txt".to_string(),
                mime: "text/plain".to_string(),
                size: 10,
            })
            .expect("begin");
        streams
            .append("cia_0123456789abcdef01234567", 0, b"hello")
            .expect("first chunk");
        assert_eq!(
            streams
                .append("cia_0123456789abcdef01234567", 0, b"hello")
                .expect_err("offset")
                .code,
            "AI_SESSION_ATTACHMENT_OFFSET_MISMATCH"
        );
        streams
            .append("cia_0123456789abcdef01234567", 5, b"world")
            .expect("second chunk");
        let draft = streams
            .complete("cia_0123456789abcdef01234567")
            .expect("complete");
        assert_eq!(draft.size, 10);
    }

    #[test]
    fn inline_and_runtime_path_attachments_are_snapshotted() {
        let (store, root) = test_store();
        let workspace = root.path().join("workspace");
        std::fs::create_dir_all(&workspace).expect("workspace");
        let runtime_file = workspace.join("README.md");
        std::fs::write(&runtime_file, b"runtime").expect("runtime file");
        let staged = store
            .stage_message(StageMessageAttachmentsInput {
                session_id: "ses_1".to_string(),
                message_id: "msg_1".to_string(),
                attachments: vec![
                    AiSessionMessageAttachmentInput::Inline {
                        id: "att_inline".to_string(),
                        kind: AiSessionAttachmentKind::File,
                        name: "inline.txt".to_string(),
                        mime: "text/plain".to_string(),
                        size: 6,
                        data: b"inline".to_vec(),
                    },
                    AiSessionMessageAttachmentInput::RuntimePath {
                        id: "att_path".to_string(),
                        kind: AiSessionAttachmentKind::File,
                        name: "README.md".to_string(),
                        mime: "text/markdown".to_string(),
                        size: 7,
                        path: runtime_file,
                    },
                ],
                retained_attachment_ids: Vec::new(),
                runtime_path_root: Some(workspace),
                draft_scope_type: None,
                draft_scope_id: None,
                draft_attachment_ids: Vec::new(),
            })
            .expect("stage");
        assert_eq!(staged.attachments.len(), 2);
        assert_eq!(staged.attachments[0].size, 6);
        assert_eq!(staged.attachments[1].size, 7);
    }

    #[test]
    fn uploaded_file_size_uses_the_node_exclusive_limit_and_413_error() {
        let (store, _root) = test_store();
        let size = AI_SESSION_DEFAULT_MAX_FILE_ATTACHMENT_BYTES as usize;
        let error = store
            .create_draft(draft_input(
                "att_0123456789abcdef01234568",
                "ses_1",
                &vec![0; size],
            ))
            .expect_err("limit is exclusive");
        assert_eq!(error.code, "AI_SESSION_ATTACHMENTS_TOO_LARGE");
        assert_eq!(error.status_code, 413);
    }

    #[test]
    fn runtime_path_size_must_match_the_declared_wire_size() {
        let (store, root) = test_store();
        let workspace = root.path().join("workspace");
        std::fs::create_dir_all(&workspace).expect("workspace");
        let runtime_file = workspace.join("README.md");
        std::fs::write(&runtime_file, b"runtime").expect("runtime file");
        let error = store
            .stage_message(StageMessageAttachmentsInput {
                session_id: "ses_1".to_string(),
                message_id: "msg_1".to_string(),
                attachments: vec![AiSessionMessageAttachmentInput::RuntimePath {
                    id: "att_path".to_string(),
                    kind: AiSessionAttachmentKind::File,
                    name: "README.md".to_string(),
                    mime: "text/markdown".to_string(),
                    size: 8,
                    path: runtime_file,
                }],
                retained_attachment_ids: Vec::new(),
                runtime_path_root: Some(workspace),
                draft_scope_type: None,
                draft_scope_id: None,
                draft_attachment_ids: Vec::new(),
            })
            .expect_err("size mismatch");
        assert_eq!(error.code, "AI_SESSION_ATTACHMENT_SIZE_MISMATCH");
        assert_eq!(error.status_code, 409);
    }

    #[test]
    fn inline_declared_size_mismatch_uses_the_node_invalid_error() {
        let (store, _root) = test_store();
        let error = store
            .stage_message(StageMessageAttachmentsInput {
                session_id: "ses_1".to_string(),
                message_id: "msg_1".to_string(),
                attachments: vec![AiSessionMessageAttachmentInput::Inline {
                    id: "att_inline".to_string(),
                    kind: AiSessionAttachmentKind::File,
                    name: "inline.txt".to_string(),
                    mime: "text/plain".to_string(),
                    size: 4,
                    data: b"hello".to_vec(),
                }],
                retained_attachment_ids: Vec::new(),
                runtime_path_root: None,
                draft_scope_type: None,
                draft_scope_id: None,
                draft_attachment_ids: Vec::new(),
            })
            .expect_err("inline size mismatch");
        assert_eq!(error.code, "AI_SESSION_ATTACHMENT_INVALID");
        assert_eq!(error.status_code, 400);
    }

    #[test]
    fn snapshot_capacity_is_checked_before_writing_any_blob_or_manifest() {
        let root = tempfile::tempdir().expect("tempdir");
        let store = AiSessionConversationAttachmentStore::with_limits(
            root.path(),
            AI_SESSION_ATTACHMENT_RETENTION_DEFAULT_DAYS,
            4,
            AI_SESSION_DEFAULT_MAX_FILE_ATTACHMENT_BYTES,
        );
        let error = store
            .stage_message(StageMessageAttachmentsInput {
                session_id: "ses_1".to_string(),
                message_id: "msg_1".to_string(),
                attachments: vec![AiSessionMessageAttachmentInput::Inline {
                    id: "att_inline".to_string(),
                    kind: AiSessionAttachmentKind::File,
                    name: "inline.txt".to_string(),
                    mime: "text/plain".to_string(),
                    size: 5,
                    data: b"hello".to_vec(),
                }],
                retained_attachment_ids: Vec::new(),
                runtime_path_root: None,
                draft_scope_type: None,
                draft_scope_id: None,
                draft_attachment_ids: Vec::new(),
            })
            .expect_err("storage full");
        assert_eq!(error.code, "AI_SESSION_ATTACHMENT_STORAGE_FULL");
        assert!(store.lock().manifests.is_empty());
        assert!(std::fs::read_dir(&store.blob_dir)
            .expect("blob dir")
            .next()
            .is_none());
    }
}
