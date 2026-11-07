import 'react-native-gesture-handler/jestSetup';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import { DeviceEventEmitter, StyleSheet } from 'react-native';
import { State } from 'react-native-gesture-handler';
import { fireGestureHandler, getByGestureTestId } from 'react-native-gesture-handler/jest-utils';
import type { PinchGesture, PanGesture, TapGesture } from 'react-native-gesture-handler';
import { getAnimatedStyle } from 'react-native-reanimated';
import { SafeAreaInsetsContext } from 'react-native-safe-area-context';
import type { ControlPlaneClient } from '@task-handoff/control-plane-client';
import { ControlPlaneAiSessionSummarySchema } from '@task-handoff/control-plane-client';
import { AiSessionTimelineItemSchema, AiSessionTurnSchema } from '@task-handoff/protocol/ai-sessions';

import { AttachmentImage } from '../src/ai-sessions/AttachmentImage';
import { MessageAttachments, SessionAttachmentContext } from '../src/ai-sessions/MessageAttachments';
import { conversationDetailItems, detailItems, SessionDetail } from '../src/ai-sessions/SessionDetail';
import { uploadMobileAttachment, uploadingMobileAttachment } from '../src/ai-sessions/attachments';

const mockCreate = jest.fn();
const mockWrite = jest.fn();
const mockDelete = jest.fn();
jest.mock('@expo/ui/swift-ui', () => {
  const { createElement } = jest.requireActual<typeof import('react')>('react');
  const { Pressable, View } = jest.requireActual<typeof import('react-native')>('react-native');
  return {
    ...jest.requireActual('@expo/ui/swift-ui'),
    Host: ({ children }: { children: React.ReactNode }) => createElement(View, null, children),
    HStack: ({ children }: { children: React.ReactNode }) => createElement(View, null, children),
    Button: ({ label, systemImage, modifiers, onPress }: { label: string; systemImage: string; modifiers: { $type: string; disabled?: boolean }[]; onPress(): void }) => {
      const disabled = modifiers.some((modifier) => modifier.$type === 'disabled' && modifier.disabled);
      return createElement(Pressable, { accessibilityLabel: label, accessibilityRole: 'button', accessibilityState: { disabled }, disabled, onPress, testID: `native-preview-${systemImage}` });
    },
  };
});
jest.mock('expo-file-system', () => ({
  File: jest.fn().mockImplementation(() => ({ uri: 'file:///cache/preview.png', create: mockCreate, write: mockWrite, delete: mockDelete })),
  Paths: { cache: 'file:///cache/' },
}));

const photo = { id: 'att/photo', kind: 'image' as const, name: 'photo.png', mime: 'image/png', size: 20, contentState: 'available' as const };
const insets = { top: 40, bottom: 34, left: 0, right: 0 };
beforeEach(() => jest.clearAllMocks());

async function openLoadedPreview() {
  const screen = await render(<SafeAreaInsetsContext.Provider value={insets}><AttachmentImage name="photo.png" uri="file:///cache/photo.png" /></SafeAreaInsetsContext.Provider>);
  await fireEvent.press(screen.getByRole('button', { name: 'Preview photo.png' }));
  const { width, height } = StyleSheet.flatten(screen.getByTestId('attachment-image-preview').props.style);
  await fireEvent(screen.getByTestId('attachment-image-preview'), 'load', { nativeEvent: { source: { width, height } } });
  return { screen, width: width as number, height: height as number };
}

async function pinchPreview(scale: number, x: number, y: number) {
  await act(async () => fireGestureHandler<PinchGesture>(getByGestureTestId('attachment-image-pinch'), [
    { state: State.BEGAN, scale: 1, focalX: x, focalY: y },
    { state: State.ACTIVE, scale: 1, focalX: x, focalY: y },
    { state: State.ACTIVE, scale, focalX: x, focalY: y },
    { state: State.END, scale, focalX: x, focalY: y },
  ]));
}

async function dragPreview(x: number, y: number) {
  await act(async () => fireGestureHandler<PanGesture>(getByGestureTestId('attachment-image-pan'), [
    { state: State.BEGAN, translationX: 0, translationY: 0 },
    { state: State.ACTIVE, translationX: 0, translationY: 0 },
    { state: State.ACTIVE, translationX: x, translationY: y },
    { state: State.END, translationX: x, translationY: y },
  ]));
}

