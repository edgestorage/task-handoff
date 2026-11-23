import crypto from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { createEntityId } from "@task-handoff/protocol/control-plane";
import {
  EMBEDDED_BROWSER_CREATION_WAIT_MS,
  EMBEDDED_BROWSER_REQUEST_TIMEOUT_MS,
  EmbeddedBrowserBrowserCancelDownloadParamsSchema,
  EmbeddedBrowserBrowserSetDownloadBehaviorParamsSchema,
  EmbeddedBrowserBrowserTargetInfoSchema,
  EmbeddedBrowserStorageClearCookiesParamsSchema,
  EmbeddedBrowserStorageGetCookiesParamsSchema,
  EmbeddedBrowserStorageSetCookiesParamsSchema,
  EmbeddedBrowserTargetAttachToTargetParamsSchema,
  EmbeddedBrowserTargetCloseTargetParamsSchema,
  EmbeddedBrowserTargetCreateTargetParamsSchema,
  EmbeddedBrowserTargetDetachFromTargetParamsSchema,
  EmbeddedBrowserTargetGetTargetInfoParamsSchema,
  EmbeddedBrowserTargetSetAutoAttachParamsSchema,
  EmbeddedBrowserTargetSetDiscoverTargetsParamsSchema,
  assertEmbeddedBrowserCdpMethod,
  embeddedBrowserTargetInfoFromPage,
  embeddedBrowserCdpProtocolDocument,
  supportsEmbeddedBrowserTargetCdpMethod,
  type EmbeddedBrowserTargetInfo,
  type EmbeddedBrowserTargetFilter,
  type EmbeddedBrowserCdpIdentity,
} from "@task-handoff/protocol/embedded-browser-control";
import { BrowserControlError, type BrowserControlErrorDetails, type BrowserControlService } from "./browser-control.ts";
import type {
  BrowserControlCdpEvent,
  BrowserControlRelayRegistry,
} from "./browser-control-relay.ts";

const DETACH_TIMEOUT_MS = 1_000;
const PUBLIC_ROUTE = { config: { taskHandoffAuth: "public" as const } };

type BrowserCdpBridgeOptions = {
  app: FastifyInstance;
  service: BrowserControlService;
  relay: BrowserControlRelayRegistry;
  httpEndpoint: string;
  sessionExists: (sessionRef: string) => boolean;
  creationWaitMs?: number;
};

type CdpRequestAuth = {
  token: string;
  sessionRef: string;
};

type CdpSocket = {
  send(data: string, options?: { binary?: boolean; compress?: boolean }): void;
  close(code?: number, reason?: string): void;
  on(event: "message" | "close" | "error", listener: (...args: any[]) => void): void;
  off(event: "message" | "close" | "error", listener: (...args: any[]) => void): void;
};

type BrowserTargetSession = {
  sessionId: string;
  leaseRef: string;
  tabRef: string;
  sourceRef: string;
  generation: number;
  // Chrome uses the page target id as the main frame id. Electron webviews use
  // their own frame id, so the bridge translates between the two.
  mainFrameId?: string;
};

type FrameIdTranslation = {
  tabRef: string;
  mainFrameId?: string;
};

type BrowserConnection = {
  socket: CdpSocket;
  sessionRef: string;
  discover: boolean;
  autoAttach?: {
    waitForDebuggerOnStart: boolean;
    flatten: true;
    filter?: EmbeddedBrowserTargetFilter[];
  };
  closed: boolean;
  targets: Map<string, EmbeddedBrowserTargetInfo>;
  sessions: Map<string, BrowserTargetSession>;
  targetSessions: Map<string, string>;
  pendingAttachments: Map<string, Promise<string>>;
  browserSessions: Set<string>;
};

const EARLY_CDP_MESSAGE_LIMIT = 256;
const EARLY_CDP_BYTES_LIMIT = 8 * 1024 * 1024;

function browserVersionResult(identity: EmbeddedBrowserCdpIdentity | undefined) {
  const chromeVersion = identity?.chromeVersion;
  return {
    protocolVersion: "1.3",
    product: chromeVersion ? `Chrome/${chromeVersion}` : "TaskHandoff/EmbeddedBrowser",
    revision: chromeVersion ? `@${chromeVersion}` : "@embedded",
    userAgent: identity?.userAgent ?? "TaskHandoff embedded Chromium",
    jsVersion: identity?.v8Version ?? "electron",
  };
}

function browserTargetInfo(browserRef: string) {
  return EmbeddedBrowserBrowserTargetInfoSchema.parse({
    targetId: browserRef,
    type: "browser",
    title: "",
    url: "",
    attached: true,
  });
}

function targetMatchesAutoAttachFilter(target: EmbeddedBrowserTargetInfo, filter: EmbeddedBrowserTargetFilter[] | undefined) {
  if (!filter?.length) return true;
  for (const entry of filter) {
    if (entry.type && entry.type !== target.type) continue;
    return entry.exclude !== true;
  }
  return false;
}

function messageBytes(data: unknown) {
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  if (Array.isArray(data)) return Buffer.concat(data.map((entry) => Buffer.from(entry)));
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  return Buffer.from(String(data));
}

function mainFrameIdFromFrameTree(result: unknown) {
  const frame = (result as { frameTree?: { frame?: { id?: unknown } } } | undefined)?.frameTree?.frame;
  return typeof frame?.id === "string" && frame.id ? frame.id : undefined;
}

function replaceStrings(value: unknown, from: string, to: string): unknown {
  if (typeof value === "string") return value === from ? to : value;
  if (Array.isArray(value)) return value.map((entry) => replaceStrings(entry, from, to));
  if (value && typeof value === "object") {
    const next: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) next[key] = replaceStrings(entry, from, to);
    return next;
  }
  return value;
}

function replaceFrameIdFields(value: unknown, from: string, to: string): unknown {
  if (Array.isArray(value)) return value.map((entry) => replaceFrameIdFields(entry, from, to));
  if (value && typeof value === "object") {
    const next: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      next[key] = (key === "frameId" || key === "parentFrameId") && entry === from
        ? to
        : replaceFrameIdFields(entry, from, to);
    }
    return next;
  }
  return value;
}

function clientResult(state: FrameIdTranslation, method: string, result: unknown) {
  if (method === "Page.getFrameTree") {
    const mainFrameId = mainFrameIdFromFrameTree(result);
    if (mainFrameId) state.mainFrameId = mainFrameId;
  }
  return state.mainFrameId ? replaceStrings(result, state.mainFrameId, state.tabRef) : result;
}

function clientEventParams(state: FrameIdTranslation, params: unknown) {
  return state.mainFrameId ? replaceStrings(params, state.mainFrameId, state.tabRef) : params;
}

