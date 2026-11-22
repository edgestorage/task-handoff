import { z } from "zod";

export const EMBEDDED_BROWSER_CHANNEL_PROTOCOL_VERSION = "2026-11-22";
export const EMBEDDED_BROWSER_FRAME_HEADER_BYTES = 9;
export const EMBEDDED_BROWSER_CONTROL_MAX_MESSAGE_BYTES = 256 * 1024;
export const EMBEDDED_BROWSER_CHANNEL_MAX_BUFFERED_BYTES = 2 * 1024 * 1024;
export const EMBEDDED_BROWSER_INITIAL_WINDOW_BYTES = 256 * 1024;
export const EMBEDDED_BROWSER_MAX_IN_FLIGHT_REQUESTS = 32;
export const EMBEDDED_BROWSER_MAX_SIDE_EFFECT_QUEUE = 16;
export const EMBEDDED_BROWSER_REQUEST_TIMEOUT_MS = 10_000;
export const EMBEDDED_BROWSER_MAX_REQUEST_TIMEOUT_MS = 60_000;
export const EMBEDDED_BROWSER_CREATION_WAIT_MS = 10_000;
export const EMBEDDED_BROWSER_CREATION_TTL_MS = 120_000;
export const EMBEDDED_BROWSER_DEDUPE_WINDOW_MS = 120_000;
export const EMBEDDED_BROWSER_MAX_DEDUPE_ENTRIES = 1_024;
export const EMBEDDED_BROWSER_SNAPSHOT_MAX_PAGES_PER_CHUNK = 100;
export const EMBEDDED_BROWSER_MAX_PAGES_PER_SOURCE = 256;
export const EMBEDDED_BROWSER_MAX_SOURCES = 32;
export const EMBEDDED_BROWSER_INLINE_RESULT_MAX_BYTES = EMBEDDED_BROWSER_CONTROL_MAX_MESSAGE_BYTES;
export const EMBEDDED_BROWSER_HTTP_RESULT_MAX_BYTES = 16 * 1024 * 1024;
export const EMBEDDED_BROWSER_HTTP_RESULT_TOTAL_BYTES = 64 * 1024 * 1024;
export const EMBEDDED_BROWSER_RESULT_TTL_MS = 120_000;
export const EMBEDDED_BROWSER_SCREENSHOT_MAX_DIMENSION = 4_096;
export const EMBEDDED_BROWSER_CDP_ACCESS_TTL_MS = 8 * 60 * 60 * 1000;

export const EMBEDDED_BROWSER_FRAME_TYPES = Object.freeze({
  open: 1,
  openOk: 2,
  data: 3,
  halfClose: 4,
  close: 5,
  error: 6,
  windowUpdate: 7,
} as const);

export type EmbeddedBrowserFrameType = keyof typeof EMBEDDED_BROWSER_FRAME_TYPES;
export type EmbeddedBrowserFrame = { type: EmbeddedBrowserFrameType; streamId: number; payload: Uint8Array };
export type EmbeddedBrowserStreamKind = "control";

export const EmbeddedBrowserPageHostSchema = z.enum(["renderer-webview", "main-page-pool"]);
export type EmbeddedBrowserPageHost = z.infer<typeof EmbeddedBrowserPageHostSchema>;

export const EmbeddedBrowserPageHostCapabilitiesSchema = z.object({
  backgroundCreation: z.boolean().default(false),
  surviveHostWindowClose: z.boolean().default(false),
  crossWindowAdopt: z.boolean().default(false),
}).strip();
export type EmbeddedBrowserPageHostCapabilities = z.infer<typeof EmbeddedBrowserPageHostCapabilitiesSchema>;

export const EMBEDDED_BROWSER_RENDERER_WEBVIEW_CAPABILITIES = Object.freeze({
  backgroundCreation: false,
  surviveHostWindowClose: false,
  crossWindowAdopt: false,
} satisfies EmbeddedBrowserPageHostCapabilities);

export const EMBEDDED_BROWSER_MAIN_PAGE_POOL_CAPABILITIES = Object.freeze({
  backgroundCreation: true,
  surviveHostWindowClose: true,
  crossWindowAdopt: true,
} satisfies EmbeddedBrowserPageHostCapabilities);

function defaultPageHostCapabilities(): EmbeddedBrowserPageHostCapabilities {
  return { ...EMBEDDED_BROWSER_RENDERER_WEBVIEW_CAPABILITIES };
}

export const EmbeddedBrowserStreamOpenSchema = z.object({ streamKind: z.literal("control") }).strict();
export type EmbeddedBrowserStreamOpen = z.infer<typeof EmbeddedBrowserStreamOpenSchema>;

export const EmbeddedBrowserStreamOpenOkSchema = z.object({
  streamKind: z.literal("control"),
  protocolVersion: z.literal(EMBEDDED_BROWSER_CHANNEL_PROTOCOL_VERSION),
}).strict();
export type EmbeddedBrowserStreamOpenOk = z.infer<typeof EmbeddedBrowserStreamOpenOkSchema>;

export const EmbeddedBrowserChannelErrorSchema = z.object({
  code: z.enum([
    "BROWSER_CHANNEL_STREAM_KIND_UNSUPPORTED",
    "BROWSER_CHANNEL_PROTOCOL_ERROR",
    "BROWSER_CONTROL_UNSUPPORTED",
    "BROWSER_SOURCE_UNAVAILABLE",
    "BROWSER_AUTHORIZATION_REVOKED",
    "BROWSER_LIMIT_EXCEEDED",
  ]),
  message: z.string().trim().min(1).max(500),
}).strip();
export type EmbeddedBrowserChannelError = z.infer<typeof EmbeddedBrowserChannelErrorSchema>;

export function encodeEmbeddedBrowserStreamOpen(value: EmbeddedBrowserStreamOpen): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(EmbeddedBrowserStreamOpenSchema.parse(value)));
}

