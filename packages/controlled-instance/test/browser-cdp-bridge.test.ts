import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import websocket from "@fastify/websocket";
import WebSocket from "ws";
import {
  EMBEDDED_BROWSER_MAIN_PAGE_POOL_CAPABILITIES,
  EMBEDDED_BROWSER_RENDERER_WEBVIEW_CAPABILITIES,
  type EmbeddedBrowserPage,
  type EmbeddedBrowserPageHost,
  type EmbeddedBrowserSource,
} from "@task-handoff/protocol/embedded-browser-control";
import { BrowserControlService } from "../src/web/browser-control.ts";
import type { BrowserControlRelayRegistry } from "../src/web/browser-control-relay.ts";
import { registerBrowserCdpBridgeRoutes } from "../src/web/browser-cdp-bridge.ts";
import { registerBrowserControlRoutes } from "../src/web/browser-control-routes.ts";

type RegistrationOptions = {
  panelId?: string;
  ownerRef?: string;
  publisherRef?: string;
  pageHost?: EmbeddedBrowserPageHost;
};

type CdpMessage = Record<string, any>;

const TEST_CDP_IDENTITY = {
  chromeVersion: "150.0.7871.47",
  userAgent: "Mozilla/5.0 Chrome/150.0.7871.47 Safari/537.36",
  v8Version: "15.0.245.15-electron.0",
  webkitVersion: "537.36",
};

function fakeRelay() {
  return {
    subscribeCdpEvent: () => () => undefined,
    subscribeDownloadEvent: () => () => undefined,
    attach: () => undefined,
    targetAttach: async () => ({}),
    targetDetach: async () => ({}),
    tabsClose: async () => ({}),
    tabsOpen: async () => ({}),
    cdpSend: async () => ({}),
    downloadsConfigure: async () => ({}),
    downloadsCancel: async () => ({}),
  } as unknown as BrowserControlRelayRegistry;
}

function creationHeaders(panelId: string, userId: string) {
  return {
    authorization: "Bearer managed-token",
    "x-task-handoff-control-plane-id": panelId,
    "x-task-handoff-user-id": userId,
  };
}

function registration(options: RegistrationOptions = {}) {
  const pageHost = options.pageHost || "main-page-pool";
  return {
    panelId: options.panelId || "control_plane_one",
    ownerRef: options.ownerRef || "user_one",
    displayName: "Desktop A",
    hostLabel: "MacBook A",
    publisherRef: options.publisherRef || "publisher-a",
    ...(pageHost === "renderer-webview" ? { rendererHostBinding: "renderer-host-a" } : {}),
    pageHost,
    pageHostCapabilities: pageHost === "renderer-webview"
      ? { ...EMBEDDED_BROWSER_RENDERER_WEBVIEW_CAPABILITIES }
      : { ...EMBEDDED_BROWSER_MAIN_PAGE_POOL_CAPABILITIES },
    cdpIdentity: TEST_CDP_IDENTITY,
  };
}

function page(source: EmbeddedBrowserSource, tabRef: string): EmbeddedBrowserPage {
  return {
    sourceRef: source.sourceRef,
    generation: source.generation,
    tabRef,
    instanceId: "instance_one",
    pageHost: source.pageHost,
    pageHostCapabilities: source.pageHostCapabilities,
    title: tabRef,
    url: `https://example.com/${tabRef}`,
    state: "ready",
    revision: 1,
  };
}

function syncSource(service: BrowserControlService, source: EmbeddedBrowserSource, pages: EmbeddedBrowserPage[]) {
  service.commitSnapshot({
    sourceRef: source.sourceRef,
    generation: source.generation,
    sourceRevision: 1,
    registryEpoch: service.registryEpochValue(),
    snapshotRef: `snapshot-${source.generation}`,
    chunkIndex: 0,
    chunkCount: 1,
    complete: true,
    pages,
  });
  assert.equal(service.syncSourceIfCurrent(
    source.sourceRef,
    source.generation,
    service.registryEpochValue(),
    service.registryRevisionValue(),
  ), true);
}

class CdpTestClient {
  private readonly socket: WebSocket;
  private readonly messages: CdpMessage[] = [];
  private readonly waiters: Array<{
    predicate: (message: CdpMessage) => boolean;
    resolve: (message: CdpMessage) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  }> = [];

  constructor(socket: WebSocket) {
    this.socket = socket;
    socket.on("message", (data) => {
      let message: CdpMessage;
      try {
        message = JSON.parse(Buffer.from(data as Buffer).toString("utf8"));
      } catch {
        return;
      }
      const index = this.waiters.findIndex((waiter) => waiter.predicate(message));
      if (index < 0) {
        this.messages.push(message);
        return;
      }
      const [waiter] = this.waiters.splice(index, 1);
      clearTimeout(waiter!.timer);
      waiter!.resolve(message);
    });
    socket.on("close", () => this.rejectAll(new Error("CDP socket closed.")));
    socket.on("error", (error) => this.rejectAll(error instanceof Error ? error : new Error(String(error))));
  }

  send(value: unknown) {
    this.socket.send(JSON.stringify(value));
  }

  waitFor(predicate: (message: CdpMessage) => boolean, timeoutMs = 2_000) {
    const index = this.messages.findIndex(predicate);
    if (index >= 0) return Promise.resolve(this.messages.splice(index, 1)[0]!);
    return new Promise<CdpMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = this.waiters.findIndex((waiter) => waiter.resolve === resolve);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(new Error("Timed out waiting for a CDP message."));
      }, timeoutMs);
      timer.unref?.();
      this.waiters.push({ predicate, resolve, reject, timer });
    });
  }

  response(id: number) {
    return this.waitFor((message) => message.id === id);
  }

  drainMessages() {
    return this.messages.splice(0);
  }

  close() {
    this.socket.close();
  }

  private rejectAll(error: Error) {
    for (const waiter of this.waiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
  }
}

