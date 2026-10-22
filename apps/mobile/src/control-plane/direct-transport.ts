import { z } from 'zod';
import { MOBILE_EVENT_STREAM_ROUTE } from '@task-handoff/control-plane-client';
import { TtyStreamSnapshotMessageSchema } from '@task-handoff/protocol/app-sessions';
import {
  COMPACT_EVENT_ENVELOPE_VERSION,
  EventKeepalivePongSchema,
  type AiSessionTransientSubscription,
} from '@task-handoff/protocol/events';
import type { ControlPlanePublicCapabilities } from '@task-handoff/protocol/control-plane-access';

import type { SecureValueStore } from '../platform/secure-storage';
import { assertDirectIdentityCompatible, probeDirectControlPlane } from './direct-enrollment';
import type { MobileDirectControlPlaneProfile } from './profile';
import {
  MOBILE_EVENT_KEEPALIVE_INTERVAL_MS,
  MobileControlPlaneTransportError,
  mobileEventKeepaliveFrame,
  normalizeMobileControlPlaneEvent,
  type MobileAppSessionTtyConnection,
  type MobileAppSessionTtyHandlers,
  type MobileControlPlaneEvent,
  type MobileControlPlaneEventConnection,
  type MobileControlPlaneEventHandlers,
  type MobileControlPlaneTransport,
} from './transport';

const ForwardedEventSchema = z.object({
  type: z.literal('node-agent.event.forwarded'),
  event: z.unknown(),
  scope: z.object({ instanceId: z.string().optional(), nodeId: z.string().optional() }).passthrough().optional(),
}).passthrough();

const DEFAULT_EVENT_TOPICS = ['ai.sessions', 'app.sessions', 'node.state', 'nodes', 'instances', 'system'] as const;

const IncomingTtyMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('connected') }).passthrough(),
  TtyStreamSnapshotMessageSchema,
  z.object({ type: z.literal('output'), data: z.string() }).passthrough(),
  z.object({ type: z.literal('resize'), cols: z.number().int().positive(), rows: z.number().int().positive() }).passthrough(),
  z.object({ type: z.literal('exit'), code: z.number().int().nullable().optional(), signal: z.union([z.string(), z.number()]).nullable().optional() }).passthrough(),
  z.object({ type: z.literal('error'), message: z.string().optional() }).passthrough(),
]);

function normalizeIncomingEvent(event: unknown): MobileControlPlaneEvent | undefined {
  const forwarded = ForwardedEventSchema.safeParse(event);
  return normalizeMobileControlPlaneEvent(
    forwarded.success ? forwarded.data.event : event,
    forwarded.success ? forwarded.data.scope : undefined,
  );
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
  return websocketRouteUrl(origin, MOBILE_EVENT_STREAM_ROUTE);
}

export class DirectControlPlaneTransport implements MobileControlPlaneTransport {
  readonly profile: MobileDirectControlPlaneProfile;
  currentCapabilities?: ControlPlanePublicCapabilities;
  private verified?: Promise<void>;
  private readonly eventSubscribers = new Set<MobileControlPlaneEventHandlers>();
  private eventSocket?: WebSocketLike;
  private eventConnecting?: Promise<void>;
  private eventOpen = false;
  private eventKeepaliveTimer?: ReturnType<typeof setInterval>;

  constructor(
    profile: MobileDirectControlPlaneProfile,
    private readonly secureStore: SecureValueStore,
    private readonly options: {
      fetchImpl?: typeof fetch;
      webSocketFactory?: WebSocketFactory;
      xhrFactory?: () => XMLHttpRequest;
      allowInsecureHttp?: boolean;
      probeImpl?: typeof probeDirectControlPlane;
    } = {},
  ) {
    this.profile = profile;
  }