export function decodeEmbeddedBrowserStreamOpen(payload: Uint8Array): EmbeddedBrowserStreamOpen {
  if (!(payload instanceof Uint8Array) || payload.byteLength > EMBEDDED_BROWSER_CONTROL_MAX_MESSAGE_BYTES) throw embeddedBrowserProtocolError();
  let value: unknown;
  try { value = JSON.parse(new TextDecoder().decode(payload)); } catch { throw embeddedBrowserProtocolError(); }
  const streamKind = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>).streamKind : undefined;
  if (streamKind !== "control") {
    throw Object.assign(new Error("BROWSER_CHANNEL_STREAM_KIND_UNSUPPORTED"), { code: "BROWSER_CHANNEL_STREAM_KIND_UNSUPPORTED" });
  }
  const parsed = EmbeddedBrowserStreamOpenSchema.safeParse(value);
  if (!parsed.success) throw embeddedBrowserProtocolError();
  return parsed.data;
}

export function encodeEmbeddedBrowserStreamOpenOk(): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(EmbeddedBrowserStreamOpenOkSchema.parse({
    streamKind: "control",
    protocolVersion: EMBEDDED_BROWSER_CHANNEL_PROTOCOL_VERSION,
  })));
}

export function decodeEmbeddedBrowserStreamOpenOk(payload: Uint8Array): EmbeddedBrowserStreamOpenOk {
  return decodeStrictJsonPayload(payload, EmbeddedBrowserStreamOpenOkSchema);
}

export function encodeEmbeddedBrowserChannelError(value: EmbeddedBrowserChannelError): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(EmbeddedBrowserChannelErrorSchema.parse(value)));
}

export function decodeEmbeddedBrowserChannelError(payload: Uint8Array): EmbeddedBrowserChannelError {
  return decodeStrictJsonPayload(payload, EmbeddedBrowserChannelErrorSchema);
}

export const EMBEDDED_BROWSER_CDP_PROFILE = "electron-page-cdp" as const;
export type EmbeddedBrowserCdpProfile = typeof EMBEDDED_BROWSER_CDP_PROFILE;
export const EmbeddedBrowserCdpMethodKindSchema = z.enum(["read", "page-write", "adapter-only"]);
export type EmbeddedBrowserCdpMethodKind = z.infer<typeof EmbeddedBrowserCdpMethodKindSchema>;

export const EMBEDDED_BROWSER_CDP_METHODS = Object.freeze({
  "Accessibility.enable": "adapter-only",
  "Accessibility.disable": "adapter-only",
  "Accessibility.getFullAXTree": "read",
  "Accessibility.getPartialAXTree": "read",
  "Accessibility.getRootAXNode": "read",
  "Console.enable": "adapter-only",
  "Console.disable": "adapter-only",
  "DOM.getDocument": "read",
  "DOM.describeNode": "read",
  "DOM.resolveNode": "read",
  "DOM.getBoxModel": "read",
  "DOM.getContentQuads": "read",
  "DOM.getNodeForLocation": "read",
  "DOM.querySelector": "read",
  "DOM.querySelectorAll": "read",
  "DOM.getAttributes": "read",
  "DOM.getOuterHTML": "read",
  "DOMSnapshot.enable": "adapter-only",
  "DOMSnapshot.disable": "adapter-only",
  "DOMSnapshot.captureSnapshot": "read",
  "Input.dispatchMouseEvent": "page-write",
  "Input.dispatchKeyEvent": "page-write",
  "Input.dispatchTouchEvent": "page-write",
  "Input.insertText": "page-write",
  "Log.enable": "adapter-only",
  "Log.disable": "adapter-only",
  "Network.enable": "adapter-only",
  "Network.disable": "adapter-only",
  "Network.getResponseBody": "read",
  "Network.getRequestPostData": "read",
  "Page.enable": "adapter-only",
  "Page.disable": "adapter-only",
  "Page.getNavigationHistory": "read",
  "Page.getFrameTree": "read",
  "Page.getLayoutMetrics": "read",
  "Page.navigate": "page-write",
  "Page.reload": "page-write",
  "Page.stopLoading": "page-write",
  "Page.captureScreenshot": "read",
  "Runtime.enable": "adapter-only",
  "Runtime.disable": "adapter-only",
  "Runtime.evaluate": "page-write",
  "Runtime.callFunctionOn": "page-write",
  "Runtime.getProperties": "read",
  "Runtime.releaseObject": "adapter-only",
  "Schema.getDomains": "read",
} satisfies Record<string, EmbeddedBrowserCdpMethodKind>);

export const EMBEDDED_BROWSER_CDP_EVENTS = Object.freeze([
  "Console.messageAdded",
  "Log.entryAdded",
  "Network.loadingFailed",
  "Network.loadingFinished",
  "Network.requestServedFromCache",
  "Network.requestWillBeSent",
  "Network.responseReceived",
  "Page.domContentEventFired",
  "Page.frameNavigated",
  "Page.frameStartedLoading",
  "Page.frameStoppedLoading",
  "Page.javascriptDialogClosed",
  "Page.javascriptDialogOpening",
  "Page.lifecycleEvent",
  "Page.loadEventFired",
  "Runtime.consoleAPICalled",
  "Runtime.exceptionThrown",
  "Runtime.executionContextCreated",
  "Runtime.executionContextDestroyed",
  "Runtime.executionContextsCleared",
] as const);

export function embeddedBrowserCdpMethodKind(method: string): EmbeddedBrowserCdpMethodKind | undefined {
  if (!embeddedBrowserCdpMethodShape(method)) return undefined;
  return (EMBEDDED_BROWSER_CDP_METHODS as Record<string, EmbeddedBrowserCdpMethodKind>)[method];
}

export function assertEmbeddedBrowserCdpMethod(method: unknown, options: { adapterOnly?: boolean } = {}): string {
  const normalized = typeof method === "string" ? method.trim() : "";
  const kind = embeddedBrowserCdpMethodKind(normalized);
  if (!kind || (kind === "adapter-only" && !options.adapterOnly)) throw embeddedBrowserCdpOperationUnsupported();
  return normalized;
}

export function supportsEmbeddedBrowserCdpEvent(method: unknown) {
  return typeof method === "string" && (EMBEDDED_BROWSER_CDP_EVENTS as readonly string[]).includes(method);
}