test('local thumbnails open an accessible full-screen preview and can zoom and close', async () => {
  const screen = await render(<SafeAreaInsetsContext.Provider value={insets}><AttachmentImage name="photo.png" uri="file:///cache/photo.png" /></SafeAreaInsetsContext.Provider>);
  expect(screen.getByTestId('attachment-image-thumbnail').props.source).toEqual({ uri: 'file:///cache/photo.png' });
  await fireEvent.press(screen.getByRole('button', { name: 'Preview photo.png' }));
  expect(Boolean(screen.getByRole('button', { name: 'Close' }))).toBe(true);
  expect(screen.getByTestId('native-preview-xmark')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Zoom out' })).toBeDisabled();
  await fireEvent.press(screen.getByRole('button', { name: 'Zoom in' }));
  await waitFor(() => expect(getAnimatedStyle(screen.getByTestId('attachment-image-preview')).transform).toContainEqual({ scale: 1.5 }));
  await fireEvent.press(screen.getByRole('button', { name: 'Close' }));
  expect(screen.queryByRole('button', { name: 'Close' })).toBeNull();
  await fireEvent.press(screen.getByRole('button', { name: 'Preview photo.png' }));
  expect(screen.getByRole('button', { name: 'Zoom out' })).toBeDisabled();
  expect(getAnimatedStyle(screen.getByTestId('attachment-image-preview')).transform).toEqual([{ translateX: 0 }, { translateY: 0 }, { scale: 1 }]);
});

test('one finger freely moves both axes at fit size and after a pinch without losing its position', async () => {
  const { screen, width, height } = await openLoadedPreview();
  await dragPreview(35, 55);
  await waitFor(() => expect(getAnimatedStyle(screen.getByTestId('attachment-image-preview')).transform).toEqual([{ translateX: 35 }, { translateY: 55 }, { scale: 1 }]));
  await dragPreview(-10, -20);
  await pinchPreview(2, width / 2, height / 2);
  await waitFor(() => expect(getAnimatedStyle(screen.getByTestId('attachment-image-preview')).transform).toEqual([{ translateX: 50 }, { translateY: 70 }, { scale: 2 }]));
  await dragPreview(15, -20);
  await waitFor(() => expect(getAnimatedStyle(screen.getByTestId('attachment-image-preview')).transform).toEqual([{ translateX: 65 }, { translateY: 50 }, { scale: 2 }]));
});

test('a single image tap dismisses the preview at fit size and after zooming', async () => {
  const { screen } = await openLoadedPreview();
  await act(async () => fireGestureHandler<TapGesture>(getByGestureTestId('attachment-image-dismiss')));
  await waitFor(() => expect(screen.queryByTestId('attachment-image-preview')).toBeNull());
  await fireEvent.press(screen.getByRole('button', { name: 'Preview photo.png' }));
  await fireEvent.press(screen.getByRole('button', { name: 'Zoom in' }));
  expect(screen.getByTestId('attachment-image-preview')).toBeTruthy();
  await act(async () => fireGestureHandler<TapGesture>(getByGestureTestId('attachment-image-dismiss')));
  await waitFor(() => expect(screen.queryByTestId('attachment-image-preview')).toBeNull());
});

test('a tap cancelled by dragging or pinching does not dismiss the preview', async () => {
  const { screen, width, height } = await openLoadedPreview();
  await dragPreview(30, 40);
  await act(async () => fireGestureHandler<TapGesture>(getByGestureTestId('attachment-image-dismiss'), [
    { state: State.BEGAN }, { state: State.CANCELLED },
  ]));
  expect(screen.getByTestId('attachment-image-preview')).toBeTruthy();
  await pinchPreview(2, width / 2, height / 2);
  await act(async () => fireGestureHandler<TapGesture>(getByGestureTestId('attachment-image-dismiss'), [
    { state: State.BEGAN }, { state: State.FAILED },
  ]));
  expect(screen.getByTestId('attachment-image-preview')).toBeTruthy();
});

test('successive pinches and native buttons share zoom, enforce limits, and allow a new drag', async () => {
  const { screen, width, height } = await openLoadedPreview();
  await pinchPreview(2, width / 2, height / 2);
  await pinchPreview(1.25, width / 2, height / 2);
  await waitFor(() => expect(getAnimatedStyle(screen.getByTestId('attachment-image-preview')).transform).toContainEqual({ scale: 2.5 }));
  await fireEvent.press(screen.getByRole('button', { name: 'Zoom out' }));
  await waitFor(() => expect(getAnimatedStyle(screen.getByTestId('attachment-image-preview')).transform).toContainEqual({ scale: 2 }));
  await pinchPreview(10, width / 2, height / 2);
  await waitFor(() => expect(screen.getByRole('button', { name: 'Zoom in' })).toBeDisabled());
  await pinchPreview(0.1, width / 2, height / 2);
  await waitFor(() => expect(screen.getByRole('button', { name: 'Zoom out' })).toBeDisabled());
  await dragPreview(20, 30);
  await waitFor(() => expect(getAnimatedStyle(screen.getByTestId('attachment-image-preview')).transform).toEqual([{ translateX: 20 }, { translateY: 30 }, { scale: 1 }]));
});

test('a moving two-finger focal point scales the image around the touched point', async () => {
  const { screen, width, height } = await openLoadedPreview();
  const x = width / 2 + 20;
  const y = height / 2 + 15;
  await act(async () => fireGestureHandler<PinchGesture>(getByGestureTestId('attachment-image-pinch'), [
    { state: State.BEGAN, scale: 1, focalX: x, focalY: y },
    { state: State.ACTIVE, scale: 1, focalX: x, focalY: y },
    { state: State.ACTIVE, scale: 2, focalX: x + 30, focalY: y + 40 },
    { state: State.END, scale: 2, focalX: x + 30, focalY: y + 40 },
  ]));
  await waitFor(() => expect(getAnimatedStyle(screen.getByTestId('attachment-image-preview')).transform).toEqual([{ translateX: 10 }, { translateY: 25 }, { scale: 2 }]));
});

test('lifting a pinch finger preserves the last two-finger position instead of following the remaining finger', async () => {
  const { screen, width, height } = await openLoadedPreview();
  const x = width / 2;
  const y = height / 2;
  await act(async () => fireGestureHandler<PinchGesture>(getByGestureTestId('attachment-image-pinch'), [
    { state: State.BEGAN, numberOfPointers: 2, scale: 1, focalX: x, focalY: y },
    { state: State.ACTIVE, numberOfPointers: 2, scale: 1, focalX: x, focalY: y },
    { state: State.ACTIVE, numberOfPointers: 2, scale: 2, focalX: x + 20, focalY: y + 30 },
    { state: State.ACTIVE, numberOfPointers: 1, scale: 2, focalX: x + 100, focalY: y + 140 },
    { state: State.END, numberOfPointers: 0, scale: 2, focalX: 0, focalY: 0 },
  ]));
  await waitFor(() => expect(getAnimatedStyle(screen.getByTestId('attachment-image-preview')).transform).toEqual([{ translateX: 20 }, { translateY: 30 }, { scale: 2 }]));
});

test('changing the pinch touch count rebases the focal point before further scaling', async () => {
  const { screen, width, height } = await openLoadedPreview();
  const x = width / 2;
  const y = height / 2;
  await act(async () => fireGestureHandler<PinchGesture>(getByGestureTestId('attachment-image-pinch'), [
    { state: State.BEGAN, numberOfPointers: 2, scale: 1, focalX: x, focalY: y },
    { state: State.ACTIVE, numberOfPointers: 2, scale: 1, focalX: x, focalY: y },
    { state: State.ACTIVE, numberOfPointers: 2, scale: 2, focalX: x, focalY: y },
    { state: State.ACTIVE, numberOfPointers: 1, scale: 2, focalX: x + 80, focalY: y + 90 },
    { state: State.ACTIVE, numberOfPointers: 2, scale: 2.2, focalX: x + 40, focalY: y + 50 },
    { state: State.ACTIVE, numberOfPointers: 2, scale: 2.75, focalX: x + 50, focalY: y + 60 },
    { state: State.END, numberOfPointers: 0, scale: 2.75, focalX: 0, focalY: 0 },
  ]));
  await waitFor(() => expect(getAnimatedStyle(screen.getByTestId('attachment-image-preview')).transform).toEqual([{ translateX: 0 }, { translateY: -2.5 }, { scale: 2.5 }]));
});

test('single-finger dragging rebases after a pointer-count change instead of applying the focal jump', async () => {
  const { screen } = await openLoadedPreview();
  await act(async () => fireGestureHandler<PanGesture>(getByGestureTestId('attachment-image-pan'), [
    { state: State.BEGAN, numberOfPointers: 1, translationX: 0, translationY: 0 },
    { state: State.ACTIVE, numberOfPointers: 1, translationX: 0, translationY: 0 },
    { state: State.ACTIVE, numberOfPointers: 1, translationX: 20, translationY: 30 },
    { state: State.ACTIVE, numberOfPointers: 2, translationX: 50, translationY: 60 },
    { state: State.ACTIVE, numberOfPointers: 1, translationX: 120, translationY: 140 },
    { state: State.ACTIVE, numberOfPointers: 1, translationX: 125, translationY: 147 },
    { state: State.END, numberOfPointers: 0, translationX: 125, translationY: 147 },
  ]));
  await waitFor(() => expect(getAnimatedStyle(screen.getByTestId('attachment-image-preview')).transform).toEqual([{ translateX: 25 }, { translateY: 37 }, { scale: 1 }]));
});

test('an active pan resumes from a fresh sample when the simultaneous pinch finishes', async () => {
  const { screen, width, height } = await openLoadedPreview();
  const pan = getByGestureTestId('attachment-image-pan');
  const pinch = getByGestureTestId('attachment-image-pinch');
  const emit = (handlerTag: number, payload: Record<string, number>) => DeviceEventEmitter.emit(
    'oldState' in payload ? 'onGestureHandlerStateChange' : 'onGestureHandlerEvent',
    { handlerTag, state: State.ACTIVE, numberOfPointers: 1, ...payload },
  );
  const panEvent = { translationX: 0, translationY: 0 };
  const pinchEvent = { focalX: width / 2, focalY: height / 2, numberOfPointers: 2, scale: 1 };
  await act(async () => {
    emit(pan.handlerTag, { ...panEvent, oldState: State.UNDETERMINED, state: State.BEGAN });
    emit(pan.handlerTag, { ...panEvent, oldState: State.BEGAN });
    emit(pan.handlerTag, { translationX: 20, translationY: 30 });
    emit(pinch.handlerTag, { ...pinchEvent, oldState: State.UNDETERMINED, state: State.BEGAN });
    emit(pinch.handlerTag, { ...pinchEvent, oldState: State.BEGAN });
    emit(pinch.handlerTag, { ...pinchEvent, scale: 2 });
    emit(pan.handlerTag, { translationX: 90, translationY: 120 });
    emit(pinch.handlerTag, { ...pinchEvent, scale: 2, numberOfPointers: 0, oldState: State.ACTIVE, state: State.END });
    emit(pan.handlerTag, { translationX: 190, translationY: 220 });
    emit(pan.handlerTag, { translationX: 195, translationY: 227 });
    emit(pan.handlerTag, { translationX: 195, translationY: 227, oldState: State.ACTIVE, state: State.END });
  });
  await waitFor(() => expect(getAnimatedStyle(screen.getByTestId('attachment-image-preview')).transform).toEqual([{ translateX: 45 }, { translateY: 67 }, { scale: 2 }]));
});

test('two-finger pan events do not double-count the translation owned by the pinch', async () => {
  const { screen, width, height } = await openLoadedPreview();
  await act(async () => fireGestureHandler<PanGesture>(getByGestureTestId('attachment-image-pan'), [
    { state: State.BEGAN, numberOfPointers: 1, translationX: 0, translationY: 0 },
    { state: State.ACTIVE, numberOfPointers: 1, translationX: 0, translationY: 0 },
    { state: State.ACTIVE, numberOfPointers: 2, translationX: 30, translationY: 40 },
    { state: State.END, numberOfPointers: 2, translationX: 30, translationY: 40 },
  ]));
  await pinchPreview(2, width / 2, height / 2);
  await waitFor(() => expect(getAnimatedStyle(screen.getByTestId('attachment-image-preview')).transform).toEqual([{ translateX: 0 }, { translateY: 0 }, { scale: 2 }]));
});

test('image load failure can retry before enabling gestures', async () => {
  const { screen, width, height } = await openLoadedPreview();
  await fireEvent(screen.getByTestId('attachment-image-preview'), 'error');
  expect(getByGestureTestId('attachment-image-pinch').config.enabled).toBe(false);
  await fireEvent.press(screen.getByRole('button', { name: 'Retry' }));
  expect(getByGestureTestId('attachment-image-pan').config.enabled).toBe(false);
  await fireEvent(screen.getByTestId('attachment-image-preview'), 'load', { nativeEvent: { source: { width, height } } });
  expect(getByGestureTestId('attachment-image-pinch').config.enabled).toBe(true);
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

test('turn body messages show attachments without loading process history in both modes', () => {
  const file = { id: 'att/file', kind: 'file', name: 'notes.pdf', mime: 'application/pdf', size: 120, contentState: 'available' };
  const turn = { id: 'turn', status: 'completed', userPrompt: 'summary', userMessages: [
    { id: 'original-photo', text: '', attachments: [photo] },
    { id: 'original-file', text: 'See attached', attachments: [file] },
  ], startedAt: '2026-11-07T00:00:00Z', updatedAt: '2026-11-07T00:00:01Z' };
  const summary = ControlPlaneAiSessionSummarySchema.parse({ id: 'session', agent: 'codex', status: 'idle', startedAt: turn.startedAt, updatedAt: turn.updatedAt });
  const session = { ...summary, turns: [AiSessionTurnSchema.parse(turn)] };
  // A lazily loaded timeline must not replace newer authoritative turn-body messages.
  const timelines = { turn: { status: 'ready' as const, items: [
    AiSessionTimelineItemSchema.parse({ id: 'original-photo', turnId: 'turn', type: 'user-message', text: 'outdated', attachments: [] }),
    AiSessionTimelineItemSchema.parse({ id: 'response', turnId: 'turn', type: 'ai-message', text: 'Done' }),
  ] } };
  for (const states of [{}, timelines]) {
    for (const items of [detailItems(session, [], 0, undefined, states), conversationDetailItems(session, [], undefined, states)]) {
      expect(items.filter((entry) => entry.role === 'user')).toMatchObject([
        { messageId: 'original-photo', text: '', attachments: [photo] },
        { messageId: 'original-file', text: 'See attached', attachments: [file] },
      ]);
      expect(items.flatMap((entry) => entry.history ?? []).filter((entry) => entry.role === 'user')).toEqual([]);
    }
  }
});

test('renders turn-body images and files above the prompt without requesting history', async () => {
  const summary = ControlPlaneAiSessionSummarySchema.parse({ id: 'session', agent: 'codex', status: 'idle', startedAt: '2026-11-07T00:00:00Z', updatedAt: '2026-11-07T00:00:01Z' });
  const session = { ...summary, turns: [AiSessionTurnSchema.parse({
    id: 'turn', status: 'completed', startedAt: summary.startedAt,
    userMessages: [{ id: 'body-message', text: 'Inspect these attachments', attachments: [photo, { id: 'att/file', kind: 'file', name: 'notes.pdf', mime: 'application/pdf', size: 120, contentState: 'available' }] }],
  })] };
  const attachmentContent = jest.fn().mockResolvedValue({ body: new Uint8Array([1, 2, 3]) });
  const client = { aiSessions: { attachmentContent } } as unknown as ControlPlaneClient;
  const onLoadTimeline = jest.fn();
  const screen = await render(<SessionDetail client={client} instanceId="instance" messages={[]} mode="turn" onLoadTimeline={onLoadTimeline} session={session} timelineEnabled />);
  await waitFor(() => expect(screen.getByRole('button', { name: 'Preview photo.png' })).toBeTruthy());
  expect(screen.getByText('notes.pdf')).toBeTruthy();
  expect(screen.getByTestId('session-user-message')).toBeTruthy();
  expect(attachmentContent).toHaveBeenCalledWith('instance', 'session', 'body-message', 'att/photo');
  expect(onLoadTimeline).not.toHaveBeenCalled();
  await screen.unmount();
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
