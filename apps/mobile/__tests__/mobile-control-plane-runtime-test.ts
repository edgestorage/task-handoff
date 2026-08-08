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

const profile: MobileControlPlaneProfile = {
  version: 1,
  identity: {
    controlPlaneId: 'control_plane_runtime',
    publicKeyFingerprint: `sha256:${'b'.repeat(43)}`,
    protocolVersion: '2026-08-05',
  },
  access: { kind: 'direct', origin: 'https://control.example.com', secureSessionKey: 'session.runtime' },
  capabilities: { authentication: 'required', aiSessions: true, nodes: true, instanceBoard: true },
  createdAt: '2026-08-05T00:00:00.000Z',
  updatedAt: '2026-08-05T00:00:00.000Z',
};

async function flushCoordinator() {
  jest.runAllTicks();
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
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
  const revalidate = jest.fn().mockResolvedValue(undefined);
  const connectEvents = jest.fn((next: MobileControlPlaneEventHandlers) => {
    handlers = next;
    next.onOpen();
    return { close };
  });
  const authSession = jest.fn().mockResolvedValue({ authenticated: true });
  const api = { auth: { session: authSession } } as unknown as ControlPlaneClient;
  const transport = {
    profile,
    revalidate,
    connectEvents,
  } as unknown as MobileControlPlaneTransport;
  return {
    coordinator: new MobileControlPlaneConnectionCoordinator(profile, api, transport),
    authSession,
    close,
    connectEvents,
    get handlers() { return handlers; },
    revalidate,
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
    expect(runtime.authSession).toHaveBeenCalledTimes(1);
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
    expect(runtime.authSession).toHaveBeenCalledTimes(2);
    expect(runtime.connectEvents).toHaveBeenCalledTimes(2);
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
