import { z } from "zod";

export const EMBEDDED_BROWSER_CHANNEL_PROTOCOL_VERSION = "2026-11-22";
// Browser-level Target CDP is exposed through /json/version and is a separate
// sub-protocol from the channel framing and electron-page-cdp method profile.
export const EMBEDDED_BROWSER_TARGET_CDP_PROFILE = "embedded-browser-target-cdp";
export const EMBEDDED_BROWSER_TARGET_CDP_PROTOCOL_VERSION = "1.3";
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
export const EMBEDDED_BROWSER_ACCESS_REQUEST_TTL_MS = 5 * 60_000;
export const EMBEDDED_BROWSER_ACCESS_WAIT_MS = 10_000;

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
  "Emulation.*": "page-write",
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
  const methods = EMBEDDED_BROWSER_CDP_METHODS as Record<string, EmbeddedBrowserCdpMethodKind>;
  return methods[method] ?? methods[`${method.slice(0, method.indexOf("."))}.*`];
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

// Wire identities intentionally reuse the authoritative source and page IDs:
// browserContextId is sourceRef, and targetId is tabRef. These schemas do not
// mint parallel IDs; they only keep the mapping explicit at the CDP boundary.
export const EmbeddedBrowserCdpBrowserContextIdSchema = z.string().trim().min(1).max(240);
export type EmbeddedBrowserCdpBrowserContextId = z.infer<typeof EmbeddedBrowserCdpBrowserContextIdSchema>;
export const EmbeddedBrowserCdpTargetIdSchema = z.string().trim().min(1).max(240);
export type EmbeddedBrowserCdpTargetId = z.infer<typeof EmbeddedBrowserCdpTargetIdSchema>;
export const EmbeddedBrowserCdpSessionIdSchema = z.string().trim().min(1).max(240);
export type EmbeddedBrowserCdpSessionId = z.infer<typeof EmbeddedBrowserCdpSessionIdSchema>;

export const EMBEDDED_BROWSER_TARGET_CDP_METHODS = Object.freeze([
  "Target.getTargets",
  "Target.getTargetInfo",
  "Target.getBrowserContexts",
  "Target.attachToTarget",
  "Target.detachFromTarget",
  "Target.closeTarget",
  "Target.createTarget",
  "Target.setDiscoverTargets",
] as const);
export type EmbeddedBrowserTargetCdpMethod = (typeof EMBEDDED_BROWSER_TARGET_CDP_METHODS)[number];

export const EMBEDDED_BROWSER_TARGET_CDP_EVENTS = Object.freeze([
  "Target.targetCreated",
  "Target.targetDestroyed",
  "Target.targetInfoChanged",
  "Target.detachedFromTarget",
] as const);
export type EmbeddedBrowserTargetCdpEventMethod = (typeof EMBEDDED_BROWSER_TARGET_CDP_EVENTS)[number];

export function supportsEmbeddedBrowserTargetCdpMethod(method: unknown): method is EmbeddedBrowserTargetCdpMethod {
  return typeof method === "string" && (EMBEDDED_BROWSER_TARGET_CDP_METHODS as readonly string[]).includes(method);
}

export function assertEmbeddedBrowserTargetCdpMethod(method: unknown): EmbeddedBrowserTargetCdpMethod {
  const normalized = typeof method === "string" ? method.trim() : "";
  if (!supportsEmbeddedBrowserTargetCdpMethod(normalized)) throw embeddedBrowserCdpOperationUnsupported();
  return normalized;
}

export function supportsEmbeddedBrowserTargetCdpEvent(method: unknown): method is EmbeddedBrowserTargetCdpEventMethod {
  return typeof method === "string" && (EMBEDDED_BROWSER_TARGET_CDP_EVENTS as readonly string[]).includes(method);
}

