import type { ControlPlaneClient } from '@task-handoff/control-plane-client';

import { runtimeAttachmentFromServerCandidate, uploadMobileAttachment, usableUploadRefs, validateMobileLocalFile } from '../src/ai-sessions/attachments';

test('validates image/file MIME and size before reading device content', () => {
  expect(validateMobileLocalFile({ uri: 'file:///cache/a.png', name: 'a.png', mime: 'image/png', size: 10, kind: 'image' }).mime).toBe('image/png');
  expect(() => validateMobileLocalFile({ uri: 'file:///cache/a.svg', name: 'a.svg', mime: 'image/svg+xml', size: 10, kind: 'image' })).toThrow(/Choose a BMP/);
  expect(() => validateMobileLocalFile({ uri: 'file:///cache/a.bin', name: 'a.bin', mime: undefined, size: undefined, kind: 'file' })).toThrow(/readable content or size/);
});

test('uploads only base64 and scoped business identity, never the device URI', async () => {
  const uploadAttachment = jest.fn().mockResolvedValue({ id: 'att-1', kind: 'file', name: 'note.txt', mime: 'text/plain', size: 5, expiresAt: '2026-08-06T00:00:00.000Z' });
  const client = { aiSessions: { uploadAttachment } } as unknown as ControlPlaneClient;
  const attachment = await uploadMobileAttachment(client, { instanceId: 'instance-1', sessionId: 'session-1' }, { uri: 'file:///private/device-note', name: 'note.txt', mime: 'text/plain', size: 5, kind: 'file' }, { readBase64: async () => 'aGVsbG8=', now: Date.parse('2026-08-05T00:00:00.000Z') });
  expect(uploadAttachment).toHaveBeenCalledWith({ instanceId: 'instance-1', sessionId: 'session-1', kind: 'file', name: 'note.txt', mime: 'text/plain', data: 'aGVsbG8=' });
  expect(JSON.stringify(uploadAttachment.mock.calls)).not.toContain('device-note');
  expect(usableUploadRefs([attachment], Date.parse('2026-08-05T00:00:00.000Z'))).toEqual([{ id: 'att-1', kind: 'file', source: { type: 'upload-ref' } }]);
  expect(() => usableUploadRefs([attachment], Date.parse('2026-08-07T00:00:00.000Z'))).toThrow(/expired/);
});

test('removes an explicit system-picker cache copy after upload without touching durable device assets', async () => {
  const uploadAttachment = jest.fn().mockResolvedValue({ id: 'att-1', kind: 'file', name: 'note.txt', mime: 'text/plain', size: 5, expiresAt: '2026-08-06T00:00:00.000Z' });
  const removeTemporary = jest.fn();
  const client = { aiSessions: { uploadAttachment } } as unknown as ControlPlaneClient;
  await uploadMobileAttachment(client, { instanceId: 'instance-1', sessionId: 'session-1' }, { uri: 'file:///cache/copied-note', name: 'note.txt', mime: 'text/plain', size: 5, kind: 'file', temporary: true }, { readBase64: async () => 'aGVsbG8=', removeTemporary });
  expect(removeTemporary).toHaveBeenCalledWith('file:///cache/copied-note');
  removeTemporary.mockClear();
  await uploadMobileAttachment(client, { instanceId: 'instance-1', sessionId: 'session-1' }, { uri: 'file:///library/photo.png', name: 'photo.png', mime: 'image/png', size: 5, kind: 'image', temporary: false }, { readBase64: async () => 'aGVsbG8=', removeTemporary });
  expect(removeTemporary).not.toHaveBeenCalled();
});

test('network-unknown upload is not converted into a reusable ref', async () => {
  const uploadAttachment = jest.fn().mockRejectedValue(Object.assign(new Error('lost'), { code: 'DIRECT_NETWORK_FAILED', retryable: true }));
  const client = { aiSessions: { uploadAttachment } } as unknown as ControlPlaneClient;
  const attachment = await uploadMobileAttachment(client, { instanceId: 'instance-1', sessionId: 'session-1' }, { uri: 'file:///cache/note', name: 'note.txt', mime: 'text/plain', size: 5, kind: 'file' }, { readBase64: async () => 'aGVsbG8=' });
  expect(attachment.phase).toBe('result-unknown');
  expect(attachment.uploadRef).toBeUndefined();
  expect(uploadAttachment).toHaveBeenCalledTimes(1);
});

test('runtime attachments can only originate from server file candidates under the absolute session cwd', () => {
  expect(runtimeAttachmentFromServerCandidate({ kind: 'file', name: 'a.txt', path: 'src/a.txt' }, '/workspace/project')).toMatchObject({ source: { type: 'runtime-path', path: '/workspace/project/src/a.txt' } });
  expect(() => runtimeAttachmentFromServerCandidate({ kind: 'file', name: 'a.txt', path: '../a.txt' }, '/workspace/project')).toThrow(/server-selected/);
  expect(() => runtimeAttachmentFromServerCandidate({ kind: 'file', name: 'a.txt', path: 'a.txt' }, 'file:///device')).toThrow(/absolute runtime path/);
});