export const EmbeddedBrowserCdpCommandSchema = z.object({
  leaseRef: z.string().trim().min(1).max(240),
  method: z.string().trim().min(1).max(240),
  params: z.unknown().optional(),
  frameSessionRef: z.string().trim().min(1).max(240).optional(),
  requestId: z.string().trim().min(1).max(160),
  timeoutMs: z.number().int().min(1).max(EMBEDDED_BROWSER_MAX_REQUEST_TIMEOUT_MS).default(EMBEDDED_BROWSER_REQUEST_TIMEOUT_MS),
}).strict().superRefine((value, context) => {
  if (!embeddedBrowserCdpMethodKind(value.method)) {
    context.addIssue({ code: "custom", path: ["method"], message: "CDP method is outside the electron-page-cdp profile." });
  }
});
export type EmbeddedBrowserCdpCommand = z.infer<typeof EmbeddedBrowserCdpCommandSchema>;

export const EmbeddedBrowserCdpEventSchema = z.object({
  generation: z.number().int().nonnegative(),
  leaseRef: z.string().trim().min(1).max(240),
  tabRef: z.string().trim().min(1).max(240),
  frameSessionRef: z.string().trim().min(1).max(240).optional(),
  method: z.string().trim().min(1).max(240),
  params: z.unknown().optional(),
}).strict().superRefine((value, context) => {
  if (!supportsEmbeddedBrowserCdpEvent(value.method)) {
    context.addIssue({ code: "custom", path: ["method"], message: "CDP event is outside the electron-page-cdp profile." });
  }
});
export type EmbeddedBrowserCdpEvent = z.infer<typeof EmbeddedBrowserCdpEventSchema>;

export const EmbeddedBrowserExternalResultSchema = z.object({
  delivery: z.literal("http"),
  resultRef: z.string().trim().min(1).max(240),
  mediaType: z.string().trim().min(1).max(160),
  byteLength: z.number().int().nonnegative().max(EMBEDDED_BROWSER_HTTP_RESULT_MAX_BYTES),
}).strict();
export type EmbeddedBrowserExternalResult = z.infer<typeof EmbeddedBrowserExternalResultSchema>;

export const EmbeddedBrowserCdpResultSchema = z.object({
  result: z.unknown().optional(),
  external: EmbeddedBrowserExternalResultSchema.optional(),
  execution: z.literal("completed").default("completed"),
}).strict().refine((value) => (value.result === undefined) !== (value.external === undefined), "CDP result requires exactly one of result or external.");
export type EmbeddedBrowserCdpResult = z.infer<typeof EmbeddedBrowserCdpResultSchema>;

export const EmbeddedBrowserRpcRequestSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.string().trim().min(1).max(160), z.number().int()]),
  method: z.string().trim().min(1).max(240),
  params: z.unknown().optional(),
}).strict();
export type EmbeddedBrowserRpcRequest = z.infer<typeof EmbeddedBrowserRpcRequestSchema>;

export const EmbeddedBrowserRpcErrorObjectSchema = z.object({
  code: z.number().int(),
  message: z.string().trim().min(1).max(500),
  data: z.unknown().optional(),
}).strip();

export const EmbeddedBrowserRpcResponseSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.string().trim().min(1).max(160), z.number().int(), z.null()]),
  result: z.unknown().optional(),
  error: EmbeddedBrowserRpcErrorObjectSchema.optional(),
}).strip().refine((value) => (value.result === undefined) !== (value.error === undefined), "JSON-RPC response requires exactly one of result or error.");
export type EmbeddedBrowserRpcResponse = z.infer<typeof EmbeddedBrowserRpcResponseSchema>;

export const EMBEDDED_BROWSER_ERROR_CODES = [
  "BROWSER_CONTROL_UNSUPPORTED",
  "BROWSER_SOURCE_UNAVAILABLE",
  "BROWSER_SOURCE_NOT_FOUND",
  "BROWSER_AUTHORIZATION_REQUIRED",
  "BROWSER_AUTHORIZATION_REVOKED",
  "BROWSER_PAGE_HOST_UNAVAILABLE",
  "BROWSER_TAB_NOT_FOUND",
  "BROWSER_WINDOW_UNAVAILABLE",
  "BROWSER_TARGET_BUSY",
  "BROWSER_LEASE_STALE",
  "BROWSER_OPERATION_UNSUPPORTED",
  "BROWSER_CDP_ERROR",
  "BROWSER_REQUEST_CONFLICT",
  "BROWSER_TIMEOUT",
  "BROWSER_CANCELLED",
  "BROWSER_EXECUTION_UNKNOWN",
  "BROWSER_SNAPSHOT_REQUIRED",
  "BROWSER_LIMIT_EXCEEDED",
  "BROWSER_RESULT_EXPIRED",
  "BROWSER_CREATION_NOT_FOUND",
  "BROWSER_CREATION_CONFLICT",
  "BROWSER_CREATION_DECLINED",
  "BROWSER_CREATION_EXPIRED",
  "BROWSER_CREATION_NO_CANDIDATE",
  "BROWSER_CHANNEL_STREAM_KIND_UNSUPPORTED",
  "BROWSER_CHANNEL_PROTOCOL_ERROR",
] as const;
export const EmbeddedBrowserErrorCodeSchema = z.enum(EMBEDDED_BROWSER_ERROR_CODES);
export type EmbeddedBrowserErrorCode = z.infer<typeof EmbeddedBrowserErrorCodeSchema>;

export const EmbeddedBrowserErrorExecutionSchema = z.enum(["not-started", "completed", "unknown"]);
export type EmbeddedBrowserErrorExecution = z.infer<typeof EmbeddedBrowserErrorExecutionSchema>;

export const EmbeddedBrowserControlErrorSchema = z.object({
  code: EmbeddedBrowserErrorCodeSchema,
  message: z.string().trim().min(1).max(500),
  execution: EmbeddedBrowserErrorExecutionSchema.default("not-started"),
  cdpCode: z.number().int().optional(),
  cdpMessage: z.string().trim().max(500).optional(),
}).strip();
export type EmbeddedBrowserControlError = z.infer<typeof EmbeddedBrowserControlErrorSchema>;

