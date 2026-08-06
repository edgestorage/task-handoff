import { z } from 'zod';

import { DirectControlPlaneTransport } from '../src/control-plane/direct-transport';
import type { MobileControlPlaneProfile } from '../src/control-plane/profile';
import type { SecureValueStore } from '../src/platform/secure-storage';

const fingerprint = `sha256:${'b'.repeat(43)}`;
const profile: MobileControlPlaneProfile = {
  version: 1,
  identity: { controlPlaneId: 'control_plane_test', publicKeyFingerprint: fingerprint, protocolVersion: '2026-08-05' },
  access: { kind: 'direct', origin: 'https://control.example.com', secureSessionKey: 'session.test' },
  capabilities: { authentication: 'required', aiSessions: true, nodes: true, instanceBoard: true },
  createdAt: '2026-08-05T00:00:00.000Z',
  updatedAt: '2026-08-05T00:00:00.000Z',
};

const target = {
  origin: profile.access.origin,
  identity: {
    version: 1 as const,
    kind: 'control-plane' as const,
    controlPlaneId: profile.identity.controlPlaneId,
    publicKey: { algorithm: 'Ed25519' as const, encoding: 'base64url' as const, value: 'a'.repeat(43), fingerprint },
    capabilities: profile.capabilities,
    protocolVersion: '2026-08-05',
    issuedAt: '2026-08-05T00:00:00.000Z',
    expiresAt: '2026-08-05T00:05:00.000Z',
  },
};

function secureStore(token = 'msess_test.secret'): SecureValueStore {
  return {
    available: async () => true,
    get: async () => token,
    set: async () => undefined,
    remove: async () => undefined,
  };
}

describe('DirectControlPlaneTransport', () => {
  test('keeps HTTP requests on the verified origin and owns the bearer header', async () => {
    const fetchImpl = jest.fn<Promise<Response>, [RequestInfo | URL, RequestInit?]>(async () => new Response(JSON.stringify({ data: { ok: true } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    const transport = new DirectControlPlaneTransport(profile, secureStore(), {
      fetchImpl: fetchImpl as typeof fetch,
      probeImpl: async () => target,
    });

    const response = await transport.request('/api/example', z.object({ data: z.object({ ok: z.literal(true) }) }));

    expect(response.data.ok).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0][0]).toBe('https://control.example.com/api/example');
    const init = fetchImpl.mock.calls[0][1] as RequestInit;
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer msess_test.secret');
    expect(init.credentials).toBe('omit');
    await expect(transport.request('https://evil.example/api', z.unknown())).rejects.toMatchObject({ code: 'DIRECT_ROUTE_INVALID' });
  });

  test('preserves structured Control Plane errors', async () => {
    const transport = new DirectControlPlaneTransport(profile, secureStore(), {
      fetchImpl: async () => new Response(JSON.stringify({ error: { code: 'CONTROL_PLANE_FORBIDDEN', message: 'No access.', retryable: false } }), { status: 403 }),
      probeImpl: async () => target,
    });

    await expect(transport.request('/api/projects', z.unknown())).rejects.toMatchObject({
      code: 'CONTROL_PLANE_FORBIDDEN',
      status: 403,
      retryable: false,
    });
  });

  test('explicit foreground revalidation does not reuse an earlier identity probe', async () => {
    const probeImpl = jest.fn().mockResolvedValue(target);
    const transport = new DirectControlPlaneTransport(profile, secureStore(), { probeImpl });
    await transport.revalidate();
    await transport.revalidate();
    expect(probeImpl).toHaveBeenCalledTimes(2);
  });

  test('blocks an existing profile when the Control Plane disables authentication', async () => {
    const fetchImpl = jest.fn();
    const transport = new DirectControlPlaneTransport(profile, secureStore(), {
      fetchImpl: fetchImpl as typeof fetch,
      probeImpl: async () => ({
        ...target,
        identity: {
          ...target.identity,
          capabilities: { ...target.identity.capabilities, authentication: 'disabled' },
        },
      }),
    });

    await expect(transport.request('/api/projects', z.unknown())).rejects.toMatchObject({ code: 'DIRECT_AUTH_REQUIRED' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test('uses the same origin and bearer session for WSS events', async () => {
    const listeners = new Map<string, (event: { data?: unknown }) => void>();
    const socket = {
      readyState: 0,
      addEventListener: jest.fn((type: string, listener: (event: { data?: unknown }) => void) => listeners.set(type, listener)),
      close: jest.fn(),
      send: jest.fn(),
    };
    const factory = jest.fn((_url: string, _headers: Record<string, string>) => socket);
    const onEvent = jest.fn();
    const transport = new DirectControlPlaneTransport(profile, secureStore(), {
      probeImpl: async () => target,
      webSocketFactory: factory,
    });
    transport.connectEvents({ onOpen: jest.fn(), onEvent, onError: jest.fn(), onClose: jest.fn() });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(factory).toHaveBeenCalledWith('wss://control.example.com/api/events', { authorization: 'Bearer msess_test.secret' });
    listeners.get('open')?.({});
    expect(socket.send).toHaveBeenCalledWith(expect.stringContaining('"type":"subscribe"'));
    listeners.get('message')?.({ data: JSON.stringify({ v: 1, type: 'streams.hello', topic: 'system', payload: {} }) });
    expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'streams.hello' }));
  });

  test('unwraps forwarded node-agent events before delivering them to consumers', async () => {
    const listeners = new Map<string, (event: { data?: unknown }) => void>();
    const socket = {
      readyState: 0,
      addEventListener: jest.fn((type: string, listener: (event: { data?: unknown }) => void) => listeners.set(type, listener)),
      close: jest.fn(),
      send: jest.fn(),
    };
    const onEvent = jest.fn();
    const onError = jest.fn();
    const transport = new DirectControlPlaneTransport(profile, secureStore(), {
      probeImpl: async () => target,
      webSocketFactory: () => socket,
    });
    transport.connectEvents({ onOpen: jest.fn(), onEvent, onError, onClose: jest.fn() });
    await new Promise((resolve) => setTimeout(resolve, 0));

    listeners.get('message')?.({
      data: JSON.stringify({
        type: 'node-agent.event.forwarded',
        scope: { nodeId: 'node-1' },
        event: {
          v: 1,
          type: 'ai-session.message-delta',
          topic: 'ai.sessions',
          payload: { sessionId: 'session-1', messageId: 'message-1', delta: 'Hello' },
          scope: { instanceId: 'instance-1' },
        },
      }),
    });

    expect(onEvent).toHaveBeenCalledWith({
      v: 1,
      type: 'ai-session.message-delta',
      topic: 'ai.sessions',
      payload: { sessionId: 'session-1', messageId: 'message-1', delta: 'Hello' },
      scope: { nodeId: 'node-1', instanceId: 'instance-1' },
    });
    expect(onError).not.toHaveBeenCalled();
    expect(socket.close).not.toHaveBeenCalled();
  });
});