function hostCommandParams(state: FrameIdTranslation, params: unknown) {
  return state.mainFrameId ? replaceFrameIdFields(params, state.tabRef, state.mainFrameId) : params;
}

function requestToken(request: FastifyRequest) {
  const bearer = request.headers.authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (bearer) return bearer;
  try {
    return new URL(request.url, "http://localhost").searchParams.get("token") || undefined;
  } catch {
    return undefined;
  }
}

function cdpError(reply: FastifyReply, statusCode: number, code: string, message: string, details: BrowserControlErrorDetails = {}) {
  return reply.code(statusCode).send({ error: { code, message, ...details } });
}

function authenticate(request: FastifyRequest, service: BrowserControlService, sessionExists: (sessionRef: string) => boolean): CdpRequestAuth {
  const token = requestToken(request);
  if (!token) {
    throw new BrowserControlError("BROWSER_AUTHORIZATION_REQUIRED", "A browser CDP access token is required.", 401);
  }
  const sessionRef = service.validateCdpToken(token);
  if (!sessionRef) {
    throw new BrowserControlError("BROWSER_AUTHORIZATION_REVOKED", "The browser CDP access token is invalid, expired, or revoked.", 401);
  }
  if (!sessionExists(sessionRef)) {
    throw new BrowserControlError("BROWSER_AUTHORIZATION_REVOKED", "The AI Session bound to this browser CDP token is closed.", 401);
  }
  return { token, sessionRef };
}

function handleAuthError(reply: FastifyReply, error: unknown) {
  if (error instanceof BrowserControlError) return cdpError(reply, error.statusCode, error.code, error.message, error.details);
  return cdpError(reply, 401, "BROWSER_AUTHORIZATION_REVOKED", "The browser CDP access token is invalid, expired, or revoked.");
}

function websocketOrigin(httpEndpoint: string) {
  return httpEndpoint.replace(/^http:\/\//, "ws://").replace(/^https:\/\//, "wss://");
}

function browserDebuggerUrl(httpEndpoint: string, browserRef: string, token: string) {
  return `${websocketOrigin(httpEndpoint)}/devtools/browser/${encodeURIComponent(browserRef)}?token=${encodeURIComponent(token)}`;
}

function targetObject(httpEndpoint: string, page: { tabRef: string; title: string; url: string; sourceRef: string }, token: string) {
  return {
    id: page.tabRef,
    type: "page",
    title: page.title,
    url: page.url,
    description: "",
    browserContextId: page.sourceRef,
    webSocketDebuggerUrl: `${websocketOrigin(httpEndpoint)}/devtools/page/${encodeURIComponent(page.tabRef)}?token=${encodeURIComponent(token)}`,
  };
}

function browserUrlAllowed(value: string) {
  const normalized = value.trim().toLowerCase();
  return normalized === "about:blank" || normalized.startsWith("http://") || normalized.startsWith("https://");
}

function cdpErrorValue(
  id: unknown,
  code: number,
  message: string,
  browserCode?: string,
  details: BrowserControlErrorDetails = {},
) {
  return {
    id,
    error: {
      code,
      message,
      ...(browserCode ? { data: { code: browserCode, execution: "not-started", ...details } } : {}),
    },
  };
}

function sendJson(socket: CdpSocket, value: unknown) {
  try { socket.send(JSON.stringify(value), { binary: false, compress: false }); } catch { /* The peer is gone. */ }
}

function sendBrowserControlError(socket: CdpSocket, id: unknown, error: unknown) {
  const code = error instanceof BrowserControlError ? error.code : "BROWSER_CDP_ERROR";
  const details = error instanceof BrowserControlError ? error.details : {};
  sendJson(socket, cdpErrorValue(
    id,
    -32000,
    error instanceof Error ? error.message : String(error),
    code,
    details,
  ));
}

function sendSessionError(socket: CdpSocket, id: unknown, sessionId: string, error: unknown) {
  const code = error instanceof BrowserControlError ? error.code : "BROWSER_CDP_ERROR";
  const details = error instanceof BrowserControlError ? error.details : {};
  sendJson(socket, {
    ...cdpErrorValue(id, -32000, error instanceof Error ? error.message : String(error), code, details),
    sessionId,
  });
}

async function detachWithTimeout(promise: Promise<unknown>) {
  await Promise.race([
    promise.catch(() => undefined),
    new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, DETACH_TIMEOUT_MS);
      timer.unref?.();
    }),
  ]);
}