async function connectCdp(url: string) {
  return new Promise<CdpTestClient>((resolve, reject) => {
    const socket = new WebSocket(url);
    socket.once("open", () => resolve(new CdpTestClient(socket)));
    socket.once("error", reject);
  });
}

async function startBridge(
  service: BrowserControlService,
  relay: BrowserControlRelayRegistry,
  options: { creationWaitMs?: number } = {},
) {
  const app = Fastify({ logger: false });
  await app.register(websocket);
  registerBrowserCdpBridgeRoutes({
    app,
    service,
    relay,
    httpEndpoint: "http://127.0.0.1:65535",
    sessionExists: (sessionRef) => sessionRef === "session_one",
    ...options,
  });
  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address();
  if (!address || typeof address === "string") throw new Error("The test server did not expose a TCP port.");
  return { app, port: address.port };
}

test("browser CDP exposes contexts, targets, sessions, discovery and disconnect cleanup", async () => {
  const service = new BrowserControlService();
  const relay = fakeRelay();
  const attachCalls: unknown[] = [];
  const detachCalls: unknown[] = [];
  const commandCalls: unknown[] = [];
  relay.targetAttach = async (params) => { attachCalls.push(params); return {}; };
  relay.targetDetach = async (params) => { detachCalls.push(params); return {}; };
  relay.cdpSend = async (_sourceRef, _generation, params) => {
    commandCalls.push(params);
    return { value: params.method };
  };
  relay.tabsClose = async () => ({});

  const source = service.registerSource(registration());
  syncSource(service, source, [page(source, "tab_a"), page(source, "tab_b")]);
  service.grantInstanceAccess();
  const token = service.issueCdpToken("session_one").token;
  const { app, port } = await startBridge(service, relay);
  const client = await connectCdp(
    `ws://127.0.0.1:${port}/devtools/browser/${encodeURIComponent(service.registryEpochValue())}?token=${encodeURIComponent(token)}`,
  );

  try {
    const version = await app.inject({ method: "GET", url: `/json/version?token=${encodeURIComponent(token)}` });
    assert.equal(version.statusCode, 200);
    assert.equal(version.json().Browser, "Chrome/150.0.7871.47");
    assert.equal(version.json()["User-Agent"], TEST_CDP_IDENTITY.userAgent);
    assert.equal(version.json()["V8-Version"], TEST_CDP_IDENTITY.v8Version);
    assert.equal(version.json()["WebKit-Version"], TEST_CDP_IDENTITY.webkitVersion);
    assert.match(version.json().webSocketDebuggerUrl, /\/devtools\/browser\//);
    assert.equal((await app.inject({ method: "GET", url: `/json/version/?token=${encodeURIComponent(token)}` })).statusCode, 200);

    const protocol = await app.inject({ method: "GET", url: "/json/protocol" });
    assert.equal(protocol.statusCode, 200);
    assert.ok(protocol.json().domains.some((domain: CdpMessage) => domain.domain === "Browser"));

    const list = await app.inject({ method: "GET", url: `/json/list?token=${encodeURIComponent(token)}` });
    assert.equal(list.statusCode, 200);
    assert.deepEqual(list.json().map((target: CdpMessage) => target.browserContextId), [source.sourceRef, source.sourceRef]);
    assert.equal((await app.inject({ method: "GET", url: `/json/list/?token=${encodeURIComponent(token)}` })).statusCode, 200);

    client.send({ id: 1, method: "Target.getBrowserContexts" });
    assert.deepEqual((await client.response(1)).result, { browserContextIds: [source.sourceRef] });

    client.send({ id: 20, method: "Browser.getVersion" });
    assert.deepEqual((await client.response(20)).result, {
      protocolVersion: "1.3",
      product: "Chrome/150.0.7871.47",
      revision: "@150.0.7871.47",
      userAgent: TEST_CDP_IDENTITY.userAgent,
      jsVersion: TEST_CDP_IDENTITY.v8Version,
    });
    client.send({ id: 21, method: "Browser.setDownloadBehavior", params: {
      behavior: "allowAndName",
      downloadPath: "/tmp/task-handoff-downloads",
      eventsEnabled: true,
    } });
    assert.deepEqual((await client.response(21)).result, {});
    client.send({ id: 22, method: "Schema.getDomains" });
    const domains = (await client.response(22)).result.domains;
    assert.ok(domains.some((domain: CdpMessage) => domain.domain === "Target"));
    client.send({ id: 23, method: "Target.getTargetInfo" });
    assert.deepEqual((await client.response(23)).result.targetInfo, {
      targetId: service.registryEpochValue(),
      type: "browser",
      title: "",
      url: "",
      attached: true,
    });

    client.send({ id: 2, method: "Target.getTargets" });
    const targets = (await client.response(2)).result.targetInfos;
    assert.deepEqual(targets.map((target: CdpMessage) => [target.targetId, target.browserContextId, target.attached]), [
      ["tab_a", source.sourceRef, false],
      ["tab_b", source.sourceRef, false],
    ]);

    client.send({ id: 3, method: "Target.attachToTarget", params: { targetId: "tab_a", flatten: false } });
    assert.equal((await client.response(3)).error.data.code, "BROWSER_OPERATION_UNSUPPORTED");

    client.send({ id: 4, method: "Target.createBrowserContext" });
    assert.equal((await client.response(4)).error.data.code, "BROWSER_OPERATION_UNSUPPORTED");

    client.send({ id: 5, method: "Target.setDiscoverTargets", params: { discover: true } });
    assert.deepEqual((await client.response(5)).result, {});
    const created = await client.waitFor((message) => message.method === "Target.targetCreated");
    assert.equal(created.params.targetInfo.targetId, "tab_a");

    client.send({ id: 6, method: "Target.attachToTarget", params: { targetId: "tab_a", flatten: true } });
    const sessionId = (await client.response(6)).result.sessionId as string;
    assert.ok(sessionId);
    assert.equal(attachCalls.length, 1);

    client.send({ id: 61, method: "Target.attachToTarget", params: { targetId: "tab_b", flatten: true } });
    const secondSessionId = (await client.response(61)).result.sessionId as string;
    assert.ok(secondSessionId);
    assert.equal(service.leaseRefsForSession("session_one").length, 2);

    client.send({ id: 7, sessionId, method: "Runtime.evaluate", params: { expression: "document.title" } });
    const evaluated = await client.response(7);
    assert.equal(evaluated.sessionId, sessionId);
    assert.deepEqual(evaluated.result, { value: "Runtime.evaluate" });
    assert.equal(commandCalls.length, 1);

    client.send({ id: 71, sessionId, method: "Network.enable" });
    assert.deepEqual((await client.response(71)).result, { value: "Network.enable" });
    assert.equal(commandCalls.length, 2);

    client.send({ id: 72, sessionId, method: "Runtime.releaseObject", params: { objectId: "obj_1" } });
    assert.deepEqual((await client.response(72)).result, { value: "Runtime.releaseObject" });
    assert.equal(commandCalls.length, 3);

    client.send({ id: 8, method: "Target.detachFromTarget", params: { sessionId } });
    assert.deepEqual((await client.response(8)).result, {});
    assert.equal(detachCalls.length, 1);
    assert.equal(service.leaseRefsForSession("session_one").length, 1);
    client.send({ id: 9, sessionId, method: "Runtime.evaluate", params: { expression: "1" } });
    assert.equal((await client.response(9)).error.data.code, "BROWSER_LEASE_STALE");

    client.send({ id: 10, method: "Target.attachToTarget", params: { targetId: "tab_b", flatten: true } });
    const reattachedSessionId = (await client.response(10)).result.sessionId as string;
    assert.ok(reattachedSessionId);
    assert.notEqual(reattachedSessionId, secondSessionId);
    assert.equal(service.leaseRefsForSession("session_one").length, 1);
  } finally {
    client.close();
    await new Promise((resolve) => setTimeout(resolve, 25));
    await app.close();
  }

  assert.equal(service.leaseRefsForSession("session_one").length, 0);
  assert.ok(detachCalls.length >= 2);
});

test("browser Target.setAutoAttach attaches current pages and supports waiting clients", async () => {
  const service = new BrowserControlService();
  const relay = fakeRelay();
  const attachCalls: unknown[] = [];
  const commandCalls: unknown[] = [];
  relay.targetAttach = async (params) => { attachCalls.push(params); return {}; };
  relay.cdpSend = async (_sourceRef, _generation, params) => {
    commandCalls.push(params);
    return { value: params.method };
  };

  const source = service.registerSource(registration());
  syncSource(service, source, [page(source, "tab_auto")]);
  service.grantInstanceAccess();
  const token = service.issueCdpToken("session_one").token;
  const { app, port } = await startBridge(service, relay);
  const client = await connectCdp(
    `ws://127.0.0.1:${port}/devtools/browser/${encodeURIComponent(service.registryEpochValue())}?token=${encodeURIComponent(token)}`,
  );

  try {
    client.send({
      id: 1,
      method: "Target.setAutoAttach",
      params: { autoAttach: true, waitForDebuggerOnStart: true, flatten: true, filter: [{ type: "page" }] },
    });
    assert.deepEqual((await client.response(1)).result, {});
    const attached = await client.waitFor((message) => message.method === "Target.attachedToTarget");
    assert.equal(attached.params.targetInfo.targetId, "tab_auto");
    assert.equal(attached.params.targetInfo.attached, true);
    assert.equal(attached.params.waitingForDebugger, true);
    assert.equal(attachCalls.length, 1);

    client.send({ id: 2, sessionId: attached.params.sessionId, method: "Runtime.runIfWaitingForDebugger" });
    const resumed = await client.response(2);
    assert.deepEqual(resumed.result, {});
    assert.equal(resumed.sessionId, attached.params.sessionId);
    assert.equal(commandCalls.length, 0);

    client.send({ id: 3, sessionId: attached.params.sessionId, method: "Target.setAutoAttach", params: {
      autoAttach: true,
      waitForDebuggerOnStart: true,
      flatten: true,
    } });
    assert.deepEqual((await client.response(3)).result, {});
    assert.equal(commandCalls.length, 0);
  } finally {
    client.close();
    await new Promise((resolve) => setTimeout(resolve, 25));
    await app.close();
  }
});

test("browser Target.setAutoAttach emits one attachment per target when discovery overlaps", async () => {
  const service = new BrowserControlService();
  const relay = fakeRelay();
  const attachCalls: unknown[] = [];
  relay.targetAttach = async (params) => {
    attachCalls.push(params);
    await new Promise((resolve) => setTimeout(resolve, 25));
    return {};
  };

  const source = service.registerSource(registration());
  syncSource(service, source, [page(source, "tab_auto_a"), page(source, "tab_auto_b")]);
  service.grantInstanceAccess();
  const token = service.issueCdpToken("session_one").token;
  const { app, port } = await startBridge(service, relay);
  const client = await connectCdp(
    `ws://127.0.0.1:${port}/devtools/browser/${encodeURIComponent(service.registryEpochValue())}?token=${encodeURIComponent(token)}`,
  );

  try {
    client.send({
      id: 1,
      method: "Target.setAutoAttach",
      params: { autoAttach: true, waitForDebuggerOnStart: false, flatten: true, filter: [{ type: "page" }] },
    });
    assert.deepEqual((await client.response(1)).result, {});
    await new Promise((resolve) => setTimeout(resolve, 150));

    const attachments = client.drainMessages().filter((message) => message.method === "Target.attachedToTarget");
    assert.deepEqual(
      attachments.map((message) => message.params.targetInfo.targetId).sort(),
      ["tab_auto_a", "tab_auto_b"],
    );
    assert.equal(new Set(attachments.map((message) => message.params.sessionId)).size, 2);
    assert.equal(attachCalls.length, 2);
  } finally {
    client.close();
    await new Promise((resolve) => setTimeout(resolve, 25));
    await app.close();
  }
});

test("browser CDP keeps Chrome's targetId === main frame id invariant for Playwright", async () => {
  const service = new BrowserControlService();
  const relay = fakeRelay();
  const attachCalls: Array<Record<string, any>> = [];
  const commandCalls: Array<Record<string, any>> = [];
  const listeners = new Set<(event: any) => void>();
  relay.targetAttach = async (params) => { attachCalls.push(params as Record<string, any>); return {}; };
  relay.subscribeCdpEvent = ((listener: (event: any) => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }) as BrowserControlRelayRegistry["subscribeCdpEvent"];
  relay.cdpSend = async (_sourceRef, _generation, params) => {
    commandCalls.push(params as Record<string, any>);
    if (params.method === "Page.getFrameTree") {
      return { frameTree: { frame: { id: "REAL_ELECTRON_FRAME", url: "https://example.com/", loaderId: "L1", mimeType: "text/html", securityOrigin: "https://example.com" } } };
    }
    return { value: params.method };
  };
  const emit = (event: unknown) => {
    for (const listener of [...listeners]) listener(event);
  };

  const source = service.registerSource(registration());
  syncSource(service, source, [page(source, "tab_frame")]);
  service.grantInstanceAccess();
  const token = service.issueCdpToken("session_one").token;
  const { app, port } = await startBridge(service, relay);
  const client = await connectCdp(
    `ws://127.0.0.1:${port}/devtools/browser/${encodeURIComponent(service.registryEpochValue())}?token=${encodeURIComponent(token)}`,
  );

  try {
    client.send({
      id: 1,
      method: "Target.setAutoAttach",
      params: { autoAttach: true, waitForDebuggerOnStart: false, flatten: true, filter: [{ type: "page" }] },
    });
    assert.deepEqual((await client.response(1)).result, {});
    const attached = await client.waitFor((message) => message.method === "Target.attachedToTarget");
    const sessionId = attached.params.sessionId;
    assert.equal(attached.params.targetInfo.targetId, "tab_frame");

    client.send({ id: 2, sessionId, method: "Page.getFrameTree" });
    const tree = await client.response(2);
    assert.equal(tree.result.frameTree.frame.id, "tab_frame");

    client.send({ id: 3, sessionId, method: "Page.createIsolatedWorld", params: { frameId: "tab_frame", worldName: "__playwright" } });
    assert.deepEqual((await client.response(3)).result, { value: "Page.createIsolatedWorld" });
    assert.equal(commandCalls.find((call) => call.method === "Page.createIsolatedWorld")?.params.frameId, "REAL_ELECTRON_FRAME");

    client.send({ id: 4, sessionId, method: "Page.handleJavaScriptDialog", params: { accept: true } });
    assert.deepEqual((await client.response(4)).result, { value: "Page.handleJavaScriptDialog" });
    assert.equal(commandCalls.find((call) => call.method === "Page.handleJavaScriptDialog")?.params.accept, true);

    emit({
      leaseRef: attachCalls[0]!.leaseRef,
      method: "Runtime.executionContextCreated",
      params: { context: { id: 7, name: "__playwright", auxData: { frameId: "REAL_ELECTRON_FRAME", isDefault: false, type: "isolated" } } },
    });
    const context = await client.waitFor((message) => message.method === "Runtime.executionContextCreated");
    assert.equal(context.params.context.auxData.frameId, "tab_frame");

    emit({
      leaseRef: attachCalls[0]!.leaseRef,
      method: "Runtime.bindingCalled",
      params: { name: "__playwrightBinding", payload: "binding-payload", executionContextId: 7 },
    });
    const binding = await client.waitFor((message) => message.method === "Runtime.bindingCalled");
    assert.equal(binding.params.name, "__playwrightBinding");
    assert.equal(binding.params.payload, "binding-payload");

    emit({
      leaseRef: attachCalls[0]!.leaseRef,
      method: "Fetch.requestPaused",
      params: { requestId: "intercept-1", request: { url: "https://example.com/", method: "GET" }, frameId: "REAL_ELECTRON_FRAME" },
    });
    const paused = await client.waitFor((message) => message.method === "Fetch.requestPaused");
    assert.equal(paused.params.requestId, "intercept-1");
    assert.equal(paused.params.frameId, "tab_frame");
  } finally {
    client.close();
    await new Promise((resolve) => setTimeout(resolve, 25));
    await app.close();
  }
});

test("browser CDP dispatches target-session commands concurrently", async () => {
  const service = new BrowserControlService();
  const relay = fakeRelay();
  const attachCalls: Array<Record<string, any>> = [];
  let releaseSlow: (() => void) | undefined;
  relay.targetAttach = async (params) => { attachCalls.push(params as Record<string, any>); return {}; };
  relay.cdpSend = async (_sourceRef, _generation, command) => {
    if (command.method !== "Runtime.callFunctionOn") return {};
    if (command.params?.functionDeclaration === "slow") {
      await new Promise<void>((resolve) => { releaseSlow = resolve; });
      return { slow: true };
    }
    return { fast: true };
  };

  const source = service.registerSource(registration());
  syncSource(service, source, [page(source, "tab_concurrent")]);
  service.grantInstanceAccess();
  const token = service.issueCdpToken("session_one").token;
  const { app, port } = await startBridge(service, relay);
  const client = await connectCdp(
    `ws://127.0.0.1:${port}/devtools/browser/${encodeURIComponent(service.registryEpochValue())}?token=${encodeURIComponent(token)}`,
  );

  try {
    client.send({
      id: 1,
      method: "Target.setAutoAttach",
      params: { autoAttach: true, waitForDebuggerOnStart: false, flatten: true, filter: [{ type: "page" }] },
    });
    assert.deepEqual((await client.response(1)).result, {});
    const attached = await client.waitFor((message) => message.method === "Target.attachedToTarget");
    const sessionId = attached.params.sessionId;

    client.send({ id: 2, sessionId, method: "Runtime.callFunctionOn", params: { functionDeclaration: "slow" } });
    client.send({ id: 3, sessionId, method: "Runtime.callFunctionOn", params: { functionDeclaration: "fast" } });

    const fast = await Promise.race([
      client.response(3),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("The fast command was serialized behind the slow command.")), 250)),
    ]);
    assert.deepEqual(fast.result, { fast: true });
    releaseSlow?.();
    assert.deepEqual((await client.response(2)).result, { slow: true });
    assert.equal(attachCalls.length, 1);
  } finally {
    releaseSlow?.();
    client.close();
    await new Promise((resolve) => setTimeout(resolve, 25));
    await app.close();
  }
});