export const EmbeddedBrowserSourceSchema = z.object({
  sourceRef: z.string().trim().min(1).max(240),
  generation: z.number().int().nonnegative(),
  panelId: z.string().trim().min(1).max(240),
  displayName: z.string().trim().min(1).max(160),
  pageHost: EmbeddedBrowserPageHostSchema,
  pageHostCapabilities: EmbeddedBrowserPageHostCapabilitiesSchema,
  revision: z.number().int().nonnegative(),
}).strip().superRefine(validateEmbeddedBrowserPageHostCapabilities);
export type EmbeddedBrowserSource = z.infer<typeof EmbeddedBrowserSourceSchema>;

export const EmbeddedBrowserSourceRegistrationRequestSchema = z.object({
  displayName: z.string().trim().min(1).max(160),
  hostLabel: z.string().trim().min(1).max(160).optional(),
  publisherRef: z.string().trim().min(1).max(240),
  rendererHostBinding: z.string().trim().min(1).max(240).optional(),
  pageHost: EmbeddedBrowserPageHostSchema,
  pageHostCapabilities: EmbeddedBrowserPageHostCapabilitiesSchema.default(defaultPageHostCapabilities()),
}).strict().superRefine(validateEmbeddedBrowserPageHostCapabilities);
export type EmbeddedBrowserSourceRegistrationRequest = z.infer<typeof EmbeddedBrowserSourceRegistrationRequestSchema>;

export const EmbeddedBrowserSourceRegistrationViewSchema = z.object({
  source: EmbeddedBrowserSourceSchema,
  registryEpoch: z.string().trim().min(1).max(240),
  registryRevision: z.number().int().nonnegative(),
}).strip();
export type EmbeddedBrowserSourceRegistrationView = z.infer<typeof EmbeddedBrowserSourceRegistrationViewSchema>;

export const EmbeddedBrowserChannelHandshakeSchema = z.object({
  accessId: z.string().trim().min(1).max(240),
  token: z.string().trim().min(1).max(512),
  expiresAt: z.string().datetime(),
  relayPath: z.literal("/browser-channel-relay"),
  sourceRef: z.string().trim().min(1).max(240),
  generation: z.number().int().nonnegative(),
  registryEpoch: z.string().trim().min(1).max(240),
  registryRevision: z.number().int().nonnegative(),
}).strip();
export type EmbeddedBrowserChannelHandshake = z.infer<typeof EmbeddedBrowserChannelHandshakeSchema>;

export const EmbeddedBrowserSourceConnectionSchema = z.object({
  source: EmbeddedBrowserSourceSchema,
  connection: EmbeddedBrowserChannelHandshakeSchema,
}).strip();
export type EmbeddedBrowserSourceConnection = z.infer<typeof EmbeddedBrowserSourceConnectionSchema>;

export const EmbeddedBrowserPageSchema = z.object({
  sourceRef: z.string().trim().min(1).max(240),
  generation: z.number().int().nonnegative(),
  tabRef: z.string().trim().min(1).max(240),
  instanceId: z.string().trim().min(1).max(160),
  pageHost: EmbeddedBrowserPageHostSchema,
  pageHostCapabilities: EmbeddedBrowserPageHostCapabilitiesSchema,
  title: z.string().trim().max(512).default(""),
  url: z.string().trim().max(4_096).default("about:blank"),
  state: z.string().trim().max(40).default("ready"),
  revision: z.number().int().nonnegative(),
}).strip().superRefine(validateEmbeddedBrowserPageHostCapabilities);
export type EmbeddedBrowserPage = z.infer<typeof EmbeddedBrowserPageSchema>;

export const EmbeddedBrowserPageListResponseSchema = z.object({
  registryEpoch: z.string().trim().min(1).max(240),
  registryRevision: z.number().int().nonnegative(),
  items: z.array(EmbeddedBrowserPageSchema).max(EMBEDDED_BROWSER_SNAPSHOT_MAX_PAGES_PER_CHUNK),
  cursor: z.string().trim().min(1).max(240).optional(),
}).strip();
export type EmbeddedBrowserPageListResponse = z.infer<typeof EmbeddedBrowserPageListResponseSchema>;

export const EmbeddedBrowserSourceSnapshotSchema = z.object({
  sourceRef: z.string().trim().min(1).max(240),
  generation: z.number().int().nonnegative(),
  sourceRevision: z.number().int().nonnegative(),
  registryEpoch: z.string().trim().min(1).max(240),
  snapshotRef: z.string().trim().min(1).max(240),
  chunkIndex: z.number().int().nonnegative(),
  chunkCount: z.number().int().positive(),
  complete: z.boolean(),
  pages: z.array(EmbeddedBrowserPageSchema).max(EMBEDDED_BROWSER_SNAPSHOT_MAX_PAGES_PER_CHUNK),
}).strip().superRefine((value, context) => {
  if (value.chunkCount > Math.ceil(EMBEDDED_BROWSER_MAX_PAGES_PER_SOURCE / EMBEDDED_BROWSER_SNAPSHOT_MAX_PAGES_PER_CHUNK)) {
    context.addIssue({ code: "custom", path: ["chunkCount"], message: "Snapshot chunk count exceeds the source budget." });
  }
  if (value.chunkIndex >= value.chunkCount) {
    context.addIssue({ code: "custom", path: ["chunkIndex"], message: "Snapshot chunk index is outside chunkCount." });
  }
});
export type EmbeddedBrowserSourceSnapshot = z.infer<typeof EmbeddedBrowserSourceSnapshotSchema>;

export const EmbeddedBrowserSourceSnapshotCommitSchema = z.object({
  registryEpoch: z.string().trim().min(1).max(240),
  registryRevision: z.number().int().nonnegative(),
  sourceRevision: z.number().int().nonnegative(),
}).strict();
export type EmbeddedBrowserSourceSnapshotCommit = z.infer<typeof EmbeddedBrowserSourceSnapshotCommitSchema>;

