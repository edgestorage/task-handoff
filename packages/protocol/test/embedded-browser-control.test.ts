import assert from "node:assert/strict";
import test from "node:test";
import {
  EMBEDDED_BROWSER_CDP_PROFILE,
  EMBEDDED_BROWSER_CONTROL_MAX_MESSAGE_BYTES,
  EMBEDDED_BROWSER_CONTROL_MESSAGE_MAX_BYTES,
  EMBEDDED_BROWSER_FRAME_HEADER_BYTES,
  EMBEDDED_BROWSER_HTTP_RESULT_MAX_BYTES,
  EMBEDDED_BROWSER_TARGET_CDP_PROFILE,
  EmbeddedBrowserControlMessageDecoder,
  EmbeddedBrowserAccessViewSchema,
  EmbeddedBrowserAccessRequestChangedEventSchema,
  EmbeddedBrowserCdpAccessResultSchema,
  EmbeddedBrowserCdpCommandSchema,
  EmbeddedBrowserCdpAccessSchema,
  EmbeddedBrowserControlErrorSchema,
  EmbeddedBrowserCreationContextChangedEventSchema,
  EmbeddedBrowserCreationContextSnapshotSchema,
  EmbeddedBrowserCreationViewSchema,
  EmbeddedBrowserCdpEventSchema,
  EmbeddedBrowserDefaultContextClaimRequestSchema,
  EmbeddedBrowserDefaultContextClaimResultSchema,
  EmbeddedBrowserFrameDecoder,
  EmbeddedBrowserPageHostCapabilitiesSchema,
  EmbeddedBrowserPageSchema,
  EmbeddedBrowserRpcRequestSchema,
  EmbeddedBrowserSourceSchema,
  EmbeddedBrowserSourceDeltaSchema,
  EmbeddedBrowserSourceRegistrationRequestSchema,
  EmbeddedBrowserSourceSnapshotSchema,
  EmbeddedBrowserTargetAttachToTargetParamsSchema,
  EmbeddedBrowserTargetCdpEventSchema,
  EmbeddedBrowserTargetCreateTargetParamsSchema,
  EmbeddedBrowserTargetDetachFromTargetParamsSchema,
  EmbeddedBrowserTargetGetBrowserContextsResultSchema,
  EmbeddedBrowserTargetGetTargetInfoResultSchema,
  EmbeddedBrowserTargetInfoSchema,
  EmbeddedBrowserTargetSetAutoAttachParamsSchema,
  EmbeddedBrowserTabsOpenParamsSchema,
  assertEmbeddedBrowserTargetCdpMethod,
  assertEmbeddedBrowserCdpMethod,
  decodeEmbeddedBrowserChannelError,
  decodeEmbeddedBrowserFrame,
  decodeEmbeddedBrowserStreamOpenOk,
  decodeEmbeddedBrowserStreamOpen,
  encodeEmbeddedBrowserChannelError,
  encodeEmbeddedBrowserControlMessage,
  encodeEmbeddedBrowserFrame,
  encodeEmbeddedBrowserStreamOpenOk,
  encodeEmbeddedBrowserStreamOpen,
  embeddedBrowserCdpMethodKind,
  embeddedBrowserCdpProtocolDocument,
  embeddedBrowserBrowserContextId,
  embeddedBrowserTargetId,
  embeddedBrowserTargetInfoFromPage,
  normalizeEmbeddedBrowserChannelCapabilities,
  supportsEmbeddedBrowserCdpEvent,
  supportsEmbeddedBrowserPageHost,
  supportsEmbeddedBrowserTargetCdp,
  supportsEmbeddedBrowserTargetCdpEvent,
  supportsEmbeddedBrowserTargetCdpMethod,
  supportsEmbeddedBrowserTabOrigin,
} from "../src/embedded-browser-control.ts";
import { normalizeControlledInstanceCapabilities, supportsControlledInstanceEmbeddedBrowserChannel } from "../src/control-plane.ts";