export function registerBrowserCdpBridgeRoutes(options: BrowserCdpBridgeOptions) {
  const { app, service, relay, httpEndpoint, sessionExists } = options;
  const creationWaitMs = options.creationWaitMs ?? EMBEDDED_BROWSER_CREATION_WAIT_MS;
  const browserConnections = new Set<BrowserConnection>();

  const syncDiscovery = (connection: BrowserConnection) => {
    if (connection.closed || (!connection.discover && !connection.autoAttach)) return;
    const pages = service.allPages();
    const pageByTabRef = new Map(pages.map((page) => [page.tabRef, page]));
    for (const [sessionId, session] of [...connection.sessions]) {
      if (pageByTabRef.has(session.tabRef)) continue;
      connection.sessions.delete(sessionId);
      if (connection.targetSessions.get(session.tabRef) === sessionId) connection.targetSessions.delete(session.tabRef);
      if (connection.discover || connection.autoAttach) {
        sendJson(connection.socket, {
          method: "Target.detachedFromTarget",
          params: { sessionId, targetId: session.tabRef },
        });
      }
    }
    const attachedTabRefs = new Set([...connection.sessions.values()].map((session) => session.tabRef));
    const nextTargets = new Map<string, EmbeddedBrowserTargetInfo>();
    for (const page of pages) {
      nextTargets.set(page.tabRef, embeddedBrowserTargetInfoFromPage(page, attachedTabRefs.has(page.tabRef)));
    }
    const newTargets: EmbeddedBrowserTargetInfo[] = [];
    for (const [tabRef, targetInfo] of nextTargets) {
      const previous = connection.targets.get(tabRef);
      if (!previous) {
        newTargets.push(targetInfo);
        if (connection.discover) sendJson(connection.socket, { method: "Target.targetCreated", params: { targetInfo } });
      } else if (connection.discover && JSON.stringify(previous) !== JSON.stringify(targetInfo)) {
        sendJson(connection.socket, { method: "Target.targetInfoChanged", params: { targetInfo } });
      }
    }
    for (const tabRef of [...connection.targets.keys()]) {
      if (nextTargets.has(tabRef)) continue;
      if (connection.discover) sendJson(connection.socket, { method: "Target.targetDestroyed", params: { targetId: tabRef } });
    }
    connection.targets = nextTargets;
    for (const targetInfo of newTargets) void autoAttachTarget(connection, targetInfo);
  };

  const detachTargetSessionsEverywhere = (tabRef: string, reason: string) => {
    for (const connection of browserConnections) {
      const leases = new Map<string, BrowserTargetSession>();
      for (const [sessionId, session] of [...connection.sessions]) {
        if (session.tabRef !== tabRef) continue;
        connection.sessions.delete(sessionId);
        leases.set(session.leaseRef, session);
        if (connection.discover || connection.autoAttach) {
          sendJson(connection.socket, {
            method: "Target.detachedFromTarget",
            params: { sessionId, targetId: session.tabRef },
          });
        }
      }
      connection.targetSessions.delete(tabRef);
      for (const session of leases.values()) {
        service.detachLease(connection.sessionRef, session.leaseRef);
        void detachWithTimeout(relay.targetDetach({
          leaseRef: session.leaseRef,
          tabRef: session.tabRef,
          sourceRef: session.sourceRef,
          generation: session.generation,
          reason,
        }));
      }
    }
  };

  const createTargetSession = async (
    connection: BrowserConnection,
    targetId: string,
    options: { emitAttached?: boolean; waitingForDebugger?: boolean } = {},
  ) => {
    const existingLease = service.leaseForSessionTab(connection.sessionRef, targetId);
    const lease = service.attachTab(connection.sessionRef, targetId);
    const target = service.leaseCommandTarget(connection.sessionRef, lease.leaseRef);
    try {
      if (!existingLease) {
        await relay.targetAttach({
          leaseRef: lease.leaseRef,
          tabRef: lease.tabRef,
          sourceRef: lease.sourceRef,
          generation: lease.generation,
          pageHost: target.page.pageHost,
          profile: service.pageProfile(),
        });
      }
    } catch (error) {
      service.detachLease(connection.sessionRef, lease.leaseRef);
      throw error;
    }
    const sessionId = createEntityId("tbs");
    connection.sessions.set(sessionId, {
      sessionId,
      leaseRef: lease.leaseRef,
      tabRef: lease.tabRef,
      sourceRef: lease.sourceRef,
      generation: lease.generation,
    });
    connection.targetSessions.set(lease.tabRef, sessionId);
    if (options.emitAttached) {
      sendJson(connection.socket, {
        method: "Target.attachedToTarget",
        params: {
          sessionId,
          targetInfo: embeddedBrowserTargetInfoFromPage(target.page, true),
          waitingForDebugger: options.waitingForDebugger === true,
        },
      });
    }
    return sessionId;
  };

  const attachTargetSession = (
    connection: BrowserConnection,
    targetId: string,
    options: { emitAttached?: boolean; waitingForDebugger?: boolean } = {},
  ) => {
    const existingSessionId = connection.targetSessions.get(targetId);
    if (existingSessionId) {
      const existing = connection.sessions.get(existingSessionId);
      if (existing) {
        try {
          service.leaseCommandTarget(connection.sessionRef, existing.leaseRef);
          return Promise.resolve(existing.sessionId);
        } catch {
          connection.sessions.delete(existingSessionId);
          connection.targetSessions.delete(targetId);
        }
      }
    }
    const pending = connection.pendingAttachments.get(targetId);
    if (pending) return pending;
    const attachment = createTargetSession(connection, targetId, options);
    connection.pendingAttachments.set(targetId, attachment);
    const clearPending = () => {
      if (connection.pendingAttachments.get(targetId) === attachment) {
        connection.pendingAttachments.delete(targetId);
      }
    };
    void attachment.then(clearPending, clearPending);
    return attachment;
  };

  const autoAttachTarget = async (connection: BrowserConnection, targetInfo: EmbeddedBrowserTargetInfo) => {
    if (!connection.autoAttach || connection.closed) return false;
    if (!targetMatchesAutoAttachFilter(targetInfo, connection.autoAttach.filter)) return false;
    if (connection.targetSessions.has(targetInfo.targetId)) return false;
    try {
      await attachTargetSession(connection, targetInfo.targetId, {
        emitAttached: true,
        waitingForDebugger: connection.autoAttach.waitForDebuggerOnStart,
      });
      syncDiscovery(connection);
      return true;
    } catch {
      return false;
    }
  };

  const storageSession = async (
    connection: BrowserConnection,
    browserContextId: string | undefined,
    preferred: BrowserTargetSession | undefined,
  ) => {
    const matches = (session: BrowserTargetSession) => !browserContextId || session.sourceRef === browserContextId;
    const alive = (session: BrowserTargetSession) => {
      try {
        service.page(session.tabRef);
        return true;
      } catch {
        return false;
      }
    };
    if (preferred && matches(preferred) && alive(preferred)) return preferred;
    for (const session of connection.sessions.values()) {
      if (matches(session) && alive(session)) return session;
    }
    const page = service.allPages().find((candidate) => !browserContextId || candidate.sourceRef === browserContextId);
    if (!page) return undefined;
    const sessionId = await attachTargetSession(connection, page.tabRef);
    return connection.sessions.get(sessionId);
  };

  const relayPageCommand = async (
    connection: BrowserConnection,
    session: BrowserTargetSession,
    method: string,
    params: unknown,
  ) => {
    const target = service.leaseCommandTarget(connection.sessionRef, session.leaseRef);
    return relay.cdpSend(target.lease.sourceRef, target.lease.generation, {
      leaseRef: session.leaseRef,
      method,
      params,
      requestId: `browserws_${session.leaseRef}_${crypto.randomUUID()}`,
      timeoutMs: EMBEDDED_BROWSER_REQUEST_TIMEOUT_MS,
    }, EMBEDDED_BROWSER_REQUEST_TIMEOUT_MS);
  };

  const attachExplicitTargetSession = async (connection: BrowserConnection, targetId: string) => {
    const primaryId = connection.targetSessions.get(targetId);
    const primary = primaryId ? connection.sessions.get(primaryId) : undefined;
    if (primary) {
      try {
        service.leaseCommandTarget(connection.sessionRef, primary.leaseRef);
        const sessionId = createEntityId("tbs");
        connection.sessions.set(sessionId, { ...primary, sessionId });
        return sessionId;
      } catch {
        connection.sessions.delete(primary.sessionId);
        connection.targetSessions.delete(targetId);
      }
    }
    return attachTargetSession(connection, targetId);
  };

  const downloadSource = (
    connection: BrowserConnection,
    browserContextId: string | undefined,
    requestSession: BrowserTargetSession | undefined,
  ) => {
    const sources = service.listSources();
    const sourceRef = browserContextId
      ?? requestSession?.sourceRef
      ?? [...connection.sessions.values()].find((session) => session.sourceRef)?.sourceRef;
    const source = sourceRef
      ? sources.find((candidate) => candidate.sourceRef === sourceRef)
      : sources.length === 1 ? sources[0] : undefined;
    if (!source) {
      throw new BrowserControlError("BROWSER_SOURCE_NOT_FOUND", "The browser context for downloads is unavailable.", 404);
    }
    return source;
  };

  const handleTargetMethod = async (
    connection: BrowserConnection,
    id: unknown,
    method: string,
    rawParams: unknown,
    responseSessionId?: string,
    requestSession?: BrowserTargetSession,
  ) => {
    const respond = (payload: Record<string, unknown>) => {
      sendJson(connection.socket, responseSessionId ? { ...payload, sessionId: responseSessionId } : payload);
    };
    const attachedTabRefs = new Set([...connection.sessions.values()].map((session) => session.tabRef));
    if (method === "Browser.getVersion") {
      respond({ id, result: browserVersionResult(service.browserCdpIdentity(connection.sessionRef)) });
      return;
    }
    if (method === "Browser.setDownloadBehavior") {
      const params = EmbeddedBrowserBrowserSetDownloadBehaviorParamsSchema.parse(rawParams ?? {});
      const source = downloadSource(connection, params.browserContextId, requestSession);
      await relay.downloadsConfigure({
        sourceRef: source.sourceRef,
        generation: source.generation,
        behavior: params.behavior,
        ...(params.downloadPath ? { downloadPath: params.downloadPath } : {}),
        ...(params.eventsEnabled === undefined ? {} : { eventsEnabled: params.eventsEnabled }),
        ...(params.browserContextId ? { browserContextId: params.browserContextId } : {}),
      });
      respond({ id, result: {} });
      return;
    }
    if (method === "Browser.cancelDownload") {
      const params = EmbeddedBrowserBrowserCancelDownloadParamsSchema.parse(rawParams ?? {});
      const source = downloadSource(connection, params.browserContextId, requestSession);
      await relay.downloadsCancel({
        sourceRef: source.sourceRef,
        generation: source.generation,
        guid: params.guid,
        ...(params.browserContextId ? { browserContextId: params.browserContextId } : {}),
      });
      respond({ id, result: {} });
      return;
    }
    if (method === "Schema.getDomains") {
      respond({ id, result: { domains: embeddedBrowserCdpProtocolDocument().domains } });
      return;
    }
    if (method === "Storage.getCookies") {
      const params = EmbeddedBrowserStorageGetCookiesParamsSchema.parse(rawParams ?? {});
      const session = await storageSession(connection, params.browserContextId, requestSession);
      const result = session
        ? await relayPageCommand(connection, session, "Network.getCookies", {}) as { cookies?: unknown }
        : undefined;
      respond({ id, result: { cookies: Array.isArray(result?.cookies) ? result.cookies : [] } });
      return;
    }
    if (method === "Storage.setCookies") {
      const params = EmbeddedBrowserStorageSetCookiesParamsSchema.parse(rawParams ?? {});
      const session = await storageSession(connection, params.browserContextId, requestSession);
      if (session) {
        for (const cookie of params.cookies) {
          const result = await relayPageCommand(connection, session, "Network.setCookie", cookie) as { success?: boolean };
          if (result?.success === false) {
            throw new BrowserControlError("BROWSER_CDP_ERROR", "The browser rejected a cookie.", 400);
          }
        }
      }
      respond({ id, result: {} });
      return;
    }
    if (method === "Storage.clearCookies") {
      const params = EmbeddedBrowserStorageClearCookiesParamsSchema.parse(rawParams ?? {});
      const session = await storageSession(connection, params.browserContextId, requestSession);
      if (session) await relayPageCommand(connection, session, "Network.clearBrowserCookies", {});
      respond({ id, result: {} });
      return;
    }
    if (method === "Target.attachToBrowserTarget") {
      const sessionId = createEntityId("bws");
      connection.browserSessions.add(sessionId);
      respond({ id, result: { sessionId } });
      return;
    }
    if (method === "Target.setAutoAttach") {
      const params = EmbeddedBrowserTargetSetAutoAttachParamsSchema.parse(rawParams ?? {});
      connection.autoAttach = params.autoAttach
        ? {
          waitForDebuggerOnStart: params.waitForDebuggerOnStart,
          flatten: true,
          ...(params.filter ? { filter: params.filter } : {}),
        }
        : undefined;
      respond({ id, result: {} });
      if (!connection.autoAttach) return;
      for (const page of service.allPages()) {
        await autoAttachTarget(connection, embeddedBrowserTargetInfoFromPage(page, connection.targetSessions.has(page.tabRef)));
      }
      syncDiscovery(connection);
      return;
    }
    if (method === "Target.getTargets") {
      respond({ id, result: service.targetInfos(attachedTabRefs) });
      return;
    }
    if (method === "Target.getTargetInfo") {
      const params = EmbeddedBrowserTargetGetTargetInfoParamsSchema.parse(rawParams ?? {});
      if (!params.targetId) {
        respond({ id, result: { targetInfo: browserTargetInfo(service.registryEpochValue()) } });
        return;
      }
      respond({ id, result: service.targetInfo(params.targetId, attachedTabRefs.has(params.targetId)) });
      return;
    }
    if (method === "Target.getBrowserContexts") {
      respond({ id, result: service.browserContexts() });
      return;
    }
    if (method === "Target.setDiscoverTargets") {
      const params = EmbeddedBrowserTargetSetDiscoverTargetsParamsSchema.parse(rawParams ?? {});
      if (params.discover) {
        connection.discover = true;
        connection.targets = new Map();
        respond({ id, result: {} });
        syncDiscovery(connection);
      } else {
        connection.discover = false;
        connection.targets.clear();
        respond({ id, result: {} });
      }
      return;
    }
    if (method === "Target.attachToTarget") {
      const raw = rawParams && typeof rawParams === "object" ? rawParams as Record<string, unknown> : {};
      if (raw.flatten !== true) {
        respond(cdpErrorValue(id, -32000, "Only flatten:true target sessions are supported.", "BROWSER_OPERATION_UNSUPPORTED"));
        return;
      }
      const params = EmbeddedBrowserTargetAttachToTargetParamsSchema.parse(raw);
      const sessionId = await attachExplicitTargetSession(connection, params.targetId);
      respond({ id, result: { sessionId } });
      syncDiscovery(connection);
      return;
    }
    if (method === "Target.detachFromTarget") {
      const params = EmbeddedBrowserTargetDetachFromTargetParamsSchema.parse(rawParams ?? {});
      if (params.sessionId && connection.browserSessions.delete(params.sessionId)) {
        respond({ id, result: {} });
        return;
      }
      const sessionId = params.sessionId ?? (params.targetId ? connection.targetSessions.get(params.targetId) : undefined);
      const session = sessionId ? connection.sessions.get(sessionId) : undefined;
      if (session && (!params.targetId || params.targetId === session.tabRef)) {
        connection.sessions.delete(session.sessionId);
        if (connection.targetSessions.get(session.tabRef) === session.sessionId) {
          const replacement = [...connection.sessions.values()].find((candidate) =>
            candidate.tabRef === session.tabRef && candidate.leaseRef === session.leaseRef
          );
          if (replacement) {
            connection.targetSessions.set(session.tabRef, replacement.sessionId);
          } else {
            connection.targetSessions.delete(session.tabRef);
            service.detachLease(connection.sessionRef, session.leaseRef);
            await detachWithTimeout(relay.targetDetach({
              leaseRef: session.leaseRef,
              tabRef: session.tabRef,
              sourceRef: session.sourceRef,
              generation: session.generation,
              reason: "target.detached",
            }));
          }
        }
        sendJson(connection.socket, {
          ...(responseSessionId ? { sessionId: responseSessionId } : {}),
          method: "Target.detachedFromTarget",
          params: { sessionId: session.sessionId, targetId: session.tabRef },
        });
      }
      respond({ id, result: {} });
      syncDiscovery(connection);
      return;
    }
    if (method === "Target.closeTarget") {
      const params = EmbeddedBrowserTargetCloseTargetParamsSchema.parse(rawParams ?? {});
      const page = service.page(params.targetId);
      await relay.tabsClose({ sourceRef: page.sourceRef, generation: page.generation, tabRef: page.tabRef });
      service.invalidateLeasesForTab(page.tabRef);
      detachTargetSessionsEverywhere(page.tabRef, "target.closed");
      respond({ id, result: { success: true } });
      return;
    }
    if (method === "Target.createTarget") {
      const params = EmbeddedBrowserTargetCreateTargetParamsSchema.parse(rawParams ?? {});
      if (!browserUrlAllowed(params.url)) {
        respond(cdpErrorValue(id, -32000, "Only http, https, and about:blank browser URLs are supported.", "BROWSER_OPERATION_UNSUPPORTED"));
        return;
      }
      const creation = service.requestCreation(connection.sessionRef, params.url, undefined, {
        ...(params.browserContextId ? { browserContextId: params.browserContextId } : {}),
      });
      const settled = await service.waitForCreation(connection.sessionRef, creation.creationRef, creationWaitMs);
      if (settled.state === "ready" && settled.tabRef) {
        respond({ id, result: { targetId: settled.tabRef } });
        return;
      }
      if (settled.state === "expired") {
        respond(cdpErrorValue(id, -32000, "The browser page creation request expired.", "BROWSER_CREATION_EXPIRED", {
          creationRef: settled.creationRef,
          expiresAt: settled.expiresAt,
        }));
        return;
      }
      if (settled.state === "failed") {
        respond(cdpErrorValue(id, -32000, "The browser page creation request failed.", "BROWSER_CDP_ERROR", {
          creationRef: settled.creationRef,
          expiresAt: settled.expiresAt,
        }));
        return;
      }
      if (settled.state === "declined") {
        respond(cdpErrorValue(id, -32000, "The browser page creation request was declined.", "BROWSER_CREATION_DECLINED", {
          creationRef: settled.creationRef,
          expiresAt: settled.expiresAt,
        }));
        return;
      }
      respond(cdpErrorValue(
        id,
        -32000,
        settled.state === "pending"
          ? "No default browser creation context has been selected."
          : "The browser page is still being created.",
        settled.state === "pending" ? "BROWSER_CREATION_CONTEXT_REQUIRED" : "BROWSER_TIMEOUT",
        { creationRef: settled.creationRef, expiresAt: settled.expiresAt },
      ));
      return;
    }
    if (method === "Target.createBrowserContext" || method === "Target.disposeBrowserContext"
      || method === "Target.sendMessageToTarget") {
      respond(cdpErrorValue(id, -32000, "The requested Target method is not supported.", "BROWSER_OPERATION_UNSUPPORTED"));
      return;
    }
    respond(cdpErrorValue(id, -32601, "The Target method is outside the embedded browser profile.", "BROWSER_OPERATION_UNSUPPORTED"));
  };

  const dispatchSessionMessage = async (
    connection: BrowserConnection,
    id: unknown,
    session: BrowserTargetSession,
    record: Record<string, unknown>,
  ) => {
    if (!sessionExists(connection.sessionRef)) {
      sendSessionError(connection.socket, id, session.sessionId, new BrowserControlError(
        "BROWSER_AUTHORIZATION_REVOKED",
        "The AI Session bound to this browser CDP token is closed.",
        401,
      ));
      try { connection.socket.close(4001, "Browser CDP session closed."); } catch { /* Already closed. */ }
      return;
    }
    try {
      assertEmbeddedBrowserCdpMethod(record.method);
    } catch {
      sendSessionError(connection.socket, id, session.sessionId, new BrowserControlError(
        "BROWSER_OPERATION_UNSUPPORTED",
        "The CDP method is outside the embedded page profile.",
        400,
      ));
      return;
    }
    if (record.method === "Runtime.runIfWaitingForDebugger") {
      sendJson(connection.socket, { id, result: {}, sessionId: session.sessionId });
      return;
    }
    if (record.method === "Target.setAutoAttach") {
      EmbeddedBrowserTargetSetAutoAttachParamsSchema.parse(record.params ?? {});
      // The renderer-webview host has no descendant targets. Chrome still
      // accepts page-session auto-attach setup, so acknowledge it without
      // forwarding an unsupported command into Electron's page debugger.
      sendJson(connection.socket, { id, result: {}, sessionId: session.sessionId });
      return;
    }
    try {
      const target = service.leaseCommandTarget(connection.sessionRef, session.leaseRef);
      const rawResult = await relay.cdpSend(target.lease.sourceRef, target.lease.generation, {
        leaseRef: session.leaseRef,
        method: record.method as string,
        params: hostCommandParams(session, record.params === undefined ? {} : record.params),
        requestId: `browserws_${session.leaseRef}_${crypto.randomUUID()}`,
        timeoutMs: EMBEDDED_BROWSER_REQUEST_TIMEOUT_MS,
      }, EMBEDDED_BROWSER_REQUEST_TIMEOUT_MS);
      const result = clientResult(session, record.method as string, rawResult);
      if (!connection.closed) sendJson(connection.socket, { id, result, sessionId: session.sessionId });
    } catch (error) {
      if (!connection.closed) sendSessionError(connection.socket, id, session.sessionId, error);
    }
  };

  const dispatchBrowserMessage = async (connection: BrowserConnection, data: unknown) => {
    if (connection.closed) return;
    if (!sessionExists(connection.sessionRef)) {
      sendJson(connection.socket, cdpErrorValue(null, -32000, "The AI Session bound to this browser CDP token is closed.", "BROWSER_AUTHORIZATION_REVOKED"));
      try { connection.socket.close(4001, "Browser CDP session closed."); } catch { /* Already closed. */ }
      return;
    }
    let value: unknown;
    try {
      value = JSON.parse(messageBytes(data).toString("utf8"));
    } catch {
      sendJson(connection.socket, cdpErrorValue(null, -32700, "Parse error"));
      return;
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      sendJson(connection.socket, cdpErrorValue(null, -32600, "Invalid request"));
      return;
    }
    const record = value as Record<string, unknown>;
    const id = record.id ?? null;
    if (id === null || (typeof id !== "string" && typeof id !== "number")) {
      sendJson(connection.socket, cdpErrorValue(id, -32600, "A CDP command id is required."));
      return;
    }
    if (typeof record.method !== "string") {
      sendJson(connection.socket, cdpErrorValue(id, -32600, "A CDP method is required."));
      return;
    }
    const sessionId = typeof record.sessionId === "string" && record.sessionId.trim() ? record.sessionId : undefined;
    if (sessionId) {
      const session = connection.sessions.get(sessionId);
      const browserSession = connection.browserSessions.has(sessionId);
      if (!session && !browserSession) {
        sendJson(connection.socket, cdpErrorValue(id, -32000, "The browser target session is unknown or stale.", "BROWSER_LEASE_STALE"));
        return;
      }
      if (record.method !== "Target.setAutoAttach" && supportsEmbeddedBrowserTargetCdpMethod(record.method)) {
        try {
          await handleTargetMethod(connection, id, record.method, record.params, sessionId, session);
        } catch (error) {
          sendSessionError(connection.socket, id, sessionId, error);
        }
        return;
      }
      if (!session) {
        if (record.method === "Runtime.runIfWaitingForDebugger") {
          sendJson(connection.socket, { id, result: {}, sessionId });
        } else {
          sendSessionError(connection.socket, id, sessionId, new BrowserControlError(
            "BROWSER_OPERATION_UNSUPPORTED",
            "The CDP method is outside the embedded browser Target profile.",
            400,
          ));
        }
        return;
      }
      await dispatchSessionMessage(connection, id, session, record);
      return;
    }
    if (!supportsEmbeddedBrowserTargetCdpMethod(record.method)) {
      sendJson(connection.socket, cdpErrorValue(id, -32601, "The CDP method is outside the embedded browser Target profile.", "BROWSER_OPERATION_UNSUPPORTED"));
      return;
    }
    try {
      await handleTargetMethod(connection, id, record.method, record.params);
    } catch (error) {
      sendBrowserControlError(connection.socket, id, error);
    }
  };

  const unsubscribeServiceEvents = service.subscribe((event) => {
    if (!["browser.registry.changed", "browser.source.changed", "browser.lease.changed"].includes(event.type)) return;
    for (const connection of browserConnections) {
      queueMicrotask(() => syncDiscovery(connection));
    }
  });
  app.addHook("onClose", async () => unsubscribeServiceEvents());

  const jsonVersion = async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const auth = authenticate(request, service, sessionExists);
      const identity = service.browserCdpIdentity(auth.sessionRef);
      return {
        Browser: identity ? `Chrome/${identity.chromeVersion}` : "TaskHandoff/EmbeddedBrowser",
        "Protocol-Version": "1.3",
        "User-Agent": identity?.userAgent ?? "TaskHandoff embedded Chromium",
        "V8-Version": identity?.v8Version ?? "electron",
        "WebKit-Version": identity?.webkitVersion ?? "electron",
        webSocketDebuggerUrl: browserDebuggerUrl(httpEndpoint, service.registryEpochValue(), auth.token),
      };
    } catch (error) {
      return handleAuthError(reply, error);
    }
  };
  app.get("/json/version", PUBLIC_ROUTE, jsonVersion);
  app.get("/json/version/", PUBLIC_ROUTE, jsonVersion);

  const jsonList = async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const auth = authenticate(request, service, sessionExists);
      return service.allPages().map((page) => targetObject(httpEndpoint, page, auth.token));
    } catch (error) {
      return handleAuthError(reply, error);
    }
  };
  app.get("/json/list", PUBLIC_ROUTE, jsonList);
  app.get("/json/list/", PUBLIC_ROUTE, jsonList);

  const jsonProtocol = async () => embeddedBrowserCdpProtocolDocument();
  app.get("/json/protocol", PUBLIC_ROUTE, jsonProtocol);
  app.get("/json/protocol/", PUBLIC_ROUTE, jsonProtocol);

  const createTarget = async (request: FastifyRequest, reply: FastifyReply) => {
    let auth: CdpRequestAuth;
    try {
      auth = authenticate(request, service, sessionExists);
    } catch (error) {
      return handleAuthError(reply, error);
    }
    const query = request.query && typeof request.query === "object" ? request.query as Record<string, unknown> : {};
    const url = typeof query.url === "string" && query.url.trim() ? query.url.trim() : "about:blank";
    if (!browserUrlAllowed(url)) {
      return cdpError(reply, 400, "BROWSER_OPERATION_UNSUPPORTED", "Only http, https, and about:blank browser URLs are supported.");
    }
    try {
      const requested = service.requestCreation(auth.sessionRef, url);
      const creation = await service.waitForCreation(auth.sessionRef, requested.creationRef, creationWaitMs);
      if (creation.state === "ready") {
        const page = creation.tabRef ? service.page(creation.tabRef) : undefined;
        if (!page) return cdpError(reply, 409, "BROWSER_TAB_NOT_FOUND", "The created browser tab is no longer available.");
        return targetObject(httpEndpoint, page, auth.token);
      }
      if (["pending", "claimed", "creating"].includes(creation.state)) {
        return reply.code(202).send({
          creationRef: creation.creationRef,
          state: creation.state,
          requestedUrl: creation.requestedUrl,
          expiresAt: creation.expiresAt,
        });
      }
      if (creation.state === "declined") {
        return cdpError(reply, 409, "BROWSER_CREATION_DECLINED", "The browser page creation request was declined.", {
          creationRef: creation.creationRef,
          expiresAt: creation.expiresAt,
        });
      }
      if (creation.state === "expired") {
        return cdpError(reply, 408, "BROWSER_CREATION_EXPIRED", "The browser page creation request expired.", {
          creationRef: creation.creationRef,
          expiresAt: creation.expiresAt,
        });
      }
      return cdpError(reply, 409, "BROWSER_CREATION_FAILED", "The browser page creation request failed on the desktop.", {
        creationRef: creation.creationRef,
        expiresAt: creation.expiresAt,
      });
    } catch (error) {
      if (error instanceof BrowserControlError) return cdpError(reply, error.statusCode, error.code, error.message, error.details);
      return cdpError(reply, 500, "BROWSER_CDP_ERROR", error instanceof Error ? error.message : String(error));
    }
  };

  app.get("/json/new", PUBLIC_ROUTE, createTarget);
  app.put("/json/new", PUBLIC_ROUTE, createTarget);

  app.get<{ Params: { tabRef: string } }>("/json/close/:tabRef", PUBLIC_ROUTE, async (request, reply) => {
    try {
      authenticate(request, service, sessionExists);
      const page = service.page(request.params.tabRef);
      await relay.tabsClose({
        sourceRef: page.sourceRef,
        generation: page.generation,
        tabRef: page.tabRef,
      });
      service.invalidateLeasesForTab(page.tabRef);
      detachTargetSessionsEverywhere(page.tabRef, "target.closed");
      return reply.type("text/plain; charset=utf-8").send("Target is closing");
    } catch (error) {
      if (error instanceof BrowserControlError) return cdpError(reply, error.statusCode, error.code, error.message, error.details);
      return cdpError(reply, 500, "BROWSER_CDP_ERROR", error instanceof Error ? error.message : String(error));
    }
  });

  app.get<{ Params: { browserRef: string } }>("/devtools/browser/:browserRef", {
    ...PUBLIC_ROUTE,
    websocket: true,
    preValidation: async (request, reply) => {
      try {
        authenticate(request, service, sessionExists);
      } catch (error) {
        return handleAuthError(reply, error);
      }
    },
  }, (socket, request) => {
    let auth: CdpRequestAuth;
    try {
      auth = authenticate(request, service, sessionExists);
      if (request.params.browserRef !== service.registryEpochValue()) {
        throw new BrowserControlError("BROWSER_SNAPSHOT_REQUIRED", "The browser reference is stale.", 409);
      }
    } catch (error) {
      if (error instanceof BrowserControlError) sendJson(socket as never, { error: { code: error.code, message: error.message } });
      try { socket.close(1008, "Browser CDP authorization failed."); } catch { /* Already closed. */ }
      return;
    }
    const connection: BrowserConnection = {
      socket: socket as never,
      sessionRef: auth.sessionRef,
      discover: false,
      closed: false,
      targets: new Map(),
      sessions: new Map(),
      targetSessions: new Map(),
      pendingAttachments: new Map(),
      browserSessions: new Set(),
    };
    browserConnections.add(connection);
    const unsubscribeRelay = relay.subscribeCdpEvent((event: BrowserControlCdpEvent) => {
      if (connection.closed) return;
      for (const session of connection.sessions.values()) {
        if (event.leaseRef !== session.leaseRef) continue;
        sendJson(connection.socket, {
          method: event.method,
          params: clientEventParams(session, event.params ?? {}),
          sessionId: session.sessionId,
        });
        return;
      }
    });
    const unsubscribeDownloads = relay.subscribeDownloadEvent((event) => {
      if (connection.closed) return;
      const session = [...connection.sessions.values()].find((candidate) =>
        candidate.tabRef === event.tabRef && candidate.sourceRef === event.sourceRef
      );
      if (!session) return;
      sendJson(connection.socket, {
        method: event.method,
        params: event.method === "Browser.downloadWillBegin"
          // Playwright sees the page's main frame as tabRef because Page.getFrameTree
          // is translated at this boundary. Chrome includes frameId in the event.
          ? { ...event.params, frameId: event.tabRef }
          : event.params,
      });
    });
    const close = () => {
      if (connection.closed) return;
      connection.closed = true;
      browserConnections.delete(connection);
      unsubscribeRelay();
      unsubscribeDownloads();
      for (const session of [...connection.sessions.values()]) {
        let target;
        try { target = service.leaseCommandTarget(connection.sessionRef, session.leaseRef); } catch { target = undefined; }
        if (target) {
          void detachWithTimeout(relay.targetDetach({
            leaseRef: target.lease.leaseRef,
            tabRef: target.lease.tabRef,
            sourceRef: target.lease.sourceRef,
            generation: target.lease.generation,
            reason: "browser-websocket-closed",
          }));
        }
        service.detachLease(connection.sessionRef, session.leaseRef);
      }
      connection.sessions.clear();
      connection.targetSessions.clear();
      connection.pendingAttachments.clear();
    };
    socket.on("close", close);
    socket.on("error", close);
    socket.on("message", (data: unknown) => {
      if (connection.closed) return;
      // Chrome processes CDP commands concurrently. Playwright relies on this
      // when a command whose promise waits for a Runtime binding needs a second
      // command to deliver the binding result, and when Fetch pauses a request
      // while its handler calls Fetch.continueRequest on the same connection.
      void dispatchBrowserMessage(connection, data).catch(() => undefined);
    });
  });

  app.get<{ Params: { tabRef: string } }>("/devtools/page/:tabRef", {
    ...PUBLIC_ROUTE,
    websocket: true,
    preValidation: async (request, reply) => {
      try {
        authenticate(request, service, sessionExists);
      } catch (error) {
        return handleAuthError(reply, error);
      }
    },
  }, async (socket, request) => {
    const earlyMessages: unknown[] = [];
    let earlyBytes = 0;
    const captureEarlyMessage = (data: unknown) => {
      const bytes = messageBytes(data).byteLength;
      if (earlyMessages.length >= EARLY_CDP_MESSAGE_LIMIT || earlyBytes + bytes > EARLY_CDP_BYTES_LIMIT) {
        socket.off("message", captureEarlyMessage);
        try { socket.close(1009, "Browser CDP early command limit exceeded."); } catch { /* Already closed. */ }
        return;
      }
      earlyBytes += bytes;
      earlyMessages.push(data);
    };
    const stopCapturingEarlyMessages = () => socket.off("message", captureEarlyMessage);
    socket.on("message", captureEarlyMessage);
    let auth: CdpRequestAuth;
    try {
      auth = authenticate(request, service, sessionExists);
    } catch (error) {
      stopCapturingEarlyMessages();
      if (error instanceof BrowserControlError) {
        sendJson(socket as never, { error: { code: error.code, message: error.message } });
      }
      try { socket.close(1008, "Browser CDP authorization failed."); } catch { /* Already closed. */ }
      return;
    }
    let page;
    let lease;
    try {
      page = service.page(request.params.tabRef);
      lease = service.attachTab(auth.sessionRef, request.params.tabRef);
    } catch (error) {
      stopCapturingEarlyMessages();
      if (error instanceof BrowserControlError) {
        sendJson(socket as never, { error: { code: error.code, message: error.message } });
      }
      try { socket.close(1008, "Browser target is unavailable."); } catch { /* Already closed. */ }
      return;
    }
    let target;
    try {
      target = service.leaseCommandTarget(auth.sessionRef, lease.leaseRef);
      await relay.targetAttach({
        leaseRef: lease.leaseRef,
        tabRef: lease.tabRef,
        sourceRef: lease.sourceRef,
        generation: lease.generation,
        pageHost: target.page.pageHost,
        profile: service.pageProfile(),
      });
    } catch (error) {
      service.detachLease(auth.sessionRef, lease.leaseRef);
      stopCapturingEarlyMessages();
      if (error instanceof BrowserControlError) {
        sendJson(socket as never, { error: { code: error.code, message: error.message } });
      }
      try { socket.close(1011, "Browser target attach failed."); } catch { /* Already closed. */ }
      return;
    }
    stopCapturingEarlyMessages();
    handlePageSocket({
      socket: socket as never,
      service,
      relay,
      sessionExists,
      sessionRef: auth.sessionRef,
      lease,
      tabRef: page.tabRef,
      initialMessages: earlyMessages,
    });
  });
}

