import crypto from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { createEntityId } from "@task-handoff/protocol/control-plane";
import {
  EMBEDDED_BROWSER_CREATION_WAIT_MS,
  EMBEDDED_BROWSER_REQUEST_TIMEOUT_MS,
  EmbeddedBrowserTargetAttachToTargetParamsSchema,
  EmbeddedBrowserTargetCloseTargetParamsSchema,
  EmbeddedBrowserTargetCreateTargetParamsSchema,
  EmbeddedBrowserTargetDetachFromTargetParamsSchema,
  EmbeddedBrowserTargetGetTargetInfoParamsSchema,
  EmbeddedBrowserTargetSetDiscoverTargetsParamsSchema,
  assertEmbeddedBrowserCdpMethod,
  embeddedBrowserTargetInfoFromPage,
  supportsEmbeddedBrowserTargetCdpMethod,
  type EmbeddedBrowserTargetInfo,
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
};

type BrowserConnection = {
  socket: CdpSocket;
  sessionRef: string;
  discover: boolean;
  closed: boolean;
  targets: Map<string, EmbeddedBrowserTargetInfo>;
  sessions: Map<string, BrowserTargetSession>;
  targetSessions: Map<string, string>;
  queue: Promise<void>;
};

const EARLY_CDP_MESSAGE_LIMIT = 256;
const EARLY_CDP_BYTES_LIMIT = 8 * 1024 * 1024;

