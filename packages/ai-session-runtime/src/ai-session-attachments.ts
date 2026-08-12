import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AI_SESSION_MAX_INLINE_FILE_BYTES, type AiSessionMessageAttachment } from "@task-handoff/protocol/ai-sessions";

export type CodexAttachmentInput =
  | { type: "image"; url: string }
  | { type: "localImage"; path: string };

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

export function materializeAiSessionAttachments(attachments: AiSessionMessageAttachment[] = [], runtimePathRoot?: string) {
  if (!attachments.length) {
    return [];
  }
  const dir = attachmentDir();
  fs.mkdirSync(dir, { recursive: true });
  cleanupExpiredAttachments(dir);
  return attachments.map((attachment) => {
    if (attachment.source.type === "runtime-path") {
      if (!path.isAbsolute(attachment.source.path)) {
        throw new Error(`Runtime attachment path must be absolute: ${attachment.source.path}`);
      }
      if (!runtimePathRoot || !path.isAbsolute(runtimePathRoot)) {
        throw runtimePathError("AI_SESSION_RUNTIME_PATH_ROOT_UNAVAILABLE", "Runtime path attachments require an absolute AI session workspace.");
      }
      const canonicalRoot = canonicalRuntimePath(runtimePathRoot, "AI_SESSION_RUNTIME_PATH_ROOT_NOT_FOUND", "AI session workspace does not exist");
      if (!fs.statSync(canonicalRoot).isDirectory()) {
        throw runtimePathError("AI_SESSION_RUNTIME_PATH_ROOT_INVALID", `AI session workspace is not a directory: ${runtimePathRoot}`);
      }
      const canonicalPath = canonicalRuntimePath(attachment.source.path, "AI_SESSION_RUNTIME_PATH_NOT_FOUND", "Runtime attachment path does not exist");
      const relative = path.relative(canonicalRoot, canonicalPath);
      if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        throw runtimePathError("AI_SESSION_RUNTIME_PATH_OUTSIDE_WORKSPACE", `Runtime attachment path is outside the AI session workspace: ${attachment.source.path}`);
      }
      const stat = fs.statSync(canonicalPath);
      if (!stat.isFile()) {
        throw runtimePathError("AI_SESSION_RUNTIME_PATH_NOT_FILE", `Runtime attachment path is not a file: ${attachment.source.path}`);
      }
      return { ...attachment, size: stat.size, path: canonicalPath };
    }
    const ext = IMAGE_MIME_EXTENSIONS[attachment.mime.toLowerCase()] || path.extname(attachment.name) || ".img";
    const fileName = `${attachment.id}-${safeName(attachment.name).replace(/\.[^.]+$/, "")}${ext}`;
    const filePath = path.join(dir, fileName);
    fs.writeFileSync(filePath, Buffer.from(attachment.source.data, "base64"));
    return { ...attachment, path: filePath };
  });
}

export async function withAttachmentPathFallback<T>(
  message: string,
  attachments: AiSessionMessageAttachment[] = [],
  runtimePathRoot: string | undefined,
  run: (message: string) => Promise<T>,
) {
  const files = materializeAiSessionAttachments(attachments, runtimePathRoot);
  if (!files.length) {
    return run(message);
  }
  return run(appendAttachmentPaths(message, files));
}

export function prepareCodexAiSessionAttachments(
  message: string,
  attachments: AiSessionMessageAttachment[] = [],
  runtimePathRoot?: string,
): { message: string; inputs: CodexAttachmentInput[] } {
  const inputs: CodexAttachmentInput[] = [];
  const files: ReturnType<typeof materializeAiSessionAttachments> = [];
  for (const attachment of attachments) {
    const isSmallInlineImage = attachment.kind === "image"
      && attachment.source.type === "inline"
      && Buffer.byteLength(attachment.source.data, "base64") <= AI_SESSION_MAX_INLINE_FILE_BYTES;
    if (isSmallInlineImage && attachment.source.type === "inline") {
      inputs.push({ type: "image", url: `data:${attachment.mime};base64,${attachment.source.data}` });
      continue;
    }
    const materialized = materializeAiSessionAttachments([attachment], runtimePathRoot)[0];
    if (attachment.kind === "image") {
      inputs.push({ type: "localImage", path: materialized.path });
    } else {
      files.push(materialized);
    }
  }
  return { message: appendAttachmentPaths(message, files), inputs };
}

function appendAttachmentPaths(
  message: string,
  files: ReturnType<typeof materializeAiSessionAttachments>,
) {
  if (!files.length) return message;
  const kindCounts = files.reduce((counts, attachment) => ({ ...counts, [attachment.kind]: (counts[attachment.kind] || 0) + 1 }), {} as Record<"image" | "file", number>);
  const kindIndexes = { image: 0, file: 0 };
  const lines = files.map((attachment) => {
    kindIndexes[attachment.kind] += 1;
    const label = attachment.kind === "image" ? "图片" : "文件";
    const index = kindCounts[attachment.kind] > 1 ? kindIndexes[attachment.kind] : "";
    return `${label}${index}路径：${attachment.path}`;
  });
  return [message.trim(), lines.join("\n")].filter(Boolean).join("\n\n");
}

function runtimePathError(code: string, message: string) {
  return Object.assign(new Error(message), { statusCode: 400, code });
}

function canonicalRuntimePath(value: string, code: string, message: string) {
  try {
    return fs.realpathSync(value);
  } catch {
    throw runtimePathError(code, `${message}: ${value}`);
  }
}
