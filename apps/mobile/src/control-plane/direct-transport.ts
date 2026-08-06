import { z } from 'zod';

import type { SecureValueStore } from '../platform/secure-storage';
import { assertDirectIdentityCompatible, probeDirectControlPlane } from './direct-enrollment';
import type { MobileControlPlaneProfile } from './profile';
import {
  MobileControlPlaneTransportError,
  type MobileControlPlaneEvent,
  type MobileControlPlaneEventConnection,
  type MobileControlPlaneEventHandlers,
  type MobileControlPlaneTransport,
} from './transport';

const EventSchema = z.object({
  v: z.literal(1),
  type: z.string().trim().min(1),
  topic: z.string().trim().min(1).optional(),
  payload: z.unknown(),
  scope: z.object({ instanceId: z.string().optional(), nodeId: z.string().optional() }).passthrough().optional(),
}).passthrough();

const ForwardedEventSchema = z.object({
  type: z.literal('node-agent.event.forwarded'),
  event: EventSchema,
  scope: z.object({ instanceId: z.string().optional(), nodeId: z.string().optional() }).passthrough().optional(),
}).passthrough();

const IncomingEventSchema = z.union([ForwardedEventSchema, EventSchema]);

function normalizeIncomingEvent(event: z.infer<typeof IncomingEventSchema>): MobileControlPlaneEvent {
  const forwarded = ForwardedEventSchema.safeParse(event);
  if (!forwarded.success) return event;
  return {
    ...forwarded.data.event,
    scope: { ...forwarded.data.scope, ...forwarded.data.event.scope },
  };
}

type WebSocketLike = {
  readyState: number;
  addEventListener(type: 'open' | 'message' | 'error' | 'close', listener: (event: { data?: unknown }) => void): void;
  close(code?: number, reason?: string): void;
  send(data: string): void;
};
type WebSocketFactory = (url: string, headers: Record<string, string>) => WebSocketLike;

function defaultWebSocketFactory(url: string, headers: Record<string, string>) {
  const ReactNativeWebSocket = WebSocket as unknown as new (
    target: string,
    protocols?: string | string[],
    options?: { headers?: Record<string, string> },
  ) => WebSocket;
  return new ReactNativeWebSocket(url, undefined, { headers });
}

function requestUrl(origin: string, route: string) {
  if (!route.startsWith('/') || route.startsWith('//')) {
    throw new MobileControlPlaneTransportError('DIRECT_ROUTE_INVALID', 'Control Plane routes must be same-origin absolute paths.');
  }
  const url = new URL(route, origin);
  if (url.origin !== origin) {
    throw new MobileControlPlaneTransportError('DIRECT_CROSS_ORIGIN_FORBIDDEN', 'A Direct transport request cannot leave its verified Control Plane origin.');
  }
  return url.toString();
}

function websocketUrl(origin: string) {
  const url = new URL('/api/events', origin);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.toString();
}

export class DirectControlPlaneTransport implements MobileControlPlaneTransport {
  readonly profile: MobileControlPlaneProfile;
  private verified?: Promise<void>;

  constructor(
    profile: MobileControlPlaneProfile,
    private readonly secureStore: SecureValueStore,
    private readonly options: {
      fetchImpl?: typeof fetch;
      webSocketFactory?: WebSocketFactory;
      allowInsecureHttp?: boolean;
      probeImpl?: typeof probeDirectControlPlane;
    } = {},
  ) {
    this.profile = profile;
  }

