import type { createControlPlaneRemoteDesktopApi } from '@task-handoff/control-plane-client';
import { RTCPeerConnection, RTCRtpReceiver } from 'react-native-webrtc';

import type {
  MobileAuthenticatedWebSocketHandlers,
  MobileAuthenticatedWebSocketOptions,
  MobileControlPlaneTransport,
} from '../src/control-plane/transport';
import { MobileControlPlaneTransportError } from '../src/control-plane/transport';
import { RemoteDesktopController } from '../src/remote-desktop/controller';
import {
  configureRemoteDesktopDecoder,
  decodeRemoteDesktopFrame,
  resetRemoteDesktopDecoder,
} from '../modules/task-handoff-remote-desktop/src';

jest.mock('react-native-webrtc', () => ({
  RTCPeerConnection: jest.fn(),
  RTCRtpReceiver: { getCapabilities: jest.fn(() => ({ codecs: [] })) },
}));

jest.mock('../modules/task-handoff-remote-desktop/src', () => ({
  closeRemoteDesktopDecoder: jest.fn(async () => undefined),
  configureRemoteDesktopDecoder: jest.fn(async () => undefined),
  decodeRemoteDesktopFrame: jest.fn(async () => undefined),
  resetRemoteDesktopDecoder: jest.fn(async () => undefined),
  startRemoteDesktopTextInputObservation: jest.fn(() => false),
  stopRemoteDesktopTextInputObservation: jest.fn(),
  subscribeRemoteDesktopDecoderErrors: jest.fn(() => ({ remove: jest.fn() })),
  subscribeRemoteDesktopTextInput: jest.fn(() => ({ remove: jest.fn() })),
}));

