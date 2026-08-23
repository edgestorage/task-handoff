import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { Transform, type Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import writeFileAtomic from "write-file-atomic";
import { z } from "zod";
import {
  AI_SESSION_ATTACHMENT_RETENTION_DEFAULT_DAYS,
  AI_SESSION_DEFAULT_MAX_FILE_ATTACHMENT_BYTES,
  AI_SESSION_MAX_ATTACHMENT_BYTES,
  AI_SESSION_MAX_CONFIGURABLE_FILE_ATTACHMENT_BYTES,
  AI_SESSION_MAX_MESSAGE_ATTACHMENT_BYTES,
  AI_SESSION_MAX_MESSAGE_ATTACHMENTS,
  AiSessionConversationAttachmentSchema,
  type AiSessionConversationAttachment,
  type AiSessionMessageAttachment,
} from "@task-handoff/protocol/ai-sessions";
import type { TaskHandoffStoragePaths } from "@task-handoff/core/storage/paths";
import { safeFileName } from "@task-handoff/core/core/file-names";

const DAY_MS = 24 * 60 * 60 * 1000;
const DRAFT_RETENTION_MS = DAY_MS;
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024 * 1024;

function normalizeMaxFileAttachmentBytes(value: number | undefined) {
  const normalized = value ?? AI_SESSION_DEFAULT_MAX_FILE_ATTACHMENT_BYTES;
  if (!Number.isInteger(normalized) || normalized <= 0 || normalized > AI_SESSION_MAX_CONFIGURABLE_FILE_ATTACHMENT_BYTES) {
    throw new RangeError(`maxFileAttachmentBytes must be between 1 and ${AI_SESSION_MAX_CONFIGURABLE_FILE_ATTACHMENT_BYTES}.`);
  }
  return normalized;
}

const ManifestSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().trim().min(1).max(120),
  inputId: z.string().trim().min(1).max(120),
  sessionId: z.string().trim().min(1).max(120),
  messageId: z.string().trim().min(1).max(240),
  turnId: z.string().trim().min(1).max(240).optional(),
  kind: z.enum(["image", "file"]),
  name: z.string().trim().min(1).max(240),
  mime: z.string().trim().min(1).max(120),
  size: z.number().int().positive().max(AI_SESSION_MAX_ATTACHMENT_BYTES),
  blobHash: z.string().regex(/^[a-f0-9]{64}$/),
  sourceType: z.enum(["inline", "runtime-path"]),
  // Internal ownership needed to restore a consumed upload draft when provider
  // dispatch fails. This never crosses the controlled-instance API boundary.
  draftScope: z.object({
    type: z.enum(["session", "create-request"]),
    id: z.string().trim().min(1).max(160),
  }).strict().optional(),
  state: z.enum(["draft", "staged", "committed"]),
  createdAt: z.string().datetime(),
  committedAt: z.string().datetime().optional(),
  contentDeletedAt: z.string().datetime().optional(),
  contentDeletionReason: z.enum(["expired", "released"]).optional(),
}).strict();

const DraftManifestSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().trim().min(1).max(120),
  scopeType: z.enum(["session", "create-request"]),
  scopeId: z.string().trim().min(1).max(160),
  kind: z.enum(["image", "file"]),
  name: z.string().trim().min(1).max(240),
  mime: z.string().trim().min(1).max(120),
  size: z.number().int().positive().max(AI_SESSION_MAX_ATTACHMENT_BYTES),
  blobHash: z.string().regex(/^[a-f0-9]{64}$/),
  createdAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
}).strict();

type AttachmentManifest = z.infer<typeof ManifestSchema>;
type DraftManifest = z.infer<typeof DraftManifestSchema>;

function restoredUploadDraft(manifest: AttachmentManifest): DraftManifest | undefined {
  if (!manifest.draftScope) return undefined;
  return DraftManifestSchema.parse({
    schemaVersion: 1,
    id: manifest.id,
    scopeType: manifest.draftScope.type,
    scopeId: manifest.draftScope.id,
    kind: manifest.kind,
    name: manifest.name,
    mime: manifest.mime,
    size: manifest.size,
    blobHash: manifest.blobHash,
    createdAt: manifest.createdAt,
    expiresAt: new Date(Date.parse(manifest.createdAt) + DRAFT_RETENTION_MS).toISOString(),
  });
}

