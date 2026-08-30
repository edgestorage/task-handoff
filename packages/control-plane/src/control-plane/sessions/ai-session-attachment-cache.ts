import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import writeFileAtomic from "write-file-atomic";
import { safeFileName } from "@task-handoff/core/core/file-names";

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024 * 1024;

const CacheManifestSchema = z.object({
  schemaVersion: z.literal(1),
  cacheId: z.string().regex(/^[a-f0-9]{64}$/),
  instanceId: z.string().trim().min(1).max(120),
  scopeType: z.enum(["session", "create-request"]),
  scopeId: z.string().trim().min(1).max(160),
  attachmentId: z.string().trim().min(1).max(120),
  sessionId: z.string().trim().min(1).max(120).optional(),
  messageId: z.string().trim().min(1).max(240).optional(),
  kind: z.enum(["image", "file"]),
  name: z.string().trim().min(1).max(240),
  mime: z.string().trim().min(1).max(120),
  disposition: z.string().trim().min(1).max(1024).optional(),
  size: z.number().int().positive(),
  etag: z.string().trim().min(1).max(160).optional(),
  instanceEpoch: z.string().trim().min(1).max(240).optional(),
  cachedAt: z.string().datetime(),
  lastAccessedAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
}).strict();

type CacheManifest = z.infer<typeof CacheManifestSchema>;

export type AiSessionAttachmentCacheEntry = CacheManifest & { path: string };
export type AiSessionAttachmentCacheWriteInput = Omit<Parameters<AiSessionAttachmentCache["putFile"]>[0], "sourcePath">;

export class AiSessionAttachmentCache {
  private readonly root: string;
  private readonly contentDir: string;
  private readonly manifestDir: string;
  private readonly maxBytes: number;
  private readonly now: () => number;
  private readonly onWarning?: (reason: string) => void;
  private readonly entries = new Map<string, CacheManifest>();
  private readonly pendingBindings = new Map<string, { instanceId: string; attachmentId: string; scopeId: string; sessionId: string; messageId: string; cacheUntil?: number; etag?: string }>();
  private reservedBytes = 0;

  constructor(dataDir: string, options: { maxBytes?: number; now?: () => number; onWarning?: (reason: string) => void } = {}) {
    this.root = path.join(dataDir, "ai-session-attachment-cache");
    this.contentDir = path.join(this.root, "content");
    this.manifestDir = path.join(this.root, "manifests");
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    this.now = options.now || Date.now;
    this.onWarning = options.onWarning;
    fs.mkdirSync(this.contentDir, { recursive: true, mode: 0o700 });
    fs.mkdirSync(this.manifestDir, { recursive: true, mode: 0o700 });
    this.restore();
    this.gc();
  }