function messageBytes(data: unknown) {
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  if (Array.isArray(data)) return Buffer.concat(data.map((entry) => Buffer.from(entry)));
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  return Buffer.from(String(data));
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
    if (connection.closed || !connection.discover) return;
    const pages = service.allPages();
    const pageByTabRef = new Map(pages.map((page) => [page.tabRef, page]));
    for (const [sessionId, session] of [...connection.sessions]) {
      if (pageByTabRef.has(session.tabRef)) continue;
      connection.sessions.delete(sessionId);
      if (connection.targetSessions.get(session.tabRef) === sessionId) connection.targetSessions.delete(session.tabRef);
      sendJson(connection.socket, {
        method: "Target.detachedFromTarget",
        params: { sessionId, targetId: session.tabRef },
      });
    }
    const attachedTabRefs = new Set([...connection.sessions.values()].map((session) => session.tabRef));
    const nextTargets = new Map<string, EmbeddedBrowserTargetInfo>();
    for (const page of pages) {
      nextTargets.set(page.tabRef, embeddedBrowserTargetInfoFromPage(page, attachedTabRefs.has(page.tabRef)));
    }
    for (const [tabRef, targetInfo] of nextTargets) {
      const previous = connection.targets.get(tabRef);
      if (!previous) {
        sendJson(connection.socket, { method: "Target.targetCreated", params: { targetInfo } });
      } else if (JSON.stringify(previous) !== JSON.stringify(targetInfo)) {
        sendJson(connection.socket, { method: "Target.targetInfoChanged", params: { targetInfo } });
      }
    }
    for (const tabRef of [...connection.targets.keys()]) {
      if (nextTargets.has(tabRef)) continue;
      sendJson(connection.socket, { method: "Target.targetDestroyed", params: { targetId: tabRef } });
    }
    connection.targets = nextTargets;
  };

  const detachTargetSessionsEverywhere = (tabRef: string, reason: string) => {
    for (const connection of browserConnections) {
      for (const [sessionId, session] of [...connection.sessions]) {
        if (session.tabRef !== tabRef) continue;
        connection.sessions.delete(sessionId);
        if (connection.targetSessions.get(tabRef) === sessionId) connection.targetSessions.delete(tabRef);
        service.detachLease(connection.sessionRef, session.leaseRef);
        void detachWithTimeout(relay.targetDetach({
          leaseRef: session.leaseRef,
          tabRef: session.tabRef,
          sourceRef: session.sourceRef,
          generation: session.generation,
          reason,
        }));
        if (connection.discover) {
          sendJson(connection.socket, {
            method: "Target.detachedFromTarget",
            params: { sessionId, targetId: session.tabRef },
          });
        }
      }
    }
  };

  const handleTargetMethod = async (connection: BrowserConnection, id: unknown, method: string, rawParams: unknown) => {
    const attachedTabRefs = new Set([...connection.sessions.values()].map((session) => session.tabRef));
    if (method === "Target.getTargets") {
      sendJson(connection.socket, { id, result: service.targetInfos(attachedTabRefs) });
      return;
    }
    if (method === "Target.getTargetInfo") {
      const params = EmbeddedBrowserTargetGetTargetInfoParamsSchema.parse(rawParams ?? {});
      sendJson(connection.socket, { id, result: service.targetInfo(params.targetId, attachedTabRefs.has(params.targetId)) });
      return;
    }
    if (method === "Target.getBrowserContexts") {
      sendJson(connection.socket, { id, result: service.browserContexts() });
      return;
    }
    if (method === "Target.setDiscoverTargets") {
      const params = EmbeddedBrowserTargetSetDiscoverTargetsParamsSchema.parse(rawParams ?? {});
      if (params.discover) {
        connection.discover = true;
        connection.targets = new Map();
        sendJson(connection.socket, { id, result: {} });
        syncDiscovery(connection);
      } else {
        connection.discover = false;
        connection.targets.clear();
        sendJson(connection.socket, { id, result: {} });
      }
      return;
    }
    if (method === "Target.attachToTarget") {
      const raw = rawParams && typeof rawParams === "object" ? rawParams as Record<string, unknown> : {};
      if (raw.flatten !== true) {
        sendJson(connection.socket, cdpErrorValue(id, -32000, "Only flatten:true target sessions are supported.", "BROWSER_OPERATION_UNSUPPORTED"));
        return;
      }
      const params = EmbeddedBrowserTargetAttachToTargetParamsSchema.parse(raw);
      const existingSessionId = connection.targetSessions.get(params.targetId);
      if (existingSessionId) {
        const existing = connection.sessions.get(existingSessionId);
        if (existing) {
          try {
            service.leaseCommandTarget(connection.sessionRef, existing.leaseRef);
            sendJson(connection.socket, { id, result: { sessionId: existing.sessionId } });
            return;
          } catch {
            connection.sessions.delete(existingSessionId);
            connection.targetSessions.delete(params.targetId);
          }
        }
      }
      const existingLease = service.leaseForSessionTab(connection.sessionRef, params.targetId);
      const lease = service.attachTab(connection.sessionRef, params.targetId);
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
      sendJson(connection.socket, { id, result: { sessionId } });
      syncDiscovery(connection);
      return;
    }
    if (method === "Target.detachFromTarget") {
      const params = EmbeddedBrowserTargetDetachFromTargetParamsSchema.parse(rawParams ?? {});
      const sessionId = params.sessionId ?? (params.targetId ? connection.targetSessions.get(params.targetId) : undefined);
      const session = sessionId ? connection.sessions.get(sessionId) : undefined;
      if (session && (!params.targetId || params.targetId === session.tabRef)) {
        connection.sessions.delete(session.sessionId);
        if (connection.targetSessions.get(session.tabRef) === session.sessionId) connection.targetSessions.delete(session.tabRef);
        service.detachLease(connection.sessionRef, session.leaseRef);
        await detachWithTimeout(relay.targetDetach({
          leaseRef: session.leaseRef,
          tabRef: session.tabRef,
          sourceRef: session.sourceRef,
          generation: session.generation,
          reason: "target.detached",
        }));
        if (connection.discover) {
          sendJson(connection.socket, {
            method: "Target.detachedFromTarget",
            params: { sessionId: session.sessionId, targetId: session.tabRef },
          });
        }
      }
      sendJson(connection.socket, { id, result: {} });
      syncDiscovery(connection);
      return;
    }
    if (method === "Target.closeTarget") {
      const params = EmbeddedBrowserTargetCloseTargetParamsSchema.parse(rawParams ?? {});
      const page = service.page(params.targetId);
      await relay.tabsClose({ sourceRef: page.sourceRef, generation: page.generation, tabRef: page.tabRef });
      service.invalidateLeasesForTab(page.tabRef);
      detachTargetSessionsEverywhere(page.tabRef, "target.closed");
      sendJson(connection.socket, { id, result: { success: true } });
      return;
    }
    if (method === "Target.createTarget") {
      const params = EmbeddedBrowserTargetCreateTargetParamsSchema.parse(rawParams ?? {});
      if (!browserUrlAllowed(params.url)) {
        sendJson(connection.socket, cdpErrorValue(id, -32000, "Only http, https, and about:blank browser URLs are supported.", "BROWSER_OPERATION_UNSUPPORTED"));
        return;
      }
      const creation = service.requestCreation(connection.sessionRef, params.url, undefined, {
        ...(params.browserContextId ? { browserContextId: params.browserContextId } : {}),
      });
      const settled = await service.waitForCreation(connection.sessionRef, creation.creationRef, creationWaitMs);
      if (settled.state === "ready" && settled.tabRef) {
        sendJson(connection.socket, { id, result: { targetId: settled.tabRef } });
        return;
      }
      if (settled.state === "expired") {
        sendJson(connection.socket, cdpErrorValue(id, -32000, "The browser page creation request expired.", "BROWSER_CREATION_EXPIRED", {
          creationRef: settled.creationRef,
          expiresAt: settled.expiresAt,
        }));
        return;
      }
      if (settled.state === "failed") {
        sendJson(connection.socket, cdpErrorValue(id, -32000, "The browser page creation request failed.", "BROWSER_CDP_ERROR", {
          creationRef: settled.creationRef,
          expiresAt: settled.expiresAt,
        }));
        return;
      }
      if (settled.state === "declined") {
        sendJson(connection.socket, cdpErrorValue(id, -32000, "The browser page creation request was declined.", "BROWSER_CREATION_DECLINED", {
          creationRef: settled.creationRef,
          expiresAt: settled.expiresAt,
        }));
        return;
      }
      sendJson(connection.socket, cdpErrorValue(
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
      || method === "Target.setAutoAttach" || method === "Target.sendMessageToTarget") {
      sendJson(connection.socket, cdpErrorValue(id, -32000, "The requested Target method is not supported.", "BROWSER_OPERATION_UNSUPPORTED"));
      return;
    }
    sendJson(connection.socket, cdpErrorValue(id, -32601, "The Target method is outside the embedded browser profile.", "BROWSER_OPERATION_UNSUPPORTED"));
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
      assertEmbeddedBrowserCdpMethod(record.method, { adapterOnly: false });
    } catch {
      sendSessionError(connection.socket, id, session.sessionId, new BrowserControlError(
        "BROWSER_OPERATION_UNSUPPORTED",
        "The CDP method is outside the embedded page profile.",
        400,
      ));
      return;
    }
    try {
      const target = service.leaseCommandTarget(connection.sessionRef, session.leaseRef);
      const result = await relay.cdpSend(target.lease.sourceRef, target.lease.generation, {
        leaseRef: session.leaseRef,
        method: record.method as string,
        params: record.params === undefined ? {} : record.params,
        requestId: `browserws_${session.leaseRef}_${crypto.randomUUID()}`,
        timeoutMs: EMBEDDED_BROWSER_REQUEST_TIMEOUT_MS,
      }, EMBEDDED_BROWSER_REQUEST_TIMEOUT_MS);
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
      if (!session) {
        sendJson(connection.socket, cdpErrorValue(id, -32000, "The browser target session is unknown or stale.", "BROWSER_LEASE_STALE"));
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

  app.get("/json/version", PUBLIC_ROUTE, async (request, reply) => {
    try {
      const auth = authenticate(request, service, sessionExists);
      return {
        Browser: "TaskHandoff/EmbeddedBrowser",
        "Protocol-Version": "1.3",
        "User-Agent": "TaskHandoff embedded Chromium",
        "V8-Version": "electron",
        "WebKit-Version": "electron",
        webSocketDebuggerUrl: browserDebuggerUrl(httpEndpoint, service.registryEpochValue(), auth.token),
      };
    } catch (error) {
      return handleAuthError(reply, error);
    }
  });

  app.get("/json/list", PUBLIC_ROUTE, async (request, reply) => {
    try {
      const auth = authenticate(request, service, sessionExists);
      return service.allPages().map((page) => targetObject(httpEndpoint, page, auth.token));
    } catch (error) {
      return handleAuthError(reply, error);
    }
  });

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
      queue: Promise.resolve(),
    };
    browserConnections.add(connection);
    const unsubscribeRelay = relay.subscribeCdpEvent((event: BrowserControlCdpEvent) => {
      if (connection.closed) return;
      for (const session of connection.sessions.values()) {
        if (event.leaseRef !== session.leaseRef) continue;
        sendJson(connection.socket, {
          method: event.method,
          params: event.params ?? {},
          sessionId: session.sessionId,
        });
        return;
      }
    });
    const close = () => {
      if (connection.closed) return;
      connection.closed = true;
      browserConnections.delete(connection);
      unsubscribeRelay();
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
    };
    socket.on("close", close);
    socket.on("error", close);
    socket.on("message", (data: unknown) => {
      if (connection.closed) return;
      connection.queue = connection.queue.then(() => dispatchBrowserMessage(connection, data)).catch(() => undefined);
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
  const unsubscribe = relay.subscribeCdpEvent((event: BrowserControlCdpEvent) => {
    if (closed || event.leaseRef !== lease.leaseRef) return;
    sendJson(socket, {
      method: event.method,
      params: event.params ?? {},
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
    void dispatchPageMessage(options, data, () => closed);
  });
  for (const data of options.initialMessages ?? []) {
    if (closed) break;
    void dispatchPageMessage(options, data, () => closed);
  }
}

async function dispatchPageMessage(options: PageSocketOptions, data: unknown, isClosed: () => boolean) {
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
    assertEmbeddedBrowserCdpMethod(record.method, { adapterOnly: false });
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
    const result = await relay.cdpSend(target.lease.sourceRef, target.lease.generation, {
      leaseRef: lease.leaseRef,
      method: record.method,
      params: record.params === undefined ? {} : record.params,
      requestId: `cdpws_${lease.leaseRef}_${crypto.randomUUID()}`,
      timeoutMs: EMBEDDED_BROWSER_REQUEST_TIMEOUT_MS,
    }, EMBEDDED_BROWSER_REQUEST_TIMEOUT_MS);
    if (!isClosed()) sendJson(socket, { id, result });
  } catch (error) {
    if (isClosed()) return;
    const code = error instanceof BrowserControlError ? error.code : "BROWSER_CDP_ERROR";
    const details = error instanceof BrowserControlError ? error.details : {};
    sendJson(socket, cdpErrorValue(id, -32000, error instanceof Error ? error.message : String(error), code, details));
  }
}