export const EmbeddedBrowserSourceDeltaSchema = z.object({
  sourceRef: z.string().trim().min(1).max(240),
  generation: z.number().int().nonnegative(),
  baseRevision: z.number().int().nonnegative(),
  revision: z.number().int().nonnegative(),
  upserts: z.array(EmbeddedBrowserPageSchema).max(EMBEDDED_BROWSER_SNAPSHOT_MAX_PAGES_PER_CHUNK).default([]),
  removes: z.array(z.string().trim().min(1).max(240)).max(EMBEDDED_BROWSER_SNAPSHOT_MAX_PAGES_PER_CHUNK).default([]),
}).strip().superRefine((value, context) => {
  if (value.revision <= value.baseRevision) {
    context.addIssue({ code: "custom", path: ["revision"], message: "Delta revision must advance baseRevision." });
  }
  for (const page of value.upserts) {
    if (page.sourceRef !== value.sourceRef || page.generation !== value.generation) {
      context.addIssue({ code: "custom", path: ["upserts"], message: "Delta page must belong to the declared source and generation." });
      break;
    }
  }
});
export type EmbeddedBrowserSourceDelta = z.infer<typeof EmbeddedBrowserSourceDeltaSchema>;

export const EmbeddedBrowserRegistryDeltaSchema = z.object({
  registryEpoch: z.string().trim().min(1).max(240),
  baseRevision: z.number().int().nonnegative(),
  revision: z.number().int().nonnegative(),
  upserts: z.array(EmbeddedBrowserPageSchema).max(EMBEDDED_BROWSER_SNAPSHOT_MAX_PAGES_PER_CHUNK).default([]),
  removes: z.array(z.string().trim().min(1).max(240)).max(EMBEDDED_BROWSER_SNAPSHOT_MAX_PAGES_PER_CHUNK).default([]),
  cursor: z.string().trim().min(1).max(240).optional(),
}).strip().superRefine((value, context) => {
  if (value.revision <= value.baseRevision) {
    context.addIssue({ code: "custom", path: ["revision"], message: "Registry delta revision must advance baseRevision." });
  }
});
export type EmbeddedBrowserRegistryDelta = z.infer<typeof EmbeddedBrowserRegistryDeltaSchema>;

export const EmbeddedBrowserCreationStatusSchema = z.enum(["pending", "claimed", "creating", "ready", "failed", "declined", "expired"]);
export type EmbeddedBrowserCreationStatus = z.infer<typeof EmbeddedBrowserCreationStatusSchema>;

export const EmbeddedBrowserCreationSchema = z.object({
  creationRef: z.string().trim().min(1).max(240),
  status: EmbeddedBrowserCreationStatusSchema,
  url: z.string().trim().max(4_096).default("about:blank"),
  title: z.string().trim().max(512).optional(),
  pageHost: EmbeddedBrowserPageHostSchema.optional(),
  pageHostCapabilities: EmbeddedBrowserPageHostCapabilitiesSchema.optional(),
  createdAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
  revision: z.number().int().nonnegative(),
  tabRef: z.string().trim().min(1).max(240).optional(),
}).strip().superRefine((value, context) => {
  if (value.pageHost && value.pageHostCapabilities) validateEmbeddedBrowserPageHostCapabilities({ pageHost: value.pageHost, pageHostCapabilities: value.pageHostCapabilities }, context);
});
export type EmbeddedBrowserCreation = z.infer<typeof EmbeddedBrowserCreationSchema>;

export const EmbeddedBrowserCreationRequestSchema = z.object({
  url: z.string().trim().min(1).max(4_096),
  title: z.string().trim().max(512).optional(),
}).strict();
export type EmbeddedBrowserCreationRequest = z.infer<typeof EmbeddedBrowserCreationRequestSchema>;

export const EmbeddedBrowserCreationClaimSchema = z.object({
  sourceRef: z.string().trim().min(1).max(240),
  expectedRevision: z.number().int().nonnegative(),
}).strict();
export type EmbeddedBrowserCreationClaim = z.infer<typeof EmbeddedBrowserCreationClaimSchema>;

export const EmbeddedBrowserCreationDeclineSchema = z.object({
  sourceRef: z.string().trim().min(1).max(240),
  expectedRevision: z.number().int().nonnegative(),
}).strict();
export type EmbeddedBrowserCreationDecline = z.infer<typeof EmbeddedBrowserCreationDeclineSchema>;

export const EmbeddedBrowserCreationCandidateSchema = z.object({
  sourceRef: z.string().trim().min(1).max(240),
  panelLabel: z.string().trim().min(1).max(160),
  desktopLabel: z.string().trim().min(1).max(160),
  hostLabel: z.string().trim().min(1).max(160).optional(),
  pageHost: EmbeddedBrowserPageHostSchema,
  state: z.string().trim().min(1).max(40),
  canCreate: z.boolean(),
}).strip().superRefine((value, context) => {
  if (value.pageHost === "renderer-webview" && value.canCreate && !value.hostLabel) {
    context.addIssue({ code: "custom", path: ["hostLabel"], message: "renderer-webview creation candidates require a live renderer host label." });
  }
});
export type EmbeddedBrowserCreationCandidate = z.infer<typeof EmbeddedBrowserCreationCandidateSchema>;

export const EmbeddedBrowserCreationViewSchema = z.object({
  creationRef: z.string().trim().min(1).max(240),
  requestedUrl: z.string().trim().min(1).max(4_096),
  title: z.string().trim().max(512).optional(),
  state: EmbeddedBrowserCreationStatusSchema,
  expiresAt: z.string().datetime(),
  candidates: z.array(EmbeddedBrowserCreationCandidateSchema).max(EMBEDDED_BROWSER_MAX_SOURCES).default([]),
  tabRef: z.string().trim().min(1).max(240).optional(),
  revision: z.number().int().nonnegative(),
}).strip();
export type EmbeddedBrowserCreationView = z.infer<typeof EmbeddedBrowserCreationViewSchema>;