export const EmbeddedBrowserTargetInfoSchema = z.object({
  targetId: EmbeddedBrowserCdpTargetIdSchema,
  type: z.literal("page"),
  title: z.string().trim().max(512).default(""),
  url: z.string().trim().max(4_096).default("about:blank"),
  attached: z.boolean().default(false),
  browserContextId: EmbeddedBrowserCdpBrowserContextIdSchema,
}).strip();
export type EmbeddedBrowserTargetInfo = z.infer<typeof EmbeddedBrowserTargetInfoSchema>;

export const EmbeddedBrowserTargetGetTargetsParamsSchema = z.object({}).strip();
export type EmbeddedBrowserTargetGetTargetsParams = z.infer<typeof EmbeddedBrowserTargetGetTargetsParamsSchema>;
export const EmbeddedBrowserTargetGetTargetsResultSchema = z.object({
  targetInfos: z.array(EmbeddedBrowserTargetInfoSchema),
}).strip();
export type EmbeddedBrowserTargetGetTargetsResult = z.infer<typeof EmbeddedBrowserTargetGetTargetsResultSchema>;

export const EmbeddedBrowserTargetGetTargetInfoParamsSchema = z.object({
  targetId: EmbeddedBrowserCdpTargetIdSchema,
}).strip();
export type EmbeddedBrowserTargetGetTargetInfoParams = z.infer<typeof EmbeddedBrowserTargetGetTargetInfoParamsSchema>;
export const EmbeddedBrowserTargetGetTargetInfoResultSchema = z.object({
  targetInfo: EmbeddedBrowserTargetInfoSchema,
}).strip();
export type EmbeddedBrowserTargetGetTargetInfoResult = z.infer<typeof EmbeddedBrowserTargetGetTargetInfoResultSchema>;

export const EmbeddedBrowserTargetGetBrowserContextsParamsSchema = z.object({}).strip();
export type EmbeddedBrowserTargetGetBrowserContextsParams = z.infer<typeof EmbeddedBrowserTargetGetBrowserContextsParamsSchema>;
export const EmbeddedBrowserTargetGetBrowserContextsResultSchema = z.object({
  browserContextIds: z.array(EmbeddedBrowserCdpBrowserContextIdSchema).max(EMBEDDED_BROWSER_MAX_SOURCES),
  defaultBrowserContextId: EmbeddedBrowserCdpBrowserContextIdSchema.optional(),
}).strip();
export type EmbeddedBrowserTargetGetBrowserContextsResult = z.infer<typeof EmbeddedBrowserTargetGetBrowserContextsResultSchema>;

export const EmbeddedBrowserTargetAttachToTargetParamsSchema = z.object({
  targetId: EmbeddedBrowserCdpTargetIdSchema,
  flatten: z.literal(true),
}).strip();
export type EmbeddedBrowserTargetAttachToTargetParams = z.infer<typeof EmbeddedBrowserTargetAttachToTargetParamsSchema>;
export const EmbeddedBrowserTargetAttachToTargetResultSchema = z.object({
  sessionId: EmbeddedBrowserCdpSessionIdSchema,
}).strip();
export type EmbeddedBrowserTargetAttachToTargetResult = z.infer<typeof EmbeddedBrowserTargetAttachToTargetResultSchema>;

export const EmbeddedBrowserTargetDetachFromTargetParamsSchema = z.object({
  sessionId: EmbeddedBrowserCdpSessionIdSchema.optional(),
  targetId: EmbeddedBrowserCdpTargetIdSchema.optional(),
}).strip().superRefine((value, context) => {
  if (!value.sessionId && !value.targetId) {
    context.addIssue({ code: "custom", message: "Target.detachFromTarget requires sessionId or targetId." });
  }
});
export type EmbeddedBrowserTargetDetachFromTargetParams = z.infer<typeof EmbeddedBrowserTargetDetachFromTargetParamsSchema>;
export const EmbeddedBrowserTargetDetachFromTargetResultSchema = z.object({}).strip();
export type EmbeddedBrowserTargetDetachFromTargetResult = z.infer<typeof EmbeddedBrowserTargetDetachFromTargetResultSchema>;

