import { z } from "zod";
import { safeParseResponse } from "./response-validation.ts";
import {
  ControlPlaneAccessManagementCapabilitySchema,
  ControlPlaneCurrentAuthorizationSchema,
  ControlPlaneUserSessionSummarySchema,
  ControlPlaneUserSummarySchema,
} from "./control-plane-users.ts";
export * from "./control-plane-users.ts";

export const PUBLIC_CONTROL_PLANE_IDENTITY_VERSION = 1;
// 2026-10-01 起身份文档 capabilities 增加 cliSessions；兼容基线为当前版本，旧客户端需同步升级。
export const CONTROL_PLANE_ACCESS_PROTOCOL_VERSION = "2026-10-01";

export const ControlPlanePublicCapabilitiesSchema = z.object({
  authentication: z.enum(["required", "disabled"]),
  aiSessions: z.boolean(),
  nodes: z.boolean(),
  instanceBoard: z.boolean(),
  triggers: z.boolean().optional(),
  stories: z.boolean().optional(),
  cliSessions: z.boolean().optional(),
  localCliSessions: z.boolean().optional(),
  accessManagement: ControlPlaneAccessManagementCapabilitySchema.optional(),
}).strict();

export function normalizeControlPlanePublicCapabilities(capabilities: unknown) {
  const parsed = safeParseResponse(ControlPlanePublicCapabilitiesSchema, capabilities);
  return parsed.success ? parsed.data : undefined;
}

export function controlPlaneAccessManagementCapabilities(capabilities: unknown) {
  return normalizeControlPlanePublicCapabilities(capabilities)?.accessManagement;
}

export function supportsControlPlaneUserManagement(capabilities: unknown) {
  return controlPlaneAccessManagementCapabilities(capabilities)?.userManagement.users === true;
}

export function supportsControlPlaneExternalIdentityLogin(capabilities: unknown) {
  return controlPlaneAccessManagementCapabilities(capabilities)?.authentication.externalIdentity !== undefined;
}

export function supportsControlPlaneCustomRoles(capabilities: unknown) {
  return controlPlaneAccessManagementCapabilities(capabilities)?.authorization.customRoles === true;
}

export function supportsControlPlaneCliSessions(capabilities: unknown) {
  return normalizeControlPlanePublicCapabilities(capabilities)?.cliSessions === true;
}

/**
 * 本地信任会话只在 authentication disabled 且客户端位于同一台机器时可用；
 * 该能力与 `cliSessions` 相互独立，缺失一律归一为不支持。
 */
export function supportsControlPlaneLocalCliSessions(capabilities: unknown) {
  return normalizeControlPlanePublicCapabilities(capabilities)?.localCliSessions === true;
}

export const ControlPlanePublicIdentityPayloadSchema = z.object({
  version: z.literal(PUBLIC_CONTROL_PLANE_IDENTITY_VERSION),
  kind: z.literal("control-plane"),
  controlPlaneId: z.string().trim().min(1).max(160),
  publicKey: z.object({
    algorithm: z.literal("Ed25519"),
    encoding: z.literal("base64url"),
    value: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    fingerprint: z.string().regex(/^sha256:[A-Za-z0-9_-]{43}$/),
  }).strict(),
  capabilities: ControlPlanePublicCapabilitiesSchema,
  protocolVersion: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  issuedAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
}).strict();

export const ControlPlanePublicIdentityDocumentSchema = z.object({
  data: z.object({
    payload: ControlPlanePublicIdentityPayloadSchema,
    signature: z.string().regex(/^[A-Za-z0-9_-]{86}$/),
  }).strict(),
}).strict();

export function controlPlaneIdentitySigningInput(input: unknown) {
  return JSON.stringify(ControlPlanePublicIdentityPayloadSchema.parse(input));
}

export const ControlPlaneMobileDeviceSchema = z.object({
  id: z.string().trim().min(8).max(160),
  name: z.string().trim().min(1).max(160),
  platform: z.enum(["ios", "android"]),
  appVersion: z.string().trim().min(1).max(80).optional(),
}).strict();

