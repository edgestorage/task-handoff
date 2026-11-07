import { fireEvent, render, waitFor } from '@testing-library/react-native';
import { SafeAreaInsetsContext } from 'react-native-safe-area-context';
import type { ControlPlaneClient } from '@task-handoff/control-plane-client';
import { ControlPlaneAiSessionSummarySchema } from '@task-handoff/control-plane-client';
import { AiSessionTimelineItemSchema } from '@task-handoff/protocol/ai-sessions';

import { AttachmentImage } from '../src/ai-sessions/AttachmentImage';
import { MessageAttachments, SessionAttachmentContext } from '../src/ai-sessions/MessageAttachments';
import { conversationDetailItems, detailItems } from '../src/ai-sessions/SessionDetail';
import { uploadMobileAttachment, uploadingMobileAttachment } from '../src/ai-sessions/attachments';

const mockCreate = jest.fn();
const mockWrite = jest.fn();
const mockDelete = jest.fn();
jest.mock('expo-file-system', () => ({
  File: jest.fn().mockImplementation(() => ({ uri: 'file:///cache/preview.png', create: mockCreate, write: mockWrite, delete: mockDelete })),
  Paths: { cache: 'file:///cache/' },
}));

const photo = { id: 'att/photo', kind: 'image' as const, name: 'photo.png', mime: 'image/png', size: 20, contentState: 'available' as const };
const insets = { top: 40, bottom: 34, left: 0, right: 0 };
beforeEach(() => jest.clearAllMocks());

test('local thumbnails open an accessible full-screen preview and can zoom and close', async () => {
  const screen = await render(<SafeAreaInsetsContext.Provider value={insets}><AttachmentImage name="photo.png" uri="file:///cache/photo.png" /></SafeAreaInsetsContext.Provider>);
  expect(screen.getByTestId('attachment-image-thumbnail').props.source).toEqual({ uri: 'file:///cache/photo.png' });
  await fireEvent.press(screen.getByRole('button', { name: 'Preview photo.png' }));
  expect(Boolean(screen.getByRole('button', { name: 'Close' }))).toBe(true);
  expect(screen.getByRole('button', { name: 'Zoom out' })).toBeDisabled();
  const initialWidth = screen.getByTestId('attachment-image-preview').props.style.width;
  await fireEvent.press(screen.getByRole('button', { name: 'Zoom in' }));
  expect(screen.getByTestId('attachment-image-preview').props.style.width).toBe(initialWidth * 1.5);
  await fireEvent.press(screen.getByRole('button', { name: 'Close' }));
  expect(screen.queryByRole('button', { name: 'Close' })).toBeNull();
});

test('remote content uses authoritative message identity, retries failures and releases its cache copy', async () => {
  const attachmentContent = jest.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue({ body: new Uint8Array([1, 2, 3]) });
  const client = { aiSessions: { attachmentContent } } as unknown as ControlPlaneClient;
  const screen = await render(<SessionAttachmentContext.Provider value={{ client, instanceId: 'instance/1', sessionId: 'session/1' }}><MessageAttachments messageId="message/1" attachments={[photo]} /></SessionAttachmentContext.Provider>);
  await waitFor(() => expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy());
  await fireEvent.press(screen.getByRole('button', { name: 'Retry' }));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Preview photo.png' })).toBeTruthy());
  expect(attachmentContent).toHaveBeenLastCalledWith('instance/1', 'session/1', 'message/1', 'att/photo');
  expect(mockWrite).toHaveBeenCalledWith(new Uint8Array([1, 2, 3]));
  await screen.unmount();
  expect(mockDelete).toHaveBeenCalledTimes(1);
});

test('an unmounted remote image never materializes a late response', async () => {
  let resolve!: (value: { body: Uint8Array }) => void;
  const attachmentContent = jest.fn().mockImplementation(() => new Promise((done) => { resolve = done; }));
  const client = { aiSessions: { attachmentContent } } as unknown as ControlPlaneClient;
  const screen = await render(<SessionAttachmentContext.Provider value={{ client, instanceId: 'i', sessionId: 's' }}><MessageAttachments messageId="m" attachments={[photo]} /></SessionAttachmentContext.Provider>);
  await screen.unmount();
  resolve({ body: new Uint8Array([1]) });
  await Promise.resolve();
  expect(mockCreate).not.toHaveBeenCalled();
});

test('missing and expired images remain visible without trying to fetch unavailable content', async () => {
  const attachmentContent = jest.fn();
  const client = { aiSessions: { attachmentContent } } as unknown as ControlPlaneClient;
  const screen = await render(<SessionAttachmentContext.Provider value={{ client, instanceId: 'i', sessionId: 's' }}><MessageAttachments messageId="m" attachments={[{ ...photo, contentState: 'missing' }, { ...photo, id: 'expired', contentState: 'expired' }]} /></SessionAttachmentContext.Provider>);
  expect(screen.getByText('Attachment unavailable')).toBeTruthy();
  expect(screen.getByText('Attachment expired')).toBeTruthy();
  expect(attachmentContent).not.toHaveBeenCalled();
});

test('attachment-only timeline messages preserve attachment identity in both detail modes', () => {
  const turn = { id: 'turn', status: 'completed', phase: 'unknown', startedAt: '2026-11-07T00:00:00Z', updatedAt: '2026-11-07T00:00:01Z', revision: 1 };
  const session = ControlPlaneAiSessionSummarySchema.parse({ id: 'session', agent: 'codex', status: 'idle', turns: [turn], startedAt: turn.startedAt, updatedAt: turn.updatedAt });
  const item = AiSessionTimelineItemSchema.parse({ id: 'original-message', turnId: 'turn', type: 'user-message', text: '', attachments: [photo] });
  const timelines = { turn: { status: 'ready' as const, items: [item] } };
  for (const items of [detailItems(session, [], 0, undefined, timelines), conversationDetailItems(session, [], undefined, timelines)]) {
    expect(items.find((entry) => entry.role === 'user')).toMatchObject({ messageId: 'original-message', text: '', attachments: [photo] });
  }
});

test('pasted images keep their local preview through upload while ordinary temporary uploads are released', async () => {
  const uploadAttachment = jest.fn().mockResolvedValue({ ...photo, id: 'uploaded' });
  const client = { aiSessions: { uploadAttachment } } as unknown as ControlPlaneClient;
  const local = { uri: 'file:///cache/pasted.png', name: 'pasted.png', mime: 'image/png', kind: 'image' as const, size: 20, temporary: true };
  const removeTemporary = jest.fn();
  const readChunks = async function* () { yield new Uint8Array(20); };
  expect(uploadingMobileAttachment(local).previewUri).toBe(local.uri);
  const uploaded = await uploadMobileAttachment(client, { instanceId: 'i', sessionId: 's' }, local, { readChunks, removeTemporary, retainImagePreview: true });
  expect(uploaded).toMatchObject({ phase: 'uploaded', previewUri: local.uri, previewTemporary: true });
  expect(removeTemporary).not.toHaveBeenCalled();
  await uploadMobileAttachment(client, { instanceId: 'i', sessionId: 's' }, local, { readChunks, removeTemporary });
  expect(removeTemporary).toHaveBeenCalledWith(local.uri);
});