// Approval views are scoped to one desktop publisher. `requesterSessionRef` is
// intentionally absent from page DTOs: only the approval surface needs to show
// which AI Session is waiting for the user to pick a desktop.
export const EmbeddedBrowserCreationApprovalViewSchema = z.object({
  request: EmbeddedBrowserCreationViewSchema,
  requesterSessionRef: z.string().trim().min(1).max(240),
}).strict();
export type EmbeddedBrowserCreationApprovalView = z.infer<typeof EmbeddedBrowserCreationApprovalViewSchema>;

export const EmbeddedBrowserCreationApprovalListResponseSchema = z.object({
  creationRevision: z.number().int().nonnegative(),
  items: z.array(EmbeddedBrowserCreationApprovalViewSchema).max(EMBEDDED_BROWSER_MAX_SOURCES),
}).strip();
export type EmbeddedBrowserCreationApprovalListResponse = z.infer<typeof EmbeddedBrowserCreationApprovalListResponseSchema>;

export const EmbeddedBrowserLeaseSchema = z.object({
  leaseRef: z.string().trim().min(1).max(240),
  tabRef: z.string().trim().min(1).max(240),
  sourceRef: z.string().trim().min(1).max(240),
  generation: z.number().int().nonnegative(),
  expiresAt: z.string().datetime(),
}).strip();
export type EmbeddedBrowserLease = z.infer<typeof EmbeddedBrowserLeaseSchema>;

// Browser control access belongs to the whole controlled instance. AI Session
// identity is only used to scope short-lived CDP connection tokens and writer
// leases; it does not narrow which published pages an authorized Agent may see.
export const EmbeddedBrowserAccessViewSchema = z.object({
  active: z.boolean(),
  revision: z.number().int().nonnegative(),
}).strip();
export type EmbeddedBrowserAccessView = z.infer<typeof EmbeddedBrowserAccessViewSchema>;

export const EmbeddedBrowserCdpAccessSchema = z.object({
  httpEndpoint: z.string().url().max(2_048),
  token: z.string().trim().min(1).max(512),
  expiresAt: z.string().datetime(),
  protocolVersion: z.literal(EMBEDDED_BROWSER_CHANNEL_PROTOCOL_VERSION),
}).strip();
export type EmbeddedBrowserCdpAccess = z.infer<typeof EmbeddedBrowserCdpAccessSchema>;

export const EmbeddedBrowserLeaseRefRequestSchema = z.object({
  leaseRef: z.string().trim().min(1).max(240),
}).strict();
export type EmbeddedBrowserLeaseRefRequest = z.infer<typeof EmbeddedBrowserLeaseRefRequestSchema>;

export const EmbeddedBrowserControlHelloSchema = z.object({
  protocolVersion: z.string().trim().min(1).max(40),
  sourceRef: z.string().trim().min(1).max(240),
  generation: z.number().int().nonnegative(),
  pageHost: EmbeddedBrowserPageHostSchema,
  pageHostCapabilities: EmbeddedBrowserPageHostCapabilitiesSchema,
  registryEpoch: z.string().trim().min(1).max(240),
  registryRevision: z.number().int().nonnegative(),
}).strict().superRefine(validateEmbeddedBrowserPageHostCapabilities);
export type EmbeddedBrowserControlHello = z.infer<typeof EmbeddedBrowserControlHelloSchema>;

export const EmbeddedBrowserControlReadySchema = z.object({
  protocolVersion: z.string().trim().min(1).max(40),
  sourceRef: z.string().trim().min(1).max(240),
  generation: z.number().int().nonnegative(),
}).strict();
export type EmbeddedBrowserControlReady = z.infer<typeof EmbeddedBrowserControlReadySchema>;

export const EmbeddedBrowserControlSyncedSchema = z.object({
  sourceRef: z.string().trim().min(1).max(240),
  generation: z.number().int().nonnegative(),
  registryEpoch: z.string().trim().min(1).max(240),
  registryRevision: z.number().int().nonnegative(),
}).strict();
export type EmbeddedBrowserControlSynced = z.infer<typeof EmbeddedBrowserControlSyncedSchema>;

export const EmbeddedBrowserTabsOpenParamsSchema = z.object({
  creationRef: z.string().trim().min(1).max(240),
  sourceRef: z.string().trim().min(1).max(240),
  generation: z.number().int().nonnegative(),
  url: z.string().trim().min(1).max(4_096),
  title: z.string().trim().max(512).optional(),
}).strict();
export type EmbeddedBrowserTabsOpenParams = z.infer<typeof EmbeddedBrowserTabsOpenParamsSchema>;

export const EmbeddedBrowserTabsCreatedParamsSchema = z.object({
  sourceRef: z.string().trim().min(1).max(240),
  generation: z.number().int().nonnegative(),
  tabRef: z.string().trim().min(1).max(240),
  creationRef: z.string().trim().min(1).max(240).optional(),
  title: z.string().trim().max(512).default(""),
  url: z.string().trim().max(4_096).default("about:blank"),
  state: z.string().trim().min(1).max(40).default("ready"),
}).strict();
export type EmbeddedBrowserTabsCreatedParams = z.infer<typeof EmbeddedBrowserTabsCreatedParamsSchema>;

export const EmbeddedBrowserTabsDestroyedParamsSchema = z.object({
  sourceRef: z.string().trim().min(1).max(240),
  generation: z.number().int().nonnegative(),
  tabRef: z.string().trim().min(1).max(240),
  reason: z.string().trim().min(1).max(120),
  creationRef: z.string().trim().min(1).max(240).optional(),
}).strict();
export type EmbeddedBrowserTabsDestroyedParams = z.infer<typeof EmbeddedBrowserTabsDestroyedParamsSchema>;

export const EmbeddedBrowserTabsCloseParamsSchema = z.object({
  sourceRef: z.string().trim().min(1).max(240),
  generation: z.number().int().nonnegative(),
  tabRef: z.string().trim().min(1).max(240),
}).strict();
export type EmbeddedBrowserTabsCloseParams = z.infer<typeof EmbeddedBrowserTabsCloseParamsSchema>;

