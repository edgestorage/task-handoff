import * as Crypto from 'expo-crypto';
import { File, Paths } from 'expo-file-system';
import {
  classifyAiSessionPastedText,
  type AiSessionPastedTextPresentation,
  type ControlPlaneClient,
} from '@task-handoff/control-plane-client';
import {
  AI_SESSION_MAX_ATTACHMENT_BYTES,
  AI_SESSION_MAX_INLINE_FILE_BYTES,
  type AiSessionMessageAttachmentRef,
  type AiSessionMentionCandidate,
} from '@task-handoff/protocol/ai-sessions';

import type { MobileLocalFile } from '../platform/file-picker';

const IMAGE_MIMES = new Set(['image/bmp', 'image/gif', 'image/jpeg', 'image/png', 'image/webp']);
const FILE_MIMES = new Set(['application/json', 'application/pdf', 'application/zip', 'application/octet-stream']);

export function formatMobileAttachmentBytes(value: number, locale: string) {
  const units = ['B', 'KiB', 'MiB'];
  let amount = Math.max(0, value);
  let unit = 0;
  while (amount >= 1024 && unit < units.length - 1) {
    amount /= 1024;
    unit += 1;
  }
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: amount >= 10 || unit === 0 ? 0 : 1 }).format(amount)} ${units[unit]}`;
}

export function formatMobileTextLength(value: number, locale: string) {
  return new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(value);
}

export type MobilePendingAttachment = {
  localId: string;
  kind: 'image' | 'file';
  name: string;
  mime: string;
  size: number;
  phase: 'selected' | 'uploading' | 'uploaded' | 'expired' | 'result-unknown' | 'failed';
  uploadRef?: AiSessionMessageAttachmentRef;
  expiresAt?: string;
  error?: string;
  textPresentation?: AiSessionPastedTextPresentation;
  retryLocal?: MobileLocalFile;
};

const PASTED_IMAGE_MIMES: Record<string, string> = {
  bmp: 'image/bmp',
  gif: 'image/gif',
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
};

export function mobilePastedImage(uri: string): MobileLocalFile {
  if (!uri.startsWith('file:')) throw attachmentError('ATTACHMENT_CLIPBOARD_INVALID', 'The pasted image is not a local file.');
  const file = new File(uri);
  const info = file.info();
  const extension = file.extension.replace(/^\./, '').toLowerCase();
  return {
    kind: 'image',
    mime: PASTED_IMAGE_MIMES[extension],
    name: file.name || `pasted-image.${extension || 'png'}`,
    size: info.size,
    temporary: true,
    uri,
  };
}

export function mobilePastedText(text: string, sequence: number): MobileLocalFile {
  const decision = classifyAiSessionPastedText(text, sequence);
  if (decision.disposition !== 'attachment') {
    throw attachmentError(
      decision.disposition === 'rejected' ? 'ATTACHMENT_TOO_LARGE' : 'ATTACHMENT_TEXT_NOT_LONG',
      decision.disposition === 'rejected' ? 'The pasted text must be smaller than 500 KiB.' : 'The pasted text does not need an attachment.',
    );
  }
  const file = new File(Paths.cache, `ai-session-paste-${Crypto.randomUUID()}.txt`);
  file.create();
  file.write(decision.file.text);
  return {
    kind: 'file',
    mime: decision.file.mime,
    name: decision.file.name,
    size: file.info().size,
    temporary: true,
    textPresentation: decision.file.presentation,
    uri: file.uri,
  };
}

export function validateMobileLocalFile(file: MobileLocalFile) {
  if (!file.size || file.size < 1) throw attachmentError('ATTACHMENT_SIZE_UNKNOWN', 'The selected file has no readable content or size.');
  const mime = (file.mime || '').toLowerCase();
  if (file.kind === 'image' && !IMAGE_MIMES.has(mime)) throw attachmentError('ATTACHMENT_MIME_UNSUPPORTED', 'Choose a BMP, GIF, JPEG, PNG, or WebP image.');
  if (file.kind === 'file' && !(mime.startsWith('text/') || FILE_MIMES.has(mime))) throw attachmentError('ATTACHMENT_MIME_UNSUPPORTED', 'This file type is not supported for mobile upload.');
  const tooLarge = file.kind === 'image' ? file.size > AI_SESSION_MAX_ATTACHMENT_BYTES : file.size >= AI_SESSION_MAX_INLINE_FILE_BYTES;
  if (tooLarge) throw attachmentError('ATTACHMENT_TOO_LARGE', file.kind === 'image' ? `Images may be at most ${AI_SESSION_MAX_ATTACHMENT_BYTES} bytes.` : `Files must be smaller than ${AI_SESSION_MAX_INLINE_FILE_BYTES} bytes.`);
  return { ...file, mime, size: file.size } as MobileLocalFile & { mime: string; size: number };
}

export async function uploadMobileAttachment(
  client: ControlPlaneClient,
  identity: { instanceId: string; sessionId: string },
  local: MobileLocalFile,
  options: { readBase64?(uri: string): Promise<string>; removeTemporary?(uri: string): Promise<void> | void; now?: number } = {},
): Promise<MobilePendingAttachment> {
  const file = validateMobileLocalFile(local);
  const localId = `${file.kind}:${file.name}:${file.size}`;
  let completed = false;
  try {
    const data = await (options.readBase64 ? options.readBase64(file.uri) : new File(file.uri).base64());
    const uploaded = await client.aiSessions.uploadAttachment({ ...identity, kind: file.kind, name: file.name, mime: file.mime, data });
    if (uploaded.expiresAt && Date.parse(uploaded.expiresAt) <= (options.now ?? Date.now())) throw attachmentError('ATTACHMENT_EXPIRED', 'The uploaded attachment expired before it could be used.');
    completed = true;
    return {
      localId, kind: uploaded.kind, name: uploaded.name, mime: uploaded.mime, size: uploaded.size,
      phase: 'uploaded', expiresAt: uploaded.expiresAt,
      textPresentation: file.textPresentation,
      uploadRef: { id: uploaded.id, kind: uploaded.kind, source: { type: 'upload-ref' } },
    };
  } catch (cause) {
    const uncertain = cause && typeof cause === 'object' && ((cause as { retryable?: unknown }).retryable === true || (cause as { code?: unknown }).code === 'DIRECT_NETWORK_FAILED');
    return { localId, kind: file.kind, name: file.name, mime: file.mime, size: file.size, phase: uncertain ? 'result-unknown' : 'failed', error: uncertain ? 'Upload result unknown. Retry this attachment before sending.' : cause instanceof Error ? cause.message : 'Upload failed.', retryLocal: file, textPresentation: file.textPresentation };
  } finally {
    if (completed && file.temporary) {
      try {
        if (options.removeTemporary) await options.removeTemporary(file.uri);
        else new File(file.uri).delete();
      } catch {
        // The upload ref is already independent from the device cache copy.
      }
    }
  }
}

export function usableUploadRefs(attachments: readonly MobilePendingAttachment[], now = Date.now()) {
  return attachments.map((attachment) => {
    if (attachment.phase !== 'uploaded' || !attachment.uploadRef) throw attachmentError('ATTACHMENT_NOT_READY', `${attachment.name} is not ready to send.`);
    if (attachment.expiresAt && Date.parse(attachment.expiresAt) <= now) throw attachmentError('ATTACHMENT_EXPIRED', `${attachment.name} expired. Upload it again.`);
    return attachment.uploadRef;
  });
}

export function runtimeAttachmentFromServerCandidate(candidate: AiSessionMentionCandidate, cwd: string): AiSessionMessageAttachmentRef {
  if (candidate.kind !== 'file' || candidate.path.startsWith('/') || candidate.path.split(/[\\/]+/).includes('..')) throw attachmentError('RUNTIME_ATTACHMENT_INVALID', 'Only a server-selected file inside the session workspace can be attached.');
  const root = cwd.replace(/[\\/]+$/, '');
  if (!root.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(root)) throw attachmentError('RUNTIME_ATTACHMENT_CWD_INVALID', 'The session cwd is not an absolute runtime path.');
  return {
    id: `runtime:${candidate.path}`,
    kind: 'file',
    name: candidate.name,
    mime: 'application/octet-stream',
    size: 0,
    source: { type: 'runtime-path', path: `${root}/${candidate.path.replace(/\\/g, '/')}` },
  };
}

function attachmentError(code: string, message: string) { return Object.assign(new Error(message), { code }); }