  putFile(input: {
    instanceId: string;
    scopeType: "session" | "create-request";
    scopeId: string;
    attachmentId: string;
    sessionId?: string;
    messageId?: string;
    kind: "image" | "file";
    name: string;
    mime: string;
    disposition?: string;
    size: number;
    sourcePath: string;
    etag?: string;
    instanceEpoch?: string;
    cacheUntil?: number;
  }) {
    this.gc();
    const stat = fs.statSync(input.sourcePath);
    if (!stat.isFile() || stat.size !== input.size || input.size <= 0) throw new Error("Attachment cache source size mismatch.");
    this.evictFor(input.size);
    if (this.usedBytes() + this.reservedBytes + input.size > this.maxBytes) return undefined;
    const cacheId = cacheIdentity(input.instanceId, input.attachmentId);
    const contentPath = this.contentPath(cacheId);
    const temporary = `${contentPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    fs.copyFileSync(input.sourcePath, temporary, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(temporary, 0o600);
    fs.renameSync(temporary, contentPath);
    const timestamp = new Date(this.now()).toISOString();
    const expiresAt = new Date(Math.min(this.now() + CACHE_TTL_MS, input.cacheUntil ?? Number.POSITIVE_INFINITY)).toISOString();
    const manifest = CacheManifestSchema.parse({
      schemaVersion: 1,
      cacheId,
      instanceId: input.instanceId,
      scopeType: input.scopeType,
      scopeId: input.scopeId,
      attachmentId: input.attachmentId,
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      ...(input.messageId ? { messageId: input.messageId } : {}),
      kind: input.kind,
      name: safeFileName(input.name),
      mime: input.mime.toLowerCase(),
      ...(input.disposition ? { disposition: input.disposition } : {}),
      size: input.size,
      ...(input.etag ? { etag: input.etag } : {}),
      ...(input.instanceEpoch ? { instanceEpoch: input.instanceEpoch } : {}),
      cachedAt: timestamp,
      lastAccessedAt: timestamp,
      expiresAt,
    });
    this.save(manifest);
    return this.project(manifest);
  }

  beginBestEffortWrite(input: AiSessionAttachmentCacheWriteInput) {
    this.gc();
    this.evictFor(input.size);
    if (input.size <= 0 || this.usedBytes() + this.reservedBytes + input.size > this.maxBytes) return undefined;
    this.reservedBytes += input.size;
    const cacheId = cacheIdentity(input.instanceId, input.attachmentId);
    const contentPath = this.contentPath(cacheId);
    const temporary = `${contentPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    const output = fs.createWriteStream(temporary, { flags: "wx", mode: 0o600, highWaterMark: 1024 * 1024 });
    let written = 0;
    let abandoned = false;
    let reservationHeld = true;
    const releaseReservation = () => {
      if (!reservationHeld) return;
      reservationHeld = false;
      this.reservedBytes = Math.max(0, this.reservedBytes - input.size);
    };
    const abort = () => {
      if (abandoned) return;
      abandoned = true;
      releaseReservation();
      output.destroy();
      try { fs.unlinkSync(temporary); } catch {}
    };
    output.on("error", abort);
    return {
      offer: (chunk: Buffer | Uint8Array) => {
        if (abandoned) return false;
        written += chunk.byteLength;
        if (written > input.size || !output.write(chunk)) {
          abort();
          return false;
        }
        return true;
      },
      finish: async () => {
        if (abandoned || written !== input.size) { abort(); return undefined; }
        await new Promise<void>((resolve, reject) => {
          output.once("finish", resolve);
          output.once("error", reject);
          output.end();
        }).catch(() => undefined);
        if (abandoned) return undefined;
        releaseReservation();
        try {
          fs.renameSync(temporary, contentPath);
          const timestamp = new Date(this.now()).toISOString();
          const expiresAt = new Date(Math.min(this.now() + CACHE_TTL_MS, input.cacheUntil ?? Number.POSITIVE_INFINITY)).toISOString();
          const manifest = CacheManifestSchema.parse({
            schemaVersion: 1,
            cacheId,
            instanceId: input.instanceId,
            scopeType: input.scopeType,
            scopeId: input.scopeId,
            attachmentId: input.attachmentId,
            ...(input.sessionId ? { sessionId: input.sessionId } : {}),
            ...(input.messageId ? { messageId: input.messageId } : {}),
            kind: input.kind,
            name: safeFileName(input.name),
            mime: input.mime.toLowerCase(),
            ...(input.disposition ? { disposition: input.disposition } : {}),
            size: input.size,
            ...(input.etag ? { etag: input.etag } : {}),
            ...(input.instanceEpoch ? { instanceEpoch: input.instanceEpoch } : {}),
            cachedAt: timestamp,
            lastAccessedAt: timestamp,
            expiresAt,
          });
          this.save(manifest);
          return this.project(manifest);
        } catch {
          abort();
          return undefined;
        }
      },
      abort,
    };
  }

  bind(input: { instanceId: string; attachmentId: string; scopeId: string; sessionId: string; messageId: string; cacheUntil?: number; etag?: string }) {
    const id = cacheIdentity(input.instanceId, input.attachmentId);
    const entry = this.entries.get(id);
    if (!entry) {
      this.pendingBindings.set(id, input);
      return false;
    }
    if (entry.scopeId !== input.scopeId) return false;
    const expiresAt = new Date(Math.min(Date.parse(entry.expiresAt), input.cacheUntil ?? Number.POSITIVE_INFINITY)).toISOString();
    this.save(CacheManifestSchema.parse({ ...entry, sessionId: input.sessionId, messageId: input.messageId, expiresAt, ...(input.etag ? { etag: input.etag } : {}) }));
    return true;
  }

  get(input: { instanceId: string; sessionId: string; messageId: string; attachmentId: string; instanceEpoch?: string }) {
    this.gc();
    const id = cacheIdentity(input.instanceId, input.attachmentId);
    const entry = this.entries.get(id);
    if (!entry
      || entry.sessionId !== input.sessionId
      || entry.messageId !== input.messageId
      || (entry.instanceEpoch && entry.instanceEpoch !== input.instanceEpoch)) return undefined;
    const next = CacheManifestSchema.parse({ ...entry, lastAccessedAt: new Date(this.now()).toISOString() });
    this.entries.set(id, next);
    return this.project(next);
  }

  removeInstance(instanceId: string) {
    for (const entry of [...this.entries.values()]) if (entry.instanceId === instanceId) this.remove(entry.cacheId);
    for (const [id, binding] of this.pendingBindings) {
      if (binding.instanceId === instanceId) this.pendingBindings.delete(id);
    }
  }

  gc() {
    const now = this.now();
    for (const entry of [...this.entries.values()]) {
      if (Date.parse(entry.expiresAt) <= now || !this.validContent(entry)) this.remove(entry.cacheId);
    }
    this.cleanupOrphans();
  }

  private restore() {
    let files: string[] = [];
    try { files = fs.readdirSync(this.manifestDir); } catch { return; }
    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      try {
        const raw = JSON.parse(fs.readFileSync(path.join(this.manifestDir, file), "utf8"));
        const known = pickFields(raw);
        const parsed = CacheManifestSchema.safeParse(known);
        if (!parsed.success) throw new Error("invalid manifest");
        if (Object.keys(raw).some((key) => !(key in CacheManifestSchema.shape))) this.writeManifest(parsed.data);
        this.entries.set(parsed.data.cacheId, parsed.data);
      } catch {
        this.onWarning?.(`invalid AI session attachment cache manifest ignored: ${file}`);
      }
    }
  }