  async request<T>(route: string, schema: z.ZodType<T>, init: RequestInit = {}) {
    await this.ensureVerified();
    const token = await this.sessionToken();
    const headers = new Headers(init.headers);
    if (headers.has('authorization')) {
      throw new MobileControlPlaneTransportError('DIRECT_AUTH_HEADER_FORBIDDEN', 'Authorization is managed by DirectControlPlaneTransport.');
    }
    headers.set('authorization', `Bearer ${token}`);
    headers.set('accept', 'application/json');
    const url = requestUrl(this.profile.access.origin, route);
    let response: Response;
    try {
      response = await (this.options.fetchImpl ?? fetch)(url, {
        ...init,
        headers,
        credentials: 'omit',
        redirect: 'error',
      });
    } catch {
      throw new MobileControlPlaneTransportError('DIRECT_NETWORK_FAILED', 'The Control Plane request could not be completed.', true);
    }
    const body = await parseJson(response);
    if (!response.ok) throw responseError(response.status, body);
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      throw new MobileControlPlaneTransportError('DIRECT_RESPONSE_SCHEMA_INVALID', 'The Control Plane response did not match the expected schema.', false, response.status);
    }
    return parsed.data;
  }

  connectEvents(handlers: MobileControlPlaneEventHandlers): MobileControlPlaneEventConnection {
    let socket: WebSocketLike | undefined;
    let closed = false;
    void (async () => {
      try {
        await this.ensureVerified();
        const token = await this.sessionToken();
        if (closed) return;
        socket = (this.options.webSocketFactory ?? defaultWebSocketFactory)(
          websocketUrl(this.profile.access.origin),
          { authorization: `Bearer ${token}` },
        );
        socket.addEventListener('open', () => {
          if (closed) return;
          socket?.send(JSON.stringify({ v: 1, type: 'subscribe', topics: ['ai.sessions', 'app.sessions', 'nodes', 'instances', 'system'] }));
          handlers.onOpen();
        });
        socket.addEventListener('message', (event) => {
          if (closed) return;
          try {
            const parsed = IncomingEventSchema.safeParse(JSON.parse(String(event.data)));
            if (!parsed.success) throw new Error('Event envelope did not match the protocol.');
            handlers.onEvent(normalizeIncomingEvent(parsed.data));
          } catch {
            handlers.onError(new MobileControlPlaneTransportError('DIRECT_EVENT_INVALID', 'The Control Plane sent an invalid event envelope.'));
            socket?.close(1002, 'Invalid event envelope');
          }
        });
        socket.addEventListener('error', () => {
          if (!closed) handlers.onError(new MobileControlPlaneTransportError('DIRECT_EVENT_CONNECTION_FAILED', 'The Control Plane event connection failed.', true));
        });
        socket.addEventListener('close', () => {
          if (!closed) handlers.onClose();
        });
      } catch (cause) {
        if (!closed) handlers.onError(asTransportError(cause));
      }
    })();
    return {
      close() {
        closed = true;
        socket?.close(1000, 'Client closed');
      },
    };
  }

  async revalidate() {
    this.verified = undefined;
    await this.ensureVerified();
  }

  private async ensureVerified() {
    this.verified ??= (async () => {
      const target = await (this.options.probeImpl ?? probeDirectControlPlane)(this.profile.access.origin, {
        allowInsecureHttp: this.options.allowInsecureHttp,
        fetchImpl: this.options.fetchImpl,
      });
      assertDirectIdentityCompatible(target, [this.profile]);
      if (target.identity.capabilities.authentication !== 'required') {
        throw new MobileControlPlaneTransportError(
          'DIRECT_AUTH_REQUIRED',
          'Enable authentication on the Control Plane before reconnecting remotely.',
        );
      }
    })();
    try {
      await this.verified;
    } catch (cause) {
      this.verified = undefined;
      throw asTransportError(cause);
    }
  }

  private async sessionToken() {
    const token = await this.secureStore.get(this.profile.access.secureSessionKey);
    if (!token) throw new MobileControlPlaneTransportError('DIRECT_SESSION_MISSING', 'The mobile Control Plane session is missing. Sign in again.');
    return token;
  }
}

async function parseJson(response: Response) {
  try {
    return await response.json();
  } catch {
    throw new MobileControlPlaneTransportError('DIRECT_RESPONSE_INVALID', 'The Control Plane returned a non-JSON response.', false, response.status);
  }
}

function responseError(status: number, body: unknown) {
  const record = body && typeof body === 'object' && 'error' in body ? (body as { error?: { code?: unknown; message?: unknown; retryable?: unknown } }).error : undefined;
  return new MobileControlPlaneTransportError(
    typeof record?.code === 'string' ? record.code : 'DIRECT_HTTP_ERROR',
    typeof record?.message === 'string' ? record.message : `Control Plane request failed with HTTP ${status}.`,
    typeof record?.retryable === 'boolean' ? record.retryable : status >= 500,
    status,
  );
}

function asTransportError(cause: unknown) {
  if (cause instanceof MobileControlPlaneTransportError) return cause;
  if (cause && typeof cause === 'object' && 'code' in cause && 'message' in cause) {
    const value = cause as { code: unknown; message: unknown; retryable?: unknown; status?: unknown };
    return new MobileControlPlaneTransportError(
      typeof value.code === 'string' ? value.code : 'DIRECT_CONNECTION_FAILED',
      typeof value.message === 'string' ? value.message : 'The Direct Control Plane connection failed.',
      value.retryable === true,
      typeof value.status === 'number' ? value.status : undefined,
    );
  }
  return new MobileControlPlaneTransportError('DIRECT_CONNECTION_FAILED', cause instanceof Error ? cause.message : 'The Direct Control Plane connection failed.');
}
