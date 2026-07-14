import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AiSessionMessageAttachment } from "@task-handoff/protocol/ai-sessions";

const IMAGE_MIME_EXTENSIONS: Record<string, string> = {
  "image/bmp": ".bmp",
  "image/gif": ".gif",
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
};
const DEFAULT_ATTACHMENT_RETENTION_MS = 24 * 60 * 60 * 1000;

function safeName(name: string) {
  const cleaned = path.basename(name).replace(/[^\w.\- ()\u4e00-\u9fff]/g, "_").slice(0, 160);
  return cleaned || "image";
}

function attachmentDir() {
  const configured = process.env.TASK_HANDOFF_AI_SESSION_ATTACHMENT_DIR?.trim();
  return configured ? path.resolve(configured) : path.join(os.tmpdir(), "task-handoff-ai-session-attachments");
}

function attachmentRetentionMs() {
  const value = Number(process.env.TASK_HANDOFF_AI_SESSION_ATTACHMENT_RETENTION_MS);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_ATTACHMENT_RETENTION_MS;
}

function cleanupExpiredAttachments(dir: string) {
  const cutoff = Date.now() - attachmentRetentionMs();
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile()) {
        continue;
      }
      const filePath = path.join(dir, entry.name);
      try {
        if (fs.statSync(filePath).mtimeMs < cutoff) {
          fs.unlinkSync(filePath);
        }
      } catch {
        // Best-effort cleanup; stale attachment files should not block sending.
      }
    }
  } catch {
    // Best-effort cleanup; the directory may not exist yet or may be inaccessible.
  }
}

export function materializeAiSessionAttachments(attachments: AiSessionMessageAttachment[] = []) {
  if (!attachments.length) {
    return [];
  }
  const dir = attachmentDir();
  fs.mkdirSync(dir, { recursive: true });
  cleanupExpiredAttachments(dir);
  return attachments.map((attachment) => {
    const ext = IMAGE_MIME_EXTENSIONS[attachment.mime.toLowerCase()] || path.extname(attachment.name) || ".img";
    const fileName = `${attachment.id}-${safeName(attachment.name).replace(/\.[^.]+$/, "")}${ext}`;
    const filePath = path.join(dir, fileName);
    fs.writeFileSync(filePath, Buffer.from(attachment.data, "base64"));
    return { ...attachment, path: filePath };
  });
}

export async function withAttachmentPathFallback<T>(
  message: string,
  attachments: AiSessionMessageAttachment[] = [],
  run: (message: string) => Promise<T>,
) {
  const files = materializeAiSessionAttachments(attachments);
  if (!files.length) {
    return run(message);
  }
  const lines = files.map((attachment, index) => `图片${files.length > 1 ? index + 1 : ""}路径：${attachment.path}`);
  const providerMessage = [message.trim(), lines.join("\n")].filter(Boolean).join("\n\n");
  return run(providerMessage);
}
