import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  EMBEDDED_BROWSER_CDP_EVENTS,
  EMBEDDED_BROWSER_CDP_METHODS,
  EMBEDDED_BROWSER_CHANNEL_MAX_BUFFERED_BYTES,
  EMBEDDED_BROWSER_CHANNEL_PROTOCOL_VERSION,
  EMBEDDED_BROWSER_CONTROL_MAX_MESSAGE_BYTES,
  EMBEDDED_BROWSER_FRAME_HEADER_BYTES,
  EMBEDDED_BROWSER_HTTP_RESULT_MAX_BYTES,
  EMBEDDED_BROWSER_HTTP_RESULT_TOTAL_BYTES,
  EMBEDDED_BROWSER_MAX_PAGES_PER_SOURCE,
  EMBEDDED_BROWSER_MAX_SOURCES,
  EMBEDDED_BROWSER_REQUEST_TIMEOUT_MS,
  EMBEDDED_BROWSER_RESULT_TTL_MS,
  EMBEDDED_BROWSER_SNAPSHOT_MAX_PAGES_PER_CHUNK,
  EMBEDDED_BROWSER_TARGET_CDP_EVENTS,
  EMBEDDED_BROWSER_TARGET_CDP_METHODS,
  EMBEDDED_BROWSER_TARGET_CDP_PROFILE,
  EMBEDDED_BROWSER_TARGET_CDP_PROTOCOL_VERSION,
  EmbeddedBrowserCdpCommandSchema,
  EmbeddedBrowserCdpEventSchema,
  EmbeddedBrowserAccessViewSchema,
  EmbeddedBrowserCdpAccessSchema,
  EmbeddedBrowserControlHelloSchema,
  EmbeddedBrowserControlErrorSchema,
  EmbeddedBrowserCreationContextChangedEventSchema,
  EmbeddedBrowserCreationContextSnapshotSchema,
  EmbeddedBrowserCreationViewSchema,
  EmbeddedBrowserDefaultContextClaimRequestSchema,
  EmbeddedBrowserDefaultContextClaimResultSchema,
  EmbeddedBrowserLeaseSchema,
  EmbeddedBrowserPageListResponseSchema,
  EmbeddedBrowserPageSchema,
  EmbeddedBrowserRegistryDeltaSchema,
  EmbeddedBrowserSourceDeltaSchema,
  EmbeddedBrowserSourceSchema,
  EmbeddedBrowserSourceSnapshotSchema,
  EmbeddedBrowserStreamOpenOkSchema,
  EmbeddedBrowserTargetAttachToTargetParamsSchema,
  EmbeddedBrowserTargetAttachToTargetResultSchema,
  EmbeddedBrowserTargetCloseTargetParamsSchema,
  EmbeddedBrowserTargetCloseTargetResultSchema,
  EmbeddedBrowserTargetCreateTargetParamsSchema,
  EmbeddedBrowserTargetCreateTargetResultSchema,
  EmbeddedBrowserTargetDetachedFromTargetEventSchema,
  EmbeddedBrowserTargetDetachFromTargetParamsSchema,
  EmbeddedBrowserTargetGetBrowserContextsResultSchema,
  EmbeddedBrowserTargetGetTargetInfoParamsSchema,
  EmbeddedBrowserTargetGetTargetInfoResultSchema,
  EmbeddedBrowserTargetGetTargetsResultSchema,
  EmbeddedBrowserTargetInfoSchema,
  EmbeddedBrowserTargetSetDiscoverTargetsParamsSchema,
  EmbeddedBrowserTargetCreatedEventSchema,
  EmbeddedBrowserTargetDestroyedEventSchema,
  EmbeddedBrowserTargetInfoChangedEventSchema,
  embeddedBrowserTargetInfoFromPage,
  encodeEmbeddedBrowserChannelError,
  encodeEmbeddedBrowserControlMessage,
  encodeEmbeddedBrowserFrame,
  encodeEmbeddedBrowserStreamOpen,
} from "../src/embedded-browser-control.ts";

const fixturePath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../controlled-instance-rs/crates/protocol/tests/fixtures/embedded-browser-control.json",
);
const desktopProfilePath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../apps/desktop-shell/src/embedded-browser-cdp-profile.json",
);