  private evictFor(required: number) {
    const candidates = [...this.entries.values()].sort((left, right) => Date.parse(left.lastAccessedAt) - Date.parse(right.lastAccessedAt));
    let used = this.usedBytes();
    for (const entry of candidates) {
      if (used + this.reservedBytes + required <= this.maxBytes) break;
      used -= entry.size;
      this.remove(entry.cacheId);
    }
  }

  private save(entry: CacheManifest) {
    const binding = this.pendingBindings.get(entry.cacheId);
    const next = binding && binding.scopeId === entry.scopeId
      ? CacheManifestSchema.parse({
        ...entry,
        sessionId: binding.sessionId,
        messageId: binding.messageId,
        expiresAt: new Date(Math.min(Date.parse(entry.expiresAt), binding.cacheUntil ?? Number.POSITIVE_INFINITY)).toISOString(),
        ...(binding.etag ? { etag: binding.etag } : {}),
      })
      : entry;
    this.pendingBindings.delete(entry.cacheId);
    this.writeManifest(next);
    this.entries.set(next.cacheId, next);
  }

  private writeManifest(entry: CacheManifest) {
    writeFileAtomic.sync(this.manifestPath(entry.cacheId), `${JSON.stringify(entry, null, 2)}\n`, { mode: 0o600 });
  }

  private remove(cacheId: string) {
    this.entries.delete(cacheId);
    try { fs.unlinkSync(this.manifestPath(cacheId)); } catch {}
    try { fs.unlinkSync(this.contentPath(cacheId)); } catch {}
  }

  private cleanupOrphans() {
    const retained = new Set(this.entries.keys());
    let files: string[] = [];
    try { files = fs.readdirSync(this.contentDir); } catch { return; }
    for (const file of files) {
      if (retained.has(file)) continue;
      try { fs.unlinkSync(path.join(this.contentDir, file)); } catch {}
    }
  }

  private validContent(entry: CacheManifest) {
    try { const stat = fs.statSync(this.contentPath(entry.cacheId)); return stat.isFile() && stat.size === entry.size; } catch { return false; }
  }

  private usedBytes() {
    return [...this.entries.values()].reduce((sum, entry) => this.validContent(entry) ? sum + entry.size : sum, 0);
  }

  private project(entry: CacheManifest): AiSessionAttachmentCacheEntry {
    return { ...entry, path: this.contentPath(entry.cacheId) };
  }

  private contentPath(cacheId: string) { return path.join(this.contentDir, cacheId); }
  private manifestPath(cacheId: string) { return path.join(this.manifestDir, `${cacheId}.json`); }
}

function cacheIdentity(instanceId: string, attachmentId: string) {
  return crypto.createHash("sha256").update(`${instanceId}\0${attachmentId}`).digest("hex");
}

function pickFields(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const record = value as Record<string, unknown>;
  return Object.fromEntries(Object.keys(CacheManifestSchema.shape).filter((key) => Object.prototype.hasOwnProperty.call(record, key)).map((key) => [key, record[key]]));
}
