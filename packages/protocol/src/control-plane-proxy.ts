import { z } from "zod";

export const CONTROL_PLANE_PROXY_PROTOCOL_VERSION = "2026-08-01";

export const ControlPlaneProxyProtocolVersionSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Proxy protocol version must use YYYY-MM-DD format.");

const IdSchema = z.string().trim().min(1).max(160).regex(/^[a-zA-Z0-9][a-zA-Z0-9_.:-]*$/);
const TimestampSchema = z.string().datetime();
const CredentialSchema = z.string().trim().min(32).max(4096);
export const ProxyCorrelationIdSchema = IdSchema;

export function normalizeControlPlaneProxyOrigin(input: string) {
  const url = new URL(input.trim());
  if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("Proxy origin must be an HTTPS origin without credentials, path, query, or fragment.");
  }
  return url.origin;
}

export const ControlPlaneProxyOriginSchema = z.string().trim().max(2048).transform((value, context) => {
  try {
    return normalizeControlPlaneProxyOrigin(value);
  } catch (error) {
    context.addIssue({ code: "custom", message: error instanceof Error ? error.message : String(error) });
    return z.NEVER;
  }
});

export function normalizeNodeAgentProxyRoute(input: string) {
  const route = input.trim();
  if (!route.startsWith("/") || route.startsWith("//") || route.includes("\\") || /%25/i.test(route)) {
    throw new Error("Proxy route must be a single-encoded node-agent relative route.");
  }
  const rawPath = route.split("?", 1)[0];
  let decodedSegments: string[];
  try {
    decodedSegments = rawPath.split("/").map((segment) => decodeURIComponent(segment));
  } catch {
    throw new Error("Proxy route contains invalid percent encoding.");
  }
  if (decodedSegments.some((segment) => segment === ".." || segment === ".")) {
    throw new Error("Proxy route cannot traverse outside the node-agent API.");
  }
  let parsed: URL;
  try {
    parsed = new URL(route, "https://node-agent.invalid");
  } catch {
    throw new Error("Proxy route is invalid.");
  }
  if (parsed.origin !== "https://node-agent.invalid" || parsed.username || parsed.password) {
    throw new Error("Proxy route cannot select an absolute upstream URL.");
  }
  return `${parsed.pathname}${parsed.search}`;
}

export const NodeAgentProxyRouteSchema = z.string().trim().min(1).max(4096).transform((value, context) => {
  try {
    return normalizeNodeAgentProxyRoute(value);
  } catch (error) {
    context.addIssue({ code: "custom", message: error instanceof Error ? error.message : String(error) });
    return z.NEVER;
  }
});

export const CONTROL_PLANE_PROXY_APPLICATION_REQUEST_HEADERS = new Set([
  "accept",
  "accept-language",
  "authorization",
  "content-type",
  "if-match",
  "if-none-match",
  "range",
  "x-request-id",
]);

export const CONTROL_PLANE_PROXY_APPLICATION_RESPONSE_HEADERS = new Set([
  "cache-control",
  "content-disposition",
  "content-language",
  "content-length",
  "content-range",
  "content-type",
  "etag",
  "last-modified",
  "x-request-id",
]);

export const CONTROL_PLANE_PROXY_AUTH_HEADERS = {
  protocolVersion: "x-task-handoff-proxy-protocol-version",
  sourceControlPlaneId: "x-task-handoff-proxy-source-control-plane-id",
  bindingKeyId: "x-task-handoff-proxy-binding-key-id",
  credential: "x-task-handoff-proxy-credential",
} as const;

export const ControlPlaneProxyErrorCode = {
  ProtocolUnsupported: "CONTROL_PLANE_PROXY_PROTOCOL_UNSUPPORTED",
  InviteInvalid: "CONTROL_PLANE_PROXY_INVITE_INVALID",
  InviteExpired: "CONTROL_PLANE_PROXY_INVITE_EXPIRED",
  InviteConsumed: "CONTROL_PLANE_PROXY_INVITE_CONSUMED",
  InviteRevoked: "CONTROL_PLANE_PROXY_INVITE_REVOKED",
  TargetUnavailable: "CONTROL_PLANE_PROXY_TARGET_UNAVAILABLE",
  TargetMismatch: "CONTROL_PLANE_PROXY_TARGET_MISMATCH",
  BindingUnknown: "CONTROL_PLANE_PROXY_BINDING_UNKNOWN",
  BindingRevoked: "CONTROL_PLANE_PROXY_BINDING_REVOKED",
  BindingIdentityConflict: "CONTROL_PLANE_PROXY_BINDING_IDENTITY_CONFLICT",
  AuthenticationFailed: "CONTROL_PLANE_PROXY_AUTHENTICATION_FAILED",
  RouteInvalid: "CONTROL_PLANE_PROXY_ROUTE_INVALID",
  HeaderInvalid: "CONTROL_PLANE_PROXY_HEADER_INVALID",
  ResourceLimit: "CONTROL_PLANE_PROXY_RESOURCE_LIMIT",
  SnapshotRequired: "CONTROL_PLANE_PROXY_SNAPSHOT_REQUIRED",
  Unavailable: "CONTROL_PLANE_PROXY_UNAVAILABLE",
  TransportFailed: "CONTROL_PLANE_PROXY_TRANSPORT_FAILED",
} as const;