test("browser CDP supports browser sessions and Storage cookie commands", async () => {
  const service = new BrowserControlService();
  const relay = fakeRelay();
  const commandCalls: Array<Record<string, any>> = [];
  relay.cdpSend = async (_sourceRef, _generation, command) => {
    commandCalls.push(command as Record<string, any>);
    if (command.method === "Network.getCookies") {
      return { cookies: [{ name: "probe", value: "1", domain: "example.com", path: "/", expires: 1, httpOnly: false, secure: true, sameSite: "Lax" }] };
    }
    return { success: true };
  };

  const source = service.registerSource(registration());
  syncSource(service, source, [page(source, "tab_storage")]);
  service.grantInstanceAccess();
  const token = service.issueCdpToken("session_one").token;
  const { app, port } = await startBridge(service, relay);
  const client = await connectCdp(
    `ws://127.0.0.1:${port}/devtools/browser/${encodeURIComponent(service.registryEpochValue())}?token=${encodeURIComponent(token)}`,
  );

  try {
    client.send({ id: 1, method: "Target.attachToBrowserTarget" });
    const browserSession = (await client.response(1)).result.sessionId as string;
    assert.ok(browserSession);

    client.send({
      id: 2,
      sessionId: browserSession,
      method: "Storage.setCookies",
      params: {
        browserContextId: source.sourceRef,
        cookies: [{ name: "probe", value: "1", url: "https://example.com/", path: "/", secure: true, sameSite: "Lax" }],
      },
    });
    const setCookies = await client.response(2);
    assert.equal(setCookies.sessionId, browserSession);
    assert.deepEqual(setCookies.result, {});
    assert.equal(commandCalls.filter((command) => command.method === "Network.setCookie").length, 1);

    client.send({
      id: 3,
      sessionId: browserSession,
      method: "Storage.getCookies",
      params: { browserContextId: source.sourceRef },
    });
    const getCookies = await client.response(3);
    assert.equal(getCookies.sessionId, browserSession);
    assert.equal(getCookies.result.cookies[0].name, "probe");

    client.send({
      id: 4,
      sessionId: browserSession,
      method: "Storage.clearCookies",
      params: { browserContextId: source.sourceRef },
    });
    const clearCookies = await client.response(4);
    assert.equal(clearCookies.sessionId, browserSession);
    assert.ok(commandCalls.some((command) => command.method === "Network.clearBrowserCookies"));

    client.send({
      id: 5,
      method: "Target.attachToTarget",
      params: { targetId: "tab_storage", flatten: true },
    });
    const pageSession = (await client.response(5)).result.sessionId as string;
    client.send({ id: 6, sessionId: pageSession, method: "Storage.getCookies", params: { browserContextId: source.sourceRef } });
    const pageSessionCookies = await client.response(6);
    assert.equal(pageSessionCookies.sessionId, pageSession);
    assert.equal(pageSessionCookies.result.cookies[0].name, "probe");

    client.send({ id: 7, sessionId: browserSession, method: "Runtime.runIfWaitingForDebugger" });
    assert.deepEqual((await client.response(7)).result, {});

    client.send({ id: 8, method: "Target.detachFromTarget", params: { sessionId: browserSession } });
    assert.deepEqual((await client.response(8)).result, {});
    client.send({ id: 9, sessionId: browserSession, method: "Storage.getCookies", params: {} });
    assert.equal((await client.response(9)).error.code, -32000);
  } finally {
    client.close();
    await new Promise((resolve) => setTimeout(resolve, 25));
    await app.close();
  }
});

