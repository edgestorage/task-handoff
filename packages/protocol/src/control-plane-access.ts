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
export const CONTROL_PLANE_ACCESS_PROTOCOL_VERSION = "2026-08-23";

export const ControlPlanePublicCapabilitiesSchema = z.object({
  authentication: z.enum(["required", "disabled"]),
  aiSessions: z.boolean(),
  nodes: z.boolean(),
  instanceBoard: z.boolean(),
  triggers: z.boolean().optional(),
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
  "CONTROL_PLANE_USER_DISABLED",
  "CONTROL_PLANE_AUTHORIZATION_REVISION_CONFLICT",
  "CONTROL_PLANE_LAST_ACTIVE_ADMIN",
  "CONTROL_PLANE_USERNAME_CONFLICT",
  "CONTROL_PLANE_EXTERNAL_IDENTITY_CONFLICT",
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

export type ControlPlanePublicCapabilities = z.infer<typeof ControlPlanePublicCapabilitiesSchema>;
export type ControlPlanePublicIdentityPayload = z.infer<typeof ControlPlanePublicIdentityPayloadSchema>;
export type ControlPlanePublicIdentityDocument = z.infer<typeof ControlPlanePublicIdentityDocumentSchema>;
export type ControlPlaneMobileDevice = z.infer<typeof ControlPlaneMobileDeviceSchema>;
export type ControlPlaneMobileLoginInput = z.infer<typeof ControlPlaneMobileLoginInputSchema>;
export type ControlPlaneAuthenticatedUser = z.infer<typeof ControlPlaneAuthenticatedUserSchema>;
export type ControlPlaneMobileSession = z.infer<typeof ControlPlaneMobileSessionSchema>;