export const EmbeddedBrowserTargetAttachParamsSchema = z.object({
  leaseRef: z.string().trim().min(1).max(240),
  tabRef: z.string().trim().min(1).max(240),
  sourceRef: z.string().trim().min(1).max(240),
  generation: z.number().int().nonnegative(),
  pageHost: EmbeddedBrowserPageHostSchema,
  profile: z.literal(EMBEDDED_BROWSER_CDP_PROFILE),
}).strict();
export type EmbeddedBrowserTargetAttachParams = z.infer<typeof EmbeddedBrowserTargetAttachParamsSchema>;

export const EmbeddedBrowserTargetDetachParamsSchema = z.object({
  leaseRef: z.string().trim().min(1).max(240),
  tabRef: z.string().trim().min(1).max(240),
  sourceRef: z.string().trim().min(1).max(240),
  generation: z.number().int().nonnegative(),
  reason: z.string().trim().min(1).max(120),
}).strict();
export type EmbeddedBrowserTargetDetachParams = z.infer<typeof EmbeddedBrowserTargetDetachParamsSchema>;

export const EmbeddedBrowserChannelCapabilitiesSchema = z.object({
  supported: z.boolean().default(false),
  transports: z.array(z.literal("reverse-websocket")).max(4).default([]),
  streamKinds: z.array(z.literal("control")).max(8).default([]),
  drivers: z.array(z.literal("electron-page-cdp")).max(8).default([]),
  pageHosts: z.array(EmbeddedBrowserPageHostSchema).max(8).default([]),
}).strip();
export type EmbeddedBrowserChannelCapabilities = z.infer<typeof EmbeddedBrowserChannelCapabilitiesSchema>;

export function unsupportedEmbeddedBrowserChannelCapabilities(): EmbeddedBrowserChannelCapabilities {
  return { supported: false, transports: [], streamKinds: [], drivers: [], pageHosts: [] };
}

export function normalizeEmbeddedBrowserChannelCapabilities(value: unknown): EmbeddedBrowserChannelCapabilities {
  if (!value || typeof value !== "object" || Array.isArray(value)) return unsupportedEmbeddedBrowserChannelCapabilities();
  const record = value as Record<string, unknown>;
  if (record.supported !== true) return unsupportedEmbeddedBrowserChannelCapabilities();
  const transports = knownValues(record.transports, ["reverse-websocket"] as const);
  const streamKinds = knownValues(record.streamKinds, ["control"] as const);
  const drivers = knownValues(record.drivers, ["electron-page-cdp"] as const);
  const pageHosts = knownValues(record.pageHosts, ["renderer-webview", "main-page-pool"] as const);
  if (!transports || !streamKinds || !drivers || !pageHosts) return unsupportedEmbeddedBrowserChannelCapabilities();
  if (!transports.includes("reverse-websocket") || !streamKinds.includes("control") || !drivers.includes("electron-page-cdp")) {
    return unsupportedEmbeddedBrowserChannelCapabilities();
  }
  return { supported: true, transports, streamKinds, drivers, pageHosts };
}

export function supportsEmbeddedBrowserChannel(capabilities: unknown) {
  const feature = embeddedBrowserChannelFeature(capabilities);
  return normalizeEmbeddedBrowserChannelCapabilities(feature).supported;
}

export function supportsEmbeddedBrowserPageHost(capabilities: unknown, pageHost: EmbeddedBrowserPageHost) {
  return normalizeEmbeddedBrowserChannelCapabilities(embeddedBrowserChannelFeature(capabilities)).pageHosts.includes(pageHost);
}

export function encodeEmbeddedBrowserFrame(frame: EmbeddedBrowserFrame): Uint8Array {
  const type = EMBEDDED_BROWSER_FRAME_TYPES[frame.type];
  if (!type || !Number.isInteger(frame.streamId) || frame.streamId <= 0) throw embeddedBrowserProtocolError();
  if (!(frame.payload instanceof Uint8Array) || frame.payload.byteLength > EMBEDDED_BROWSER_CONTROL_MAX_MESSAGE_BYTES) {
    throw embeddedBrowserProtocolError();
  }
  const bytes = new Uint8Array(EMBEDDED_BROWSER_FRAME_HEADER_BYTES + frame.payload.byteLength);
  const view = new DataView(bytes.buffer);
  view.setUint8(0, type);
  view.setUint32(1, frame.streamId, false);
  view.setUint32(5, frame.payload.byteLength, false);
  bytes.set(frame.payload, EMBEDDED_BROWSER_FRAME_HEADER_BYTES);
  return bytes;
}

export function decodeEmbeddedBrowserFrame(bytes: Uint8Array): EmbeddedBrowserFrame {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < EMBEDDED_BROWSER_FRAME_HEADER_BYTES) throw embeddedBrowserProtocolError();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const type = frameType(view.getUint8(0));
  const streamId = view.getUint32(1, false);
  const payloadLength = view.getUint32(5, false);
  if (!type || streamId <= 0 || payloadLength > EMBEDDED_BROWSER_CONTROL_MAX_MESSAGE_BYTES || bytes.byteLength !== EMBEDDED_BROWSER_FRAME_HEADER_BYTES + payloadLength) {
    throw embeddedBrowserProtocolError();
  }
  return { type, streamId, payload: bytes.subarray(EMBEDDED_BROWSER_FRAME_HEADER_BYTES) };
}

export class EmbeddedBrowserFrameDecoder {
  private pending = new Uint8Array();

  push(chunk: Uint8Array): EmbeddedBrowserFrame[] {
    if (!(chunk instanceof Uint8Array)) throw embeddedBrowserProtocolError();
    if (this.pending.byteLength + chunk.byteLength > EMBEDDED_BROWSER_CHANNEL_MAX_BUFFERED_BYTES + EMBEDDED_BROWSER_FRAME_HEADER_BYTES) {
      throw embeddedBrowserProtocolError();
    }
    const merged = new Uint8Array(this.pending.byteLength + chunk.byteLength);
    merged.set(this.pending);
    merged.set(chunk, this.pending.byteLength);
    this.pending = merged;
    const frames: EmbeddedBrowserFrame[] = [];
    let offset = 0;
    while (this.pending.byteLength - offset >= EMBEDDED_BROWSER_FRAME_HEADER_BYTES) {
      const view = new DataView(this.pending.buffer, this.pending.byteOffset + offset, this.pending.byteLength - offset);
      const payloadLength = view.getUint32(5, false);
      if (payloadLength > EMBEDDED_BROWSER_CONTROL_MAX_MESSAGE_BYTES) throw embeddedBrowserProtocolError();
      const frameLength = EMBEDDED_BROWSER_FRAME_HEADER_BYTES + payloadLength;
      if (this.pending.byteLength - offset < frameLength) break;
      frames.push(decodeEmbeddedBrowserFrame(this.pending.subarray(offset, offset + frameLength)));
      offset += frameLength;
    }
    this.pending = offset === this.pending.byteLength ? new Uint8Array() : this.pending.slice(offset);
    return frames;
  }