export type RetainedAiSessionMessageAttachment = AiSessionMessageAttachment & { retainedPath?: string };

export type AiSessionConversationAttachmentStoreOptions = {
  now?: () => number;
  retentionDays?: number;
  maxBytes?: number;
  maxFileAttachmentBytes?: number;
  onWarning?: (reason: string) => void;
};

export type StagedAiSessionMessageAttachments = {
  messageId: string;
  attachments: AiSessionConversationAttachment[];
  providerAttachments: RetainedAiSessionMessageAttachment[];
};

export type AiSessionAttachmentContent = {
  attachment: AiSessionConversationAttachment;
  path: string;
  etag: string;
  cacheUntil: number;
};

export type AiSessionDraftAttachment = {
  id: string;
  kind: "image" | "file";
  name: string;
  mime: string;
  size: number;
  expiresAt: string;
};

export class AiSessionConversationAttachmentStore {
  private readonly root: string;
  private readonly blobDir: string;
  private readonly manifestDir: string;
  private readonly draftDir: string;
  private readonly now: () => number;
  private readonly maxBytes: number;
  private maxFileAttachmentBytes: number;
  private readonly onWarning?: (reason: string) => void;
  private retentionDays: number;
  private readonly manifests = new Map<string, AttachmentManifest>();
  private readonly drafts = new Map<string, DraftManifest>();

  constructor(
    paths: Pick<TaskHandoffStoragePaths, "dataDir">,
    options: AiSessionConversationAttachmentStoreOptions = {},
  ) {
    this.root = path.join(paths.dataDir, "ai-session-attachments");
    this.blobDir = path.join(this.root, "blobs");
    this.manifestDir = path.join(this.root, "manifests");
    this.draftDir = path.join(this.root, "drafts");
    this.now = options.now || Date.now;
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    this.maxFileAttachmentBytes = normalizeMaxFileAttachmentBytes(options.maxFileAttachmentBytes);
    this.retentionDays = normalizeRetentionDays(options.retentionDays);
    this.onWarning = options.onWarning;
    fs.mkdirSync(this.blobDir, { recursive: true, mode: 0o700 });
    fs.mkdirSync(this.manifestDir, { recursive: true, mode: 0o700 });
    fs.mkdirSync(this.draftDir, { recursive: true, mode: 0o700 });
    this.restore();
    this.restoreDrafts();
    this.cleanupUnreferencedBlobs();
    this.gc();
  }

  setRetentionDays(days: number) {
    this.retentionDays = normalizeRetentionDays(days);
    return this.gc();
  }

  setMaxFileAttachmentBytes(bytes: number) {
    this.maxFileAttachmentBytes = normalizeMaxFileAttachmentBytes(bytes);
  }