export const ControlPlaneMobileLoginInputSchema = z.object({
  username: z.string().trim().min(1).max(80),
  password: z.string().min(1).max(4096),
  device: ControlPlaneMobileDeviceSchema,
}).strict();

export const ControlPlaneAuthenticatedUserSchema = ControlPlaneUserSummarySchema;

export const ControlPlaneMobileSessionSchema = ControlPlaneUserSessionSummarySchema.extend({
  device: ControlPlaneMobileDeviceSchema,
  user: ControlPlaneUserSummarySchema,
}).strict();

export const ControlPlaneAccessErrorCodeSchema = z.enum([
  "CONTROL_PLANE_FORBIDDEN",
  "CONTROL_PLANE_AUTH_REQUIRED",
  "AUTH_PASSWORD_CHANGE_REQUIRED",
  "CONTROL_PLANE_USER_DISABLED",
  "CONTROL_PLANE_AUTHORIZATION_REVISION_CONFLICT",
  "CONTROL_PLANE_LAST_ACTIVE_ADMIN",
  "CONTROL_PLANE_USERNAME_CONFLICT",
  "CONTROL_PLANE_EXTERNAL_IDENTITY_CONFLICT",
  "CONTROL_PLANE_IDENTITY_PROVIDER_NAMESPACE_IMMUTABLE",
  "CONTROL_PLANE_IDENTITY_PROVIDER_UNAVAILABLE",
  "USER_STORE_REINITIALIZATION_REQUIRED",
]);

export const ControlPlaneMobileLoginResponseSchema = z.object({
  data: z.object({
    sessionToken: z.string().trim().min(32),
    session: ControlPlaneMobileSessionSchema,
    authorization: ControlPlaneCurrentAuthorizationSchema,
  }).strict(),
}).strict();

export const ControlPlaneMobileSessionsResponseSchema = z.object({ data: z.array(ControlPlaneMobileSessionSchema) }).strict();
export const ControlPlaneMobileSessionRevocationResponseSchema = z.object({ data: z.object({ revoked: z.boolean() }).strict() }).strict();
export const ControlPlaneMobileSessionRenewalResponseSchema = z.object({
  data: z.object({ expiresAt: z.string().datetime() }).strict(),
}).strict();

// CLI 授权：CLI 不接触密码，也不持有 Web 会话凭证；由已登录的 Web 会话批准授权请求，
// CLI 再用一次性 code（或 device code）兑换属于自己的 CLI 会话 token。

export const ControlPlaneCliClientSchema = z.object({
  name: z.string().trim().min(1).max(160),
  platform: z.enum(["darwin", "linux", "win32"]),
  version: z.string().trim().min(1).max(80).optional(),
}).strict();

export const ControlPlaneCliAuthorizationRequestIdSchema = z.string().trim().min(1).max(200);
export const ControlPlaneCliStateSchema = z.string().trim().regex(/^[A-Za-z0-9\-._~]{16,200}$/);
export const ControlPlaneCliCodeChallengeSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
export const ControlPlaneCliCodeVerifierSchema = z.string().regex(/^[A-Za-z0-9\-._~]{43,128}$/);

/** 回跳地址只允许 loopback 回调路径，授权 code 只能交回本机监听端口。 */
export function parseControlPlaneCliLoopbackRedirectUri(value: unknown) {
  if (typeof value !== "string" || value.length < 1 || value.length > 2_048) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== "http:" || parsed.username || parsed.password) return undefined;
  if (parsed.hostname !== "127.0.0.1" && parsed.hostname !== "[::1]") return undefined;
  if (parsed.pathname !== "/callback" || parsed.search || parsed.hash) return undefined;
  const port = Number(parsed.port);
  return Number.isInteger(port) && port >= 1 && port <= 65_535 ? parsed : undefined;
}