test("browser CDP keeps explicit target sessions independent", async () => {
  const service = new BrowserControlService();
  const relay = fakeRelay();
  relay.cdpSend = async () => ({ value: 1 });

  const source = service.registerSource(registration());
  syncSource(service, source, [page(source, "tab_independent")]);
  service.grantInstanceAccess();
  const token = service.issueCdpToken("session_one").token;
  const { app, port } = await startBridge(service, relay);
  const client = await connectCdp(
    `ws://127.0.0.1:${port}/devtools/browser/${encodeURIComponent(service.registryEpochValue())}?token=${encodeURIComponent(token)}`,
  );

  try {
    client.send({ id: 1, method: "Target.attachToTarget", params: { targetId: "tab_independent", flatten: true } });
    const first = (await client.response(1)).result.sessionId as string;
    client.send({ id: 2, method: "Target.attachToTarget", params: { targetId: "tab_independent", flatten: true } });
    const second = (await client.response(2)).result.sessionId as string;
    assert.notEqual(first, second);

    client.send({ id: 3, sessionId: second, method: "Runtime.evaluate", params: { expression: "1+1" } });
    assert.deepEqual((await client.response(3)).result, { value: 1 });

    client.send({ id: 4, method: "Target.detachFromTarget", params: { sessionId: second } });
    assert.deepEqual((await client.response(4)).result, {});

    client.send({ id: 5, sessionId: first, method: "Runtime.evaluate", params: { expression: "2+2" } });
    assert.deepEqual((await client.response(5)).result, { value: 1 });

    client.send({ id: 6, method: "Target.detachFromTarget", params: { sessionId: first } });
    assert.deepEqual((await client.response(6)).result, {});
    client.send({ id: 7, sessionId: first, method: "Runtime.evaluate", params: { expression: "3+3" } });
    assert.equal((await client.response(7)).error.code, -32000);

    client.send({ id: 8, method: "Target.attachToBrowserTarget" });
    const browserSession = (await client.response(8)).result.sessionId as string;
    client.send({ id: 9, sessionId: browserSession, method: "Target.attachToTarget", params: { targetId: "tab_independent", flatten: true } });
    const scopedSession = (await client.response(9)).result.sessionId as string;
    client.send({ id: 10, sessionId: browserSession, method: "Target.detachFromTarget", params: { sessionId: scopedSession } });
    assert.deepEqual((await client.response(10)).result, {});
    const scopedEvent = await client.waitFor((message) => message.method === "Target.detachedFromTarget" && message.params?.sessionId === scopedSession);
    assert.equal(scopedEvent.sessionId, browserSession);
  } finally {
    client.close();
    await new Promise((resolve) => setTimeout(resolve, 25));
    await app.close();
  }
});

