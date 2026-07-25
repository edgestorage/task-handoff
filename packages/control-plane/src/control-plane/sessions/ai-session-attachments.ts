import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  AI_SESSION_MAX_ATTACHMENT_BYTES,
  AI_SESSION_MAX_INLINE_FILE_BYTES,
  AI_SESSION_MAX_MESSAGE_ATTACHMENT_BYTES,
  AI_SESSION_MAX_MESSAGE_ATTACHMENTS,
  AiSessionMessageAttachmentRefSchema,
  AiSessionMessageAttachmentSchema,
  type AiSessionMessageAttachment,
  type AiSessionMessageAttachmentRef,
} from "@task-handoff/protocol/ai-sessions";

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

const IMAGE_MIME_EXTENSIONS: Record<string, string> = {
  "image/bmp": ".bmp",
  "image/gif": ".gif",
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
};

const UploadSchema = z
  .object({
    instanceId: z.string().trim().min(1).max(120),
    sessionId: z.string().trim().min(1).max(120),
    kind: z.enum(["image", "file"]),
    name: z.string().trim().min(1).max(240),
    mime: z.string().trim().min(1).max(120),
    data: z.string().min(1).max(30 * 1024 * 1024),
  })
  .strict();

export type AiSessionAttachmentUpload = z.infer<typeof UploadSchema>;

export type StoredAiSessionAttachment = AiSessionMessageAttachment & {
  instanceId: string;
  sessionId: string;
  createdAt: string;
  expiresAt: string;
  path: string;
};

function attachmentRoot() {
  return path.join(os.tmpdir(), "task-handoff-ai-session-attachments");
}

function safeName(name: string) {
  const cleaned = path.basename(name).replace(/[^\w.\- ()\u4e00-\u9fff]/g, "_").slice(0, 160);
  return cleaned || "attachment";
}

function decodeDataUrlOrBase64(data: string, fallbackMime: string) {
  const match = /^data:([^;,]+);base64,(.+)$/i.exec(data.trim());
  const mime = match?.[1] || fallbackMime;
  const encoded = match?.[2] || data;
  return { mime, buffer: Buffer.from(encoded, "base64") };
}

export class AiSessionAttachmentStore {
  private readonly items = new Map<string, StoredAiSessionAttachment>();
  private readonly ttlMs: number;

  constructor(ttlMs = DEFAULT_TTL_MS) {
    this.ttlMs = ttlMs;
  }

  upload(input: unknown) {
    this.pruneExpired();
    const parsed = UploadSchema.parse(input);
    const decoded = decodeDataUrlOrBase64(parsed.data, parsed.mime);
    const mime = decoded.mime.toLowerCase();
    const ext = IMAGE_MIME_EXTENSIONS[mime] || "";
    if (parsed.kind === "image" && !ext) {
      throw new Error(`Unsupported image type: ${mime}`);
    }
    const tooLarge = parsed.kind === "image"
      ? decoded.buffer.length > AI_SESSION_MAX_ATTACHMENT_BYTES
      : decoded.buffer.length >= AI_SESSION_MAX_INLINE_FILE_BYTES;
    if (!decoded.buffer.length || tooLarge) {
      throw new Error(parsed.kind === "image"
        ? `Image must be between 1 byte and ${AI_SESSION_MAX_ATTACHMENT_BYTES} bytes.`
        : `File must be smaller than ${AI_SESSION_MAX_INLINE_FILE_BYTES} bytes.`);
    }
    const id = `att_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
    const now = new Date();
    const expiresAt = new Date(now.getTime() + this.ttlMs);
    const dir = attachmentRoot();
    fs.mkdirSync(dir, { recursive: true });
    const name = safeName(parsed.name);
    const filePath = path.join(dir, `${id}-${name.endsWith(ext) ? name : `${name}${ext}`}`);
    fs.writeFileSync(filePath, decoded.buffer);
    const attachment: StoredAiSessionAttachment = {
      id,
      instanceId: parsed.instanceId,
      sessionId: parsed.sessionId,
      kind: parsed.kind,
      name,
      mime,
      size: decoded.buffer.length,
      source: {
        type: "inline",
        encoding: "base64",
        data: decoded.buffer.toString("base64"),
      },
      path: filePath,
      createdAt: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
    };
    this.items.set(id, attachment);
    return this.publicAttachment(attachment);
  }

  resolveRefs(input: unknown, instanceId: string, sessionId: string): AiSessionMessageAttachment[] {
    this.pruneExpired();
    const refs = z.array(AiSessionMessageAttachmentRefSchema).max(AI_SESSION_MAX_MESSAGE_ATTACHMENTS).default([]).parse(input);
    const attachments = refs.map((ref) => {
      if (ref.source.type === "runtime-path") return AiSessionMessageAttachmentSchema.parse(ref);
      return this.requireAttachment(ref as Extract<AiSessionMessageAttachmentRef, { source: { type: "upload-ref" } }>, instanceId, sessionId);
    });
    const totalBytes = attachments.reduce((sum, attachment) => sum + (attachment.source.type === "inline" ? attachment.size : 0), 0);
    if (totalBytes > AI_SESSION_MAX_MESSAGE_ATTACHMENT_BYTES) {
      throw new Error(`Inline attachments must be ${AI_SESSION_MAX_MESSAGE_ATTACHMENT_BYTES} bytes or less in total.`);
    }
    for (const ref of refs) {
      if (ref.source.type === "upload-ref") this.consumeAttachment(ref.id);
    }
    return attachments;
  }

  private requireAttachment(ref: Extract<AiSessionMessageAttachmentRef, { source: { type: "upload-ref" } }>, instanceId: string, sessionId: string) {
    const attachment = this.items.get(ref.id);
    if (!attachment) {
      throw new Error(`AI session attachment not found or expired: ${ref.id}`);
    }
    if (ref.kind && ref.kind !== attachment.kind) {
      throw new Error(`AI session attachment kind mismatch: ${ref.id}`);
    }
    if (attachment.instanceId !== instanceId || attachment.sessionId !== sessionId) {
      throw new Error(`AI session attachment scope mismatch: ${ref.id}`);
    }
    return AiSessionMessageAttachmentSchema.parse({
      id: attachment.id,
      kind: attachment.kind,
      name: attachment.name,
      mime: attachment.mime,
      size: attachment.size,
      source: attachment.source,
    });
  }

  private consumeAttachment(id: string) {
    const attachment = this.items.get(id);
    if (!attachment) {
      return;
    }
    this.items.delete(id);
    try {
      fs.unlinkSync(attachment.path);
    } catch {
      // Best-effort cleanup; consumed attachments are no longer resolvable.
    }
  }

  private publicAttachment(attachment: StoredAiSessionAttachment) {
    return {
      id: attachment.id,
      kind: attachment.kind,
      name: attachment.name,
      mime: attachment.mime,
      size: attachment.size,
      expiresAt: attachment.expiresAt,
    };
  }

  private pruneExpired() {
    const now = Date.now();
    for (const [id, attachment] of this.items) {
      if (Date.parse(attachment.expiresAt) > now) {
        continue;
      }
      this.items.delete(id);
      try {
        fs.unlinkSync(attachment.path);
      } catch {
        // Best-effort cleanup; expired attachments are no longer resolvable.
      }
    }
  }
}