export const ControlPlaneCliLoopbackRedirectUriSchema = z
  .string()
  .trim()
  .min(1)
  .max(2_048)
  .refine((value) => parseControlPlaneCliLoopbackRedirectUri(value) !== undefined, "CLI redirect URIs must target an http loopback /callback address.");

export const ControlPlaneCliBrowserAuthorizationRequestSchema = z.object({
  mode: z.literal("browser"),
  client: ControlPlaneCliClientSchema,
  redirectUri: ControlPlaneCliLoopbackRedirectUriSchema,
  state: ControlPlaneCliStateSchema,
  codeChallenge: ControlPlaneCliCodeChallengeSchema,
  codeChallengeMethod: z.literal("S256"),
}).strict();

export const ControlPlaneCliDeviceAuthorizationRequestSchema = z.object({
  mode: z.literal("device"),
  client: ControlPlaneCliClientSchema,
}).strict();

export const ControlPlaneCliAuthorizationRequestSchema = z.discriminatedUnion("mode", [
  ControlPlaneCliBrowserAuthorizationRequestSchema,
  ControlPlaneCliDeviceAuthorizationRequestSchema,
]);

export const ControlPlaneCliAuthorizationSchema = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("browser"),
    requestId: ControlPlaneCliAuthorizationRequestIdSchema,
    verificationUri: z.string().trim().url().max(2_048),
    expiresAt: z.string().datetime(),
  }).strict(),
  z.object({
    mode: z.literal("device"),
    requestId: ControlPlaneCliAuthorizationRequestIdSchema,
    verificationUri: z.string().trim().url().max(2_048),
    verificationUriComplete: z.string().trim().url().max(2_048),
    userCode: z.string().trim().min(1).max(40),
    intervalSeconds: z.number().int().min(1).max(300),
    expiresAt: z.string().datetime(),
  }).strict(),
]);

export const ControlPlaneCliAuthorizeResponseSchema = z.object({ data: ControlPlaneCliAuthorizationSchema }).strict();

export const ControlPlaneCliAuthorizationStatusSchema = z.enum(["pending", "approved", "denied", "consumed", "expired"]);

export const ControlPlaneCliAuthorizationRequestDetailSchema = z.object({
  requestId: ControlPlaneCliAuthorizationRequestIdSchema,
  mode: z.enum(["browser", "device"]),
  status: ControlPlaneCliAuthorizationStatusSchema,
  client: ControlPlaneCliClientSchema,
  createdAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
  redirectUri: ControlPlaneCliLoopbackRedirectUriSchema.optional(),
  userCode: z.string().trim().min(1).max(40).optional(),
  decidedAt: z.string().datetime().optional(),
}).strict();

export const ControlPlaneCliAuthorizationRequestDetailResponseSchema = z.object({
  data: ControlPlaneCliAuthorizationRequestDetailSchema,
}).strict();

export const ControlPlaneCliAuthorizationApprovalResponseSchema = z.object({
  data: z.object({
    mode: z.enum(["browser", "device"]),
    redirectUri: z.string().trim().url().max(2_048).optional(),
  }).strict(),
}).strict();

export const ControlPlaneCliAuthorizationDenialResponseSchema = z.object({
  data: z.object({ ok: z.boolean() }).strict(),
}).strict();

export const CONTROL_PLANE_CLI_DEVICE_CODE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";

export const ControlPlaneCliTokenRequestSchema = z.discriminatedUnion("grantType", [
  z.object({
    grantType: z.literal("authorization_code"),
    requestId: ControlPlaneCliAuthorizationRequestIdSchema,
    code: z.string().trim().min(1).max(400),
    codeVerifier: ControlPlaneCliCodeVerifierSchema,
  }).strict(),
  z.object({
    grantType: z.literal(CONTROL_PLANE_CLI_DEVICE_CODE_GRANT_TYPE),
    requestId: ControlPlaneCliAuthorizationRequestIdSchema,
  }).strict(),
]);

export const ControlPlaneCliSessionSchema = ControlPlaneUserSessionSummarySchema.extend({
  clientType: z.literal("cli"),
  client: ControlPlaneCliClientSchema,
  user: ControlPlaneUserSummarySchema,
}).strict();