export const ControlPlaneProxyErrorCodeSchema = z.enum(Object.values(ControlPlaneProxyErrorCode));

export const ControlPlaneProxyErrorSchema = z.object({
  code: ControlPlaneProxyErrorCodeSchema,
  message: z.string().trim().min(1).max(2048),
  retryable: z.boolean(),
  details: z.record(z.string(), z.unknown()).optional(),
}).strict();

export const ProxyInviteStatusSchema = z.enum(["active", "consumed", "revoked", "expired"]);

export const ProxyInviteSchema = z.object({
  id: IdSchema,
  targetNodeId: IdSchema,
  tokenHash: z.string().trim().min(32).max(256),
  status: ProxyInviteStatusSchema,
  createdBy: IdSchema,
  expiresAt: TimestampSchema,
  consumedByClaimId: IdSchema.optional(),
  consumedAt: TimestampSchema.optional(),
  revokedAt: TimestampSchema.optional(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
}).strict();

export const PublicProxyInviteSchema = ProxyInviteSchema.omit({ tokenHash: true });

export const CreateProxyInviteInputSchema = z.object({
  targetNodeId: IdSchema,
  expiresInSeconds: z.number().int().min(60).max(3600).default(600),
}).strict();

export const CreateProxyInviteResultSchema = z.object({
  invite: PublicProxyInviteSchema,
  token: z.string().trim().min(24).max(512),
  proxyOrigin: ControlPlaneProxyOriginSchema,
  protocolVersion: ControlPlaneProxyProtocolVersionSchema,
}).strict();

export const ProxyBindingStatusSchema = z.enum(["active", "revoked"]);

export const ProxyBindingSchema = z.object({
  id: IdSchema,
  claimId: IdSchema,
  sourceControlPlaneId: IdSchema,
  targetNodeId: IdSchema,
  bindingKeyId: IdSchema,
  credentialHash: z.string().trim().min(32).max(256),
  status: ProxyBindingStatusSchema,
  revision: z.number().int().positive(),
  lastError: ControlPlaneProxyErrorSchema.optional(),
  revokedAt: TimestampSchema.optional(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
}).strict();

export const PublicProxyBindingSchema = ProxyBindingSchema.omit({ credentialHash: true });

export const ClaimProxyInviteInputSchema = z.object({
  protocolVersion: ControlPlaneProxyProtocolVersionSchema,
  inviteToken: z.string().trim().min(24).max(512).optional(),
  claimId: IdSchema,
  sourceControlPlaneId: IdSchema,
  targetNodeId: IdSchema.optional(),
  bindingKeyId: IdSchema,
  credential: CredentialSchema,
}).strict();

export const ProxyBindingAuthenticationSchema = z.object({
  sourceControlPlaneId: IdSchema,
  bindingKeyId: IdSchema,
  credential: CredentialSchema,
}).strict();

export const ProxyTargetStateSchema = z.object({
  id: IdSchema,
  name: z.string().trim().min(1).max(160),
  status: z.enum(["unknown", "online", "offline", "degraded"]),
  health: z.enum(["unknown", "ok", "degraded", "failed"]),
  lastSeenAt: TimestampSchema.optional(),
  capabilities: z.record(z.string(), z.unknown()).default({}),
}).strict();

export const ProxyTargetSnapshotSchema = z.object({
  protocolVersion: ControlPlaneProxyProtocolVersionSchema,
  binding: PublicProxyBindingSchema,
  streamId: IdSchema,
  revision: z.number().int().nonnegative(),
  observedAt: TimestampSchema,
  target: ProxyTargetStateSchema,
}).strict();

export const ProxyTargetEventSchema = z.object({
  type: z.literal("control-plane-proxy.event"),
  protocolVersion: ControlPlaneProxyProtocolVersionSchema,
  streamId: IdSchema,
  bindingId: IdSchema,
  sourceControlPlaneId: IdSchema,
  targetNodeId: IdSchema,
  revision: z.number().int().positive(),
  source: z.object({
    id: z.string().trim().min(1).max(512),
    seq: z.number().int().nonnegative(),
  }).strict(),
  target: ProxyTargetStateSchema,
  event: z.object({
    type: z.string().trim().min(1).max(240),
    topic: z.string().trim().min(1).max(240),
    createdAt: TimestampSchema,
  }).strict(),
}).strict();

export const ProxyEventsReadySchema = z.object({
  type: z.literal("control-plane-proxy.events.ready"),
  protocolVersion: ControlPlaneProxyProtocolVersionSchema,
  streamId: IdSchema,
  bindingId: IdSchema,
  sourceControlPlaneId: IdSchema,
  targetNodeId: IdSchema,
  latestRevision: z.number().int().nonnegative(),
  earliestRetainedRevision: z.number().int().nonnegative(),
}).strict();

export const ProxySnapshotRequiredSchema = z.object({
  type: z.literal("control-plane-proxy.snapshot-required"),
  protocolVersion: ControlPlaneProxyProtocolVersionSchema,
  streamId: IdSchema,
  bindingId: IdSchema,
  sourceControlPlaneId: IdSchema,
  targetNodeId: IdSchema,
  sinceRevision: z.number().int().nonnegative(),
  latestRevision: z.number().int().nonnegative(),
  earliestRetainedRevision: z.number().int().nonnegative(),
  error: ControlPlaneProxyErrorSchema,
}).strict();

export const ProxyEventStreamMessageSchema = z.discriminatedUnion("type", [
  ProxyTargetEventSchema,
  ProxyEventsReadySchema,
  ProxySnapshotRequiredSchema,
]);

export const ClaimProxyInviteResultSchema = z.object({
  protocolVersion: ControlPlaneProxyProtocolVersionSchema,
  binding: PublicProxyBindingSchema,
  target: ProxyTargetSnapshotSchema.shape.target,
}).strict();

export const PendingProxyClaimSchema = z.object({
  id: IdSchema,
  claimId: IdSchema,
  proxyOrigin: ControlPlaneProxyOriginSchema,
  requestedName: z.string().trim().min(1).max(160).optional(),
  sourceControlPlaneId: IdSchema,
  targetNodeId: IdSchema.optional(),
  bindingKeyId: IdSchema,
  credential: CredentialSchema,
  status: z.enum(["pending", "compensation-required"]),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
  expiresAt: TimestampSchema,
}).strict();

export const PublicPendingProxyClaimSchema = PendingProxyClaimSchema.omit({ credential: true });

export const ProxyNodeCredentialSchema = z.object({
  id: IdSchema,
  nodeId: IdSchema,
  proxyOrigin: ControlPlaneProxyOriginSchema,
  proxyBindingId: IdSchema,
  targetNodeId: IdSchema,
  sourceControlPlaneId: IdSchema,
  bindingKeyId: IdSchema,
  credential: CredentialSchema,
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
}).strict();

export type ProxyInvite = z.infer<typeof ProxyInviteSchema>;
export type PublicProxyInvite = z.infer<typeof PublicProxyInviteSchema>;
export type ProxyBinding = z.infer<typeof ProxyBindingSchema>;
export type PublicProxyBinding = z.infer<typeof PublicProxyBindingSchema>;
export type ClaimProxyInviteInput = z.infer<typeof ClaimProxyInviteInputSchema>;
export type ProxyTargetSnapshot = z.infer<typeof ProxyTargetSnapshotSchema>;
export type ProxyTargetEvent = z.infer<typeof ProxyTargetEventSchema>;
export type ControlPlaneProxyError = z.infer<typeof ControlPlaneProxyErrorSchema>;
export type ProxyEventStreamMessage = z.infer<typeof ProxyEventStreamMessageSchema>;
export type PendingProxyClaim = z.infer<typeof PendingProxyClaimSchema>;
export type PublicPendingProxyClaim = z.infer<typeof PublicPendingProxyClaimSchema>;
export type ProxyNodeCredential = z.infer<typeof ProxyNodeCredentialSchema>;
