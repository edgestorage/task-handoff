import { z } from 'zod';
import { TtyStreamSnapshotMessageSchema } from '@task-handoff/protocol/app-sessions';
import type { AiSessionTransientSubscription } from '@task-handoff/protocol/events';

import type { SecureValueStore } from '../platform/secure-storage';
import { assertDirectIdentityCompatible, probeDirectControlPlane } from './direct-enrollment';
import type { MobileDirectControlPlaneProfile } from './profile';
import {
  MobileControlPlaneTransportError,
  type MobileAppSessionTtyConnection,
  type MobileAppSessionTtyHandlers,
  type MobileControlPlaneEvent,
  type MobileControlPlaneEventConnection,
  type MobileControlPlaneEventHandlers,
  type MobileControlPlaneTransport,
} from './transport';

const EventSchema = z.object({
  v: z.literal(1),
  type: z.string().trim().min(1),
  replay: z.boolean().optional(),
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
const DEFAULT_EVENT_TOPICS = ['ai.sessions', 'app.sessions', 'node.state', 'nodes', 'instances', 'system'] as const;

const IncomingTtyMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('connected') }).passthrough(),
  TtyStreamSnapshotMessageSchema,
  z.object({ type: z.literal('output'), data: z.string() }).passthrough(),
  z.object({ type: z.literal('resize'), cols: z.number().int().positive(), rows: z.number().int().positive() }).passthrough(),
  z.object({ type: z.literal('exit'), code: z.number().int().nullable().optional(), signal: z.union([z.string(), z.number()]).nullable().optional() }).passthrough(),
  z.object({ type: z.literal('error'), message: z.string().optional() }).passthrough(),
]);

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

function websocketRouteUrl(origin: string, route: string) {
  const url = new URL(requestUrl(origin, route));
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.toString();
}

function websocketUrl(origin: string) {
  return websocketRouteUrl(origin, '/api/events?aiSessionTransient=1');
}

export class DirectControlPlaneTransport implements MobileControlPlaneTransport {
  readonly profile: MobileDirectControlPlaneProfile;
  private verified?: Promise<void>;
  private readonly eventSubscribers = new Set<MobileControlPlaneEventHandlers>();
  private eventSocket?: WebSocketLike;
  private eventConnecting?: Promise<void>;
  private eventOpen = false;

  constructor(
    profile: MobileDirectControlPlaneProfile,
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
    let closed = false;
    this.eventSubscribers.add(handlers);
    if (this.eventOpen) {
      this.sendEventSubscription();
      handlers.onOpen();
    }
    else void this.ensureEventConnection();
    return {
      close: () => {
        if (closed) return;
        closed = true;
        this.eventSubscribers.delete(handlers);
        if (!this.eventSubscribers.size) this.closeEventConnection();
        else if (this.eventOpen) this.sendEventSubscription();
      },
      updateAiSessionTransient: (subscription) => {
        handlers.aiSessionTransient = subscription;
        this.sendEventSubscription();
      },
    };
  }

  private ensureEventConnection() {
    if (this.eventSocket || this.eventConnecting || !this.eventSubscribers.size) return this.eventConnecting;
    this.eventConnecting = (async () => {
      try {
        await this.ensureVerified();
        const token = await this.sessionToken();
        if (!this.eventSubscribers.size || this.eventSocket) return;
        const socket = (this.options.webSocketFactory ?? defaultWebSocketFactory)(
          websocketUrl(this.profile.access.origin),
          { authorization: `Bearer ${token}` },
        );
        this.eventSocket = socket;
        socket.addEventListener('open', () => {
          if (this.eventSocket !== socket) return;
          this.eventOpen = true;
          this.sendEventSubscription();
          for (const subscriber of [...this.eventSubscribers]) subscriber.onOpen();
        });
        socket.addEventListener('message', (event) => {
          if (this.eventSocket !== socket) return;
          try {
            const parsed = IncomingEventSchema.safeParse(JSON.parse(String(event.data)));
            if (!parsed.success) throw new Error('Event envelope did not match the protocol.');
            const normalized = normalizeIncomingEvent(parsed.data);
            for (const subscriber of [...this.eventSubscribers]) subscriber.onEvent(normalized);
          } catch {
            const error = new MobileControlPlaneTransportError('DIRECT_EVENT_INVALID', 'The Control Plane sent an invalid event envelope.');
            for (const subscriber of [...this.eventSubscribers]) subscriber.onError(error);
            socket.close(1002, 'Invalid event envelope');
          }
        });
        socket.addEventListener('error', () => {
          if (this.eventSocket !== socket) return;
          const error = new MobileControlPlaneTransportError('DIRECT_EVENT_CONNECTION_FAILED', 'The Control Plane event connection failed.', true);
          for (const subscriber of [...this.eventSubscribers]) subscriber.onError(error);
        });
        socket.addEventListener('close', () => {
          if (this.eventSocket !== socket) return;
          this.eventSocket = undefined;
          this.eventOpen = false;
          for (const subscriber of [...this.eventSubscribers]) subscriber.onClose();
        });
      } catch (cause) {
        const error = asTransportError(cause);
        for (const subscriber of [...this.eventSubscribers]) subscriber.onError(error);
      } finally {
        this.eventConnecting = undefined;
      }
    })();
    return this.eventConnecting;
  }