test("browser CDP routes Chrome download setup and browser-level progress events", async () => {
  const service = new BrowserControlService();
  const relay = fakeRelay();
  const configured: unknown[] = [];
  const cancelled: unknown[] = [];
  let downloadListener: ((event: Record<string, any>) => void) | undefined;
  relay.downloadsConfigure = async (params) => { configured.push(params); return {}; };
  relay.downloadsCancel = async (params) => { cancelled.push(params); return {}; };
  relay.subscribeDownloadEvent = (listener) => {
    downloadListener = listener as (event: Record<string, any>) => void;
    return () => { downloadListener = undefined; };
  };

  const source = service.registerSource(registration());
  syncSource(service, source, [page(source, "tab_download")]);
  service.grantInstanceAccess();
  const token = service.issueCdpToken("session_one").token;
  const { app, port } = await startBridge(service, relay);
  const client = await connectCdp(
    `ws://127.0.0.1:${port}/devtools/browser/${encodeURIComponent(service.registryEpochValue())}?token=${encodeURIComponent(token)}`,
  );

  try {
    client.send({ id: 1, method: "Target.attachToTarget", params: { targetId: "tab_download", flatten: true } });
    assert.ok((await client.response(1)).result.sessionId);

    client.send({ id: 2, method: "Browser.setDownloadBehavior", params: {
      behavior: "allowAndName",
      downloadPath: "/tmp/task-handoff-playwright-downloads",
      eventsEnabled: true,
      browserContextId: source.sourceRef,
    } });
    assert.deepEqual((await client.response(2)).result, {});
    assert.deepEqual(configured, [{
      sourceRef: source.sourceRef,
      generation: source.generation,
      behavior: "allowAndName",
      downloadPath: "/tmp/task-handoff-playwright-downloads",
      eventsEnabled: true,
      browserContextId: source.sourceRef,
    }]);

    downloadListener?.({
      sourceRef: source.sourceRef,
      generation: source.generation,
      tabRef: "tab_download",
      method: "Browser.downloadWillBegin",
      params: { guid: "download_1", url: "https://example.com/file.txt", suggestedFilename: "file.txt" },
    });
    const began = await client.waitFor((message) => message.method === "Browser.downloadWillBegin");
    assert.deepEqual(began.params, {
      guid: "download_1",
      url: "https://example.com/file.txt",
      suggestedFilename: "file.txt",
      frameId: "tab_download",
    });
    assert.equal(began.sessionId, undefined);

    downloadListener?.({
      sourceRef: source.sourceRef,
      generation: source.generation,
      tabRef: "tab_download",
      method: "Browser.downloadProgress",
      params: { guid: "download_1", totalBytes: 4, receivedBytes: 4, state: "completed" },
    });
    const progress = await client.waitFor((message) => message.method === "Browser.downloadProgress");
    assert.equal(progress.params.state, "completed");

    client.send({ id: 3, method: "Browser.cancelDownload", params: {
      guid: "download_1",
      browserContextId: source.sourceRef,
    } });
    assert.deepEqual((await client.response(3)).result, {});
    assert.deepEqual(cancelled, [{
      sourceRef: source.sourceRef,
      generation: source.generation,
      guid: "download_1",
      browserContextId: source.sourceRef,
    }]);
  } finally {
    client.close();
    await new Promise((resolve) => setTimeout(resolve, 25));
    await app.close();
  }
});

