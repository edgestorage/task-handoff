import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const TELEGRAM_IMAGE_DOWNLOAD_LIMIT_BYTES = 20 * 1024 * 1024;

type TelegramImageMessage = {
  text?: string;
  caption?: string;
  photo?: Array<{ file_id?: string; file_size?: number; width?: number; height?: number }>;
  document?: { file_id?: string; file_name?: string; mime_type?: string; file_size?: number };
};

type TelegramFileApi = {
  getFileLink: (fileId: string) => Promise<URL | string>;
  fetchFile?: typeof fetch;
};

type TelegramImageAttachment = {
  fileId: string;
  fileName?: string;
  fileSize?: number;
};

function telegramImageAttachments(message: TelegramImageMessage) {
  const attachments: TelegramImageAttachment[] = [];
  const photo = [...(message.photo || [])]
    .filter((item) => item.file_id)
    .sort((a, b) => Number(b.file_size || b.width || 0) - Number(a.file_size || a.width || 0))[0];
  if (photo?.file_id) {
    attachments.push({ fileId: photo.file_id, fileName: "telegram-photo.jpg", fileSize: photo.file_size });
  }
  if (message.document?.file_id && String(message.document.mime_type || "").startsWith("image/")) {
    attachments.push({ fileId: message.document.file_id, fileName: message.document.file_name, fileSize: message.document.file_size });
  }
  return attachments;
}

async function downloadTelegramFile(telegram: TelegramFileApi, fileId: string, fileName = "telegram-image", fileSize?: number) {
  if (fileSize && fileSize > TELEGRAM_IMAGE_DOWNLOAD_LIMIT_BYTES) {
    throw new Error(`image is too large: ${fileSize} bytes`);
  }
  const fileLink = await telegram.getFileLink(fileId);
  const url = String(fileLink);
  const response = await (telegram.fetchFile || fetch)(url);
  if (!response.ok) {
    throw new Error(`download failed with HTTP ${response.status}`);
  }
  const contentLength = Number(response.headers.get("content-length") || 0);
  if (contentLength > TELEGRAM_IMAGE_DOWNLOAD_LIMIT_BYTES) {
    throw new Error(`image is too large: ${contentLength} bytes`);
  }
  const fallbackExt = path.extname(fileName) || ".jpg";
  let ext = fallbackExt;
  try {
    ext = path.extname(new URL(url).pathname) || fallbackExt;
  } catch {
    ext = fallbackExt;
  }
  const dir = path.join(os.tmpdir(), "task-handoff-images");
  await fs.mkdir(dir, { recursive: true });
  const safeExt = ext.replace(/[^.\w-]/g, "") || ".jpg";
  const filePath = path.join(dir, `telegram-${Date.now()}-${Math.random().toString(16).slice(2)}${safeExt}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > TELEGRAM_IMAGE_DOWNLOAD_LIMIT_BYTES) {
    throw new Error(`image is too large: ${bytes.length} bytes`);
  }
  await fs.writeFile(filePath, bytes);
  return filePath;
}

function textWithTelegramImagePaths(text: string, imagePaths: string[]) {
  if (imagePaths.length === 0) {
    return text;
  }
  return [
    text.trim(),
    imagePaths.map((filePath, index) => `图片${imagePaths.length > 1 ? index + 1 : ""}路径：${filePath}`).join("\n"),
  ]
    .filter(Boolean)
    .join("\n\n");
}

export type { TelegramFileApi, TelegramImageAttachment, TelegramImageMessage };
export { downloadTelegramFile, telegramImageAttachments, textWithTelegramImagePaths };