const hex = (value) => Buffer.from(value).toString("hex");
const pageInput = {
  sourceRef: "source_main_pool",
  generation: 2,
  tabRef: "browser_tab_1",
  instanceId: "instance_1",
  pageHost: "main-page-pool",
  pageHostCapabilities: { backgroundCreation: true, surviveHostWindowClose: true, crossWindowAdopt: true },
  title: "Example",
  url: "https://example.com/",
  state: "ready",
  revision: 7,
  sessionKey: "renderer-local-key",
  webContentsId: 42,
  partition: "persist:private",
};
const page = EmbeddedBrowserPageSchema.parse(pageInput);
const source = EmbeddedBrowserSourceSchema.parse({
  sourceRef: "source_renderer",
  generation: 1,
  panelId: "control_plane_1",
  displayName: "Desktop A",
  pageHost: "renderer-webview",
  pageHostCapabilities: { backgroundCreation: false, surviveHostWindowClose: false, crossWindowAdopt: false },
  revision: 3,
  hostWindowId: 9,
});
const expiresAt = "2026-11-22T12:02:00.000Z";
const rendererPage = EmbeddedBrowserPageSchema.parse({
  ...pageInput,
  sourceRef: "source_renderer",
  generation: 1,
  tabRef: "browser_tab_2",
  pageHost: "renderer-webview",
  pageHostCapabilities: { backgroundCreation: false, surviveHostWindowClose: false, crossWindowAdopt: false },
  title: "Renderer page",
  url: "https://renderer.example/",
  revision: 4,
});
const mainTargetInfo = embeddedBrowserTargetInfoFromPage(page, false);
const rendererTargetInfo = embeddedBrowserTargetInfoFromPage(rendererPage, true);
const creationContext = EmbeddedBrowserCreationContextSnapshotSchema.parse({
  revision: 3,
  defaultContext: { sourceRef: page.sourceRef, browserContextId: page.sourceRef },
  panels: [
    {
      sourceRef: page.sourceRef,
      panelLabel: "MacBook",
      hostLabel: "Main pool",
      pageHost: "main-page-pool",
      canCreate: true,
      isDefault: true,
      canClaim: true,
    },
    {
      sourceRef: source.sourceRef,
      panelLabel: "Mac mini",
      hostLabel: "Renderer window",
      pageHost: "renderer-webview",
      canCreate: true,
      isDefault: false,
      canClaim: false,
    },
  ],
  pendingCreation: {
    creationRef: "creation_pending",
    url: "https://pending.example/",
    expiresAt,
  },
});
const defaultContextClaimResult = EmbeddedBrowserDefaultContextClaimResultSchema.parse({
  sourceRef: source.sourceRef,
  browserContextId: source.sourceRef,
  revision: creationContext.revision + 1,
});
const openFrame = encodeEmbeddedBrowserFrame({
  type: "open",
  streamId: 1,
  payload: encodeEmbeddedBrowserStreamOpen({ streamKind: "control" }),
});
const dataFrame = encodeEmbeddedBrowserFrame({ type: "data", streamId: 3, payload: new Uint8Array([0, 1, 255]) });
const controlRequest = encodeEmbeddedBrowserControlMessage({ jsonrpc: "2.0", id: "request_1", method: "tabs.list" });
const fixture = `${JSON.stringify({
  protocolVersion: EMBEDDED_BROWSER_CHANNEL_PROTOCOL_VERSION,
  limits: {
    frameHeaderBytes: EMBEDDED_BROWSER_FRAME_HEADER_BYTES,
    controlMaxMessageBytes: EMBEDDED_BROWSER_CONTROL_MAX_MESSAGE_BYTES,
    channelMaxBufferedBytes: EMBEDDED_BROWSER_CHANNEL_MAX_BUFFERED_BYTES,
    requestTimeoutMs: EMBEDDED_BROWSER_REQUEST_TIMEOUT_MS,
    snapshotMaxPagesPerChunk: EMBEDDED_BROWSER_SNAPSHOT_MAX_PAGES_PER_CHUNK,
    maxPagesPerSource: EMBEDDED_BROWSER_MAX_PAGES_PER_SOURCE,
    maxSources: EMBEDDED_BROWSER_MAX_SOURCES,
    httpResultMaxBytes: EMBEDDED_BROWSER_HTTP_RESULT_MAX_BYTES,
    httpResultTotalBytes: EMBEDDED_BROWSER_HTTP_RESULT_TOTAL_BYTES,
    resultTtlMs: EMBEDDED_BROWSER_RESULT_TTL_MS,
  },
  frameTypes: { open: 1, openOk: 2, data: 3, halfClose: 4, close: 5, error: 6, windowUpdate: 7 },
  cdp: {
    profile: "electron-page-cdp",
    methods: EMBEDDED_BROWSER_CDP_METHODS,
    events: EMBEDDED_BROWSER_CDP_EVENTS,
    targetCdp: {
      profile: EMBEDDED_BROWSER_TARGET_CDP_PROFILE,
      protocolVersion: EMBEDDED_BROWSER_TARGET_CDP_PROTOCOL_VERSION,
      methods: EMBEDDED_BROWSER_TARGET_CDP_METHODS,
      events: EMBEDDED_BROWSER_TARGET_CDP_EVENTS,
    },
  },
  frames: {
    openControlStream: hex(openFrame),
    openOkControlStream: hex(encodeEmbeddedBrowserFrame({
      type: "openOk",
      streamId: 1,
      payload: new TextEncoder().encode(JSON.stringify(EmbeddedBrowserStreamOpenOkSchema.parse({
        streamKind: "control",
        protocolVersion: EMBEDDED_BROWSER_CHANNEL_PROTOCOL_VERSION,
      }))),
    })),
    dataStream3: hex(dataFrame),
    errorUnsupportedStreamKind: hex(encodeEmbeddedBrowserFrame({
      type: "error",
      streamId: 1,
      payload: encodeEmbeddedBrowserChannelError({
        code: "BROWSER_CHANNEL_STREAM_KIND_UNSUPPORTED",
        message: "unsupported",
      }),
    })),
    coalesced: hex(new Uint8Array([...openFrame, ...dataFrame])),
    controlRequest: hex(encodeEmbeddedBrowserFrame({ type: "data", streamId: 1, payload: controlRequest })),
  },
  messages: {
    streamOpen: { streamKind: "control" },
    openOk: EmbeddedBrowserStreamOpenOkSchema.parse({
      streamKind: "control",
      protocolVersion: EMBEDDED_BROWSER_CHANNEL_PROTOCOL_VERSION,
    }),
    hello: EmbeddedBrowserControlHelloSchema.parse({
      protocolVersion: EMBEDDED_BROWSER_CHANNEL_PROTOCOL_VERSION,
      sourceRef: "source_renderer",
      generation: 1,
      pageHost: "renderer-webview",
      pageHostCapabilities: { backgroundCreation: false, surviveHostWindowClose: false, crossWindowAdopt: false },
      registryEpoch: "epoch_1",
      registryRevision: 7,
    }),
    source,
    page,
    pageList: EmbeddedBrowserPageListResponseSchema.parse({
      registryEpoch: "epoch_1",
      registryRevision: 8,
      items: [page],
      cursor: "cursor_1",
    }),
    snapshot: EmbeddedBrowserSourceSnapshotSchema.parse({
      sourceRef: page.sourceRef,
      generation: page.generation,
      sourceRevision: page.revision,
      registryEpoch: "epoch_1",
      snapshotRef: "snapshot_1",
      chunkIndex: 0,
      chunkCount: 1,
      complete: true,
      pages: [page],
    }),
    delta: EmbeddedBrowserSourceDeltaSchema.parse({
      sourceRef: page.sourceRef,
      generation: page.generation,
      baseRevision: page.revision,
      revision: page.revision + 1,
      upserts: [{ ...page, revision: page.revision + 1, title: "Example updated" }],
      removes: [],
    }),
    registryDelta: EmbeddedBrowserRegistryDeltaSchema.parse({
      registryEpoch: "epoch_1",
      baseRevision: 8,
      revision: 9,
      upserts: [{ ...page, revision: page.revision + 1 }],
      removes: ["browser_tab_old"],
      cursor: "cursor_2",
    }),
    creationView: EmbeddedBrowserCreationViewSchema.parse({
      creationRef: "creation_1",
      requestedUrl: "https://example.com/",
      title: "Example",
      state: "pending",
      expiresAt,
      candidates: [{
        sourceRef: "source_renderer",
        panelLabel: "Panel A",
        desktopLabel: "Desktop A",
        hostLabel: "Window 1",
        pageHost: "renderer-webview",
        state: "ready",
        canCreate: true,
      }],
      revision: 1,
    }),
    lease: EmbeddedBrowserLeaseSchema.parse({
      leaseRef: "lease_1",
      tabRef: "browser_tab_1",
      sourceRef: "source_main_pool",
      generation: 2,
      expiresAt,
    }),
    access: EmbeddedBrowserAccessViewSchema.parse({
      active: true,
      revision: 1,
    }),
    cdpAccess: EmbeddedBrowserCdpAccessSchema.parse({
      httpEndpoint: "http://127.0.0.1:49221",
      token: "cdp_access_token",
      expiresAt,
      protocolVersion: EMBEDDED_BROWSER_CHANNEL_PROTOCOL_VERSION,
    }),
    cdpCommand: EmbeddedBrowserCdpCommandSchema.parse({
      leaseRef: "lease_1",
      method: "Page.navigate",
      params: { url: "https://example.com/" },
      requestId: "request_1",
      timeoutMs: 10_000,
    }),
    cdpEvent: EmbeddedBrowserCdpEventSchema.parse({
      generation: 2,
      leaseRef: "lease_1",
      tabRef: "browser_tab_1",
      method: "Page.loadEventFired",
      params: { timestamp: 1 },
    }),
    targetInfo: mainTargetInfo,
    targetInfoChanged: EmbeddedBrowserTargetInfoSchema.parse({
      ...rendererTargetInfo,
      title: "Renderer page updated",
      url: "https://renderer.example/updated",
    }),
    targetGetTargets: EmbeddedBrowserTargetGetTargetsResultSchema.parse({
      targetInfos: [mainTargetInfo, rendererTargetInfo],
    }),
    targetGetTargetInfoParams: EmbeddedBrowserTargetGetTargetInfoParamsSchema.parse({
      targetId: rendererPage.tabRef,
    }),
    targetGetTargetInfo: EmbeddedBrowserTargetGetTargetInfoResultSchema.parse({
      targetInfo: rendererTargetInfo,
    }),
    targetGetBrowserContexts: EmbeddedBrowserTargetGetBrowserContextsResultSchema.parse({
      browserContextIds: [page.sourceRef, source.sourceRef],
      defaultBrowserContextId: page.sourceRef,
    }),
    targetAttachParams: EmbeddedBrowserTargetAttachToTargetParamsSchema.parse({
      targetId: page.tabRef,
      flatten: true,
    }),
    targetAttachResult: EmbeddedBrowserTargetAttachToTargetResultSchema.parse({
      sessionId: "target_session_1",
    }),
    targetDetachParams: EmbeddedBrowserTargetDetachFromTargetParamsSchema.parse({
      sessionId: "target_session_1",
    }),
    targetCloseParams: EmbeddedBrowserTargetCloseTargetParamsSchema.parse({
      targetId: page.tabRef,
    }),
    targetCloseResult: EmbeddedBrowserTargetCloseTargetResultSchema.parse({
      success: true,
    }),
    targetCreateParams: EmbeddedBrowserTargetCreateTargetParamsSchema.parse({
      url: "https://created.example/",
    }),
    targetCreateResult: EmbeddedBrowserTargetCreateTargetResultSchema.parse({
      targetId: "browser_tab_created",
    }),
    targetSetDiscoverParams: EmbeddedBrowserTargetSetDiscoverTargetsParamsSchema.parse({
      discover: true,
    }),
    targetUnsupportedMethod: "Target.createBrowserContext",
    targetCreatedEvent: EmbeddedBrowserTargetCreatedEventSchema.parse({
      method: "Target.targetCreated",
      params: { targetInfo: mainTargetInfo },
    }),
    targetInfoChangedEvent: EmbeddedBrowserTargetInfoChangedEventSchema.parse({
      method: "Target.targetInfoChanged",
      params: { targetInfo: rendererTargetInfo },
    }),
    targetDestroyedEvent: EmbeddedBrowserTargetDestroyedEventSchema.parse({
      method: "Target.targetDestroyed",
      params: { targetId: page.tabRef },
    }),
    targetDetachedEvent: EmbeddedBrowserTargetDetachedFromTargetEventSchema.parse({
      method: "Target.detachedFromTarget",
      params: { sessionId: "target_session_1", targetId: page.tabRef },
    }),
    externalResult: {
      delivery: "http",
      resultRef: "result_1",
      mediaType: "application/json",
      byteLength: 640000,
    },
    channelError: { code: "BROWSER_CHANNEL_STREAM_KIND_UNSUPPORTED", message: "unsupported" },
    creationContext,
    creationContextClaimRequest: EmbeddedBrowserDefaultContextClaimRequestSchema.parse({
      sourceRef: source.sourceRef,
      expectedRevision: creationContext.revision,
    }),
    creationContextClaimResult: defaultContextClaimResult,
    creationContextChanged: EmbeddedBrowserCreationContextChangedEventSchema.parse({
      type: "browser.creation-context.changed",
      revision: defaultContextClaimResult.revision,
      defaultBrowserContextId: defaultContextClaimResult.browserContextId,
      previousBrowserContextId: page.sourceRef,
    }),
    creationContextRequiredError: EmbeddedBrowserControlErrorSchema.parse({
      code: "BROWSER_CREATION_CONTEXT_REQUIRED",
      message: "No connected panel has claimed the default browser creation context.",
      execution: "not-started",
      creationRef: "creation_pending",
      expiresAt,
    }),
    creationContextConflictError: EmbeddedBrowserControlErrorSchema.parse({
      code: "BROWSER_DEFAULT_CONTEXT_CONFLICT",
      message: "Another panel changed the default browser creation context.",
      execution: "not-started",
      revision: creationContext.revision,
      defaultBrowserContextId: page.sourceRef,
    }),
    creationContextNotOwnedError: EmbeddedBrowserControlErrorSchema.parse({
      code: "BROWSER_CREATION_CONTEXT_NOT_OWNED",
      message: "The requested browser source does not belong to this panel.",
      execution: "not-started",
      revision: creationContext.revision,
    }),
  },
  capabilities: {
    supported: {
      supported: true,
      transports: ["reverse-websocket"],
      streamKinds: ["control"],
      drivers: ["electron-page-cdp"],
      pageHosts: ["renderer-webview", "main-page-pool"],
      targetCdp: true,
    },
    withUnknownExtensions: {
      supported: true,
      transports: ["reverse-websocket", "future-transport"],
      streamKinds: ["control", "tcp"],
      drivers: ["electron-page-cdp", "future-driver"],
      pageHosts: ["renderer-webview", "future-page-host", "main-page-pool"],
      targetCdp: true,
      futureField: true,
    },
    legacyWithoutTargetCdp: {
      supported: true,
      transports: ["reverse-websocket"],
      streamKinds: ["control"],
      drivers: ["electron-page-cdp"],
      pageHosts: ["renderer-webview", "main-page-pool"],
    },
  },
}, null, 2)}\n`;
const desktopProfile = `${JSON.stringify({
  profile: "electron-page-cdp",
  methods: EMBEDDED_BROWSER_CDP_METHODS,
  events: EMBEDDED_BROWSER_CDP_EVENTS,
}, null, 2)}\n`;

if (process.argv.includes("--check")) {
  if (!fs.existsSync(fixturePath) || fs.readFileSync(fixturePath, "utf8") !== fixture) {
    console.error(`Embedded Browser Channel fixture is stale: ${fixturePath}`);
    process.exitCode = 1;
  }
  if (!fs.existsSync(desktopProfilePath) || fs.readFileSync(desktopProfilePath, "utf8") !== desktopProfile) {
    console.error(`Desktop Embedded Browser CDP profile is stale: ${desktopProfilePath}`);
    process.exitCode = 1;
  }
} else {
  fs.mkdirSync(path.dirname(fixturePath), { recursive: true });
  fs.writeFileSync(fixturePath, fixture);
  fs.mkdirSync(path.dirname(desktopProfilePath), { recursive: true });
  fs.writeFileSync(desktopProfilePath, desktopProfile);
}