test("browser Target.createTarget waits for the bounded creation window before returning a creationRef", async () => {
  const service = new BrowserControlService();
  const relay = fakeRelay();
  relay.targetAttach = async () => ({});
  relay.targetDetach = async () => ({});
  relay.cdpSend = async () => ({});
  relay.tabsClose = async () => ({});
  relay.tabsOpen = async () => ({});

  const first = service.registerSource(registration({ publisherRef: "renderer-a", panelId: "panel_a", ownerRef: "user_a", pageHost: "renderer-webview" }));
  const second = service.registerSource(registration({ publisherRef: "renderer-b", panelId: "panel_b", ownerRef: "user_b", pageHost: "renderer-webview" }));
  syncSource(service, first, []);
  syncSource(service, second, []);
  service.grantInstanceAccess();
  const token = service.issueCdpToken("session_one").token;
  const { app, port } = await startBridge(service, relay, { creationWaitMs: 50 });
  const client = await connectCdp(
    `ws://127.0.0.1:${port}/devtools/browser/${encodeURIComponent(service.registryEpochValue())}?token=${encodeURIComponent(token)}`,
  );

  try {
    const startedAt = Date.now();
    client.send({ id: 1, method: "Target.createTarget", params: { url: "https://example.com/pending" } });
    const pending = await client.response(1);
    assert.ok(Date.now() - startedAt >= 40);
    assert.equal(pending.error.data.code, "BROWSER_CREATION_CONTEXT_REQUIRED");
    assert.match(pending.error.data.creationRef, /^bcr_/);
  } finally {
    client.close();
    await app.close();
  }
});

