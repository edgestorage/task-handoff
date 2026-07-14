import fs from "node:fs";
import path from "node:path";

const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".tif", ".tiff", ".heic", ".heif"]);
const MAX_ATTACHMENTS = 20;

type AttachmentKind = "image" | "file";

type SenderAttachment = {
  id: string;
  kind: AttachmentKind;
  path: string;
  name: string;
  mime?: string;
  size?: number;
};

type AttachmentInput = {
  kind: AttachmentKind;
  path: string;
};

function mimeForPath(filePath: string) {
  const ext = path.extname(filePath).toLowerCase();
  const table: Record<string, string> = {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".bmp": "image/bmp",
    ".tif": "image/tiff",
    ".tiff": "image/tiff",
    ".heic": "image/heic",
    ".heif": "image/heif",
    ".pdf": "application/pdf",
    ".txt": "text/plain",
    ".md": "text/markdown",
    ".json": "application/json",
    ".csv": "text/csv",
    ".zip": "application/zip",
  };
  return table[ext];
}

function normalizeAttachmentInputs(inputs: AttachmentInput[] = [], cwd = process.cwd()) {
  if (inputs.length > MAX_ATTACHMENTS) {
    throw new Error(`Too many attachments. Maximum is ${MAX_ATTACHMENTS}.`);
  }
  return inputs.map((input, index): SenderAttachment => {
    const rawPath = String(input.path || "").trim();
    if (!rawPath) {
      throw new Error("Attachment path cannot be empty.");
    }
    const absolutePath = path.resolve(cwd, rawPath);
    const stat = fs.statSync(absolutePath);
    if (!stat.isFile()) {
      throw new Error(`Attachment is not a file: ${absolutePath}`);
    }
    const ext = path.extname(absolutePath).toLowerCase();
    if (input.kind === "image" && !IMAGE_EXTENSIONS.has(ext)) {
      throw new Error(`Image attachment has unsupported extension: ${absolutePath}`);
    }
    return {
      id: String(index + 1),
      kind: input.kind,
      path: absolutePath,
      name: path.basename(absolutePath),
      mime: mimeForPath(absolutePath),
      size: stat.size,
    };
  });
}

function attachmentLabel(attachment: Pick<SenderAttachment, "kind" | "name">) {
  return `${attachment.kind === "image" ? "发送图片" : "发送文件"} ${attachment.name}`;
}

function formatAttachmentSize(size: unknown) {
  const value = Number(size);
  if (!Number.isFinite(value) || value < 0) {
    return "";
  }
  if (value < 1024) {
    return `${value}B`;
  }
  if (value < 1024 * 1024) {
    return `${(value / 1024).toFixed(value < 10 * 1024 ? 1 : 0)}KB`;
  }
  return `${(value / (1024 * 1024)).toFixed(value < 10 * 1024 * 1024 ? 1 : 0)}MB`;
}

function renderAttachmentSummary(attachments: SenderAttachment[] = []) {
  if (attachments.length === 0) {
    return "";
  }
  const lines = [`附件：${attachments.length} 个`];
  for (const attachment of attachments) {
    const size = formatAttachmentSize(attachment.size);
    lines.push(`[${attachment.kind}] ${attachment.name}${size ? ` (${size})` : ""}`);
  }
  return lines.join("\n");
}

function findAttachment(attachments: SenderAttachment[] | undefined, attachmentId: unknown) {
  const id = String(attachmentId || "").trim();
  return (attachments || []).find((attachment) => attachment.id === id);
}

export {
  attachmentLabel,
  findAttachment,
  formatAttachmentSize,
  normalizeAttachmentInputs,
  renderAttachmentSummary,
};

export type { AttachmentInput, AttachmentKind, SenderAttachment };