test("embedded browser frames round-trip through sliced buffers and fragmented or coalesced chunks", () => {
  const first = encodeEmbeddedBrowserFrame({ type: "open", streamId: 1, payload: new TextEncoder().encode('{"streamKind":"control"}') });
  const second = encodeEmbeddedBrowserFrame({ type: "data", streamId: 1, payload: new Uint8Array([7, 8, 9]) });
  const padded = new Uint8Array(first.byteLength + 2);
  padded.set(first, 1);
  assert.equal(decodeEmbeddedBrowserFrame(padded.subarray(1, -1)).type, "open");

  const decoder = new EmbeddedBrowserFrameDecoder();
  const merged = new Uint8Array(first.byteLength + second.byteLength);
  merged.set(first);
  merged.set(second, first.byteLength);
  assert.deepEqual(decoder.push(merged.subarray(0, 3)), []);
  assert.deepEqual(decoder.push(merged.subarray(3, first.byteLength + 2)).map((frame) => frame.type), ["open"]);
  assert.deepEqual(decoder.push(merged.subarray(first.byteLength + 2)).map((frame) => frame.type), ["data"]);
  decoder.finish();
});

test("embedded browser frame and control decoders reject protocol violations", () => {
  assert.throws(() => decodeEmbeddedBrowserFrame(new Uint8Array(EMBEDDED_BROWSER_FRAME_HEADER_BYTES - 1)), { code: "BROWSER_CHANNEL_PROTOCOL_ERROR" });
  assert.throws(() => encodeEmbeddedBrowserFrame({ type: "data", streamId: 0, payload: new Uint8Array() }), { code: "BROWSER_CHANNEL_PROTOCOL_ERROR" });
  assert.throws(() => encodeEmbeddedBrowserFrame({ type: "data", streamId: 1, payload: new Uint8Array(EMBEDDED_BROWSER_CONTROL_MAX_MESSAGE_BYTES + 1) }), { code: "BROWSER_CHANNEL_PROTOCOL_ERROR" });
  const invalid = new Uint8Array(EMBEDDED_BROWSER_FRAME_HEADER_BYTES);
  invalid[0] = 99;
  assert.throws(() => decodeEmbeddedBrowserFrame(invalid), { code: "BROWSER_CHANNEL_PROTOCOL_ERROR" });

  const decoder = new EmbeddedBrowserControlMessageDecoder();
  const message = encodeEmbeddedBrowserControlMessage({ jsonrpc: "2.0", id: 1, method: "tabs.list" });
  assert.deepEqual(decoder.push(message.subarray(0, 2)), []);
  assert.deepEqual(decoder.push(message.subarray(2)), [{ jsonrpc: "2.0", id: 1, method: "tabs.list" }]);
  decoder.finish();
  assert.throws(() => decoder.push(new Uint8Array([0, 0, 0, 0])), { code: "BROWSER_CHANNEL_PROTOCOL_ERROR" });
  assert.deepEqual(decodeEmbeddedBrowserStreamOpen(encodeEmbeddedBrowserStreamOpen({ streamKind: "control" })), { streamKind: "control" });
  assert.throws(() => decodeEmbeddedBrowserStreamOpen(new TextEncoder().encode('{"streamKind":"tcp","host":"example.com","port":443}')), { code: "BROWSER_CHANNEL_STREAM_KIND_UNSUPPORTED" });
  assert.throws(() => decodeEmbeddedBrowserStreamOpen(new TextEncoder().encode("not-json")), { code: "BROWSER_CHANNEL_PROTOCOL_ERROR" });
});

test("JSON-RPC and public page DTOs keep the renderer local key out of the wire model", () => {
  assert.deepEqual(EmbeddedBrowserRpcRequestSchema.parse({ jsonrpc: "2.0", id: "request_1", method: "tabs.get", params: { tabRef: "browser_tab_1" } }), {
    jsonrpc: "2.0",
    id: "request_1",
    method: "tabs.get",
    params: { tabRef: "browser_tab_1" },
  });
  const page = EmbeddedBrowserPageSchema.parse({
    sourceRef: "source_1",
    generation: 2,
    tabRef: "browser_tab_1",
    instanceId: "instance_1",
    pageHost: "renderer-webview",
    pageHostCapabilities: { backgroundCreation: false, surviveHostWindowClose: false, crossWindowAdopt: false },
    revision: 7,
    sessionKey: "local-only-key",
    webContentsId: 42,
    partition: "persist:private",
  });
  assert.equal("sessionKey" in page, false);
  assert.equal("webContentsId" in page, false);
  assert.equal("partition" in page, false);
  assert.equal(page.pageHost, "renderer-webview");
});

test("page-host capabilities and source DTOs normalize to the authoritative fields", () => {
  assert.deepEqual(EmbeddedBrowserPageHostCapabilitiesSchema.parse({ backgroundCreation: true }), {
    backgroundCreation: true,
    surviveHostWindowClose: false,
    crossWindowAdopt: false,
  });
  const source = EmbeddedBrowserSourceSchema.parse({
    sourceRef: "source_1",
    generation: 1,
    panelId: "control_plane_1",
    displayName: "Desktop A",
    pageHost: "main-page-pool",
    pageHostCapabilities: { backgroundCreation: true, surviveHostWindowClose: true, crossWindowAdopt: true },
    revision: 3,
    hostWindowId: 9,
  });
  assert.equal("hostWindowId" in source, false);
  assert.equal(source.pageHost, "main-page-pool");
});