test("browser Target.createTarget resolves after a single candidate creates the page", async () => {
  const service = new BrowserControlService();
  const relay = fakeRelay();
  relay.targetAttach = async () => ({});
  relay.targetDetach = async () => ({});
  relay.cdpSend = async () => ({});
  relay.tabsClose = async () => ({});
  relay.tabsOpen = async () => ({});

  const source = service.registerSource(registration({ publisherRef: "renderer-a", pageHost: "renderer-webview" }));
  syncSource(service, source, []);
  service.grantInstanceAccess();
  const token = service.issueCdpToken("session_one").token;
  service.setCreationDispatcher(async (creation, target) => {
    const binding = service.sourceBinding(target.sourceRef, target.generation);
    const created = page(source, "tab_created");
    service.commitDelta({
      sourceRef: target.sourceRef,
      generation: target.generation,
      baseRevision: binding.sourceRevision,
      revision: binding.sourceRevision + 1,
      upserts: [created],
      removes: [],
    });
    service.completeCreation(target.sourceRef, creation.creationRef, created.tabRef);
  });
  const { app, port } = await startBridge(service, relay);
  const client = await connectCdp(
    `ws://127.0.0.1:${port}/devtools/browser/${encodeURIComponent(service.registryEpochValue())}?token=${encodeURIComponent(token)}`,
  );

  try {
    client.send({ id: 1, method: "Target.createTarget", params: { url: "https://example.com/created" } });
    assert.deepEqual((await client.response(1)).result, { targetId: "tab_created" });
    assert.equal(service.defaultCreationContext()?.sourceRef, source.sourceRef);
  } finally {
    client.close();
    await app.close();
  }
});

test("browser Target.createTarget waits for a panel takeover and then creates on the new default", async () => {
  const service = new BrowserControlService();
  const relay = fakeRelay();
  relay.tabsOpen = async () => ({});

  const first = service.registerSource(registration({ publisherRef: "renderer-a", panelId: "panel_a", ownerRef: "user_a", pageHost: "renderer-webview" }));
  const second = service.registerSource(registration({ publisherRef: "renderer-b", panelId: "panel_b", ownerRef: "user_b", pageHost: "renderer-webview" }));
  syncSource(service, first, []);
  syncSource(service, second, []);
  service.grantInstanceAccess();
  service.setCreationDispatcher(async (creation, target) => {
    const binding = service.sourceBinding(target.sourceRef, target.generation);
    const created = page(first, "tab_claimed");
    service.commitDelta({
      sourceRef: target.sourceRef,
      generation: target.generation,
      baseRevision: binding.sourceRevision,
      revision: binding.sourceRevision + 1,
      upserts: [created],
      removes: [],
    });
    service.completeCreation(target.sourceRef, creation.creationRef, created.tabRef);
  });
  const token = service.issueCdpToken("session_one").token;
  const { app, port } = await startBridge(service, relay, { creationWaitMs: 1_000 });
  const client = await connectCdp(
    `ws://127.0.0.1:${port}/devtools/browser/${encodeURIComponent(service.registryEpochValue())}?token=${encodeURIComponent(token)}`,
  );

  try {
    client.send({ id: 1, method: "Target.createTarget", params: { url: "https://example.com/claimed" } });
    await new Promise((resolve) => setTimeout(resolve, 20));
    service.claimDefaultContext({
      sourceRef: first.sourceRef,
      expectedRevision: service.creationContextRevisionValue(),
      panelId: "panel_a",
      ownerRef: "user_a",
    });
    const response = await client.response(1);
    assert.equal(response.result.targetId, "tab_claimed");
    assert.equal(service.defaultCreationContext()?.sourceRef, first.sourceRef);
  } finally {
    client.close();
    await app.close();
  }
});