jest.mock('../src/observability/diagnostic-logs', () => ({
  diagnosticLog: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

beforeEach(() => {
  jest.clearAllMocks();
  (RTCRtpReceiver.getCapabilities as jest.Mock).mockReturnValue({ codecs: [] });
});

type RemoteDesktopApi = ReturnType<typeof createControlPlaneRemoteDesktopApi>;
type OpenedSocket = {
  options: MobileAuthenticatedWebSocketOptions;
  handlers: MobileAuthenticatedWebSocketHandlers;
  readyState: number;
  send: jest.Mock;
  close: jest.Mock;
};

function createdSession(viewerSessionId = 'rdv_1', sourceRef = 'display-primary') {
  return {
    snapshot: {
      viewerSessionId,
      sessionRevision: 1,
      controlRevision: 0,
      isController: true,
      hasController: true,
      viewerCount: 1,
      transport: 'webrtc',
      phase: 'starting',
      captureSelection: { sourceRef },
      sessionExpiresAt: Date.now() + 60_000,
      idleExpiresAt: null,
      mediaPaused: false,
      reason: null,
    },
    signalUrl: '/api/remote-desktop/signal?ticket=signal-ticket',
    iceServers: [],
    iceCredentialsExpiresAt: null,
    ticketExpiresAt: Date.now() + 60_000,
    protocolVersion: '2026-11-11',
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function fallbackSession() {
  return {
    protocolVersion: '2026-11-09',
    fallbackGeneration: 'fgen_test',
    mediaUrl: '/api/remote-desktop/fallback/media?ticket=media-ticket',
    controlUrl: '/api/remote-desktop/fallback/control?ticket=control-ticket',
    mediaSubprotocol: 'taskhandoff.remote-desktop.fallback.media.v1',
    controlSubprotocol: 'taskhandoff.remote-desktop.fallback.control.v1',
    ticketExpiresAt: Date.now() + 30_000,
    limits: { maxWidth: 1920, maxHeight: 1080, maxFps: 30, maxBitrate: 8_000_000 },
  } as const;
}

function setup(
  availability: { p2p: boolean; turn: boolean; websocket: boolean },
  interactive = true,
  videoCodecs: readonly string[] = [],
) {
  const sockets: OpenedSocket[] = [];
  const openAuthenticatedWebSocket = jest.fn((options: MobileAuthenticatedWebSocketOptions, handlers: MobileAuthenticatedWebSocketHandlers) => {
    const socket: OpenedSocket = {
      options,
      handlers,
      readyState: 1,
      send: jest.fn(),
      close: jest.fn(),
    };
    sockets.push(socket);
    return socket;
  });
  const transport = { openAuthenticatedWebSocket } as unknown as MobileControlPlaneTransport;
  const api = {
    sources: jest.fn(async () => ({
      sources: [{
        sourceRef: 'display-primary',
        kind: 'display',
        title: 'Primary display',
        subtitle: null,
        width: 1920,
        height: 1080,
        capturable: true,
        reason: null,
      }],
    })),
    createSession: jest.fn(async () => createdSession()),
    resumeSignal: jest.fn(async () => ({
      signalUrl: '/api/remote-desktop/signal?ticket=resumed-ticket',
      ticketExpiresAt: Date.now() + 15_000,
      protocolVersion: '2026-11-11',
    })),
    fallback: jest.fn(async () => fallbackSession()),
    stop: jest.fn(async () => ({ stopped: true })),
  } as unknown as RemoteDesktopApi;
  const controller = new RemoteDesktopController({
    api,
    transport,
    instanceId: 'instance_1',
    interactive,
    target: { kind: 'display', sourceRef: 'display-primary' },
    resolution: 'auto',
    frameRate: 'auto',
    capturePrecision: 'auto',
    transportAvailability: availability,
    videoCodecs,
  });
  return { api, controller, openAuthenticatedWebSocket, sockets };
}

test('view-only startup never requests remote input', async () => {
  const { controller } = setup({ p2p: true, turn: true, websocket: true }, false);
  await controller.start();
  expect(controller.getSnapshot().inputRequested).toBe(false);
  expect(controller.getSnapshot().inputEnabled).toBe(false);
  expect(controller.getSnapshot().controlRequestPending).toBe(false);
  await controller.close();
});

test('native WebRTC dimensions become the shared snapshot geometry', async () => {
  const { controller } = setup({ p2p: true, turn: true, websocket: true });

  controller.setVideoDimensions(2560.4, 1440.6);
  expect(controller.getSnapshot().videoWidth).toBe(2560);
  expect(controller.getSnapshot().videoHeight).toBe(1441);

  controller.setVideoDimensions(0, 1080);
  expect(controller.getSnapshot().videoWidth).toBe(2560);
  expect(controller.getSnapshot().videoHeight).toBe(1441);

  await controller.close();
});

test('WebRTC prefers HEVC Main when the instance advertises H265', async () => {
  const h264 = { mimeType: 'video/H264', sdpFmtpLine: 'profile-level-id=42e01f' };
  const hevc = { mimeType: 'video/H265', sdpFmtpLine: 'profile-id=1;tier-flag=0;tx-mode=SRST' };
  (RTCRtpReceiver.getCapabilities as jest.Mock).mockReturnValue({ codecs: [h264, hevc] });
  const { transceiver } = installFakePeerConnection();
  const { controller, sockets } = setup({ p2p: true, turn: true, websocket: true }, true, ['h264', 'h265']);

  await controller.start();
  sockets[0].handlers.onOpen?.();
  sockets[0].handlers.onMessage(JSON.stringify({ type: 'ready' }));
  await flushMicrotasks();

  expect(transceiver.setCodecPreferences).toHaveBeenCalledWith([hevc, h264]);
  await controller.close();
});

async function flushMicrotasks() {
  for (let index = 0; index < 6; index += 1) await Promise.resolve();
}

function fallbackMediaFrame(keyframe = true, payloadBytes = 5, frameId = 1, timestampUs = 1n) {
  const payload = new Uint8Array(payloadBytes);
  payload.set([0, 0, 0, 1, 0x65]);
  const frame = new Uint8Array(25 + payload.length);
  frame[0] = 0x52;
  frame[1] = 0x44;
  frame[2] = 1;
  frame[3] = 1;
  frame[4] = keyframe ? 1 : 0;
  const view = new DataView(frame.buffer);
  view.setUint32(5, frameId);
  view.setBigUint64(9, timestampUs);
  view.setUint16(17, 0);
  view.setUint16(19, 1);
  view.setUint32(21, payload.length);
  frame.set(payload, 25);
  return frame.buffer;
}

function installFakePeerConnection() {
  const listeners = new Map<string, Array<(event?: unknown) => void>>();
  const transceiver = { setCodecPreferences: jest.fn() };
  const peer = {
    iceConnectionState: 'new',
    connectionState: 'new',
    localDescription: undefined as { type: 'offer'; sdp: string } | undefined,
    addEventListener(type: string, listener: (event?: unknown) => void) {
      listeners.set(type, [...(listeners.get(type) ?? []), listener]);
    },
    addTransceiver: jest.fn(() => transceiver),
    createDataChannel: jest.fn(() => ({ readyState: 'connecting', send: jest.fn(), close: jest.fn() })),
    createOffer: jest.fn(async () => ({ type: 'offer' as const, sdp: 'v=0\r\n' })),
    setLocalDescription: jest.fn(async (description: { type: 'offer'; sdp: string }) => { peer.localDescription = description; }),
    setRemoteDescription: jest.fn(async () => undefined),
    addIceCandidate: jest.fn(async () => undefined),
    setConfiguration: jest.fn(),
    getStats: jest.fn(async () => new Map()),
    close: jest.fn(),
  };
  (RTCPeerConnection as unknown as jest.Mock).mockImplementation(() => peer);
  return { peer, transceiver };
}

test('WebSocket-only startup attaches signaling before requesting fallback', async () => {
  const { api, controller, openAuthenticatedWebSocket, sockets } = setup({ p2p: false, turn: false, websocket: true });

  await controller.start();
  expect(openAuthenticatedWebSocket).toHaveBeenCalledTimes(1);
  expect(openAuthenticatedWebSocket.mock.calls[0][0].path).toBe(createdSession().signalUrl);
  expect(api.fallback).not.toHaveBeenCalled();

  sockets[0].handlers.onOpen?.();
  sockets[0].handlers.onMessage(JSON.stringify({ type: 'ready' }));
  await flushMicrotasks();

  expect(api.fallback).toHaveBeenCalledWith(
    'instance_1',
    'rdv_1',
    'ice-failed',
    'REMOTE_DESKTOP_ALL_WEBRTC_TRANSPORTS_DISABLED',
  );
  expect(openAuthenticatedWebSocket).toHaveBeenCalledTimes(3);
  expect(RTCPeerConnection).not.toHaveBeenCalled();
  expect(controller.getSnapshot().signalingReady).toBe(true);
  await controller.close();
});

test('a signaling tunnel loss resumes the same P2P session instead of switching to fallback', async () => {
  const { peer } = installFakePeerConnection();
  const { api, controller, sockets } = setup({ p2p: true, turn: true, websocket: true });

  await controller.start();
  sockets[0].handlers.onOpen?.();
  sockets[0].handlers.onMessage(JSON.stringify({ type: 'ready' }));
  await flushMicrotasks();
  peer.iceConnectionState = 'connected';

  sockets[0].handlers.onClose?.({ code: 1006, reason: 'relay socket reset' });
  await new Promise((resolve) => setTimeout(resolve, 20));
  await flushMicrotasks();

  expect(api.resumeSignal).toHaveBeenCalledWith('instance_1', 'rdv_1');
  expect(api.fallback).not.toHaveBeenCalled();
  expect(sockets).toHaveLength(2);
  expect(sockets[1].options.path).toBe('/api/remote-desktop/signal?ticket=resumed-ticket');
  expect(peer.close).not.toHaveBeenCalled();

  sockets[1].handlers.onOpen?.();
  sockets[1].handlers.onMessage(JSON.stringify({ type: 'ready' }));
  await flushMicrotasks();
  expect(controller.getSnapshot().signalingReady).toBe(true);
  await controller.close();
});

test('a retryable signaling resume failure is retried after the backoff delay', async () => {
  jest.useFakeTimers();
  try {
    const { peer } = installFakePeerConnection();
    const { api, controller, sockets } = setup({ p2p: true, turn: true, websocket: true });
    (api.resumeSignal as jest.Mock).mockRejectedValueOnce(new MobileControlPlaneTransportError(
      'RELAY_ATTEMPT_CANCELLED',
      'Relay transport revalidated during resume.',
      true,
    ));

    await controller.start();
    sockets[0].handlers.onOpen?.();
    sockets[0].handlers.onMessage(JSON.stringify({ type: 'ready' }));
    await flushMicrotasks();
    peer.iceConnectionState = 'connected';

    sockets[0].handlers.onClose?.({ code: 1006, reason: 'relay socket reset' });
    await jest.advanceTimersByTimeAsync(0);
    await flushMicrotasks();
    expect(api.resumeSignal).toHaveBeenCalledTimes(1);
    expect(sockets).toHaveLength(1);

    await jest.advanceTimersByTimeAsync(300);
    await flushMicrotasks();
    expect(api.resumeSignal).toHaveBeenCalledTimes(2);
    expect(sockets).toHaveLength(2);
    expect(api.fallback).not.toHaveBeenCalled();

    await controller.close();
  } finally {
    jest.useRealTimers();
  }
});

test('a 404 signaling resume recreates the expired viewer session', async () => {
  jest.useFakeTimers();
  try {
    const { peer } = installFakePeerConnection();
    const { api, controller, sockets } = setup({ p2p: true, turn: true, websocket: true });
    (api.createSession as jest.Mock)
      .mockResolvedValueOnce(createdSession())
      .mockResolvedValueOnce(createdSession('rdv_2'));
    (api.resumeSignal as jest.Mock).mockRejectedValueOnce(new MobileControlPlaneTransportError(
      'RELAY_CONTROL_PLANE_RESPONSE_FAILED',
      'Control Plane request failed with HTTP 404.',
      false,
      404,
    ));

    await controller.start();
    sockets[0].handlers.onOpen?.();
    sockets[0].handlers.onMessage(JSON.stringify({ type: 'ready' }));
    await flushMicrotasks();
    peer.iceConnectionState = 'connected';

    sockets[0].handlers.onClose?.({ code: 1006, reason: 'relay socket reset' });
    await jest.advanceTimersByTimeAsync(0);
    await flushMicrotasks();

    expect(api.resumeSignal).toHaveBeenCalledWith('instance_1', 'rdv_1');
    expect(api.stop).toHaveBeenCalledWith('instance_1', 'rdv_1');
    expect(api.createSession).toHaveBeenCalledTimes(2);
    expect(controller.getSnapshot().error).toBeUndefined();
    expect(sockets).toHaveLength(2);
    expect(sockets[1].options.path).toBe(createdSession().signalUrl);

    await controller.close();
  } finally {
    jest.useRealTimers();
  }
});

test('switching capture targets while stopping starts only the latest target', async () => {
  const { api, controller } = setup({ p2p: false, turn: false, websocket: true });
  (api.sources as jest.Mock).mockResolvedValue({
    sources: [
      { sourceRef: 'display-primary', kind: 'display', title: 'Primary display', subtitle: null, width: 1920, height: 1080, capturable: true, reason: null },
      { sourceRef: 'window-a', kind: 'window', title: 'Window A', subtitle: 'App A', width: 1280, height: 720, capturable: true, reason: null },
      { sourceRef: 'window-b', kind: 'window', title: 'Window B', subtitle: 'App B', width: 1440, height: 900, capturable: true, reason: null },
    ],
  });
  await controller.start();
  expect(api.createSession).toHaveBeenCalledTimes(1);

  const stopped = deferred<{ stopped: boolean }>();
  (api.stop as jest.Mock).mockImplementationOnce(() => stopped.promise);
  const first = controller.switchTarget({ kind: 'window', sourceRef: 'window-a' });
  await flushMicrotasks();
  expect(api.stop).toHaveBeenCalledWith('instance_1', 'rdv_1');

  const second = controller.switchTarget({ kind: 'window', sourceRef: 'window-b' });
  stopped.resolve({ stopped: true });
  await Promise.all([first, second]);

  expect(api.createSession).toHaveBeenCalledTimes(2);
  expect((api.createSession as jest.Mock).mock.calls[1][1]).toEqual({ sourceRef: 'window-b' });
  expect(controller.getSnapshot().target.sourceRef).toBe('window-b');
  await controller.close();
});

test('releases a stale session created after a newer target supersedes it', async () => {
  const { api, controller } = setup({ p2p: false, turn: false, websocket: true });
  (api.sources as jest.Mock).mockResolvedValue({
    sources: [
      { sourceRef: 'display-primary', kind: 'display', title: 'Primary display', subtitle: null, width: 1920, height: 1080, capturable: true, reason: null },
      { sourceRef: 'window-a', kind: 'window', title: 'Window A', subtitle: 'App A', width: 1280, height: 720, capturable: true, reason: null },
      { sourceRef: 'window-b', kind: 'window', title: 'Window B', subtitle: 'App B', width: 1440, height: 900, capturable: true, reason: null },
    ],
  });
  await controller.start();

  const staleCreation = deferred<ReturnType<typeof createdSession>>();
  (api.createSession as jest.Mock)
    .mockImplementationOnce(() => staleCreation.promise)
    .mockImplementation(async (_instanceId: string, selection: { sourceRef: string }) => createdSession(`rdv_${selection.sourceRef}`, selection.sourceRef));

  const first = controller.switchTarget({ kind: 'window', sourceRef: 'window-a' });
  await flushMicrotasks();
  expect(api.createSession).toHaveBeenCalledTimes(2);
  const second = controller.switchTarget({ kind: 'window', sourceRef: 'window-b' });
  staleCreation.resolve(createdSession('rdv_stale', 'window-a'));
  await Promise.all([first, second]);

  expect(api.stop).toHaveBeenCalledWith('instance_1', 'rdv_stale');
  expect((api.createSession as jest.Mock).mock.calls.map((call) => call[1])).toEqual([
    { sourceRef: 'display-primary' },
    { sourceRef: 'window-a' },
    { sourceRef: 'window-b' },
  ]);
  expect(controller.getSnapshot().target.sourceRef).toBe('window-b');
  await controller.close();
});

test('signaling failure before ready resumes the same session instead of requesting fallback', async () => {
  const { api, controller, sockets } = setup({ p2p: false, turn: false, websocket: true });

  await controller.start();
  sockets[0].handlers.onError?.(new MobileControlPlaneTransportError('REMOTE_DESKTOP_SIGNAL_SOCKET_ERROR', 'socket failed'));
  await new Promise((resolve) => setTimeout(resolve, 10));
  await flushMicrotasks();

  expect(api.fallback).not.toHaveBeenCalled();
  expect(api.resumeSignal).toHaveBeenCalledWith('instance_1', 'rdv_1');
  expect(sockets).toHaveLength(2);
  await controller.close();
});

test('coalesces duplicate WebRTC stats watchers for the same peer', async () => {
  jest.useFakeTimers();
  const { controller } = setup({ p2p: true, turn: false, websocket: false });
  const peer = { getStats: jest.fn(async () => new Map()) };
  (controller as unknown as { peer: unknown }).peer = peer;

  (controller as unknown as { startStatsWatch(peer: unknown): void }).startStatsWatch(peer);
  (controller as unknown as { startStatsWatch(peer: unknown): void }).startStatsWatch(peer);
  await flushMicrotasks();
  expect(peer.getStats).toHaveBeenCalledTimes(1);

  jest.advanceTimersByTime(2_000);
  await flushMicrotasks();
  expect(peer.getStats).toHaveBeenCalledTimes(2);

  await controller.close();
  jest.useRealTimers();
});

test('fallback ticket request retries after a temporary transport outage', async () => {
  jest.useFakeTimers();
  const { api, controller, openAuthenticatedWebSocket, sockets } = setup({ p2p: false, turn: false, websocket: true });
  const fallback = api.fallback as jest.Mock;
  fallback
    .mockRejectedValueOnce(new MobileControlPlaneTransportError('REMOTE_DESKTOP_RELAY_CHANNEL_FAILED', 'offline', true))
    .mockResolvedValueOnce(fallbackSession());

  await controller.start();
  sockets[0].handlers.onOpen?.();
  sockets[0].handlers.onMessage(JSON.stringify({ type: 'ready' }));
  await flushMicrotasks();

  expect(fallback).toHaveBeenCalledTimes(1);
  expect(controller.getSnapshot().phase).not.toBe('error');

  jest.advanceTimersByTime(3_000);
  await flushMicrotasks();

  expect(fallback).toHaveBeenCalledTimes(2);
  expect(openAuthenticatedWebSocket).toHaveBeenCalledTimes(3);
  expect(controller.getSnapshot().phase).not.toBe('error');
  expect(controller.getSnapshot().transportStates.websocket).not.toBe('failed');

  await controller.close();
  jest.useRealTimers();
});

test('a session-not-found fallback failure recreates the expired viewer session', async () => {
  jest.useFakeTimers();
  installFakePeerConnection();
  const { api, controller, sockets } = setup({ p2p: true, turn: false, websocket: true });
  const fallback = api.fallback as jest.Mock;
  fallback
    .mockRejectedValueOnce(new MobileControlPlaneTransportError('REMOTE_DESKTOP_RELAY_CHANNEL_FAILED', 'offline', true))
    .mockRejectedValueOnce(new MobileControlPlaneTransportError('REMOTE_DESKTOP_NOT_FOUND', 'Remote desktop operation failed.', false));

  await controller.start();
  sockets[0].handlers.onOpen?.();
  sockets[0].handlers.onMessage(JSON.stringify({ type: 'ready' }));
  await flushMicrotasks();
  sockets[0].handlers.onClose?.({ code: 1006, reason: 'network lost' });
  await flushMicrotasks();

  expect(fallback).toHaveBeenCalledTimes(1);
  expect(controller.getSnapshot().phase).toBe('connecting');

  jest.advanceTimersByTime(3_000);
  await flushMicrotasks();
  await jest.advanceTimersByTimeAsync(0);
  for (let index = 0; index < 30; index += 1) await Promise.resolve();

  expect(fallback).toHaveBeenCalledTimes(2);
  expect(api.stop).toHaveBeenCalledWith('instance_1', 'rdv_1');
  expect(api.createSession).toHaveBeenCalledTimes(2);
  expect(controller.getSnapshot().phase).toBe('connecting');
  expect(controller.getSnapshot().error).toBeUndefined();

  await controller.close();
  jest.useRealTimers();
});

test('startup fails visibly when signaling opens but never becomes ready', async () => {
  jest.useFakeTimers();
  const { api, controller, sockets } = setup({ p2p: false, turn: false, websocket: true });

  await controller.start();
  sockets[0].handlers.onOpen?.();
  await flushMicrotasks();
  expect(controller.getSnapshot().phase).toBe('connecting');

  jest.advanceTimersByTime(20_000);
  await flushMicrotasks();

  expect(controller.getSnapshot().phase).toBe('error');
  expect(controller.getSnapshot().error?.code).toBe('REMOTE_DESKTOP_CONNECTION_TIMEOUT');
  expect(api.stop).toHaveBeenCalledWith('instance_1', 'rdv_1');

  await controller.close();
  jest.useRealTimers();
});

test('fallback configuration keeps the decoder alive for the first keyframe', async () => {
  const configure = configureRemoteDesktopDecoder as jest.Mock;
  const decode = decodeRemoteDesktopFrame as jest.Mock;
  const reset = resetRemoteDesktopDecoder as jest.Mock;
  configure.mockClear();
  decode.mockClear();
  reset.mockClear();

  const { controller, sockets } = setup({ p2p: false, turn: false, websocket: true });
  await controller.start();
  sockets[0].handlers.onOpen?.();
  sockets[0].handlers.onMessage(JSON.stringify({ type: 'ready' }));
  await flushMicrotasks();

  const media = sockets[1];
  media.handlers.onOpen?.();
  media.handlers.onMessage(JSON.stringify({
    type: 'fallback.configure',
    payload: { width: 1920, height: 1080, fps: 30, bitrate: 12_000_000, codec: 'avc1.42E028' },
  }));
  media.handlers.onMessage(fallbackMediaFrame());
  await flushMicrotasks();

  expect(configure).toHaveBeenCalledTimes(1);
  expect(configure).toHaveBeenCalledWith(expect.objectContaining({ bitrate: 12_000_000 }));
  expect(decode).toHaveBeenCalledTimes(1);
  expect(reset).not.toHaveBeenCalled();
  expect(controller.getSnapshot().videoWidth).toBe(1920);
  expect(controller.getSnapshot().videoHeight).toBe(1080);
  await controller.close();
});

test.each([
  'REMOTE_DESKTOP_GEOMETRY_CHANGED',
  'REMOTE_DESKTOP_WINDOW_FOCUS_REQUIRED',
])('recoverable suspension renews input against the suspension revision (%s)', async (cause) => {
  const { controller, sockets } = setup({ p2p: false, turn: false, websocket: true });
  await controller.start();
  sockets[0].handlers.onOpen?.();
  sockets[0].handlers.onMessage(JSON.stringify({ type: 'ready' }));
  await flushMicrotasks();

  const control = sockets[2];
  control.handlers.onOpen?.();
  control.handlers.onMessage(JSON.stringify({ type: 'fallback.ready' }));
  await flushMicrotasks();

  controller.enableInput();
  await flushMicrotasks();
  control.handlers.onMessage(JSON.stringify({ type: 'input.resumed', payload: { inputEpoch: 5 } }));
  expect(controller.getSnapshot().inputEnabled).toBe(true);

  control.send.mockClear();
  control.handlers.onMessage(JSON.stringify({
    type: 'input.suspended',
    payload: {
      cause,
      recoverable: true,
      sessionRevision: 9,
    },
  }));
  await flushMicrotasks();

  expect(controller.getSnapshot().session?.sessionRevision).toBe(9);
  expect(controller.getSnapshot().inputPending).toBe(true);
  const resumed = control.send.mock.calls
    .map(([data]) => JSON.parse(String(data)))
    .find((message) => message.type === 'input.resume');
  expect(resumed?.payload).toEqual({ sessionRevision: 9 });

  await controller.close();
});

test('an inactive channel does not steal control and preserves explicit input intent', async () => {
  const { controller, sockets } = setup({ p2p: false, turn: false, websocket: true });
  await controller.start();
  sockets[0].handlers.onOpen?.();
  sockets[0].handlers.onMessage(JSON.stringify({ type: 'ready' }));
  await flushMicrotasks();

  const control = sockets[2];
  control.handlers.onOpen?.();
  control.handlers.onMessage(JSON.stringify({ type: 'fallback.ready' }));
  await flushMicrotasks();

  controller.enableInput();
  control.handlers.onMessage(JSON.stringify({ type: 'input.resumed', payload: { inputEpoch: 5 } }));
  expect(controller.getSnapshot().inputEnabled).toBe(true);
  expect(controller.getSnapshot().inputRequested).toBe(true);

  controller.setActive(false);
  control.handlers.onMessage(JSON.stringify({
    type: 'control.changed',
    payload: {
      isController: false,
      viewerCount: 2,
      viewerSources: [
        { sourceRef: 'display-primary', viewerCount: 1 },
        { sourceRef: 'window-secondary', viewerCount: 1 },
      ],
      controlRevision: 2,
    },
  }));
  await flushMicrotasks();
  expect(controller.getSnapshot().paused).toBe(true);
  expect(controller.getSnapshot().inputEnabled).toBe(false);
  expect(controller.getSnapshot().inputRequested).toBe(true);
  expect(controller.getSnapshot().viewerSources).toEqual([
    { sourceRef: 'display-primary', viewerCount: 1 },
    { sourceRef: 'window-secondary', viewerCount: 1 },
  ]);

  control.send.mockClear();
  controller.setActive(true);
  await flushMicrotasks();
  expect(controller.getSnapshot().inputRequested).toBe(true);
  expect(control.send.mock.calls
    .map(([data]) => JSON.parse(String(data)))
    .some((message) => message.type === 'control.request')).toBe(false);

  controller.enableInput();
  await flushMicrotasks();
  expect(control.send.mock.calls
    .map(([data]) => JSON.parse(String(data)))
    .some((message) => message.type === 'control.request')).toBe(true);

  sockets[0].handlers.onMessage(JSON.stringify({
    type: 'snapshot',
    snapshot: { ...createdSession().snapshot, transport: 'websocket', phase: 'connected', isController: false },
  }));
  await flushMicrotasks();
  expect(controller.getSnapshot().inputRequested).toBe(true);

  control.handlers.onMessage(JSON.stringify({
    type: 'control.changed',
    payload: { isController: true, viewerCount: 2, controlRevision: 3 },
  }));
  await flushMicrotasks();
  expect(control.send.mock.calls
    .map(([data]) => JSON.parse(String(data)))
    .some((message) => message.type === 'input.resume')).toBe(true);

  await controller.close();
});

test('automatically acquires control when nobody holds input', async () => {
  const { controller, sockets } = setup({ p2p: false, turn: false, websocket: true });
  await controller.start();
  sockets[0].handlers.onOpen?.();
  sockets[0].handlers.onMessage(JSON.stringify({ type: 'ready' }));
  await flushMicrotasks();

  const control = sockets[2];
  control.handlers.onOpen?.();
  control.handlers.onMessage(JSON.stringify({ type: 'fallback.ready' }));
  sockets[0].handlers.onMessage(JSON.stringify({
    type: 'snapshot',
    snapshot: { ...createdSession().snapshot, transport: 'websocket', phase: 'active', isController: false, hasController: false },
  }));
  await flushMicrotasks();

  expect(controller.getSnapshot().inputRequested).toBe(true);
  expect(control.send.mock.calls
    .map(([data]) => JSON.parse(String(data)))
    .some((message) => message.type === 'control.request')).toBe(true);

  await controller.close();
});

test('retries input resume with the latest revision after a recoverable rejection', async () => {
  jest.useFakeTimers();
  const { controller, sockets } = setup({ p2p: false, turn: false, websocket: true });
  await controller.start();
  sockets[0].handlers.onOpen?.();
  sockets[0].handlers.onMessage(JSON.stringify({ type: 'ready' }));
  await flushMicrotasks();

  const control = sockets[2];
  control.handlers.onOpen?.();
  control.handlers.onMessage(JSON.stringify({ type: 'fallback.ready' }));
  await flushMicrotasks();

  controller.disableInput();
  sockets[0].handlers.onMessage(JSON.stringify({
    type: 'snapshot',
    snapshot: { ...createdSession().snapshot, sessionRevision: 4, transport: 'websocket', phase: 'active', isController: true, hasController: true },
  }));
  await flushMicrotasks();
  control.send.mockClear();

  controller.enableInput();
  await flushMicrotasks();
  expect(control.send.mock.calls
    .map(([data]) => JSON.parse(String(data)))
    .find((message) => message.type === 'input.resume')?.payload).toEqual({ sessionRevision: 4 });

  sockets[0].handlers.onMessage(JSON.stringify({
    type: 'snapshot',
    snapshot: { ...createdSession().snapshot, sessionRevision: 5, transport: 'websocket', phase: 'active', isController: true, hasController: true },
  }));
  control.handlers.onMessage(JSON.stringify({ type: 'error', payload: { code: 'REMOTE_DESKTOP_STALE_EPOCH' } }));
  await flushMicrotasks();

  expect(controller.getSnapshot().inputPending).toBe(false);
  expect(controller.getSnapshot().error).toBeUndefined();

  jest.advanceTimersByTime(250);
  await flushMicrotasks();
  const resumes = control.send.mock.calls
    .map(([data]) => JSON.parse(String(data)))
    .filter((message) => message.type === 'input.resume');
  expect(resumes.at(-1)?.payload).toEqual({ sessionRevision: 5 });

  control.handlers.onMessage(JSON.stringify({ type: 'input.resumed', payload: { inputEpoch: 9 } }));
  await flushMicrotasks();
  expect(controller.getSnapshot().inputEnabled).toBe(true);
  expect(controller.getSnapshot().inputPending).toBe(false);

  control.handlers.onMessage(JSON.stringify({ type: 'error', payload: { code: 'REMOTE_DESKTOP_INVALID_STATE' } }));
  await flushMicrotasks();
  expect(controller.getSnapshot().inputEnabled).toBe(true);
  expect(controller.getSnapshot().error).toBeUndefined();

  await controller.close();
  jest.useRealTimers();
});

test('automatically recovers input after a focus loss once input was enabled', async () => {
  jest.useFakeTimers();
  const { controller, sockets } = setup({ p2p: false, turn: false, websocket: true });
  await controller.start();
  sockets[0].handlers.onOpen?.();
  sockets[0].handlers.onMessage(JSON.stringify({ type: 'ready' }));
  await flushMicrotasks();

  const control = sockets[2];
  control.handlers.onOpen?.();
  control.handlers.onMessage(JSON.stringify({ type: 'fallback.ready' }));
  await flushMicrotasks();

  controller.enableInput();
  await flushMicrotasks();
  control.handlers.onMessage(JSON.stringify({ type: 'input.resumed', payload: { inputEpoch: 5 } }));
  expect(controller.getSnapshot().inputEnabled).toBe(true);
  control.send.mockClear();

  control.handlers.onMessage(JSON.stringify({
    type: 'error',
    payload: { code: 'REMOTE_DESKTOP_WINDOW_FOCUS_REQUIRED' },
  }));
  await flushMicrotasks();
  expect(controller.getSnapshot().inputEnabled).toBe(false);
  expect(controller.getSnapshot().error).toBeUndefined();

  jest.advanceTimersByTime(250);
  await flushMicrotasks();
  const resumes = control.send.mock.calls
    .map(([data]) => JSON.parse(String(data)))
    .filter((message) => message.type === 'input.resume');
  expect(resumes).toHaveLength(1);
  expect(resumes[0]?.payload).toEqual({ sessionRevision: 1 });

  control.handlers.onMessage(JSON.stringify({ type: 'input.resumed', payload: { inputEpoch: 6 } }));
  await flushMicrotasks();
  expect(controller.getSnapshot().inputEnabled).toBe(true);
  expect(controller.getSnapshot().inputPending).toBe(false);
  expect(controller.getSnapshot().error).toBeUndefined();

  await controller.close();
  jest.useRealTimers();
});

test('does not auto-recover input after the user explicitly disables it', async () => {
  jest.useFakeTimers();
  const { controller, sockets } = setup({ p2p: false, turn: false, websocket: true });
  await controller.start();
  sockets[0].handlers.onOpen?.();
  sockets[0].handlers.onMessage(JSON.stringify({ type: 'ready' }));
  await flushMicrotasks();

  const control = sockets[2];
  control.handlers.onOpen?.();
  control.handlers.onMessage(JSON.stringify({ type: 'fallback.ready' }));
  await flushMicrotasks();

  controller.enableInput();
  await flushMicrotasks();
  control.handlers.onMessage(JSON.stringify({ type: 'input.resumed', payload: { inputEpoch: 5 } }));
  controller.disableInput();
  control.send.mockClear();

  control.handlers.onMessage(JSON.stringify({
    type: 'error',
    payload: { code: 'REMOTE_DESKTOP_WINDOW_FOCUS_REQUIRED' },
  }));
  await flushMicrotasks();
  jest.advanceTimersByTime(5_000);
  await flushMicrotasks();

  expect(controller.getSnapshot().inputRequested).toBe(false);
  expect(controller.getSnapshot().inputEnabled).toBe(false);
  expect(control.send.mock.calls
    .map(([data]) => JSON.parse(String(data)))
    .some((message) => message.type === 'input.resume')).toBe(false);

  await controller.close();
  jest.useRealTimers();
});

test('keeps non-recoverable input errors terminal', async () => {
  jest.useFakeTimers();
  const { controller, sockets } = setup({ p2p: false, turn: false, websocket: true });
  await controller.start();
  sockets[0].handlers.onOpen?.();
  sockets[0].handlers.onMessage(JSON.stringify({ type: 'ready' }));
  await flushMicrotasks();

  const control = sockets[2];
  control.handlers.onOpen?.();
  control.handlers.onMessage(JSON.stringify({ type: 'fallback.ready' }));
  await flushMicrotasks();

  controller.enableInput();
  await flushMicrotasks();
  control.handlers.onMessage(JSON.stringify({ type: 'input.resumed', payload: { inputEpoch: 5 } }));
  control.send.mockClear();

  control.handlers.onMessage(JSON.stringify({
    type: 'error',
    payload: { code: 'REMOTE_DESKTOP_FORBIDDEN' },
  }));
  await flushMicrotasks();
  jest.advanceTimersByTime(5_000);
  await flushMicrotasks();

  expect(controller.getSnapshot().inputEnabled).toBe(false);
  expect(controller.getSnapshot().error?.code).toBe('REMOTE_DESKTOP_FORBIDDEN');
  expect(control.send.mock.calls
    .map(([data]) => JSON.parse(String(data)))
    .some((message) => message.type === 'input.resume')).toBe(false);

  await controller.close();
  jest.useRealTimers();
});

test('retries input resume when the acknowledgement never arrives', async () => {
  jest.useFakeTimers();
  const { controller, sockets } = setup({ p2p: false, turn: false, websocket: true });
  await controller.start();
  sockets[0].handlers.onOpen?.();
  sockets[0].handlers.onMessage(JSON.stringify({ type: 'ready' }));
  await flushMicrotasks();

  const control = sockets[2];
  control.handlers.onOpen?.();
  control.handlers.onMessage(JSON.stringify({ type: 'fallback.ready' }));
  await flushMicrotasks();

  controller.disableInput();
  control.send.mockClear();
  controller.enableInput();
  await flushMicrotasks();
  expect(controller.getSnapshot().inputPending).toBe(true);

  jest.advanceTimersByTime(2_500);
  await flushMicrotasks();
  expect(controller.getSnapshot().inputPending).toBe(false);

  sockets[0].handlers.onMessage(JSON.stringify({
    type: 'snapshot',
    snapshot: { ...createdSession().snapshot, sessionRevision: 6, transport: 'websocket', phase: 'active', isController: true, hasController: true },
  }));
  control.handlers.onMessage(JSON.stringify({ type: 'error', payload: { code: 'REMOTE_DESKTOP_STALE_EPOCH' } }));
  await flushMicrotasks();
  expect(controller.getSnapshot().error).toBeUndefined();

  jest.advanceTimersByTime(500);
  await flushMicrotasks();
  const resumes = control.send.mock.calls
    .map(([data]) => JSON.parse(String(data)))
    .filter((message) => message.type === 'input.resume');
  expect(resumes).toHaveLength(2);
  expect(resumes.at(-1)?.payload).toEqual({ sessionRevision: 6 });
  expect(controller.getSnapshot().inputPending).toBe(true);

  control.handlers.onMessage(JSON.stringify({ type: 'input.resumed', payload: { inputEpoch: 10 } }));
  await flushMicrotasks();
  expect(controller.getSnapshot().inputEnabled).toBe(true);

  await controller.close();
  jest.useRealTimers();
});

test('keeps input resume backoff when a snapshot arrives while a retry is pending', async () => {
  jest.useFakeTimers();
  const { controller, sockets } = setup({ p2p: false, turn: false, websocket: true });
  await controller.start();
  sockets[0].handlers.onOpen?.();
  sockets[0].handlers.onMessage(JSON.stringify({ type: 'ready' }));
  await flushMicrotasks();

  const control = sockets[2];
  control.handlers.onOpen?.();
  control.handlers.onMessage(JSON.stringify({ type: 'fallback.ready' }));
  await flushMicrotasks();

  controller.disableInput();
  control.send.mockClear();
  controller.enableInput();
  await flushMicrotasks();
  expect(control.send.mock.calls
    .map(([data]) => JSON.parse(String(data)))
    .filter((message) => message.type === 'input.resume')).toHaveLength(1);

  jest.advanceTimersByTime(2_500);
  await flushMicrotasks();
  expect(controller.getSnapshot().inputPending).toBe(false);

  sockets[0].handlers.onMessage(JSON.stringify({
    type: 'snapshot',
    snapshot: { ...createdSession().snapshot, sessionRevision: 8, transport: 'websocket', phase: 'active', isController: true, hasController: true },
  }));
  await flushMicrotasks();
  expect(control.send.mock.calls
    .map(([data]) => JSON.parse(String(data)))
    .filter((message) => message.type === 'input.resume')).toHaveLength(1);

  jest.advanceTimersByTime(250);
  await flushMicrotasks();
  expect(control.send.mock.calls
    .map(([data]) => JSON.parse(String(data)))
    .filter((message) => message.type === 'input.resume')).toHaveLength(2);

  await controller.close();
  jest.useRealTimers();
});

test('does not request control while another viewer is controlling', async () => {
  const { controller, sockets } = setup({ p2p: false, turn: false, websocket: true });
  await controller.start();
  sockets[0].handlers.onOpen?.();
  sockets[0].handlers.onMessage(JSON.stringify({ type: 'ready' }));
  await flushMicrotasks();

  const control = sockets[2];
  control.handlers.onOpen?.();
  control.handlers.onMessage(JSON.stringify({ type: 'fallback.ready' }));
  sockets[0].handlers.onMessage(JSON.stringify({
    type: 'snapshot',
    snapshot: { ...createdSession().snapshot, transport: 'websocket', phase: 'active', isController: false, hasController: true },
  }));
  await flushMicrotasks();

  expect(controller.getSnapshot().inputRequested).toBe(true);
  expect(control.send.mock.calls
    .map(([data]) => JSON.parse(String(data)))
    .some((message) => message.type === 'control.request')).toBe(false);

  await controller.close();
});

test('manual input disable stays disabled when control becomes available', async () => {
  const { controller, sockets } = setup({ p2p: false, turn: false, websocket: true });
  await controller.start();
  sockets[0].handlers.onOpen?.();
  sockets[0].handlers.onMessage(JSON.stringify({ type: 'ready' }));
  await flushMicrotasks();

  const control = sockets[2];
  control.handlers.onOpen?.();
  control.handlers.onMessage(JSON.stringify({ type: 'fallback.ready' }));
  controller.disableInput();
  control.send.mockClear();
  sockets[0].handlers.onMessage(JSON.stringify({
    type: 'snapshot',
    snapshot: { ...createdSession().snapshot, transport: 'websocket', phase: 'active', isController: false, hasController: false },
  }));
  await flushMicrotasks();

  expect(controller.getSnapshot().inputRequested).toBe(false);
  expect(control.send.mock.calls
    .map(([data]) => JSON.parse(String(data)))
    .some((message) => message.type === 'control.request')).toBe(false);

  await controller.close();
});

test('websocket fallback publishes control RTT from the application pong', async () => {
  jest.useFakeTimers();
  try {
    const { controller, sockets } = setup({ p2p: false, turn: false, websocket: true });
    await controller.start();
    sockets[0].handlers.onOpen?.();
    sockets[0].handlers.onMessage(JSON.stringify({ type: 'ready' }));
    await flushMicrotasks();

    const control = sockets[2];
    control.handlers.onOpen?.();
    control.handlers.onMessage(JSON.stringify({ type: 'fallback.ready' }));
    await flushMicrotasks();

    const ping = control.send.mock.calls
      .map(([data]) => JSON.parse(String(data)))
      .find((message) => message.type === 'fallback.rtt.ping');
    expect(ping?.payload?.requestId).toEqual(expect.any(String));

    control.handlers.onMessage(JSON.stringify({
      type: 'fallback.rtt.pong',
      payload: { requestId: ping.payload.requestId },
    }));
    await flushMicrotasks();

    const diagnostics = controller.getSnapshot().transportDiagnostics;
    expect(diagnostics?.path).toBe('websocket');
    expect(diagnostics?.latencyStatus).toBe('active');
    expect(diagnostics?.latencyMs).toBeGreaterThanOrEqual(0);

    await controller.close();
  } finally {
    jest.useRealTimers();
  }
});

test('websocket fallback tracks media throughput without control-channel reports', async () => {
  jest.useFakeTimers();
  try {
    const { controller, sockets } = setup({ p2p: false, turn: false, websocket: true });
    await controller.start();
    sockets[0].handlers.onOpen?.();
    sockets[0].handlers.onMessage(JSON.stringify({ type: 'ready' }));
    await flushMicrotasks();

    const media = sockets[1];
    const control = sockets[2];
    media.handlers.onOpen?.();
    control.handlers.onOpen?.();
    control.handlers.onMessage(JSON.stringify({ type: 'fallback.ready' }));
    await flushMicrotasks();

    media.handlers.onMessage(JSON.stringify({
      type: 'fallback.configure',
      payload: { width: 1280, height: 720, fps: 30, bitrate: 4_000_000, codec: 'avc1.42E01E' },
    }));
    media.handlers.onMessage(fallbackMediaFrame(true, 200_000));
    await jest.advanceTimersByTimeAsync(1_100);
    await flushMicrotasks();

    const diagnostics = controller.getSnapshot().transportDiagnostics;
    expect(diagnostics?.path).toBe('websocket');
    expect(diagnostics?.bandwidthStatus).toBe('active');
    expect(diagnostics?.bandwidthMbps).toBeGreaterThan(0);
    const reports = control.send.mock.calls
      .map(([data]) => JSON.parse(String(data)))
      .filter((message) => message.type === 'fallback.media-report');
    expect(reports).toEqual([]);

    await controller.close();
  } finally {
    jest.useRealTimers();
  }
});

test('websocket fallback coalesces pointer motion to the latest position at 60 Hz', async () => {
  jest.useFakeTimers();
  try {
    const { controller, sockets } = setup({ p2p: false, turn: false, websocket: true });
    await controller.start();
    sockets[0].handlers.onOpen?.();
    sockets[0].handlers.onMessage(JSON.stringify({ type: 'ready' }));
    await flushMicrotasks();

    const control = sockets[2];
    control.handlers.onOpen?.();
    control.handlers.onMessage(JSON.stringify({ type: 'fallback.ready' }));
    await flushMicrotasks();
    controller.enableInput();
    await flushMicrotasks();
    control.handlers.onMessage(JSON.stringify({ type: 'input.resumed', payload: { inputEpoch: 4 } }));
    await flushMicrotasks();

    control.send.mockClear();
    controller.sendPointer(0.1, 0.2);
    controller.sendPointer(0.3, 0.4);
    expect(control.send.mock.calls
      .map(([data]) => JSON.parse(String(data)))
      .filter((message) => message.type === 'pointer')).toHaveLength(0);

    await jest.advanceTimersByTimeAsync(16);
    const pointers = control.send.mock.calls
      .map(([data]) => JSON.parse(String(data)))
      .filter((message) => message.type === 'pointer');
    expect(pointers).toHaveLength(1);
    expect(pointers[0].payload).toEqual({ x: 0.3, y: 0.4, inputEpoch: 4 });
    await controller.close();
  } finally {
    jest.useRealTimers();
  }
});