test("renderer webview sources cannot advertise background or cross-window capabilities", () => {
  assert.throws(() => EmbeddedBrowserSourceSchema.parse({
    sourceRef: "source_1",
    generation: 1,
    panelId: "control_plane_1",
    displayName: "Desktop A",
    pageHost: "renderer-webview",
    pageHostCapabilities: { backgroundCreation: true },
    revision: 1,
  }), /renderer-webview cannot support background creation/);
  assert.throws(() => EmbeddedBrowserPageSchema.parse({
    sourceRef: "source_1",
    generation: 1,
    tabRef: "browser_tab_1",
    instanceId: "instance_1",
    pageHost: "renderer-webview",
    pageHostCapabilities: { crossWindowAdopt: true },
    revision: 1,
  }), /renderer-webview cannot support cross-window adoption/);
});

test("the CDP profile is a method and namespace allowlist with stable classes and events", () => {
  assert.equal(EMBEDDED_BROWSER_CDP_PROFILE, "electron-page-cdp");
  assert.equal(embeddedBrowserCdpMethodKind("Page.navigate"), "page-write");
  assert.equal(embeddedBrowserCdpMethodKind("Runtime.evaluate"), "page-write");
  assert.equal(embeddedBrowserCdpMethodKind("Accessibility.getFullAXTree"), "read");
  assert.equal(embeddedBrowserCdpMethodKind("Network.enable"), "session");
  assert.equal(embeddedBrowserCdpMethodKind("Runtime.releaseObject"), "session");
  assert.equal(embeddedBrowserCdpMethodKind("Fetch.continueRequest"), "page-write");
  assert.equal(embeddedBrowserCdpMethodKind("Network.emulateNetworkConditions"), "session");
  assert.equal(embeddedBrowserCdpMethodKind("Page.handleJavaScriptDialog"), "page-write");
  assert.equal(embeddedBrowserCdpMethodKind("Page.navigateToHistoryEntry"), "page-write");
  assert.equal(embeddedBrowserCdpMethodKind("Emulation.setDeviceMetricsOverride"), "page-write");
  assert.equal(embeddedBrowserCdpMethodKind("Emulation.setUserAgentOverride"), "page-write");
  assert.equal(embeddedBrowserCdpMethodKind("Target.attachToTarget"), undefined);
  assert.equal(embeddedBrowserCdpMethodKind("Browser.getVersion"), undefined);
  assert.equal(embeddedBrowserCdpMethodKind("Page.navigate\nRuntime.evaluate"), undefined);
  assert.equal(supportsEmbeddedBrowserCdpEvent("Page.lifecycleEvent"), true);
  assert.equal(supportsEmbeddedBrowserCdpEvent("Runtime.bindingCalled"), true);
  assert.equal(supportsEmbeddedBrowserCdpEvent("Fetch.requestPaused"), true);
  assert.equal(supportsEmbeddedBrowserCdpEvent("Page.fileChooserOpened"), true);
  assert.equal(supportsEmbeddedBrowserCdpEvent("Target.targetCreated"), false);
  assert.throws(() => assertEmbeddedBrowserCdpMethod("Target.attachToTarget"), { code: "BROWSER_OPERATION_UNSUPPORTED" });
  assert.equal(assertEmbeddedBrowserCdpMethod("Network.enable"), "Network.enable");
  assert.equal(assertEmbeddedBrowserCdpMethod("Runtime.releaseObject"), "Runtime.releaseObject");
  assert.equal(assertEmbeddedBrowserCdpMethod("Page.navigate"), "Page.navigate");
  assert.equal(assertEmbeddedBrowserCdpMethod("Emulation.setDeviceMetricsOverride"), "Emulation.setDeviceMetricsOverride");
});