export const EmbeddedBrowserTargetCloseTargetParamsSchema = z.object({
  targetId: EmbeddedBrowserCdpTargetIdSchema,
}).strip();
export type EmbeddedBrowserTargetCloseTargetParams = z.infer<typeof EmbeddedBrowserTargetCloseTargetParamsSchema>;
export const EmbeddedBrowserTargetCloseTargetResultSchema = z.object({
  success: z.boolean(),
}).strip();
export type EmbeddedBrowserTargetCloseTargetResult = z.infer<typeof EmbeddedBrowserTargetCloseTargetResultSchema>;

export const EmbeddedBrowserTargetCreateTargetParamsSchema = z.object({
  url: z.string().trim().min(1).max(4_096),
  browserContextId: EmbeddedBrowserCdpBrowserContextIdSchema.optional(),
}).strip();
export type EmbeddedBrowserTargetCreateTargetParams = z.infer<typeof EmbeddedBrowserTargetCreateTargetParamsSchema>;
export const EmbeddedBrowserTargetCreateTargetResultSchema = z.object({
  targetId: EmbeddedBrowserCdpTargetIdSchema,
}).strip();
export type EmbeddedBrowserTargetCreateTargetResult = z.infer<typeof EmbeddedBrowserTargetCreateTargetResultSchema>;

export const EmbeddedBrowserTargetSetDiscoverTargetsParamsSchema = z.object({
  discover: z.boolean(),
}).strip();
export type EmbeddedBrowserTargetSetDiscoverTargetsParams = z.infer<typeof EmbeddedBrowserTargetSetDiscoverTargetsParamsSchema>;
export const EmbeddedBrowserTargetSetDiscoverTargetsResultSchema = z.object({}).strip();
export type EmbeddedBrowserTargetSetDiscoverTargetsResult = z.infer<typeof EmbeddedBrowserTargetSetDiscoverTargetsResultSchema>;

export const EmbeddedBrowserTargetCreatedEventSchema = z.object({
  method: z.literal("Target.targetCreated"),
  params: z.object({ targetInfo: EmbeddedBrowserTargetInfoSchema }).strip(),
}).strip();
export type EmbeddedBrowserTargetCreatedEvent = z.infer<typeof EmbeddedBrowserTargetCreatedEventSchema>;

export const EmbeddedBrowserTargetInfoChangedEventSchema = z.object({
  method: z.literal("Target.targetInfoChanged"),
  params: z.object({ targetInfo: EmbeddedBrowserTargetInfoSchema }).strip(),
}).strip();
export type EmbeddedBrowserTargetInfoChangedEvent = z.infer<typeof EmbeddedBrowserTargetInfoChangedEventSchema>;

export const EmbeddedBrowserTargetDestroyedEventSchema = z.object({
  method: z.literal("Target.targetDestroyed"),
  params: z.object({ targetId: EmbeddedBrowserCdpTargetIdSchema }).strip(),
}).strip();
export type EmbeddedBrowserTargetDestroyedEvent = z.infer<typeof EmbeddedBrowserTargetDestroyedEventSchema>;

export const EmbeddedBrowserTargetDetachedFromTargetEventSchema = z.object({
  method: z.literal("Target.detachedFromTarget"),
  params: z.object({
    sessionId: EmbeddedBrowserCdpSessionIdSchema,
    targetId: EmbeddedBrowserCdpTargetIdSchema.optional(),
  }).strip(),
}).strip();
export type EmbeddedBrowserTargetDetachedFromTargetEvent = z.infer<typeof EmbeddedBrowserTargetDetachedFromTargetEventSchema>;

