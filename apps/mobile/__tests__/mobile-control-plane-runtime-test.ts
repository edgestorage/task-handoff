import type { ControlPlaneClient } from '@task-handoff/control-plane-client';

import type { MobileControlPlaneProfile } from '../src/control-plane/profile';
import {
  MobileControlPlaneConnectionCoordinator,
  type MobileControlPlaneDomain,
} from '../src/control-plane/use-mobile-control-plane-runtime';
import type {
  MobileControlPlaneEventHandlers,
  MobileControlPlaneTransport,
} from '../src/control-plane/transport';
import { MobileControlPlaneTransportError } from '../src/control-plane/transport';

const profile: MobileControlPlaneProfile = {
  version: 1,
  identity: {
    controlPlaneId: 'control_plane_runtime',
    publicKeyFingerprint: `sha256:${'b'.repeat(43)}`,
    protocolVersion: '2026-08-05',
  },
  access: { kind: 'direct', origin: 'https://control.example.com', secureSessionKey: 'session.runtime' },
  capabilities: { authentication: 'required', aiSessions: true, nodes: true, instanceBoard: true, triggers: true },
  createdAt: '2026-08-05T00:00:00.000Z',
  updatedAt: '2026-08-05T00:00:00.000Z',
};

async function flushCoordinator() {
  jest.runAllTicks();
  for (let index = 0; index < 32; index += 1) await Promise.resolve();
}

function domain(key: string, topics: string[], background = false): MobileControlPlaneDomain {
  return {
    key,
    topics,
    background,
    start: jest.fn().mockResolvedValue(undefined),
    stop: jest.fn(),
    offline: jest.fn(),
    onEvent: jest.fn(),
    onConnectionError: jest.fn(),
  };
}

function harness() {
  let handlers: MobileControlPlaneEventHandlers | undefined;
  const close = jest.fn();
  const updateTopics = jest.fn((topics: readonly string[]) => { if (handlers) handlers.topics = [...topics]; });
  const updateAiSessionTransient = jest.fn();
  const revalidate = jest.fn().mockResolvedValue(undefined);
  const suspend = jest.fn();
  const connectEvents = jest.fn((next: MobileControlPlaneEventHandlers) => {
    handlers = next;
    next.onOpen();
    return { close, updateTopics, updateAiSessionTransient };
  });
  const authSession = jest.fn().mockResolvedValue({ authenticated: true });
  const renewMobileSession = jest.fn().mockResolvedValue({ expiresAt: '2026-09-12T00:00:00.000Z' });
  const identity = jest.fn().mockResolvedValue({ data: { payload: {
    version: 1,
    kind: 'control-plane',
    controlPlaneId: profile.identity.controlPlaneId,
    publicKey: { algorithm: 'Ed25519', encoding: 'base64url', value: 'a'.repeat(43), fingerprint: profile.identity.publicKeyFingerprint },
    capabilities: { ...profile.capabilities, stories: true },
    protocolVersion: profile.identity.protocolVersion,
    issuedAt: '2026-09-02T00:00:00.000Z',
    expiresAt: '2026-09-02T00:05:00.000Z',
  }, signature: 'a'.repeat(86) } });
  const api = { auth: { session: authSession, identity, renewMobileSession } } as unknown as ControlPlaneClient;
  const transport = {
    profile,
    revalidate,
    suspend,
    connectEvents,
  } as unknown as MobileControlPlaneTransport;
  return {
    coordinator: new MobileControlPlaneConnectionCoordinator(profile, api, transport),
    authSession,
    close,
    connectEvents,
    identity,
    renewMobileSession,
    get handlers() { return handlers; },
    revalidate,
    suspend,
    updateAiSessionTransient,
    updateTopics,
  };
}