test("source registration carries the desktop host's CDP identity", () => {
  const parsed = EmbeddedBrowserSourceRegistrationRequestSchema.parse({
    displayName: "Desktop",
    publisherRef: "publisher",
    pageHost: "renderer-webview",
    rendererHostBinding: "renderer-host",
    cdpIdentity: {
      chromeVersion: "150.0.7871.47",
      userAgent: "Mozilla/5.0 Chrome/150.0.7871.47 Safari/537.36",
      v8Version: "15.0.245.15-electron.0",
      webkitVersion: "537.36",
    },
  });
  assert.equal(parsed.cdpIdentity?.chromeVersion, "150.0.7871.47");
  assert.equal(EmbeddedBrowserSourceRegistrationRequestSchema.parse({
    displayName: "Desktop",
    publisherRef: "publisher",
    pageHost: "main-page-pool",
  }).cdpIdentity, undefined);
});

test("the CDP protocol document lists the browser and page methods Chrome clients discover", () => {
  const document = embeddedBrowserCdpProtocolDocument();
  const domain = (name: string) => document.domains.find((entry) => entry.domain === name);
  assert.deepEqual(domain("Browser")?.commands, [
    { name: "cancelDownload" },
    { name: "getVersion" },
    { name: "setDownloadBehavior" },
  ]);
  assert.deepEqual(domain("Browser")?.events, [{ name: "downloadProgress" }, { name: "downloadWillBegin" }]);
  assert.ok(domain("Schema")?.commands?.some((command) => command.name === "getDomains"));
  assert.ok(domain("Target")?.commands?.some((command) => command.name === "setAutoAttach"));
  assert.ok(domain("Target")?.events?.some((event) => event.name === "attachedToTarget"));
  assert.ok(domain("Page")?.commands?.some((command) => command.name === "captureScreenshot"));
  assert.ok(domain("Emulation")?.commands?.some((command) => command.name === "setFocusEmulationEnabled"));
  assert.equal(document.version.major, "1");
  assert.equal(document.version.minor, "3");
});

test("control messages may exceed one frame while the frame payload stays bounded", () => {
  assert.equal(EMBEDDED_BROWSER_CONTROL_MESSAGE_MAX_BYTES, 16 * 1024 * 1024);
  const large = encodeEmbeddedBrowserControlMessage({ data: "x".repeat(EMBEDDED_BROWSER_CONTROL_MAX_MESSAGE_BYTES * 2) });
  assert.ok(large.byteLength > EMBEDDED_BROWSER_CONTROL_MAX_MESSAGE_BYTES);
  const decoder = new EmbeddedBrowserControlMessageDecoder();
  const values = [];
  for (let offset = 0; offset < large.byteLength; offset += EMBEDDED_BROWSER_CONTROL_MAX_MESSAGE_BYTES) {
    values.push(...decoder.push(large.subarray(offset, offset + EMBEDDED_BROWSER_CONTROL_MAX_MESSAGE_BYTES)));
  }
  assert.equal(values.length, 1);
  assert.equal((values[0] as { data: string }).data.length, EMBEDDED_BROWSER_CONTROL_MAX_MESSAGE_BYTES * 2);
  decoder.finish();
});

test("Target.getTargetInfo accepts browser-root discovery without a target id", () => {
  const parsed = EmbeddedBrowserTargetGetTargetInfoResultSchema.parse({
    targetInfo: { targetId: "browser-root", type: "browser", title: "", url: "", attached: true },
  });
  assert.equal(parsed.targetInfo.type, "browser");
  assert.equal(parsed.targetInfo.targetId, "browser-root");
});

test("Target.setAutoAttach accepts Chrome filters and requires flattened sessions", () => {
  const parsed = EmbeddedBrowserTargetSetAutoAttachParamsSchema.parse({
    autoAttach: true,
    waitForDebuggerOnStart: true,
    flatten: true,
    filter: [{ type: "page", exclude: true }, {}],
  });
  assert.equal(parsed.filter?.length, 2);
  assert.throws(() => EmbeddedBrowserTargetSetAutoAttachParamsSchema.parse({
    autoAttach: true,
    waitForDebuggerOnStart: true,
    flatten: false,
  }), /flatten=true/);
});