  finish() {
    if (this.pending.byteLength) throw embeddedBrowserProtocolError();
  }
}

export function encodeEmbeddedBrowserControlMessage(value: unknown): Uint8Array {
  const json = new TextEncoder().encode(JSON.stringify(value));
  if (!json.byteLength || json.byteLength > EMBEDDED_BROWSER_CONTROL_MAX_MESSAGE_BYTES) throw embeddedBrowserProtocolError();
  const bytes = new Uint8Array(4 + json.byteLength);
  new DataView(bytes.buffer).setUint32(0, json.byteLength, false);
  bytes.set(json, 4);
  return bytes;
}

export class EmbeddedBrowserControlMessageDecoder {
  private pending = new Uint8Array();

  push(chunk: Uint8Array): unknown[] {
    if (!(chunk instanceof Uint8Array)) throw embeddedBrowserProtocolError();
    if (this.pending.byteLength + chunk.byteLength > EMBEDDED_BROWSER_CHANNEL_MAX_BUFFERED_BYTES) throw embeddedBrowserProtocolError();
    const merged = new Uint8Array(this.pending.byteLength + chunk.byteLength);
    merged.set(this.pending);
    merged.set(chunk, this.pending.byteLength);
    this.pending = merged;
    const values: unknown[] = [];
    let offset = 0;
    while (this.pending.byteLength - offset >= 4) {
      const length = new DataView(this.pending.buffer, this.pending.byteOffset + offset, this.pending.byteLength - offset).getUint32(0, false);
      if (!length || length > EMBEDDED_BROWSER_CONTROL_MAX_MESSAGE_BYTES) throw embeddedBrowserProtocolError();
      if (this.pending.byteLength - offset < 4 + length) break;
      const text = new TextDecoder().decode(this.pending.subarray(offset + 4, offset + 4 + length));
      let parsed: unknown;
      try { parsed = JSON.parse(text); } catch { throw embeddedBrowserProtocolError(); }
      values.push(parsed);
      offset += 4 + length;
    }
    this.pending = offset === this.pending.byteLength ? new Uint8Array() : this.pending.slice(offset);
    return values;
  }

  finish() {
    if (this.pending.byteLength) throw embeddedBrowserProtocolError();
  }
}

export function embeddedBrowserProtocolError() {
  return Object.assign(new Error("BROWSER_CHANNEL_PROTOCOL_ERROR"), { code: "BROWSER_CHANNEL_PROTOCOL_ERROR" });
}

export function embeddedBrowserOperationUnsupported(message = "BROWSER_OPERATION_UNSUPPORTED") {
  return Object.assign(new Error(message), { code: "BROWSER_OPERATION_UNSUPPORTED" });
}

function embeddedBrowserCdpMethodShape(method: unknown): method is string {
  return typeof method === "string"
    && method.length > 0
    && method.length <= 240
    && /^[A-Za-z][A-Za-z0-9]*\.[A-Za-z][A-Za-z0-9]*$/.test(method);
}

function embeddedBrowserCdpOperationUnsupported() {
  return embeddedBrowserOperationUnsupported();
}

function validateEmbeddedBrowserPageHostCapabilities(
  value: { pageHost: EmbeddedBrowserPageHost; pageHostCapabilities: EmbeddedBrowserPageHostCapabilities },
  context: z.RefinementCtx,
) {
  if (value.pageHost !== "renderer-webview") return;
  if (value.pageHostCapabilities.backgroundCreation) {
    context.addIssue({ code: "custom", path: ["pageHostCapabilities", "backgroundCreation"], message: "renderer-webview cannot support background creation." });
  }
  if (value.pageHostCapabilities.surviveHostWindowClose) {
    context.addIssue({ code: "custom", path: ["pageHostCapabilities", "surviveHostWindowClose"], message: "renderer-webview cannot survive host window close." });
  }
  if (value.pageHostCapabilities.crossWindowAdopt) {
    context.addIssue({ code: "custom", path: ["pageHostCapabilities", "crossWindowAdopt"], message: "renderer-webview cannot support cross-window adoption." });
  }
}

function decodeStrictJsonPayload<T>(payload: Uint8Array, schema: z.ZodType<T>): T {
  if (!(payload instanceof Uint8Array) || payload.byteLength > EMBEDDED_BROWSER_CONTROL_MAX_MESSAGE_BYTES) throw embeddedBrowserProtocolError();
  let value: unknown;
  try { value = JSON.parse(new TextDecoder().decode(payload)); } catch { throw embeddedBrowserProtocolError(); }
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw embeddedBrowserProtocolError();
  return parsed.data;
}

function knownValues<const T extends readonly string[]>(value: unknown, allowed: T): T[number][] | undefined {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) return undefined;
  const accepted = new Set<string>(allowed);
  return [...new Set(value.filter((entry): entry is T[number] => accepted.has(entry as string)))];
}

function frameType(value: number): EmbeddedBrowserFrameType | undefined {
  for (const [name, code] of Object.entries(EMBEDDED_BROWSER_FRAME_TYPES)) {
    if (code === value) return name as EmbeddedBrowserFrameType;
  }
  return undefined;
}

function embeddedBrowserChannelFeature(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (record.embeddedBrowserChannel !== undefined) return record.embeddedBrowserChannel;
  if (record.features && typeof record.features === "object" && !Array.isArray(record.features)) {
    return (record.features as Record<string, unknown>).embeddedBrowserChannel;
  }
  return record;
}