export const EmbeddedBrowserTargetCdpEventSchema = z.discriminatedUnion("method", [
  EmbeddedBrowserTargetCreatedEventSchema,
  EmbeddedBrowserTargetInfoChangedEventSchema,
  EmbeddedBrowserTargetDestroyedEventSchema,
  EmbeddedBrowserTargetDetachedFromTargetEventSchema,
]);
export type EmbeddedBrowserTargetCdpEvent = z.infer<typeof EmbeddedBrowserTargetCdpEventSchema>;

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
  "BROWSER_CREATION_CONTEXT_REQUIRED",
  "BROWSER_CREATION_CONTEXT_UNAVAILABLE",
  "BROWSER_CREATION_CONTEXT_NOT_SELECTED",
  "BROWSER_CREATION_CONTEXT_NOT_OWNED",
  "BROWSER_CREATION_CONTEXT_FORBIDDEN",
  "BROWSER_DEFAULT_CONTEXT_CONFLICT",
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
  // Structured details for pending creation and creation-context conflicts.
  // The base error model remains code/message/execution; these fields are
  // additive so older readers can ignore them.
  creationRef: z.string().trim().min(1).max(240).optional(),
  expiresAt: z.string().datetime().optional(),
  revision: z.number().int().nonnegative().optional(),
  defaultBrowserContextId: z.string().trim().min(1).max(240).optional(),
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

/** Returns the sourceRef unchanged; browserContextId has no separate identity. */
export function embeddedBrowserBrowserContextId(sourceRef: string): EmbeddedBrowserCdpBrowserContextId {
  return EmbeddedBrowserCdpBrowserContextIdSchema.parse(sourceRef);
}

/** Returns the tabRef unchanged; targetId has no separate identity. */
export function embeddedBrowserTargetId(tabRef: string): EmbeddedBrowserCdpTargetId {
  return EmbeddedBrowserCdpTargetIdSchema.parse(tabRef);
}

export function embeddedBrowserTargetInfoFromPage(
  page: EmbeddedBrowserPage,
  attached = false,
): EmbeddedBrowserTargetInfo {
  return EmbeddedBrowserTargetInfoSchema.parse({
    targetId: embeddedBrowserTargetId(page.tabRef),
    type: "page",
    title: page.title,
    url: page.url,
    attached,
    browserContextId: embeddedBrowserBrowserContextId(page.sourceRef),
  });
}

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

// Instance-wide creation-context state. `browserContextId` is the sourceRef;
// the pair exists only so consumers can use the CDP field name without
// inventing a second identifier.
export const EmbeddedBrowserBrowserContextSchema = z.object({
  sourceRef: z.string().trim().min(1).max(240),
  browserContextId: EmbeddedBrowserCdpBrowserContextIdSchema,
}).strip().superRefine((value, context) => {
  if (value.sourceRef !== value.browserContextId) {
    context.addIssue({ code: "custom", path: ["browserContextId"], message: "browserContextId must equal sourceRef." });
  }
});
export type EmbeddedBrowserBrowserContext = z.infer<typeof EmbeddedBrowserBrowserContextSchema>;

export const EmbeddedBrowserCreationPanelSchema = z.object({
  sourceRef: z.string().trim().min(1).max(240),
  panelLabel: z.string().trim().min(1).max(160),
  hostLabel: z.string().trim().min(1).max(160).optional(),
  pageHost: EmbeddedBrowserPageHostSchema,
  canCreate: z.boolean(),
  isDefault: z.boolean().default(false),
  canClaim: z.boolean().default(false),
}).strip().superRefine((value, context) => {
  if (value.pageHost === "renderer-webview" && value.canCreate && !value.hostLabel) {
    context.addIssue({ code: "custom", path: ["hostLabel"], message: "renderer-webview creation panels require a live renderer host label." });
  }
});
export type EmbeddedBrowserCreationPanel = z.infer<typeof EmbeddedBrowserCreationPanelSchema>;

export const EmbeddedBrowserCreationPendingSchema = z.object({
  creationRef: z.string().trim().min(1).max(240),
  url: z.string().trim().min(1).max(4_096),
  state: z.literal("pending").default("pending"),
  expiresAt: z.string().datetime(),
}).strip();
export type EmbeddedBrowserCreationPending = z.infer<typeof EmbeddedBrowserCreationPendingSchema>;