test("browser-level Target CDP reuses sourceRef and tabRef as context and target identities", () => {
  const page = EmbeddedBrowserPageSchema.parse({
    sourceRef: "bsr_source_a",
    generation: 1,
    tabRef: "tab_a",
    instanceId: "instance_1",
    pageHost: "main-page-pool",
    pageHostCapabilities: { backgroundCreation: true, surviveHostWindowClose: true, crossWindowAdopt: true },
    title: "A",
    url: "https://a.example/",
    revision: 1,
  });
  assert.equal(embeddedBrowserBrowserContextId(page.sourceRef), "bsr_source_a");
  assert.equal(embeddedBrowserTargetId(page.tabRef), "tab_a");
  assert.deepEqual(embeddedBrowserTargetInfoFromPage(page), {
    targetId: "tab_a",
    type: "page",
    title: "A",
    url: "https://a.example/",
    attached: false,
    browserContextId: "bsr_source_a",
  });
  assert.equal(EmbeddedBrowserTargetInfoSchema.parse({
    targetId: "tab_a",
    type: "page",
    attached: false,
    browserContextId: "bsr_source_a",
    openerId: "ignored",
    futureField: true,
  }).url, "about:blank");
  assert.deepEqual(EmbeddedBrowserTargetGetBrowserContextsResultSchema.parse({
    browserContextIds: ["bsr_source_a", "bsr_source_b"],
    defaultBrowserContextId: "bsr_source_a",
    futureField: true,
  }), {
    browserContextIds: ["bsr_source_a", "bsr_source_b"],
    defaultBrowserContextId: "bsr_source_a",
  });
});

test("browser-level Target methods and discovery events stay in a separate allowlist", () => {
  assert.equal(EMBEDDED_BROWSER_TARGET_CDP_PROFILE, "embedded-browser-target-cdp");
  assert.equal(supportsEmbeddedBrowserTargetCdpMethod("Target.getTargets"), true);
  assert.equal(supportsEmbeddedBrowserTargetCdpMethod("Target.createTarget"), true);
  assert.equal(supportsEmbeddedBrowserTargetCdpMethod("Target.createBrowserContext"), false);
  assert.equal(supportsEmbeddedBrowserTargetCdpMethod("Browser.getVersion"), true);
  assert.equal(assertEmbeddedBrowserTargetCdpMethod("Target.attachToTarget"), "Target.attachToTarget");
  assert.throws(() => assertEmbeddedBrowserTargetCdpMethod("Target.createBrowserContext"), { code: "BROWSER_OPERATION_UNSUPPORTED" });
  assert.equal(supportsEmbeddedBrowserTargetCdpEvent("Target.targetCreated"), true);
  assert.equal(supportsEmbeddedBrowserTargetCdpEvent("Target.attachedToTarget"), true);
  assert.equal(supportsEmbeddedBrowserTargetCdpEvent("Target.targetDestroyed"), true);
  assert.equal(supportsEmbeddedBrowserTargetCdpEvent("Target.setAutoAttach"), false);

  assert.deepEqual(EmbeddedBrowserTargetAttachToTargetParamsSchema.parse({ targetId: "tab_a", flatten: true, futureField: true }), {
    targetId: "tab_a",
    flatten: true,
  });
  assert.throws(() => EmbeddedBrowserTargetAttachToTargetParamsSchema.parse({ targetId: "tab_a", flatten: false }), /Invalid input/);
  assert.throws(() => EmbeddedBrowserTargetDetachFromTargetParamsSchema.parse({}), /sessionId or targetId/);
  assert.deepEqual(EmbeddedBrowserTargetDetachFromTargetParamsSchema.parse({ targetId: "tab_a", futureField: true }), { targetId: "tab_a" });
  assert.deepEqual(EmbeddedBrowserTargetCreateTargetParamsSchema.parse({ url: "about:blank", browserContextId: "bsr_source_a" }), {
    url: "about:blank",
    browserContextId: "bsr_source_a",
  });
  assert.deepEqual(EmbeddedBrowserTargetCdpEventSchema.parse({
    method: "Target.targetInfoChanged",
    params: {
      targetInfo: {
        targetId: "tab_a",
        type: "page",
        title: "A",
        url: "https://a.example/",
        attached: true,
        browserContextId: "bsr_source_a",
      },
    },
  }).method, "Target.targetInfoChanged");
  assert.deepEqual(EmbeddedBrowserTargetCdpEventSchema.parse({
    method: "Target.attachedToTarget",
    params: {
      sessionId: "target_session_1",
      targetInfo: {
        targetId: "tab_a",
        type: "page",
        title: "A",
        url: "https://a.example/",
        attached: true,
        browserContextId: "bsr_source_a",
        futureField: true,
      },
      waitingForDebugger: true,
      futureField: true,
    },
  }), {
    method: "Target.attachedToTarget",
    params: {
      sessionId: "target_session_1",
      targetInfo: {
        targetId: "tab_a",
        type: "page",
        title: "A",
        url: "https://a.example/",
        attached: true,
        browserContextId: "bsr_source_a",
      },
      waitingForDebugger: true,
    },
  });
});