  async request<T>(route: string, schema: z.ZodType<T>, init: RequestInit = {}, onUploadProgress?: (progress: number) => void) {
    await this.ensureVerified();
    const token = await this.sessionToken();
    const headers = new Headers(init.headers);
    if (headers.has('authorization')) {
      throw new MobileControlPlaneTransportError('DIRECT_AUTH_HEADER_FORBIDDEN', 'Authorization is managed by DirectControlPlaneTransport.');
    }
    headers.set('authorization', `Bearer ${token}`);
    headers.set('accept', 'application/json');
    const url = requestUrl(this.profile.access.origin, route);
    if (onUploadProgress) {
      return requestWithUploadProgress(url, schema, { ...init, headers }, onUploadProgress, this.options.xhrFactory);
    }
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

  async requestBinary(route: string, init: RequestInit = {}): Promise<{ body: Uint8Array; filename?: string; contentType?: string }> {
    await this.ensureVerified();
    const token = await this.sessionToken();
    const headers = new Headers(init.headers);
    if (headers.has('authorization')) {
      throw new MobileControlPlaneTransportError('DIRECT_AUTH_HEADER_FORBIDDEN', 'Authorization is managed by DirectControlPlaneTransport.');
    }
    headers.set('authorization', `Bearer ${token}`);
    headers.set('accept', 'application/octet-stream, application/gzip, */*');
    headers.set('accept-encoding', 'identity');
    let response: Response;
    try {
      response = await (this.options.fetchImpl ?? fetch)(requestUrl(this.profile.access.origin, route), {
        ...init,
        headers,
        credentials: 'omit',
        redirect: 'error',
      });
    } catch {
      throw new MobileControlPlaneTransportError('DIRECT_NETWORK_FAILED', 'The Control Plane request could not be completed.', true);
    }
    if (!response.ok) {
      const body = await response.json().catch(() => undefined);
      throw responseError(response.status, body);
    }
    const disposition = response.headers.get('content-disposition') ?? '';
    const filename = dispositionFilename(disposition);
    return {
      body: new Uint8Array(await response.arrayBuffer()),
      ...(filename ? { filename } : {}),
      ...(response.headers.get('content-type') ? { contentType: response.headers.get('content-type')! } : {}),
    };
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
      updateTopics: (topics) => {
        handlers.topics = topics;
        this.sendEventSubscription();
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
          this.startEventKeepalive(socket);
          for (const subscriber of [...this.eventSubscribers]) subscriber.onOpen();
        });
        socket.addEventListener('message', (event) => {
          if (this.eventSocket !== socket) return;
          try {
            const raw = JSON.parse(String(event.data));
            // The keepalive answer is not an event envelope; the web console drops it
            // the same way instead of treating it as a protocol violation.
            if (EventKeepalivePongSchema.safeParse(raw).success) return;
            const normalized = normalizeIncomingEvent(raw);
            if (!normalized) throw new Error('Event envelope did not match the protocol.');
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
          this.stopEventKeepalive();
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
    this.stopEventKeepalive();
    socket?.close(1000, 'Client closed');
  }

  /**
   * A silent event stream is what an intermediate reverse proxy reaps, and the
   * reaped stream comes back as a full directory bootstrap. The Control Plane
   * event transport answers this ping with a pong.
   */
  private startEventKeepalive(socket: WebSocketLike) {
    this.stopEventKeepalive();
    const timer = setInterval(() => {
      if (this.eventSocket !== socket || !this.eventOpen || socket.readyState !== 1) return;
      try { socket.send(JSON.stringify(mobileEventKeepaliveFrame())); }
      catch { /* the socket close/error path owns reconnect */ }
    }, MOBILE_EVENT_KEEPALIVE_INTERVAL_MS);
    // A keepalive must never be the reason a process stays alive; React Native
    // returns a numeric handle and simply ignores the call.
    (timer as unknown as { unref?(): void }).unref?.();
    this.eventKeepaliveTimer = timer;
  }

  private stopEventKeepalive() {
    if (this.eventKeepaliveTimer) clearInterval(this.eventKeepaliveTimer);
    this.eventKeepaliveTimer = undefined;
  }

  private sendEventSubscription() {
    const socket = this.eventSocket;
    if (!this.eventOpen || !socket) return;
    const topics = new Set<string>();
    for (const subscriber of this.eventSubscribers) {
      for (const topic of subscriber.topics ?? DEFAULT_EVENT_TOPICS) topics.add(topic);
    }
    const aiSessionTransient = aggregateTransientDemand(this.eventSubscribers, topics);
    socket.send(JSON.stringify({ v: 1, type: 'subscribe', eventEnvelopeVersion: COMPACT_EVENT_ENVELOPE_VERSION, aiSessionHierarchy: { subagents: true }, topics: [...topics].sort(), metricInstanceIds: [], ...(aiSessionTransient ? { aiSessionTransient } : {}) }));
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
      this.currentCapabilities = target.identity.capabilities;
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

function requestWithUploadProgress<T>(
  url: string,
  schema: z.ZodType<T>,
  init: RequestInit,
  onUploadProgress: (progress: number) => void,
  xhrFactory: (() => XMLHttpRequest) | undefined,
) {
  return new Promise<T>((resolve, reject) => {
    const xhr = xhrFactory ? xhrFactory() : new XMLHttpRequest();
    const signal = init.signal;
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', abort);
      callback();
    };
    const abort = () => xhr.abort();
    xhr.open(init.method || 'GET', url, true);
    xhr.withCredentials = false;
    for (const [name, value] of new Headers(init.headers)) xhr.setRequestHeader(name, value);
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && event.total > 0) onUploadProgress(Math.min(1, event.loaded / event.total));
    };
    xhr.onload = () => {
      let body: unknown;
      try {
        body = xhr.responseText ? JSON.parse(xhr.responseText) : undefined;
      } catch {
        finish(() => reject(new MobileControlPlaneTransportError('DIRECT_RESPONSE_INVALID', 'The Control Plane returned a non-JSON response.', false, xhr.status)));
        return;
      }
      if (xhr.status < 200 || xhr.status >= 300) {
        finish(() => reject(responseError(xhr.status, body)));
        return;
      }
      const parsed = schema.safeParse(body);
      finish(() => parsed.success
        ? resolve(parsed.data)
        : reject(new MobileControlPlaneTransportError('DIRECT_RESPONSE_SCHEMA_INVALID', 'The Control Plane response did not match the expected schema.', false, xhr.status)));
    };
    xhr.onerror = () => finish(() => reject(new MobileControlPlaneTransportError('DIRECT_NETWORK_FAILED', 'The Control Plane request could not be completed.', true)));
    xhr.onabort = () => finish(() => reject(new MobileControlPlaneTransportError('DIRECT_REQUEST_ABORTED', 'The Control Plane request was cancelled.')));
    if (signal?.aborted) {
      abort();
      return;
    }
    signal?.addEventListener('abort', abort, { once: true });
    xhr.send((init.body ?? null) as XMLHttpRequestBodyInit | null);
  });
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

function dispositionFilename(disposition: string) {
  const raw = /filename\*?=(?:UTF-8''|")?([^";]+)/i.exec(disposition)?.[1]?.trim();
  if (!raw) return undefined;
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
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