export const EmbeddedBrowserCreationContextSnapshotSchema = z.object({
  revision: z.number().int().nonnegative(),
  defaultContext: z.preprocess((value) => value === null ? undefined : value, EmbeddedBrowserBrowserContextSchema.optional()),
  panels: z.array(EmbeddedBrowserCreationPanelSchema).max(EMBEDDED_BROWSER_MAX_SOURCES).default([]),
  pendingCreation: z.preprocess((value) => value === null ? undefined : value, EmbeddedBrowserCreationPendingSchema.optional()),
}).strip().superRefine((value, context) => {
  const defaults = value.panels.filter((panel) => panel.isDefault);
  if (defaults.length > 1) {
    context.addIssue({ code: "custom", path: ["panels"], message: "At most one panel can be the default creation context." });
  }
  if (defaults.length === 1 && value.defaultContext && defaults[0].sourceRef !== value.defaultContext.sourceRef) {
    context.addIssue({ code: "custom", path: ["panels"], message: "The default panel must match defaultContext." });
  }
});
export type EmbeddedBrowserCreationContextSnapshot = z.infer<typeof EmbeddedBrowserCreationContextSnapshotSchema>;

export const EmbeddedBrowserDefaultContextClaimRequestSchema = z.object({
  // The caller may only submit its own desktop source. The instance rechecks
  // token, panel/user and source ownership; this schema deliberately has no
  // field for selecting another panel.
  sourceRef: z.string().trim().min(1).max(240),
  expectedRevision: z.number().int().nonnegative(),
}).strict();
export type EmbeddedBrowserDefaultContextClaimRequest = z.infer<typeof EmbeddedBrowserDefaultContextClaimRequestSchema>;

export const EmbeddedBrowserDefaultContextClaimResultSchema = z.object({
  sourceRef: z.string().trim().min(1).max(240),
  browserContextId: EmbeddedBrowserCdpBrowserContextIdSchema,
  revision: z.number().int().nonnegative(),
}).strip().superRefine((value, context) => {
  if (value.sourceRef !== value.browserContextId) {
    context.addIssue({ code: "custom", path: ["browserContextId"], message: "browserContextId must equal sourceRef." });
  }
});
export type EmbeddedBrowserDefaultContextClaimResult = z.infer<typeof EmbeddedBrowserDefaultContextClaimResultSchema>;

export const EmbeddedBrowserCreationContextChangedEventSchema = z.object({
  type: z.literal("browser.creation-context.changed"),
  revision: z.number().int().nonnegative(),
  defaultBrowserContextId: EmbeddedBrowserCdpBrowserContextIdSchema.optional(),
  previousBrowserContextId: EmbeddedBrowserCdpBrowserContextIdSchema.optional(),
}).strip();
export type EmbeddedBrowserCreationContextChangedEvent = z.infer<typeof EmbeddedBrowserCreationContextChangedEventSchema>;

export const EmbeddedBrowserLeaseSchema = z.object({
  leaseRef: z.string().trim().min(1).max(240),
  tabRef: z.string().trim().min(1).max(240),
  sourceRef: z.string().trim().min(1).max(240),
  generation: z.number().int().nonnegative(),
  expiresAt: z.string().datetime(),
}).strip();
export type EmbeddedBrowserLease = z.infer<typeof EmbeddedBrowserLeaseSchema>;

// An AI Session can ask the user for instance-wide browser access. The request
// is a separate instance-owned record so every connected Control Plane can show
// the same approval; it never narrows which pages an authorized Agent may see.
export const EmbeddedBrowserAccessRequestViewSchema = z.object({
  requestRef: z.string().trim().min(1).max(240),
  requesterSessionRef: z.string().trim().min(1).max(240),
  revision: z.number().int().nonnegative(),
  createdAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
}).strip();
export type EmbeddedBrowserAccessRequestView = z.infer<typeof EmbeddedBrowserAccessRequestViewSchema>;