test("creation-context routes only let a panel claim its own source and expose read-only panels", async () => {
  const service = new BrowserControlService();
  const relay = fakeRelay();
  const first = service.registerSource(registration({ publisherRef: "pool-a", panelId: "panel_a", ownerRef: "user_a" }));
  const second = service.registerSource(registration({ publisherRef: "pool-b", panelId: "panel_b", ownerRef: "user_b" }));
  syncSource(service, first, []);
  syncSource(service, second, []);
  const app = Fastify({ logger: false });
  await app.register(websocket);
  registerBrowserControlRoutes({ app, service, relay, registrationToken: "managed-token" });

  try {
    const ownSnapshot = await app.inject({
      method: "GET",
      url: `/api/browser-control/creation-context?sourceRef=${encodeURIComponent(first.sourceRef)}`,
      headers: creationHeaders("panel_a", "user_a"),
    });
    assert.equal(ownSnapshot.statusCode, 200);
    const ownPanels = ownSnapshot.json().data.panels as CdpMessage[];
    assert.equal(ownPanels.find((panel) => panel.sourceRef === first.sourceRef)?.canClaim, true);
    assert.equal(ownPanels.find((panel) => panel.sourceRef === second.sourceRef)?.canClaim, false);

    const webSnapshot = await app.inject({
      method: "GET",
      url: "/api/browser-control/creation-context",
      headers: creationHeaders("panel_a", "user_a"),
    });
    assert.equal(webSnapshot.statusCode, 200);
    assert.ok((webSnapshot.json().data.panels as CdpMessage[]).every((panel) => panel.canClaim === false));

    const forged = await app.inject({
      method: "PUT",
      url: "/api/browser-control/creation-context",
      headers: creationHeaders("panel_a", "user_a"),
      payload: { sourceRef: second.sourceRef, expectedRevision: 0 },
    });
    assert.equal(forged.statusCode, 403);
    assert.equal(forged.json().error.code, "BROWSER_CREATION_CONTEXT_NOT_OWNED");

    const claimed = await app.inject({
      method: "PUT",
      url: "/api/browser-control/creation-context",
      headers: creationHeaders("panel_a", "user_a"),
      payload: { sourceRef: first.sourceRef, expectedRevision: 0 },
    });
    assert.equal(claimed.statusCode, 200);
    assert.equal(claimed.json().data.browserContextId, first.sourceRef);

    const forgedRevoke = await app.inject({
      method: "DELETE",
      url: "/api/browser-control/creation-context",
      headers: creationHeaders("panel_b", "user_b"),
      payload: { sourceRef: first.sourceRef, expectedRevision: 1 },
    });
    assert.equal(forgedRevoke.statusCode, 403);
    assert.equal(forgedRevoke.json().error.code, "BROWSER_CREATION_CONTEXT_NOT_OWNED");

    const readOnlyRevoke = await app.inject({
      method: "DELETE",
      url: "/api/browser-control/creation-context",
      headers: creationHeaders("panel_a", "user_a"),
    });
    assert.equal(readOnlyRevoke.statusCode, 400);
    assert.equal(readOnlyRevoke.json().error.code, "BROWSER_REQUEST_INVALID");
    assert.equal(service.defaultCreationContext()?.sourceRef, first.sourceRef);

    const revoked = await app.inject({
      method: "DELETE",
      url: "/api/browser-control/creation-context",
      headers: creationHeaders("panel_a", "user_a"),
      payload: { sourceRef: first.sourceRef, expectedRevision: 1 },
    });
    assert.equal(revoked.statusCode, 200);
    assert.equal(revoked.json().data.cleared, true);
    assert.equal(service.defaultCreationContext(), undefined);
  } finally {
    await app.close();
  }
});

test("/json/new shares the same default context and returns the created target", async () => {
  const service = new BrowserControlService();
  const relay = fakeRelay();
  const source = service.registerSource(registration({ publisherRef: "renderer-http", pageHost: "renderer-webview" }));
  syncSource(service, source, []);
  service.grantInstanceAccess();
  const token = service.issueCdpToken("session_one").token;
  service.setCreationDispatcher(async (creation, target) => {
    const binding = service.sourceBinding(target.sourceRef, target.generation);
    const created = page(source, "tab_http");
    service.commitDelta({
      sourceRef: target.sourceRef,
      generation: target.generation,
      baseRevision: binding.sourceRevision,
      revision: binding.sourceRevision + 1,
      upserts: [created],
      removes: [],
    });
    service.completeCreation(target.sourceRef, creation.creationRef, created.tabRef);
  });
  const { app } = await startBridge(service, relay);

  try {
    const created = await app.inject({
      method: "GET",
      url: `/json/new?url=${encodeURIComponent("https://example.com/http")}&token=${encodeURIComponent(token)}`,
    });
    assert.equal(created.statusCode, 200);
    assert.equal(created.json().id, "tab_http");
    assert.equal(created.json().browserContextId, source.sourceRef);
    assert.match(created.json().webSocketDebuggerUrl, /\/devtools\/page\/tab_http/);
    assert.equal(service.defaultCreationContext()?.sourceRef, source.sourceRef);
  } finally {
    await app.close();
  }
});
