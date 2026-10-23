import type { ControlPlaneClient } from '@task-handoff/control-plane-client';
import { File, FileMode } from 'expo-file-system';

import { mobileFileChunks, runtimeAttachmentFromServerCandidate, uploadMobileAttachment, usableUploadRefs, validateMobileLocalFile } from '../src/ai-sessions/attachments';
import { diagnosticLog } from '../src/observability/diagnostic-logs';

function chunkReader(...chunks: Uint8Array[]) {
  return () => (async function* () {
    for (const chunk of chunks) yield chunk;
  })();
}

test('validates image/file MIME and size before reading device content', () => {
  expect(validateMobileLocalFile({ uri: 'file:///cache/a.png', name: 'a.png', mime: 'image/png', size: 10, kind: 'image' }).mime).toBe('image/png');
  expect(validateMobileLocalFile({ uri: 'file:///cache/a.png', name: 'a.png', mime: 'application/octet-stream', size: 10, kind: 'image' }).mime).toBe('image/png');
  expect(validateMobileLocalFile({ uri: 'file:///cache/a.docx', name: 'a.docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', size: 10, kind: 'file' }).mime).toBe('application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  expect(validateMobileLocalFile({ uri: 'file:///cache/a.unknown', name: 'a.unknown', mime: undefined, size: 10, kind: 'file' }).mime).toBe('application/octet-stream');
  expect(() => validateMobileLocalFile({ uri: 'file:///cache/a.svg', name: 'a.svg', mime: 'image/svg+xml', size: 10, kind: 'image' })).toThrow(/Choose a BMP/);
  expect(() => validateMobileLocalFile({ uri: 'file:///cache/a.bin', name: 'a.bin', mime: undefined, size: undefined, kind: 'file' })).toThrow(/readable content or size/);
});

test('uses the instance-specific ordinary file size limit', () => {
  const file = { uri: 'file:///cache/large.txt', name: 'large.txt', mime: 'text/plain', size: 700 * 1024, kind: 'file' as const };
  expect(() => validateMobileLocalFile(file)).toThrow(/smaller than 512000 bytes/);
  expect(validateMobileLocalFile(file, 1024 * 1024).size).toBe(700 * 1024);
  expect(() => validateMobileLocalFile({ ...file, size: 1024 * 1024 }, 1024 * 1024)).toThrow(/smaller than 1048576 bytes/);
});

test('reads local attachments through a bounded file handle', async () => {
  const content = new Uint8Array([1, 2, 3, 4, 5]);
  let offset = 0;
  const close = jest.fn();
  const open = jest.spyOn(File.prototype, 'open').mockReturnValue({
    size: content.byteLength,
    readBytes: (length: number) => {
      const chunk = content.slice(offset, offset + length);
      offset += chunk.byteLength;
      return chunk;
    },
    close,
  } as never);
  try {
    const chunks: number[] = [];
    for await (const chunk of mobileFileChunks('file:///cache/note.bin', content.byteLength, 2)) chunks.push(chunk.byteLength);
    expect(open).toHaveBeenCalledWith(FileMode.ReadOnly);
    expect(chunks).toEqual([2, 2, 1]);
    expect(close).toHaveBeenCalledTimes(1);
  } finally {
    open.mockRestore();
  }
});

test('uploads only file bytes and scoped business identity, never the device URI', async () => {
  const uploadAttachment = jest.fn().mockResolvedValue({ id: 'att-1', kind: 'file', name: 'note.txt', mime: 'text/plain', size: 5, expiresAt: '2026-08-06T00:00:00.000Z' });
  const client = { aiSessions: { uploadAttachment } } as unknown as ControlPlaneClient;
  const bytes = new Uint8Array([104, 101, 108, 108, 111]);
  const attachment = await uploadMobileAttachment(client, { instanceId: 'instance-1', sessionId: 'session-1' }, { uri: 'file:///private/device-note', name: 'note.txt', mime: 'text/plain', size: 5, kind: 'file' }, { readChunks: chunkReader(bytes), now: Date.parse('2026-08-05T00:00:00.000Z') });
  const input = uploadAttachment.mock.calls[0]![0] as { size: number; chunks: AsyncIterable<Uint8Array>; bytes?: unknown; data?: unknown };
  expect(input).toMatchObject({ instanceId: 'instance-1', sessionId: 'session-1', kind: 'file', name: 'note.txt', mime: 'text/plain', size: 5 });
  expect(input).not.toHaveProperty('data');
  expect(input).not.toHaveProperty('bytes');
  const streamed = [];
  for await (const chunk of input.chunks) streamed.push(...chunk);
  expect(streamed).toEqual([...bytes]);
  expect(JSON.stringify(uploadAttachment.mock.calls)).not.toContain('device-note');
  expect(usableUploadRefs([attachment], Date.parse('2026-08-05T00:00:00.000Z'))).toEqual([{ id: 'att-1', kind: 'file', source: { type: 'upload-ref' } }]);
  expect(() => usableUploadRefs([attachment], Date.parse('2026-08-07T00:00:00.000Z'))).toThrow(/expired/);
});

test('passes the create-request scope for attachments uploaded before a session exists', async () => {
  const uploadAttachment = jest.fn().mockResolvedValue({ id: 'att-1', kind: 'file', name: 'note.txt', mime: 'text/plain', size: 5 });
  const client = { aiSessions: { uploadAttachment } } as unknown as ControlPlaneClient;
  await uploadMobileAttachment(
    client,
    { instanceId: 'instance-1', sessionId: 'create-request-1', scopeType: 'create-request' },
    { uri: 'file:///private/device-note', name: 'note.txt', mime: 'text/plain', size: 5, kind: 'file' },
    { readChunks: chunkReader(new Uint8Array([104, 101, 108, 108, 111])) },
  );
  expect(uploadAttachment).toHaveBeenCalledWith(expect.objectContaining({
    instanceId: 'instance-1',
    sessionId: 'create-request-1',
    scopeType: 'create-request',
  }), undefined);
});

test('removes an explicit system-picker cache copy after upload without touching durable device assets', async () => {
  const uploadAttachment = jest.fn().mockResolvedValue({ id: 'att-1', kind: 'file', name: 'note.txt', mime: 'text/plain', size: 5, expiresAt: '2026-08-06T00:00:00.000Z' });
  const removeTemporary = jest.fn();
  const client = { aiSessions: { uploadAttachment } } as unknown as ControlPlaneClient;
  await uploadMobileAttachment(client, { instanceId: 'instance-1', sessionId: 'session-1' }, { uri: 'file:///cache/copied-note', name: 'note.txt', mime: 'text/plain', size: 5, kind: 'file', temporary: true }, { readChunks: chunkReader(new Uint8Array([104, 101, 108, 108, 111])), removeTemporary, now: Date.parse('2026-08-05T00:00:00.000Z') });
  expect(removeTemporary).toHaveBeenCalledWith('file:///cache/copied-note');
  removeTemporary.mockClear();
  await uploadMobileAttachment(client, { instanceId: 'instance-1', sessionId: 'session-1' }, { uri: 'file:///library/photo.png', name: 'photo.png', mime: 'image/png', size: 5, kind: 'image', temporary: false }, { readChunks: chunkReader(new Uint8Array([104, 101, 108, 108, 111])), removeTemporary, now: Date.parse('2026-08-05T00:00:00.000Z') });
  expect(removeTemporary).not.toHaveBeenCalled();
});

test('network-unknown upload is not converted into a reusable ref', async () => {
  const uploadAttachment = jest.fn().mockRejectedValue(Object.assign(new Error('lost'), { code: 'DIRECT_NETWORK_FAILED', retryable: true }));
  const client = { aiSessions: { uploadAttachment } } as unknown as ControlPlaneClient;
  const attachment = await uploadMobileAttachment(client, { instanceId: 'instance-1', sessionId: 'session-1' }, { uri: 'file:///cache/note', name: 'note.txt', mime: 'text/plain', size: 5, kind: 'file' }, { readChunks: chunkReader(new Uint8Array([104, 101, 108, 108, 111])) });
  expect(attachment.phase).toBe('result-unknown');
  expect(attachment.uploadRef).toBeUndefined();
  expect(uploadAttachment).toHaveBeenCalledTimes(1);
});

test('keeps a temporary generated file after a definite failure so the user can retry it', async () => {
  const uploadAttachment = jest.fn().mockRejectedValue(new Error('offline'));
  const removeTemporary = jest.fn();
  const client = { aiSessions: { uploadAttachment } } as unknown as ControlPlaneClient;
  const local = { uri: 'file:///cache/pasted-text-1.txt', name: 'pasted-text-1.txt', mime: 'text/plain', size: 10_001, kind: 'file' as const, temporary: true, textPresentation: { summary: 'hello', codePointLength: 10_001 } };
  const attachment = await uploadMobileAttachment(client, { instanceId: 'instance-1', sessionId: 'session-1' }, local, { readChunks: chunkReader(new Uint8Array([104, 101, 108, 108, 111])), removeTemporary });
  expect(attachment).toMatchObject({ phase: 'failed', retryLocal: local, textPresentation: local.textPresentation });
  expect(removeTemporary).not.toHaveBeenCalled();
});

test('upload diagnostics identify the failing phase without recording file names or content', async () => {
  const info = jest.spyOn(diagnosticLog, 'info').mockImplementation(() => undefined);
  const warn = jest.spyOn(diagnosticLog, 'warn').mockImplementation(() => undefined);
  try {
    const uploadAttachment = jest.fn().mockRejectedValue(Object.assign(new Error('File is too large.'), {
      code: 'AI_SESSION_ATTACHMENTS_TOO_LARGE',
      status: 413,
      retryable: false,
    }));
    const client = { aiSessions: { uploadAttachment } } as unknown as ControlPlaneClient;
    await uploadMobileAttachment(client, { instanceId: 'instance-1', sessionId: 'session-1' }, {
      uri: 'file:///private/secret-name.pdf',
      name: 'secret-name.pdf',
      mime: 'application/pdf',
      size: 238 * 1024,
      kind: 'file',
    }, { readChunks: chunkReader(new Uint8Array([104, 101, 108, 108, 111])) });

    expect(info).toHaveBeenCalledWith('attachment.upload.start', { kind: 'file', mime: 'application/pdf', size: 238 * 1024 });
    expect(warn).toHaveBeenCalledWith('attachment.upload.failed', expect.objectContaining({
      kind: 'file',
      size: 238 * 1024,
      phase: 'request',
      errorCode: 'AI_SESSION_ATTACHMENTS_TOO_LARGE',
      status: 413,
    }));
    expect(JSON.stringify([...info.mock.calls, ...warn.mock.calls])).not.toContain('secret-name.pdf');
    expect(JSON.stringify([...info.mock.calls, ...warn.mock.calls])).not.toContain('aGVsbG8=');
  } finally {
    info.mockRestore();
    warn.mockRestore();
  }
});

test('runtime attachments can only originate from server file candidates under the absolute session cwd', () => {
  expect(runtimeAttachmentFromServerCandidate({ kind: 'file', name: 'a.txt', path: 'src/a.txt' }, '/workspace/project')).toMatchObject({ source: { type: 'runtime-path', path: '/workspace/project/src/a.txt' } });
  expect(() => runtimeAttachmentFromServerCandidate({ kind: 'file', name: 'a.txt', path: '../a.txt' }, '/workspace/project')).toThrow(/server-selected/);
  expect(() => runtimeAttachmentFromServerCandidate({ kind: 'file', name: 'a.txt', path: 'a.txt' }, 'file:///device')).toThrow(/absolute runtime path/);
});