export const ControlPlaneCliTokenResponseSchema = z.object({
  data: z.object({
    sessionToken: z.string().trim().min(32),
    session: ControlPlaneCliSessionSchema,
    authorization: ControlPlaneCurrentAuthorizationSchema,
  }).strict(),
}).strict();

/**
 * 本地信任会话请求：仅允许 loopback 来源调用，客户端必须声明自己的元数据以便审计。
 */
export const ControlPlaneCliLocalSessionRequestSchema = z.object({
  client: ControlPlaneCliClientSchema,
}).strict();

export const ControlPlaneCliSessionsResponseSchema = z.object({ data: z.array(ControlPlaneCliSessionSchema) }).strict();
export const ControlPlaneCliSessionRevocationResponseSchema = z.object({ data: z.object({ revoked: z.boolean() }).strict() }).strict();
export const ControlPlaneCliSessionRenewalResponseSchema = z.object({
  data: z.object({ expiresAt: z.string().datetime() }).strict(),
}).strict();

export const CONTROL_PLANE_CLI_AUTHORIZATION_ERROR_CODES = [
  "CLI_AUTHORIZATION_REQUEST_UNKNOWN",
  "CLI_AUTHORIZATION_PENDING",
  "CLI_AUTHORIZATION_SLOW_DOWN",
  "CLI_AUTHORIZATION_EXPIRED",
  "CLI_AUTHORIZATION_DENIED",
  "CLI_AUTHORIZATION_ALREADY_USED",
  "CLI_AUTHORIZATION_INVALID_GRANT",
  "CLI_AUTHORIZATION_RATE_LIMITED",
] as const;

export const ControlPlaneCliAuthorizationErrorCodeSchema = z.enum(CONTROL_PLANE_CLI_AUTHORIZATION_ERROR_CODES);

export type ControlPlanePublicCapabilities = z.infer<typeof ControlPlanePublicCapabilitiesSchema>;
export type ControlPlanePublicIdentityPayload = z.infer<typeof ControlPlanePublicIdentityPayloadSchema>;
export type ControlPlanePublicIdentityDocument = z.infer<typeof ControlPlanePublicIdentityDocumentSchema>;
export type ControlPlaneMobileDevice = z.infer<typeof ControlPlaneMobileDeviceSchema>;
export type ControlPlaneMobileLoginInput = z.infer<typeof ControlPlaneMobileLoginInputSchema>;
export type ControlPlaneAuthenticatedUser = z.infer<typeof ControlPlaneAuthenticatedUserSchema>;
export type ControlPlaneMobileSession = z.infer<typeof ControlPlaneMobileSessionSchema>;
export type ControlPlaneCliClient = z.infer<typeof ControlPlaneCliClientSchema>;
export type ControlPlaneCliAuthorizationRequest = z.infer<typeof ControlPlaneCliAuthorizationRequestSchema>;
export type ControlPlaneCliAuthorization = z.infer<typeof ControlPlaneCliAuthorizationSchema>;
export type ControlPlaneCliAuthorizationStatus = z.infer<typeof ControlPlaneCliAuthorizationStatusSchema>;
export type ControlPlaneCliAuthorizationRequestDetail = z.infer<typeof ControlPlaneCliAuthorizationRequestDetailSchema>;
export type ControlPlaneCliTokenRequest = z.infer<typeof ControlPlaneCliTokenRequestSchema>;
export type ControlPlaneCliLocalSessionRequest = z.infer<typeof ControlPlaneCliLocalSessionRequestSchema>;
export type ControlPlaneCliTokenResponse = z.infer<typeof ControlPlaneCliTokenResponseSchema>;
export type ControlPlaneCliSession = z.infer<typeof ControlPlaneCliSessionSchema>;
export type ControlPlaneCliAuthorizationErrorCode = z.infer<typeof ControlPlaneCliAuthorizationErrorCodeSchema>;