test("default creation context and panel claims are single-owner compare-and-swap DTOs", () => {
  const snapshot = EmbeddedBrowserCreationContextSnapshotSchema.parse({
    revision: 3,
    defaultContext: { sourceRef: "bsr_source_a", browserContextId: "bsr_source_a" },
    panels: [
      { sourceRef: "bsr_source_a", panelLabel: "MacBook", pageHost: "main-page-pool", canCreate: true, isDefault: true, canClaim: true },
      { sourceRef: "bsr_source_b", panelLabel: "Mac mini", hostLabel: "Window", pageHost: "renderer-webview", canCreate: true, isDefault: false, canClaim: false },
    ],
    pendingCreation: { creationRef: "creation_1", url: "https://example.com/", expiresAt: "2026-11-22T12:02:00.000Z" },
    futureField: true,
  });
  assert.equal(snapshot.pendingCreation?.state, "pending");
  assert.equal(snapshot.panels.filter((panel) => panel.isDefault).length, 1);
  assert.throws(() => EmbeddedBrowserCreationContextSnapshotSchema.parse({
    revision: 3,
    panels: [
      { sourceRef: "bsr_source_a", panelLabel: "A", pageHost: "main-page-pool", canCreate: true, isDefault: true },
      { sourceRef: "bsr_source_b", panelLabel: "B", pageHost: "main-page-pool", canCreate: true, isDefault: true },
    ],
  }), /At most one panel/);
  assert.throws(() => EmbeddedBrowserCreationContextSnapshotSchema.parse({
    revision: 3,
    defaultContext: { sourceRef: "bsr_source_a", browserContextId: "bsr_source_a" },
    panels: [
      { sourceRef: "bsr_source_b", panelLabel: "B", pageHost: "main-page-pool", canCreate: true, isDefault: true },
    ],
  }), /must match defaultContext/);

  assert.deepEqual(EmbeddedBrowserDefaultContextClaimRequestSchema.parse({ sourceRef: "bsr_source_b", expectedRevision: 3 }), {
    sourceRef: "bsr_source_b",
    expectedRevision: 3,
  });
  assert.throws(() => EmbeddedBrowserDefaultContextClaimRequestSchema.parse({ sourceRef: "bsr_source_b", expectedRevision: 3, targetSourceRef: "bsr_source_a" }), /Unrecognized key/);
  assert.deepEqual(EmbeddedBrowserDefaultContextClaimResultSchema.parse({
    sourceRef: "bsr_source_b",
    browserContextId: "bsr_source_b",
    revision: 4,
  }), {
    sourceRef: "bsr_source_b",
    browserContextId: "bsr_source_b",
    revision: 4,
  });
  assert.throws(() => EmbeddedBrowserDefaultContextClaimResultSchema.parse({
    sourceRef: "bsr_source_b",
    browserContextId: "bsr_source_a",
    revision: 4,
  }), /browserContextId must equal sourceRef/);
  assert.deepEqual(EmbeddedBrowserCreationContextChangedEventSchema.parse({
    type: "browser.creation-context.changed",
    revision: 4,
    defaultBrowserContextId: "bsr_source_b",
    previousBrowserContextId: "bsr_source_a",
  }), {
    type: "browser.creation-context.changed",
    revision: 4,
    defaultBrowserContextId: "bsr_source_b",
    previousBrowserContextId: "bsr_source_a",
  });
  assert.deepEqual(EmbeddedBrowserControlErrorSchema.parse({
    code: "BROWSER_CREATION_CONTEXT_REQUIRED",
    message: "pending",
    creationRef: "creation_1",
    expiresAt: "2026-11-22T12:02:00.000Z",
    futureField: true,
  }), {
    code: "BROWSER_CREATION_CONTEXT_REQUIRED",
    message: "pending",
    execution: "not-started",
    creationRef: "creation_1",
    expiresAt: "2026-11-22T12:02:00.000Z",
  });
  assert.throws(() => EmbeddedBrowserDefaultContextClaimRequestSchema.parse({ sourceRef: "bsr_source_b" }), /expectedRevision/);
});

test("CDP command and event DTOs reject methods outside the profile", () => {
  assert.deepEqual(EmbeddedBrowserCdpCommandSchema.parse({
    leaseRef: "lease_1",
    method: "Page.navigate",
    params: { url: "https://example.com" },
    requestId: "request_1",
  }), {
    leaseRef: "lease_1",
    method: "Page.navigate",
    params: { url: "https://example.com" },
    requestId: "request_1",
    timeoutMs: 10_000,
  });
  assert.throws(() => EmbeddedBrowserCdpCommandSchema.parse({
    leaseRef: "lease_1",
    method: "Target.createTarget",
    requestId: "request_1",
  }), /outside the electron-page-cdp profile/);
  assert.throws(() => EmbeddedBrowserCdpEventSchema.parse({
    generation: 1,
    leaseRef: "lease_1",
    tabRef: "browser_tab_1",
    method: "Target.targetCreated",
  }), /outside the electron-page-cdp profile/);
});