type PageSocketOptions = {
  socket: CdpSocket;
  service: BrowserControlService;
  relay: BrowserControlRelayRegistry;
  sessionExists: (sessionRef: string) => boolean;
  sessionRef: string;
  lease: { leaseRef: string; tabRef: string; sourceRef: string; generation: number };
  tabRef: string;
  initialMessages?: readonly unknown[];
};

function handlePageSocket(options: PageSocketOptions) {
  const { socket, service, relay, sessionExists, sessionRef, lease } = options;
  let closed = false;
  const frameIds: FrameIdTranslation = { tabRef: options.tabRef };
  const unsubscribe = relay.subscribeCdpEvent((event: BrowserControlCdpEvent) => {
    if (closed || event.leaseRef !== lease.leaseRef) return;
    sendJson(socket, {
      method: event.method,
      params: clientEventParams(frameIds, event.params ?? {}),
      ...(event.frameSessionRef ? { sessionId: event.frameSessionRef } : {}),
    });
  });
  const close = () => {
    if (closed) return;
    closed = true;
    unsubscribe();
    let target;
    try { target = service.leaseCommandTarget(sessionRef, lease.leaseRef); } catch { target = undefined; }
    if (target) {
      void detachWithTimeout(relay.targetDetach({
        leaseRef: target.lease.leaseRef,
        tabRef: target.lease.tabRef,
        sourceRef: target.lease.sourceRef,
        generation: target.lease.generation,
        reason: "cdp-websocket-closed",
      }));
    }
    service.detachLease(sessionRef, lease.leaseRef);
  };
  socket.on("close", close);
  socket.on("error", close);
  socket.on("message", (data: unknown) => {
    if (closed) return;
    void dispatchPageMessage(options, frameIds, data, () => closed);
  });
  for (const data of options.initialMessages ?? []) {
    if (closed) break;
    void dispatchPageMessage(options, frameIds, data, () => closed);
  }
}