  private closeEventConnection() {
    const socket = this.eventSocket;
    this.eventSocket = undefined;
    this.eventOpen = false;
    socket?.close(1000, 'Client closed');
  }

  private sendEventSubscription() {
    const socket = this.eventSocket;
    if (!this.eventOpen || !socket) return;
    const topics = new Set<string>();
    for (const subscriber of this.eventSubscribers) {
      for (const topic of subscriber.topics ?? DEFAULT_EVENT_TOPICS) topics.add(topic);
    }
    const aiSessionTransient = aggregateTransientDemand(this.eventSubscribers, topics);
    socket.send(JSON.stringify({ v: 1, type: 'subscribe', topics: [...topics].sort(), ...(aiSessionTransient ? { aiSessionTransient } : {}) }));
  }

  connectAppSessionTty(instanceId: string, sessionId: string, handlers: MobileAppSessionTtyHandlers): MobileAppSessionTtyConnection {
    let socket: WebSocketLike | undefined;
    let closed = false;
    let open = false;
    let pendingResize: { cols: number; rows: number } | undefined;
    const send = (message: unknown) => {
      if (open && socket?.readyState === 1) socket.send(JSON.stringify(message));
    };
    void (async () => {
      try {
        await this.ensureVerified();
        const token = await this.sessionToken();
        if (closed) return;
        const route = `/instances/${encodeURIComponent(instanceId)}/api/apps/sessions/${encodeURIComponent(sessionId)}/tty`;
        socket = (this.options.webSocketFactory ?? defaultWebSocketFactory)(
          websocketRouteUrl(this.profile.access.origin, route),
          { authorization: `Bearer ${token}` },
        );
        socket.addEventListener('open', () => {
          if (closed) return;
          open = true;
          handlers.onOpen();
          if (pendingResize) send({ type: 'resize', ...pendingResize });
        });
        socket.addEventListener('message', (event) => {
          if (closed || typeof event.data !== 'string') return;
          try {
            const parsed = IncomingTtyMessageSchema.safeParse(JSON.parse(event.data));
            if (!parsed.success) return;
            const message = parsed.data;
            if (message.type === 'snapshot') handlers.onSnapshot(message.data, message.pendingEscape, message.cols, message.rows);
            else if (message.type === 'output') handlers.onOutput(message.data);
            else if (message.type === 'resize') handlers.onResize(message.cols, message.rows);
            else if (message.type === 'exit') handlers.onExit(message.code, message.signal == null ? null : String(message.signal));
            else if (message.type === 'error') handlers.onError(new MobileControlPlaneTransportError('TTY_SESSION_ERROR', message.message || 'TTY session error.'));
          } catch {
            handlers.onError(new MobileControlPlaneTransportError('TTY_MESSAGE_INVALID', 'The TTY session sent an invalid message.'));
          }
        });
        socket.addEventListener('error', () => {
          if (!closed) handlers.onError(new MobileControlPlaneTransportError('TTY_CONNECTION_FAILED', 'The TTY session connection failed.', true));
        });
        socket.addEventListener('close', () => {
          open = false;
          if (!closed) handlers.onClose();
        });
      } catch (cause) {
        if (!closed) handlers.onError(asTransportError(cause));
      }
    })();
    return {
      sendInput(data: string) {
        if (data) send({ type: 'input', data });
      },
      resize(cols: number, rows: number) {
        if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols <= 0 || rows <= 0) return;
        pendingResize = { cols, rows };
        send({ type: 'resize', cols, rows });
      },
      close() {
        closed = true;
        open = false;
        socket?.close(1000, 'Client closed');
      },
    } satisfies MobileAppSessionTtyConnection;
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

function aggregateTransientDemand(subscribers: Iterable<MobileControlPlaneEventHandlers>, topics: Set<string>): AiSessionTransientSubscription | undefined {
  if (![...topics].some((topic) => topic === 'ai.sessions' || topic === '*')) return undefined;
  const selected = [...subscribers].filter((entry) => (entry.topics ?? DEFAULT_EVENT_TOPICS).some((topic) => topic === 'ai.sessions' || topic === '*'));
  if (selected.some((entry) => !entry.aiSessionTransient)) return undefined;
  const instanceIds = new Set<string>();
  const timelineSessions = new Map<string, { instanceId: string; sessionId: string }>();
  let allInstances = false;
  let timelineAllSessions = false;
  let replaySince: string | undefined;
  for (const entry of selected) {
    const demand = entry.aiSessionTransient!;
    allInstances ||= demand.messageDeltas.allInstances;
    timelineAllSessions ||= demand.timelineAllSessions;
    for (const id of demand.messageDeltas.instanceIds) instanceIds.add(id);
    for (const session of demand.timelineSessions) timelineSessions.set(`${session.instanceId}\0${session.sessionId}`, session);
    if (demand.replaySince && (!replaySince || demand.replaySince < replaySince)) replaySince = demand.replaySince;
  }
  return { ...(replaySince ? { replaySince } : {}), messageDeltas: { allInstances, instanceIds: [...instanceIds] }, timelineAllSessions, timelineSessions: [...timelineSessions.values()] };
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