test("snapshot, delta, creation and result contracts are bounded and source-fenced", () => {
  const page = {
    sourceRef: "source_1",
    generation: 2,
    tabRef: "browser_tab_1",
    instanceId: "instance_1",
    pageHost: "main-page-pool",
    pageHostCapabilities: { backgroundCreation: true, surviveHostWindowClose: true, crossWindowAdopt: true },
    revision: 4,
  };
  assert.equal(EmbeddedBrowserSourceSnapshotSchema.parse({
    sourceRef: "source_1",
    generation: 2,
    sourceRevision: 4,
    registryEpoch: "epoch_1",
    snapshotRef: "snapshot_1",
    chunkIndex: 0,
    chunkCount: 1,
    complete: true,
    pages: [page],
  }).pages.length, 1);
  assert.throws(() => EmbeddedBrowserSourceDeltaSchema.parse({
    sourceRef: "source_1",
    generation: 2,
    baseRevision: 4,
    revision: 5,
    upserts: [{ ...page, sourceRef: "source_2" }],
  }), /must belong to the declared source/);
  assert.equal(EmbeddedBrowserCreationViewSchema.parse({
    creationRef: "creation_1",
    requestedUrl: "https://example.com",
    state: "pending",
    expiresAt: new Date().toISOString(),
    candidates: [{
      sourceRef: "source_1",
      panelLabel: "Panel A",
      desktopLabel: "Desktop A",
      hostLabel: "Window 1",
      pageHost: "renderer-webview",
      state: "ready",
      canCreate: true,
    }],
    revision: 1,
  }).candidates[0].tabRef, undefined);
  assert.equal(EMBEDDED_BROWSER_HTTP_RESULT_MAX_BYTES, 16 * 1024 * 1024);
  const accessExpiresAt = new Date().toISOString();
  assert.deepEqual(EmbeddedBrowserAccessViewSchema.parse({
    active: true,
    revision: 3,
    ignored: true,
  }), {
    active: true,
    revision: 3,
  });
  assert.deepEqual(EmbeddedBrowserCdpAccessSchema.parse({
    httpEndpoint: "http://127.0.0.1:49221",
    token: "token_1",
    expiresAt: accessExpiresAt,
    protocolVersion: "2026-11-23",
    ignored: true,
  }), {
    httpEndpoint: "http://127.0.0.1:49221",
    token: "token_1",
    expiresAt: accessExpiresAt,
    protocolVersion: "2026-11-23",
  });
  const pendingRequest = {
    requestRef: "breq_one",
    requesterSessionRef: "session_one",
    revision: 0,
    createdAt: accessExpiresAt,
    expiresAt: accessExpiresAt,
  };
  assert.deepEqual(EmbeddedBrowserAccessViewSchema.parse({
    active: false,
    revision: 2,
    pendingRequest,
  }).pendingRequest, pendingRequest);
  assert.equal(EmbeddedBrowserAccessRequestChangedEventSchema.parse({
    type: "browser.access.request.changed",
    requestRef: "breq_one",
    state: "pending",
    revision: 0,
  }).state, "pending");
  assert.deepEqual(EmbeddedBrowserCdpAccessResultSchema.parse({
    status: "granted",
    httpEndpoint: "http://127.0.0.1:49221",
    token: "token_1",
    expiresAt: accessExpiresAt,
    protocolVersion: "2026-11-23",
  }).status, "granted");
  assert.deepEqual(EmbeddedBrowserCdpAccessResultSchema.parse({
    status: "pending",
    requestRef: "breq_one",
    expiresAt: accessExpiresAt,
    message: "Approve it in the approval center.",
  }).status, "pending");
  assert.throws(() => EmbeddedBrowserCdpAccessResultSchema.parse({
    status: "pending",
    requestRef: "breq_one",
    message: "Missing expiry.",
  }));
});

