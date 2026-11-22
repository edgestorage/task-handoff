import assert from "node:assert/strict";
import test from "node:test";
import {
  EMBEDDED_BROWSER_CDP_PROFILE,
  EMBEDDED_BROWSER_CONTROL_MAX_MESSAGE_BYTES,
  EMBEDDED_BROWSER_FRAME_HEADER_BYTES,
  EMBEDDED_BROWSER_HTTP_RESULT_MAX_BYTES,
  EmbeddedBrowserControlMessageDecoder,
  EmbeddedBrowserAccessViewSchema,
  EmbeddedBrowserCdpCommandSchema,
  EmbeddedBrowserCdpAccessSchema,
  EmbeddedBrowserCreationViewSchema,
  EmbeddedBrowserCdpEventSchema,
  EmbeddedBrowserFrameDecoder,
  EmbeddedBrowserPageHostCapabilitiesSchema,
  EmbeddedBrowserPageSchema,
  EmbeddedBrowserRpcRequestSchema,
  EmbeddedBrowserSourceSchema,
  EmbeddedBrowserSourceDeltaSchema,
  EmbeddedBrowserSourceSnapshotSchema,
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
  normalizeEmbeddedBrowserChannelCapabilities,
  supportsEmbeddedBrowserCdpEvent,
  supportsEmbeddedBrowserPageHost,
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

test("the CDP profile is an explicit method allowlist with stable classes and events", () => {
  assert.equal(EMBEDDED_BROWSER_CDP_PROFILE, "electron-page-cdp");
  assert.equal(embeddedBrowserCdpMethodKind("Page.navigate"), "page-write");
  assert.equal(embeddedBrowserCdpMethodKind("Runtime.evaluate"), "page-write");
  assert.equal(embeddedBrowserCdpMethodKind("Accessibility.getFullAXTree"), "read");
  assert.equal(embeddedBrowserCdpMethodKind("Network.enable"), "adapter-only");
  assert.equal(embeddedBrowserCdpMethodKind("Target.attachToTarget"), undefined);
  assert.equal(embeddedBrowserCdpMethodKind("Browser.getVersion"), undefined);
  assert.equal(embeddedBrowserCdpMethodKind("Page.navigate\nRuntime.evaluate"), undefined);
  assert.equal(supportsEmbeddedBrowserCdpEvent("Page.lifecycleEvent"), true);
  assert.equal(supportsEmbeddedBrowserCdpEvent("Target.targetCreated"), false);
  assert.throws(() => assertEmbeddedBrowserCdpMethod("Target.attachToTarget"), { code: "BROWSER_OPERATION_UNSUPPORTED" });
  assert.throws(() => assertEmbeddedBrowserCdpMethod("Network.enable"), { code: "BROWSER_OPERATION_UNSUPPORTED" });
  assert.equal(assertEmbeddedBrowserCdpMethod("Network.enable", { adapterOnly: true }), "Network.enable");
  assert.equal(assertEmbeddedBrowserCdpMethod("Page.navigate"), "Page.navigate");
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
    protocolVersion: "2026-11-22",
    ignored: true,
  }), {
    httpEndpoint: "http://127.0.0.1:49221",
    token: "token_1",
    expiresAt: accessExpiresAt,
    protocolVersion: "2026-11-22",
  });
});

test("OPEN_OK and channel ERROR payloads use the shared strict envelope", () => {
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
  });
  assert.equal(supportsEmbeddedBrowserPageHost({ embeddedBrowserChannel: supported }, "renderer-webview"), true);
  assert.equal(supportsEmbeddedBrowserPageHost({ features: { embeddedBrowserChannel: supported } }, "renderer-webview"), true);
  assert.equal(supportsEmbeddedBrowserPageHost({ embeddedBrowserChannel: supported }, "main-page-pool"), false);

  const legacy = normalizeControlledInstanceCapabilities({ features: { browserTunnel: true } });
  assert.equal(supportsControlledInstanceEmbeddedBrowserChannel(legacy), false);
  assert.equal(legacy.features.browserTunnel, true);
  const current = normalizeControlledInstanceCapabilities({ features: { embeddedBrowserChannel: supported } });
  assert.equal(supportsControlledInstanceEmbeddedBrowserChannel(current), true);
  assert.deepEqual(current.features.embeddedBrowserChannel.pageHosts, ["renderer-webview"]);
});