describe('MobileControlPlaneConnectionCoordinator', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  test('starts multiple domains through one authentication and event connection', async () => {
    const runtime = harness();
    const ai = domain('ai', ['ai.sessions'], true);
    const directories = domain('directories', ['instances', 'nodes']);
    const apps = domain('apps', ['app.sessions']);

    runtime.coordinator.setEnvironment({ foreground: true, connected: true });
    runtime.coordinator.register(ai);
    runtime.coordinator.register(directories);
    runtime.coordinator.register(apps);
    await flushCoordinator();

    expect(runtime.revalidate).toHaveBeenCalledTimes(1);
    expect(runtime.renewMobileSession).toHaveBeenCalledTimes(1);
    expect(runtime.authSession).toHaveBeenCalledTimes(1);
    expect(runtime.identity).toHaveBeenCalledTimes(1);
    expect(runtime.coordinator.currentCapabilities.stories).toBe(true);
    expect(ai.start).toHaveBeenCalledTimes(1);
    expect(directories.start).toHaveBeenCalledTimes(1);
    expect(apps.start).toHaveBeenCalledTimes(1);
    expect(runtime.connectEvents).toHaveBeenCalledTimes(1);
    expect(runtime.connectEvents.mock.calls[0][0].topics).toEqual(['ai.sessions', 'app.sessions', 'instances', 'nodes']);
    expect(runtime.coordinator.snapshot().phase).toBe('connected');

    runtime.handlers?.onClose();
    jest.advanceTimersByTime(1_000);
    await flushCoordinator();

    expect(runtime.revalidate).toHaveBeenCalledTimes(2);
    expect(runtime.renewMobileSession).toHaveBeenCalledTimes(2);
    expect(runtime.authSession).toHaveBeenCalledTimes(2);
    expect(runtime.connectEvents).toHaveBeenCalledTimes(2);
    runtime.coordinator.stop();
  });

  test('a superseded startup does not open its domains or event connection', async () => {
    const runtime = harness();
    const ai = domain('ai', ['ai.sessions'], true);
    const directories = domain('directories', ['instances', 'nodes']);
    let releaseFirstSession: ((value: { authenticated: boolean }) => void) | undefined;
    runtime.authSession.mockImplementationOnce(() => new Promise((resolve) => { releaseFirstSession = resolve; }));

    runtime.coordinator.setEnvironment({ foreground: true, connected: true });
    runtime.coordinator.register(ai);
    await flushCoordinator();
    expect(runtime.authSession).toHaveBeenCalledTimes(1);

    runtime.coordinator.register(directories);
    await flushCoordinator();
    expect(runtime.coordinator.snapshot().phase).toBe('connected');
    expect(ai.start).toHaveBeenCalledTimes(1);
    expect(directories.start).toHaveBeenCalledTimes(1);
    expect(runtime.connectEvents).toHaveBeenCalledTimes(1);

    releaseFirstSession?.({ authenticated: true });
    await flushCoordinator();
    expect(runtime.authSession).toHaveBeenCalledTimes(2);
    expect(ai.start).toHaveBeenCalledTimes(1);
    expect(directories.start).toHaveBeenCalledTimes(1);
    expect(runtime.connectEvents).toHaveBeenCalledTimes(1);
    expect(runtime.coordinator.snapshot().phase).toBe('connected');
    runtime.coordinator.stop();
  });

  test('aborts a superseded revalidation instead of waiting on its frozen attempt', async () => {
    const runtime = harness();
    const ai = domain('ai', ['ai.sessions'], true);
    const directories = domain('directories', ['instances', 'nodes']);
    let firstSignal: AbortSignal | undefined;
    runtime.revalidate.mockImplementationOnce((signal?: AbortSignal) => new Promise<void>((resolve) => {
      firstSignal = signal;
      signal?.addEventListener('abort', () => resolve(), { once: true });
    }));

    runtime.coordinator.setEnvironment({ foreground: true, connected: true });
    runtime.coordinator.register(ai);
    await flushCoordinator();
    expect(runtime.revalidate).toHaveBeenCalledTimes(1);
    expect(runtime.authSession).not.toHaveBeenCalled();

    runtime.coordinator.register(directories);
    await flushCoordinator();
    expect(firstSignal?.aborted).toBe(true);
    expect(runtime.revalidate).toHaveBeenCalledTimes(2);
    expect(runtime.authSession).toHaveBeenCalledTimes(1);
    expect(ai.start).toHaveBeenCalledTimes(1);
    expect(directories.start).toHaveBeenCalledTimes(1);
    expect(runtime.connectEvents).toHaveBeenCalledTimes(1);
    expect(runtime.coordinator.snapshot().phase).toBe('connected');
    runtime.coordinator.stop();
  });

  test('suspends the transport when the app has no foreground work', async () => {
    const runtime = harness();
    const ai = domain('ai', ['ai.sessions'], true);
    runtime.coordinator.setEnvironment({ foreground: true, connected: true });
    runtime.coordinator.register(ai);
    await flushCoordinator();
    expect(runtime.coordinator.snapshot().phase).toBe('connected');

    runtime.coordinator.setEnvironment({ foreground: false });
    await flushCoordinator();

    expect(runtime.suspend).toHaveBeenCalledTimes(1);
    expect(runtime.coordinator.snapshot().phase).toBe('idle');
    runtime.coordinator.stop();
  });

  test('continues with session verification when v0.0.28 does not support renewal', async () => {
    const runtime = harness();
    runtime.renewMobileSession.mockRejectedValue(new MobileControlPlaneTransportError('DIRECT_HTTP_ERROR', 'Not found', false, 404));
    const ai = domain('ai', ['ai.sessions']);
    runtime.coordinator.setEnvironment({ foreground: true, connected: true });
    runtime.coordinator.register(ai);
    await flushCoordinator();

    expect(runtime.authSession).toHaveBeenCalledTimes(1);
    expect(runtime.coordinator.snapshot().phase).toBe('connected');
    runtime.handlers?.onClose();
    jest.advanceTimersByTime(1_000);
    await flushCoordinator();
    expect(runtime.renewMobileSession).toHaveBeenCalledTimes(1);
    expect(runtime.authSession).toHaveBeenCalledTimes(2);
    runtime.coordinator.stop();
  });

  test('keeps control-plane-closed visible while reconnect attempts are still pending', async () => {
    const runtime = harness();
    const ai = domain('ai', ['ai.sessions']);
    runtime.coordinator.setEnvironment({ foreground: true, connected: true });
    runtime.coordinator.register(ai);
    await flushCoordinator();

    const closed = new MobileControlPlaneTransportError('RELAY_PEER_DETACHED', 'The Control Plane is closed.', true);
    runtime.handlers?.onError(closed);

    expect(runtime.coordinator.snapshot()).toEqual({ phase: 'control-plane-closed', error: 'The Control Plane is closed.' });
    expect(ai.onConnectionError).toHaveBeenCalledWith(closed);

    let releaseReconnect: (() => void) | undefined;
    runtime.revalidate.mockImplementationOnce(() => new Promise<void>((resolve) => { releaseReconnect = resolve; }));
    jest.advanceTimersByTime(1_000);
    await flushCoordinator();

    expect(runtime.revalidate).toHaveBeenCalledTimes(2);
    expect(runtime.coordinator.snapshot().phase).toBe('control-plane-closed');

    releaseReconnect?.();
    await flushCoordinator();
    expect(runtime.coordinator.snapshot().phase).toBe('connected');
    runtime.coordinator.stop();
  });

  test('treats an unavailable Control Plane during initial connection as closed', async () => {
    const runtime = harness();
    const ai = domain('ai', ['ai.sessions']);
    const closed = new MobileControlPlaneTransportError('CONTROL_PLANE_CONNECTION_UNAVAILABLE', 'Control Plane is unavailable.', true, 409);
    runtime.revalidate.mockRejectedValueOnce(closed);
    runtime.coordinator.setEnvironment({ foreground: true, connected: true });
    runtime.coordinator.register(ai);
    await flushCoordinator();

    expect(runtime.coordinator.snapshot()).toEqual({ phase: 'control-plane-closed', error: 'The Control Plane is closed.' });
    expect(ai.onConnectionError).toHaveBeenCalledWith(closed);

    jest.advanceTimersByTime(1_000);
    await flushCoordinator();
    expect(runtime.coordinator.snapshot().phase).toBe('connected');
    runtime.coordinator.stop();
  });

  test('route domain registration and removal update one live connection in place', async () => {
    const runtime = harness();
    const ai = domain('ai', ['ai.sessions'], true);
    runtime.coordinator.setEnvironment({ foreground: true, connected: true });
    runtime.coordinator.register(ai);
    await flushCoordinator();
    expect(runtime.connectEvents).toHaveBeenCalledTimes(1);
    expect(runtime.updateTopics).not.toHaveBeenCalled();

    const detail = domain('ai-session-detail', ['ai.sessions']);
    const unregister = runtime.coordinator.register(detail);
    await flushCoordinator();

    expect(runtime.revalidate).toHaveBeenCalledTimes(1);
    expect(runtime.connectEvents).toHaveBeenCalledTimes(1);
    expect(runtime.close).not.toHaveBeenCalled();
    expect(detail.start).toHaveBeenCalledTimes(1);
    expect(ai.stop).not.toHaveBeenCalled();
    expect(runtime.updateTopics).toHaveBeenLastCalledWith(['ai.sessions']);
    expect(runtime.coordinator.snapshot().phase).toBe('connected');

    unregister();
    await flushCoordinator();
    expect(detail.stop).toHaveBeenCalledTimes(1);
    expect(runtime.connectEvents).toHaveBeenCalledTimes(1);
    expect(runtime.revalidate).toHaveBeenCalledTimes(1);
    expect(ai.start).toHaveBeenCalledTimes(1);
    runtime.coordinator.stop();
  });

  test('a route domain start failure does not tear down the shared connection', async () => {
    const runtime = harness();
    const ai = domain('ai', ['ai.sessions'], true);
    runtime.coordinator.setEnvironment({ foreground: true, connected: true });
    runtime.coordinator.register(ai);
    await flushCoordinator();

    const detail = domain('ai-session-detail', ['ai.sessions']);
    detail.start = jest.fn().mockRejectedValue(new Error('session detail read failed'));
    runtime.coordinator.register(detail);
    await flushCoordinator();

    expect(detail.onConnectionError).toHaveBeenCalledWith(expect.objectContaining({ code: 'CONTROL_PLANE_DOMAIN_START_FAILED', retryable: true }));
    expect(runtime.connectEvents).toHaveBeenCalledTimes(1);
    expect(runtime.close).not.toHaveBeenCalled();
    expect(runtime.revalidate).toHaveBeenCalledTimes(1);
    runtime.coordinator.stop();
  });

  test('opening a session updates transient demand on the live connection in place', async () => {
    const runtime = harness();
    const ai = domain('ai', ['ai.sessions'], true);
    runtime.coordinator.setEnvironment({ foreground: true, connected: true });
    runtime.coordinator.register(ai);
    await flushCoordinator();

    const dispose = runtime.coordinator.registerAiSessionTransientDemand({
      messageDeltas: { allInstances: false, instanceIds: ['instance-1'] },
      timelineAllSessions: false,
      timelineSessions: [{ instanceId: 'instance-1', sessionId: 'session-1' }],
    });
    await flushCoordinator();

    expect(runtime.updateAiSessionTransient).toHaveBeenCalledWith(expect.objectContaining({
      messageDeltas: { allInstances: false, instanceIds: ['instance-1'] },
      timelineSessions: [{ instanceId: 'instance-1', sessionId: 'session-1' }],
    }));
    expect(runtime.revalidate).toHaveBeenCalledTimes(1);
    expect(runtime.connectEvents).toHaveBeenCalledTimes(1);
    expect(runtime.close).not.toHaveBeenCalled();
    expect(runtime.coordinator.snapshot().phase).toBe('connected');

    dispose();
    await flushCoordinator();
    expect(runtime.close).not.toHaveBeenCalled();
    runtime.coordinator.stop();
  });

  test('publishes session-expired when renewal and session verification reject the credential', async () => {
    const runtime = harness();
    runtime.renewMobileSession.mockRejectedValue(new MobileControlPlaneTransportError('CONTROL_PLANE_AUTH_REQUIRED', 'Unauthorized', false, 401));
    runtime.authSession.mockResolvedValue({ authenticated: false });
    const ai = domain('ai', ['ai.sessions']);
    runtime.coordinator.setEnvironment({ foreground: true, connected: true });
    runtime.coordinator.register(ai);
    await flushCoordinator();

    expect(runtime.coordinator.snapshot().phase).toBe('session-expired');
    expect(runtime.connectEvents).not.toHaveBeenCalled();
    runtime.coordinator.stop();
  });

  test('renews again when a continuously active session enters the renewal window', async () => {
    const runtime = harness();
    runtime.renewMobileSession.mockResolvedValue({ expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60_000 + 60_000).toISOString() });
    const ai = domain('ai', ['ai.sessions']);
    runtime.coordinator.setEnvironment({ foreground: true, connected: true });
    runtime.coordinator.register(ai);
    await flushCoordinator();

    expect(runtime.renewMobileSession).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(60_000);
    await flushCoordinator();
    expect(runtime.renewMobileSession).toHaveBeenCalledTimes(2);
    runtime.coordinator.stop();
  });

  test('keeps only background-capable topics while CarPlay is connected', async () => {
    const runtime = harness();
    const ai = domain('ai', ['ai.sessions'], true);
    const directories = domain('directories', ['instances', 'nodes']);
    runtime.coordinator.setEnvironment({ foreground: true, connected: true });
    runtime.coordinator.register(ai);
    runtime.coordinator.register(directories);
    await flushCoordinator();

    runtime.coordinator.setEnvironment({ foreground: false, carPlayConnected: true });
    await flushCoordinator();

    expect(runtime.connectEvents).toHaveBeenCalledTimes(2);
    expect(runtime.connectEvents.mock.calls[1][0].topics).toEqual(['ai.sessions']);
    expect(ai.start).toHaveBeenCalledTimes(2);
    expect(directories.start).toHaveBeenCalledTimes(1);
    expect(directories.stop).toHaveBeenCalledTimes(1);
    runtime.coordinator.stop();
  });
});