test("OPEN_OK keeps the frozen framing version so older desktops can complete the handshake", () => {
  assert.deepEqual(decodeEmbeddedBrowserStreamOpenOk(encodeEmbeddedBrowserStreamOpenOk()), {
    streamKind: "control",
    protocolVersion: "2026-11-22",
  });
  assert.deepEqual(decodeEmbeddedBrowserChannelError(encodeEmbeddedBrowserChannelError({
    code: "BROWSER_CHANNEL_STREAM_KIND_UNSUPPORTED",
    message: "unsupported",
  })), {
    code: "BROWSER_CHANNEL_STREAM_KIND_UNSUPPORTED",
    message: "unsupported",
  });
});

test("embedded browser capability is optional and malformed values only disable its feature domain", () => {
  const supported = normalizeEmbeddedBrowserChannelCapabilities({
    supported: true,
    transports: ["reverse-websocket"],
    streamKinds: ["control"],
    drivers: ["electron-page-cdp"],
    pageHosts: ["renderer-webview"],
    futureField: true,
  });
  assert.deepEqual(supported, {
    supported: true,
    transports: ["reverse-websocket"],
    streamKinds: ["control"],
    drivers: ["electron-page-cdp"],
    pageHosts: ["renderer-webview"],
    targetCdp: false,
  });
  assert.equal(normalizeEmbeddedBrowserChannelCapabilities({ supported: true, transports: ["future"] }).supported, false);
  assert.equal(normalizeEmbeddedBrowserChannelCapabilities("corrupt").supported, false);
  assert.deepEqual(normalizeEmbeddedBrowserChannelCapabilities({
    supported: true,
    transports: ["reverse-websocket", "future-transport"],
    streamKinds: ["control", "tcp"],
    drivers: ["electron-page-cdp", "future-driver"],
    pageHosts: ["renderer-webview", "future-page-host", "main-page-pool"],
  }), {
    supported: true,
    transports: ["reverse-websocket"],
    streamKinds: ["control"],
    drivers: ["electron-page-cdp"],
    pageHosts: ["renderer-webview", "main-page-pool"],
    targetCdp: false,
  });
  assert.equal(supportsEmbeddedBrowserTargetCdp({ embeddedBrowserChannel: supported }), false);
  const targetCdp = normalizeEmbeddedBrowserChannelCapabilities({
    supported: true,
    transports: ["reverse-websocket"],
    streamKinds: ["control"],
    drivers: ["electron-page-cdp"],
    pageHosts: ["renderer-webview"],
    targetCdp: true,
    futureField: true,
  });
  assert.equal(targetCdp.targetCdp, true);
  assert.equal(supportsEmbeddedBrowserTargetCdp({ features: { embeddedBrowserChannel: targetCdp } }), true);
  assert.equal(supportsEmbeddedBrowserTargetCdp({ embeddedBrowserChannel: { ...targetCdp, targetCdp: "yes" } }), false);
  assert.equal(supportsEmbeddedBrowserPageHost({ embeddedBrowserChannel: supported }, "renderer-webview"), true);
  assert.equal(supportsEmbeddedBrowserPageHost({ features: { embeddedBrowserChannel: supported } }, "renderer-webview"), true);
  assert.equal(supportsEmbeddedBrowserPageHost({ embeddedBrowserChannel: supported }, "main-page-pool"), false);

  const legacy = normalizeControlledInstanceCapabilities({ features: { browserTunnel: true } });
  assert.equal(supportsControlledInstanceEmbeddedBrowserChannel(legacy), false);
  assert.equal(legacy.features.browserTunnel, true);
  const current = normalizeControlledInstanceCapabilities({ features: { embeddedBrowserChannel: supported } });
  assert.equal(supportsControlledInstanceEmbeddedBrowserChannel(current), true);
  assert.deepEqual(current.features.embeddedBrowserChannel.pageHosts, ["renderer-webview"]);
  assert.equal(current.features.embeddedBrowserChannel.targetCdp, false);
});


test("tabs.open accepts the legacy shape and gates requester session by peer protocol", () => {
  const legacy = EmbeddedBrowserTabsOpenParamsSchema.parse({
    creationRef: "creation_1",
    sourceRef: "source_1",
    generation: 2,
    url: "https://example.com/",
  });
  assert.equal(legacy.requesterSessionRef, undefined);
  const current = EmbeddedBrowserTabsOpenParamsSchema.parse({
    ...legacy,
    requesterSessionRef: "session_one",
  });
  assert.equal(current.requesterSessionRef, "session_one");
  assert.equal(supportsEmbeddedBrowserTabOrigin("2026-11-22"), false);
  assert.equal(supportsEmbeddedBrowserTabOrigin("2026-11-23"), true);
  assert.equal(supportsEmbeddedBrowserTabOrigin(undefined), false);
});