// Browser control access belongs to the whole controlled instance. AI Session
// identity is only used to scope short-lived CDP connection tokens and writer
// leases; it does not narrow which published pages an authorized Agent may see.
export const EmbeddedBrowserAccessViewSchema = z.object({
  active: z.boolean(),
  revision: z.number().int().nonnegative(),
  pendingRequest: z.preprocess((value) => value === null ? undefined : value, EmbeddedBrowserAccessRequestViewSchema.optional()),
}).strip();
export type EmbeddedBrowserAccessView = z.infer<typeof EmbeddedBrowserAccessViewSchema>;

export const EmbeddedBrowserAccessRequestChangedEventSchema = z.object({
  type: z.literal("browser.access.request.changed"),
  requestRef: z.string().trim().min(1).max(240),
  state: z.enum(["pending", "approved", "denied", "expired", "cancelled"]),
  revision: z.number().int().nonnegative(),
}).strip();
export type EmbeddedBrowserAccessRequestChangedEvent = z.infer<typeof EmbeddedBrowserAccessRequestChangedEventSchema>;

export const EmbeddedBrowserCdpAccessSchema = z.object({
  httpEndpoint: z.string().url().max(2_048),
  token: z.string().trim().min(1).max(512),
  expiresAt: z.string().datetime(),
  protocolVersion: z.literal(EMBEDDED_BROWSER_CHANNEL_PROTOCOL_VERSION),
}).strip();
export type EmbeddedBrowserCdpAccess = z.infer<typeof EmbeddedBrowserCdpAccessSchema>;

// The single Agent browser tool returns one of these states. `pending` means
// the approval card is waiting for a human in the approval center; callers must
// return to the conversation and ask the user to approve instead of holding the
// MCP call open indefinitely.
export const EmbeddedBrowserCdpAccessResultSchema = z.discriminatedUnion("status", [
  EmbeddedBrowserCdpAccessSchema.extend({ status: z.literal("granted") }).strip(),
  z.object({
    status: z.literal("pending"),
    requestRef: z.string().trim().min(1).max(240),
    expiresAt: z.string().datetime(),
    message: z.string().trim().min(1).max(2_000),
  }).strip(),
  z.object({
    status: z.literal("denied"),
    requestRef: z.string().trim().min(1).max(240),
    message: z.string().trim().min(1).max(2_000),
  }).strip(),
  z.object({
    status: z.literal("expired"),
    requestRef: z.string().trim().min(1).max(240),
    message: z.string().trim().min(1).max(2_000),
  }).strip(),
]);
export type EmbeddedBrowserCdpAccessResult = z.infer<typeof EmbeddedBrowserCdpAccessResultSchema>;

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
  // Compatibility: older capability documents omit this additive domain and
  // therefore keep browser-level Target CDP disabled.
  targetCdp: z.preprocess((value) => value === true, z.boolean()),
}).strip();
export type EmbeddedBrowserChannelCapabilities = z.infer<typeof EmbeddedBrowserChannelCapabilitiesSchema>;

export function unsupportedEmbeddedBrowserChannelCapabilities(): EmbeddedBrowserChannelCapabilities {
  return { supported: false, transports: [], streamKinds: [], drivers: [], pageHosts: [], targetCdp: false };
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
  return { supported: true, transports, streamKinds, drivers, pageHosts, targetCdp: record.targetCdp === true };
}

export function supportsEmbeddedBrowserChannel(capabilities: unknown) {
  const feature = embeddedBrowserChannelFeature(capabilities);
  return normalizeEmbeddedBrowserChannelCapabilities(feature).supported;
}

export function supportsEmbeddedBrowserPageHost(capabilities: unknown, pageHost: EmbeddedBrowserPageHost) {
  return normalizeEmbeddedBrowserChannelCapabilities(embeddedBrowserChannelFeature(capabilities)).pageHosts.includes(pageHost);
}

export function supportsEmbeddedBrowserTargetCdp(capabilities: unknown) {
  return normalizeEmbeddedBrowserChannelCapabilities(embeddedBrowserChannelFeature(capabilities)).targetCdp;
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
