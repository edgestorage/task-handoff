import { File } from 'expo-file-system';
import type { ControlPlaneClient } from '@task-handoff/control-plane-client';
import {
  AI_SESSION_MAX_ATTACHMENT_BYTES,
  AI_SESSION_MAX_INLINE_FILE_BYTES,
  type AiSessionMessageAttachmentRef,
  type AiSessionMentionCandidate,
} from '@task-handoff/protocol/ai-sessions';

import type { MobileLocalFile } from '../platform/file-picker';

const IMAGE_MIMES = new Set(['image/bmp', 'image/gif', 'image/jpeg', 'image/png', 'image/webp']);
const FILE_MIMES = new Set(['application/json', 'application/pdf', 'application/zip', 'application/octet-stream']);

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
};

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
  try {
    const data = await (options.readBase64 ? options.readBase64(file.uri) : new File(file.uri).base64());
    const uploaded = await client.aiSessions.uploadAttachment({ ...identity, kind: file.kind, name: file.name, mime: file.mime, data });
    if (uploaded.expiresAt && Date.parse(uploaded.expiresAt) <= (options.now ?? Date.now())) throw attachmentError('ATTACHMENT_EXPIRED', 'The uploaded attachment expired before it could be used.');
    return {
      localId, kind: uploaded.kind, name: uploaded.name, mime: uploaded.mime, size: uploaded.size,
      phase: 'uploaded', expiresAt: uploaded.expiresAt,
      uploadRef: { id: uploaded.id, kind: uploaded.kind, source: { type: 'upload-ref' } },
    };
  } catch (cause) {
    const uncertain = cause && typeof cause === 'object' && ((cause as { retryable?: unknown }).retryable === true || (cause as { code?: unknown }).code === 'DIRECT_NETWORK_FAILED');
    return { localId, kind: file.kind, name: file.name, mime: file.mime, size: file.size, phase: uncertain ? 'result-unknown' : 'failed', error: uncertain ? 'Upload result unknown. Select the file again; the client will not reuse or resend this upload.' : cause instanceof Error ? cause.message : 'Upload failed.' };
  } finally {
    if (file.temporary) {
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