async function dispatchPageMessage(options: PageSocketOptions, frameIds: FrameIdTranslation, data: unknown, isClosed: () => boolean) {
  const { socket, service, relay, sessionExists, sessionRef, lease } = options;
  if (!sessionExists(sessionRef)) {
    sendJson(socket, cdpErrorValue(null, -32000, "The AI Session bound to this browser CDP token is closed.", "BROWSER_AUTHORIZATION_REVOKED"));
    try { socket.close(4001, "Browser CDP session closed."); } catch { /* Already closed. */ }
    return;
  }
  let value: unknown;
  try {
    value = JSON.parse(messageBytes(data).toString("utf8"));
  } catch {
    sendJson(socket, cdpErrorValue(null, -32700, "Parse error"));
    return;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    sendJson(socket, cdpErrorValue(null, -32600, "Invalid request"));
    return;
  }
  const record = value as Record<string, unknown>;
  const id = record.id ?? null;
  if (id === null || (typeof id !== "string" && typeof id !== "number")) {
    sendJson(socket, cdpErrorValue(id, -32600, "A CDP command id is required."));
    return;
  }
  if (typeof record.method !== "string") {
    sendJson(socket, cdpErrorValue(id, -32600, "A CDP method is required."));
    return;
  }
  if (typeof record.sessionId === "string" && record.sessionId.trim()) {
    sendJson(socket, cdpErrorValue(id, -32000, "Descendant CDP sessions are not supported yet.", "BROWSER_OPERATION_UNSUPPORTED"));
    return;
  }
  try {
    assertEmbeddedBrowserCdpMethod(record.method);
  } catch {
    sendJson(socket, cdpErrorValue(id, -32601, "The CDP method is outside the embedded page profile.", "BROWSER_OPERATION_UNSUPPORTED"));
    return;
  }
  const target = (() => {
    try { return service.leaseCommandTarget(sessionRef, lease.leaseRef); } catch (error) {
      if (error instanceof BrowserControlError) {
        sendJson(socket, cdpErrorValue(id, -32000, error.message, error.code, error.details));
      }
      return undefined;
    }
  })();
  if (!target || isClosed()) return;
  try {
    const rawResult = await relay.cdpSend(target.lease.sourceRef, target.lease.generation, {
      leaseRef: lease.leaseRef,
      method: record.method,
      params: hostCommandParams(frameIds, record.params === undefined ? {} : record.params),
      requestId: `cdpws_${lease.leaseRef}_${crypto.randomUUID()}`,
      timeoutMs: EMBEDDED_BROWSER_REQUEST_TIMEOUT_MS,
    }, EMBEDDED_BROWSER_REQUEST_TIMEOUT_MS);
    const result = clientResult(frameIds, record.method, rawResult);
    if (!isClosed()) sendJson(socket, { id, result });
  } catch (error) {
    if (isClosed()) return;
    const code = error instanceof BrowserControlError ? error.code : "BROWSER_CDP_ERROR";
    const details = error instanceof BrowserControlError ? error.details : {};
    sendJson(socket, cdpErrorValue(id, -32000, error instanceof Error ? error.message : String(error), code, details));
  }
}
