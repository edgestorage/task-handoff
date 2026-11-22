import crypto from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  EMBEDDED_BROWSER_CREATION_WAIT_MS,
  EMBEDDED_BROWSER_REQUEST_TIMEOUT_MS,
  assertEmbeddedBrowserCdpMethod,
  type EmbeddedBrowserPage,
} from "@task-handoff/protocol/embedded-browser-control";
import { BrowserControlError, type BrowserControlService } from "./browser-control";
import {
  webSocketMessageBytes,
  type BrowserControlCdpEvent,
  type BrowserControlRelayRegistry,
} from "./browser-control-relay";

const DETACH_TIMEOUT_MS = 1_000;
const PUBLIC_ROUTE = { config: { taskHandoffAuth: "public" as const } };

type BrowserCdpBridgeOptions = {
  app: FastifyInstance;
  service: BrowserControlService;
  relay: BrowserControlRelayRegistry;
  httpEndpoint: string;
  sessionExists: (sessionRef: string) => boolean;
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

const EARLY_CDP_MESSAGE_LIMIT = 256;
const EARLY_CDP_BYTES_LIMIT = 8 * 1024 * 1024;

function requestToken(request: FastifyRequest) {
  const bearer = request.headers.authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (bearer) return bearer;
  try {
    return new URL(request.url, "http://localhost").searchParams.get("token") || undefined;
  } catch {
    return undefined;
  }
}

function cdpError(reply: FastifyReply, statusCode: number, code: string, message: string) {
  return reply.code(statusCode).send({ error: { code, message } });
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
  if (error instanceof BrowserControlError) return cdpError(reply, error.statusCode, error.code, error.message);
  return cdpError(reply, 401, "BROWSER_AUTHORIZATION_REVOKED", "The browser CDP access token is invalid, expired, or revoked.");
}

function websocketOrigin(httpEndpoint: string) {
  return httpEndpoint.replace(/^http:\/\//, "ws://").replace(/^https:\/\//, "wss://");
}

function targetObject(httpEndpoint: string, page: EmbeddedBrowserPage, token: string) {
  return {
    id: page.tabRef,
    type: "page",
    title: page.title,
    url: page.url,
    description: "",
    webSocketDebuggerUrl: `${websocketOrigin(httpEndpoint)}/devtools/page/${encodeURIComponent(page.tabRef)}?token=${encodeURIComponent(token)}`,
  };
}

function browserUrlAllowed(value: string) {
  const normalized = value.trim().toLowerCase();
  return normalized === "about:blank" || normalized.startsWith("http://") || normalized.startsWith("https://");
}

function cdpErrorValue(id: unknown, code: number, message: string, browserCode?: string) {
  return {
    id,
    error: {
      code,
      message,
      ...(browserCode ? { data: { code: browserCode, execution: "not-started" } } : {}),
    },
  };
}

function sendJson(socket: CdpSocket, value: unknown) {
  try { socket.send(JSON.stringify(value), { binary: false, compress: false }); } catch { /* The peer is gone. */ }
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

  app.get("/json/version", PUBLIC_ROUTE, async (request, reply) => {
    try {
      authenticate(request, service, sessionExists);
      return {
        Browser: "TaskHandoff/EmbeddedBrowser",
        "Protocol-Version": "1.3",
        "User-Agent": "TaskHandoff embedded Chromium",
        "V8-Version": "electron",
        "WebKit-Version": "electron",
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
      const creation = await service.waitForCreation(auth.sessionRef, requested.creationRef, EMBEDDED_BROWSER_CREATION_WAIT_MS);
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
        return cdpError(reply, 409, "BROWSER_CREATION_DECLINED", "The browser page creation request was declined.");
      }
      if (creation.state === "expired") {
        return cdpError(reply, 408, "BROWSER_CREATION_EXPIRED", "The browser page creation request expired.");
      }
      return cdpError(reply, 409, "BROWSER_CREATION_FAILED", "The browser page creation request failed on the desktop.");
    } catch (error) {
      if (error instanceof BrowserControlError) return cdpError(reply, error.statusCode, error.code, error.message);
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
      service.destroyTab(page.sourceRef, page.generation, page.tabRef, "closed");
      return reply.type("text/plain; charset=utf-8").send("Target is closing");
    } catch (error) {
      if (error instanceof BrowserControlError) return cdpError(reply, error.statusCode, error.code, error.message);
      return cdpError(reply, 500, "BROWSER_CDP_ERROR", error instanceof Error ? error.message : String(error));
    }
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
      const bytes = webSocketMessageBytes(data).byteLength;
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
    let page: EmbeddedBrowserPage;
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
    value = JSON.parse(webSocketMessageBytes(data).toString("utf8"));
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
        sendJson(socket, cdpErrorValue(id, -32000, error.message, error.code));
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
    sendJson(socket, cdpErrorValue(id, -32000, error instanceof Error ? error.message : String(error), code));
  }
}