  async createDraft(input: {
    id?: string;
    scopeType: "session" | "create-request";
    scopeId: string;
    kind: "image" | "file";
    name: string;
    mime: string;
    size: number;
    source: Readable;
  }): Promise<AiSessionDraftAttachment> {
    this.gc();
    if (!Number.isInteger(input.size) || input.size <= 0 || input.size > AI_SESSION_MAX_ATTACHMENT_BYTES) {
      throw attachmentError("AI_SESSION_ATTACHMENT_INVALID", "AI session attachment has an invalid size.", 400);
    }
    this.assertUploadedFileSize(input.kind, input.size);
    if (this.usedBytes() + input.size > this.maxBytes) {
      throw attachmentError("AI_SESSION_ATTACHMENT_STORAGE_FULL", "AI session attachment storage is full.", 507);
    }
    const id = input.id || `att_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;
    if (!/^(?:att|cia)_[a-f0-9]{24}$/.test(id) || this.drafts.has(id) || this.manifests.has(id)) {
      throw attachmentError("AI_SESSION_ATTACHMENT_INVALID", "AI session attachment id is invalid or already exists.", 409);
    }
    const temporary = path.join(this.blobDir, `.${id}.${process.pid}.${crypto.randomUUID()}.tmp`);
    const hash = crypto.createHash("sha256");
    let size = 0;
    const meter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        size += chunk.length;
        if (size > input.size || size > AI_SESSION_MAX_ATTACHMENT_BYTES) {
          callback(attachmentError("AI_SESSION_ATTACHMENT_SIZE_MISMATCH", "Attachment content exceeded its declared size.", 400));
          return;
        }
        hash.update(chunk);
        callback(null, chunk);
      },
    });
    try {
      await pipeline(input.source, meter, fs.createWriteStream(temporary, { flags: "wx", mode: 0o600 }));
      if (size !== input.size) {
        throw attachmentError("AI_SESSION_ATTACHMENT_SIZE_MISMATCH", "Attachment content did not match its declared size.", 400);
      }
      const blobHash = hash.digest("hex");
      const blobPath = this.blobPath(blobHash);
      if (fs.existsSync(blobPath)) fs.unlinkSync(temporary);
      else fs.renameSync(temporary, blobPath);
      const createdAt = new Date(this.now()).toISOString();
      const manifest = DraftManifestSchema.parse({
        schemaVersion: 1,
        id,
        scopeType: input.scopeType,
        scopeId: input.scopeId,
        kind: input.kind,
        name: safeFileName(input.name),
        mime: input.mime.toLowerCase(),
        size,
        blobHash,
        createdAt,
        expiresAt: new Date(this.now() + DRAFT_RETENTION_MS).toISOString(),
      });
      this.saveDraft(manifest);
      return this.publicDraft(manifest);
    } catch (error) {
      try { fs.unlinkSync(temporary); } catch {}
      this.cleanupUnreferencedBlobs();
      throw error;
    }
  }

  cancelDraft(scopeType: DraftManifest["scopeType"], scopeId: string, attachmentId: string) {
    const draft = this.drafts.get(attachmentId);
    if (!draft || draft.scopeType !== scopeType || draft.scopeId !== scopeId) return false;
    return this.removeDraft(attachmentId);
  }

  stageDrafts(input: {
    scopeType: DraftManifest["scopeType"];
    scopeId: string;
    sessionId: string;
    messageId: string;
    attachmentIds: readonly string[];
  }): StagedAiSessionMessageAttachments {
    return this.stageMessage({
      sessionId: input.sessionId,
      messageId: input.messageId,
      draftScopeType: input.scopeType,
      draftScopeId: input.scopeId,
      draftAttachmentIds: input.attachmentIds,
    });
  }

  stageMessage(input: {
    sessionId: string;
    messageId: string;
    attachments?: AiSessionMessageAttachment[];
    runtimePathRoot?: string;
    draftScopeType?: DraftManifest["scopeType"];
    draftScopeId?: string;
    draftAttachmentIds?: readonly string[];
  }): StagedAiSessionMessageAttachments {
    const attachments = input.attachments || [];
    const draftAttachmentIds = input.draftAttachmentIds || [];
    if (attachments.length + draftAttachmentIds.length > AI_SESSION_MAX_MESSAGE_ATTACHMENTS) {
      throw attachmentError("AI_SESSION_ATTACHMENT_TOO_MANY", `Messages may contain at most ${AI_SESSION_MAX_MESSAGE_ATTACHMENTS} attachments.`, 400);
    }
    if (!attachments.length && !draftAttachmentIds.length) return { messageId: input.messageId, attachments: [], providerAttachments: [] };
    const existing = this.messageManifests(input.sessionId, input.messageId);
    if (existing.length) {
      return {
        messageId: input.messageId,
        attachments: existing.map((manifest) => this.publicAttachment(manifest)),
        providerAttachments: existing.map((manifest) => this.providerAttachment(manifest)),
      };
    }
    this.gc();
    const drafts = draftAttachmentIds.map((id) => {
      const draft = this.drafts.get(id);
      if (!draft || !input.draftScopeType || !input.draftScopeId
        || draft.scopeType !== input.draftScopeType || draft.scopeId !== input.draftScopeId
        || Date.parse(draft.expiresAt) <= this.now()) {
        throw attachmentError("AI_SESSION_ATTACHMENT_DRAFT_NOT_FOUND", "AI session attachment draft not found or expired.", 404);
      }
      return draft;
    });
    const snapshots = attachments.map((attachment) => this.snapshot(attachment, input.runtimePathRoot));
    for (const snapshot of snapshots) {
      if (snapshot.attachment.source.type === "inline") {
        this.assertUploadedFileSize(snapshot.attachment.kind, snapshot.content.length);
      }
    }
    const totalBytes = snapshots.reduce((sum, entry) => sum + entry.content.length, drafts.reduce((sum, draft) => sum + draft.size, 0));
    if (totalBytes > AI_SESSION_MAX_MESSAGE_ATTACHMENT_BYTES) {
      throw attachmentError("AI_SESSION_ATTACHMENT_MESSAGE_TOO_LARGE", `Attachments must be ${AI_SESSION_MAX_MESSAGE_ATTACHMENT_BYTES} bytes or less in total.`, 400);
    }
    this.assertCapacity(snapshots);
    const created: AttachmentManifest[] = [];
    try {
      for (const draft of drafts) {
        const manifest = ManifestSchema.parse({
          schemaVersion: 1,
          id: draft.id,
          inputId: draft.id,
          sessionId: input.sessionId,
          messageId: input.messageId,
          kind: draft.kind,
          name: draft.name,
          mime: draft.mime,
          size: draft.size,
          blobHash: draft.blobHash,
          sourceType: "inline",
          draftScope: { type: draft.scopeType, id: draft.scopeId },
          state: "staged",
          createdAt: draft.createdAt,
        });
        this.saveManifest(manifest);
        created.push(manifest);
      }
      for (const snapshot of snapshots) {
        const id = `att_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;
        const blobHash = crypto.createHash("sha256").update(snapshot.content).digest("hex");
        this.writeBlob(blobHash, snapshot.content);
        const manifest = ManifestSchema.parse({
          schemaVersion: 1,
          id,
          inputId: snapshot.attachment.id,
          sessionId: input.sessionId,
          messageId: input.messageId,
          kind: snapshot.attachment.kind,
          name: safeFileName(snapshot.attachment.name),
          mime: snapshot.attachment.mime,
          size: snapshot.content.length,
          blobHash,
          sourceType: snapshot.attachment.source.type,
          state: "staged",
          createdAt: new Date(this.now()).toISOString(),
        });
        this.saveManifest(manifest);
        created.push(manifest);
      }
    } catch (error) {
      for (const manifest of created) this.removeManifest(manifest.id);
      this.cleanupUnreferencedBlobs();
      throw error;
    }
    // Draft ownership changes only after every durable message manifest exists.
    for (const draft of drafts) this.removeDraft(draft.id);
    return {
      messageId: input.messageId,
      attachments: created.map((manifest) => this.publicAttachment(manifest)),
      providerAttachments: created.map((manifest) => this.providerAttachment(manifest)),
    };
  }

  commitMessage(sessionId: string, messageId: string, turnId?: string) {
    const committedAt = new Date(this.now()).toISOString();
    const manifests = this.messageManifests(sessionId, messageId);
    for (const manifest of manifests) {
      const { draftScope: _draftScope, ...committed } = manifest;
      const next = ManifestSchema.parse({ ...committed, state: "committed", committedAt: manifest.committedAt || committedAt, turnId: turnId || manifest.turnId });
      this.saveManifest(next);
    }
    this.gc();
    return manifests.length;
  }

  rollbackMessage(sessionId: string, messageId: string) {
    let rolledBack = 0;
    for (const manifest of this.messageManifests(sessionId, messageId)) {
      if (manifest.state !== "staged") continue;
      if (manifest.draftScope) {
        // Persist the restored draft before removing the message manifest so a
        // crash cannot lose the only durable owner of the shared blob.
        this.saveDraft(restoredUploadDraft(manifest)!);
        this.removeManifest(manifest.id);
      } else {
        this.saveManifest(ManifestSchema.parse({ ...manifest, state: "draft" }));
      }
      rolledBack += 1;
    }
    return rolledBack;
  }

  attachmentsForMessage(sessionId: string, messageId: string) {
    this.gc();
    return this.messageManifests(sessionId, messageId).map((manifest) => this.publicAttachment(manifest));
  }

  attachmentMetadata(sessionId: string, messageId: string, attachmentId: string) {
    this.gc();
    const manifest = this.manifests.get(attachmentId);
    if (!manifest || manifest.sessionId !== sessionId || manifest.messageId !== messageId) return undefined;
    return this.publicAttachment(manifest);
  }

  providerAttachments(attachmentIds: readonly string[]) {
    return attachmentIds.flatMap((id) => {
      const manifest = this.manifests.get(id);
      return manifest ? [this.providerAttachment(manifest)] : [];
    });
  }

  messageIdForAttachments(sessionId: string, attachmentIds: readonly string[]) {
    const manifests = attachmentIds.map((id) => this.manifests.get(id));
    if (!manifests.length || manifests.some((manifest) => !manifest || manifest.sessionId !== sessionId)) return undefined;
    const messageIds = new Set(manifests.map((manifest) => manifest!.messageId));
    return messageIds.size === 1 ? [...messageIds][0] : undefined;
  }

  claimMessageAttachments(sessionId: string, messageId: string, attachmentIds: readonly string[]) {
    const manifests = attachmentIds.map((id) => this.manifests.get(id));
    if (!manifests.length || manifests.some((manifest) => !manifest
      || manifest.sessionId !== sessionId
      || manifest.messageId !== messageId)) return false;
    for (const manifest of manifests) {
      if (manifest!.state === "draft") {
        this.saveManifest(ManifestSchema.parse({ ...manifest, state: "staged" }));
      }
    }
    for (const manifest of manifests) {
      if (manifest!.draftScope) this.removeDraft(manifest!.id);
    }
    return true;
  }

  content(sessionId: string, messageId: string, attachmentId: string): AiSessionAttachmentContent {
    this.gc();
    const manifest = this.manifests.get(attachmentId);
    if (!manifest || manifest.sessionId !== sessionId || manifest.messageId !== messageId || manifest.state !== "committed") {
      throw attachmentError("AI_SESSION_ATTACHMENT_NOT_FOUND", "AI session attachment not found.", 404);
    }
    const attachment = this.publicAttachment(manifest);
    if (attachment.contentState === "expired") {
      throw attachmentError("AI_SESSION_ATTACHMENT_EXPIRED", "AI session attachment content has expired.", 410);
    }
    if (attachment.contentState !== "available") {
      throw attachmentError("AI_SESSION_ATTACHMENT_NOT_FOUND", "AI session attachment not found.", 404);
    }
    return {
      attachment,
      path: this.blobPath(manifest.blobHash),
      etag: `"att-${crypto.createHash("sha256").update(`${manifest.id}:${manifest.blobHash}`).digest("hex").slice(0, 32)}"`,
      cacheUntil: Date.parse(manifest.committedAt!) + this.retentionDays * DAY_MS,
    };
  }

  releaseSession(sessionId: string) {
    const ids = [...this.manifests.values()].filter((manifest) => manifest.sessionId === sessionId).map((manifest) => manifest.id);
    for (const id of ids) this.removeManifest(id);
    return ids.length;
  }

  gc() {
    const now = this.now();
    let removedDrafts = 0;
    let expiredContent = 0;
    for (const draft of [...this.drafts.values()]) {
      if (Date.parse(draft.expiresAt) > now) continue;
      this.removeDraft(draft.id);
      removedDrafts += 1;
    }
    for (const manifest of [...this.manifests.values()]) {
      if (manifest.state !== "committed" && now - Date.parse(manifest.createdAt) >= DRAFT_RETENTION_MS) {
        this.removeManifest(manifest.id);
        removedDrafts += 1;
        continue;
      }
      if (manifest.state !== "committed" || manifest.contentDeletedAt || !manifest.committedAt) continue;
      if (now - Date.parse(manifest.committedAt) < this.retentionDays * DAY_MS) continue;
      const next = ManifestSchema.parse({
        ...manifest,
        contentDeletedAt: new Date(now).toISOString(),
        contentDeletionReason: "expired",
      });
      this.saveManifest(next);
      this.removeBlobIfUnreferenced(manifest.blobHash);
      expiredContent += 1;
    }
    return { removedDrafts, expiredContent };
  }

  private restoreDrafts() {
    let entries: fs.Dirent[] = [];
    try { entries = fs.readdirSync(this.draftDir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      try {
        const raw = JSON.parse(fs.readFileSync(path.join(this.draftDir, entry.name), "utf8"));
        const parsed = DraftManifestSchema.safeParse(pickSchemaFields(DraftManifestSchema, raw));
        if (!parsed.success) {
          this.onWarning?.(`invalid attachment draft ignored: ${entry.name}`);
          continue;
        }
        if (raw && typeof raw === "object" && Object.keys(raw).some((key) => !(key in DraftManifestSchema.shape))) {
          this.onWarning?.(`unknown attachment draft fields ignored: ${entry.name}`);
          this.writeDraftFile(parsed.data);
        }
        this.drafts.set(parsed.data.id, parsed.data);
        this.verifyDraftBlob(parsed.data);
      } catch (error) {
        this.onWarning?.(`unreadable attachment draft ignored: ${entry.name}: ${safeError(error)}`);
      }
    }
  }

  private restore() {
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(this.manifestDir, { withFileTypes: true });
    } catch (error) {
      this.onWarning?.(`attachment manifests could not be listed: ${safeError(error)}`);
      return;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const filePath = path.join(this.manifestDir, entry.name);
      try {
        const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
        const known = pickManifestFields(raw);
        const parsed = ManifestSchema.safeParse(known);
        if (!parsed.success) {
          this.onWarning?.(`invalid attachment manifest ignored: ${entry.name}`);
          continue;
        }
        if (raw && typeof raw === "object" && Object.keys(raw).some((key) => !(key in ManifestSchema.shape))) {
          this.onWarning?.(`unknown attachment manifest fields ignored: ${entry.name}`);
          this.writeManifestFile(parsed.data);
        }
        // A staged provider call has no durable acceptance proof after a process
        // restart. Restore it as an explicitly retryable draft; never replay it.
        const restored = parsed.data.state === "staged"
          ? ManifestSchema.parse({ ...parsed.data, state: "draft" })
          : parsed.data;
        const retryableDraft = parsed.data.state === "staged" ? restoredUploadDraft(parsed.data) : undefined;
        if (retryableDraft) {
          this.saveDraft(retryableDraft);
        }
        if (restored !== parsed.data) this.writeManifestFile(restored);
        this.manifests.set(restored.id, restored);
        if (!restored.contentDeletedAt) this.verifyBlob(restored);
      } catch (error) {
        this.onWarning?.(`unreadable attachment manifest ignored: ${entry.name}: ${safeError(error)}`);
      }
    }
  }

  private verifyBlob(manifest: AttachmentManifest) {
    try {
      const filePath = this.blobPath(manifest.blobHash);
      const stat = fs.statSync(filePath);
      if (!stat.isFile() || stat.size !== manifest.size) throw new Error("blob size mismatch");
      const hash = crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
      if (hash !== manifest.blobHash) throw new Error("blob hash mismatch");
    } catch (error) {
      this.onWarning?.(`attachment blob is missing or corrupt for ${manifest.id}: ${safeError(error)}`);
    }
  }

  private verifyDraftBlob(draft: DraftManifest) {
    this.verifyBlob({ ...draft, inputId: draft.id, sessionId: draft.scopeId, messageId: draft.id, sourceType: "inline", state: "draft" });
  }

  private snapshot(attachment: AiSessionMessageAttachment, runtimePathRoot?: string) {
    if (attachment.source.type === "inline") {
      const content = Buffer.from(attachment.source.data, "base64");
      if (!content.length || content.length !== attachment.size || content.length > AI_SESSION_MAX_ATTACHMENT_BYTES) {
        throw attachmentError("AI_SESSION_ATTACHMENT_INVALID", "AI session attachment has an invalid size.", 400);
      }
      return { attachment, content };
    }
    if (!runtimePathRoot || !path.isAbsolute(runtimePathRoot)) {
      throw attachmentError("AI_SESSION_RUNTIME_PATH_ROOT_UNAVAILABLE", "Runtime path attachments require an absolute AI session workspace.", 400);
    }
    const root = fs.realpathSync(runtimePathRoot);
    const filePath = fs.realpathSync(attachment.source.path);
    const relative = path.relative(root, filePath);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw attachmentError("AI_SESSION_RUNTIME_PATH_OUTSIDE_WORKSPACE", "Runtime attachment path is outside the AI session workspace.", 400);
    }
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) throw attachmentError("AI_SESSION_RUNTIME_PATH_NOT_FILE", "Runtime attachment path is not a file.", 400);
    if (stat.size <= 0 || stat.size > AI_SESSION_MAX_ATTACHMENT_BYTES) {
      throw attachmentError("AI_SESSION_ATTACHMENT_INVALID", "AI session attachment has an invalid size.", 400);
    }
    if (stat.size !== attachment.size) {
      throw attachmentError("AI_SESSION_ATTACHMENT_SIZE_MISMATCH", "Runtime attachment size changed before it was accepted.", 409);
    }
    return { attachment, content: fs.readFileSync(filePath) };
  }

  private assertUploadedFileSize(kind: "image" | "file", size: number) {
    if (kind !== "file" || size < this.maxFileAttachmentBytes) return;
    throw attachmentError(
      "AI_SESSION_ATTACHMENTS_TOO_LARGE",
      `File attachment must be smaller than ${this.maxFileAttachmentBytes} bytes.`,
      413,
    );
  }

  private publicAttachment(manifest: AttachmentManifest): AiSessionConversationAttachment {
    return AiSessionConversationAttachmentSchema.parse({
      id: manifest.id,
      kind: manifest.kind,
      name: manifest.name,
      mime: manifest.mime,
      size: manifest.size,
      contentState: manifest.contentDeletionReason === "expired"
        ? "expired"
        : this.blobAvailable(manifest)
          ? "available"
          : "missing",
    });
  }

  private providerAttachment(manifest: AttachmentManifest): RetainedAiSessionMessageAttachment {
    const filePath = this.blobPath(manifest.blobHash);
    if (!this.blobAvailable(manifest)) {
      throw attachmentError("AI_SESSION_ATTACHMENT_NOT_FOUND", "AI session attachment content is unavailable.", 404);
    }
    return {
      id: manifest.id,
      kind: manifest.kind,
      name: manifest.name,
      mime: manifest.mime,
      size: manifest.size,
      source: { type: "runtime-path", path: filePath },
      retainedPath: filePath,
    };
  }

  private messageManifests(sessionId: string, messageId: string) {
    return [...this.manifests.values()]
      .filter((manifest) => manifest.sessionId === sessionId && manifest.messageId === messageId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
  }

  private assertCapacity(snapshots: Array<{ content: Buffer }>) {
    const hashes = new Map<string, number>();
    for (const snapshot of snapshots) hashes.set(crypto.createHash("sha256").update(snapshot.content).digest("hex"), snapshot.content.length);
    let required = 0;
    for (const [hash, size] of hashes) if (!fs.existsSync(this.blobPath(hash))) required += size;
    if (this.usedBytes() + required > this.maxBytes) {
      throw attachmentError("AI_SESSION_ATTACHMENT_STORAGE_FULL", "AI session attachment storage is full.", 507);
    }
  }

  private usedBytes() {
    try {
      return fs.readdirSync(this.blobDir, { withFileTypes: true }).reduce((sum, entry) => {
        if (!entry.isFile()) return sum;
        try { return sum + fs.statSync(path.join(this.blobDir, entry.name)).size; } catch { return sum; }
      }, 0);
    } catch {
      return 0;
    }
  }

  private writeBlob(hash: string, content: Buffer) {
    const filePath = this.blobPath(hash);
    if (fs.existsSync(filePath)) return;
    const temporary = path.join(this.blobDir, `.${hash}.${process.pid}.${crypto.randomUUID()}.tmp`);
    fs.writeFileSync(temporary, content, { mode: 0o600, flag: "wx" });
    try {
      fs.renameSync(temporary, filePath);
    } catch (error) {
      try { fs.unlinkSync(temporary); } catch {}
      if (!fs.existsSync(filePath)) throw error;
    }
  }

  private saveManifest(manifest: AttachmentManifest) {
    this.writeManifestFile(manifest);
    this.manifests.set(manifest.id, manifest);
  }

  private saveDraft(draft: DraftManifest) {
    this.writeDraftFile(draft);
    this.drafts.set(draft.id, draft);
  }

  private writeDraftFile(draft: DraftManifest) {
    writeFileAtomic.sync(this.draftPath(draft.id), `${JSON.stringify(draft, null, 2)}\n`, { mode: 0o600 });
  }

  private publicDraft(draft: DraftManifest): AiSessionDraftAttachment {
    return {
      id: draft.id,
      kind: draft.kind,
      name: draft.name,
      mime: draft.mime,
      size: draft.size,
      expiresAt: draft.expiresAt,
    };
  }

  private writeManifestFile(manifest: AttachmentManifest) {
    writeFileAtomic.sync(this.manifestPath(manifest.id), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  }

  private removeManifest(id: string) {
    const manifest = this.manifests.get(id);
    if (!manifest) return false;
    this.manifests.delete(id);
    try { fs.unlinkSync(this.manifestPath(id)); } catch (error) {
      if (!isMissing(error)) this.onWarning?.(`attachment manifest cleanup failed for ${id}`);
    }
    this.removeBlobIfUnreferenced(manifest.blobHash);
    return true;
  }

  private removeDraft(id: string) {
    const draft = this.drafts.get(id);
    if (!draft) return false;
    this.drafts.delete(id);
    try { fs.unlinkSync(this.draftPath(id)); } catch (error) {
      if (!isMissing(error)) this.onWarning?.(`attachment draft cleanup failed for ${id}`);
    }
    this.removeBlobIfUnreferenced(draft.blobHash);
    return true;
  }

  private removeBlobIfUnreferenced(hash: string) {
    if ([...this.manifests.values()].some((manifest) => manifest.blobHash === hash && !manifest.contentDeletedAt)) return;
    if ([...this.drafts.values()].some((draft) => draft.blobHash === hash)) return;
    try { fs.unlinkSync(this.blobPath(hash)); } catch (error) {
      if (!isMissing(error)) this.onWarning?.("attachment blob cleanup failed");
    }
  }

  private cleanupUnreferencedBlobs() {
    const referenced = new Set([...this.manifests.values()]
      .filter((manifest) => !manifest.contentDeletedAt)
      .map((manifest) => manifest.blobHash));
    for (const draft of this.drafts.values()) referenced.add(draft.blobHash);
    let entries: fs.Dirent[] = [];
    try { entries = fs.readdirSync(this.blobDir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (!entry.isFile() || referenced.has(entry.name)) continue;
      try { fs.unlinkSync(path.join(this.blobDir, entry.name)); } catch (error) {
        if (!isMissing(error)) this.onWarning?.("unreferenced attachment blob cleanup failed");
      }
    }
  }

  private blobAvailable(manifest: AttachmentManifest) {
    if (manifest.contentDeletedAt) return false;
    try {
      const stat = fs.statSync(this.blobPath(manifest.blobHash));
      return stat.isFile() && stat.size === manifest.size;
    } catch {
      return false;
    }
  }

  private blobPath(hash: string) {
    return path.join(this.blobDir, hash);
  }

  private manifestPath(id: string) {
    return path.join(this.manifestDir, `${id}.json`);
  }

  private draftPath(id: string) {
    return path.join(this.draftDir, `${id}.json`);
  }
}

function normalizeRetentionDays(value: number | undefined) {
  return Number.isInteger(value) && value !== undefined && value >= 0 && value <= 365 ? value : AI_SESSION_ATTACHMENT_RETENTION_DEFAULT_DAYS;
}

function pickManifestFields(value: unknown) {
  return pickSchemaFields(ManifestSchema, value);
}

function pickSchemaFields(schema: { shape: Record<string, unknown> }, value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const record = value as Record<string, unknown>;
  return Object.fromEntries(Object.keys(schema.shape).filter((key) => Object.prototype.hasOwnProperty.call(record, key)).map((key) => [key, record[key]]));
}

function attachmentError(code: string, message: string, statusCode: number) {
  return Object.assign(new Error(message), { code, statusCode });
}

function isMissing(error: unknown) {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}

function safeError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
