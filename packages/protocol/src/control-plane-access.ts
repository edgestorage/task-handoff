import { z } from "zod";

export const PUBLIC_CONTROL_PLANE_IDENTITY_VERSION = 1;
// Public Direct-client capability boundary. This is intentionally independent
// from the node-agent / controlled-instance connection protocol version.
export const CONTROL_PLANE_ACCESS_PROTOCOL_VERSION = "2026-08-09";

export const ControlPlanePublicCapabilitiesSchema = z.object({
  authentication: z.enum(["required", "disabled"]),
  aiSessions: z.boolean(),
  nodes: z.boolean(),
  instanceBoard: z.boolean(),
  // Added after the original mobile access boundary. Its absence means that
  // the remote Control Plane does not advertise trigger support.
  triggers: z.boolean().optional(),
}).strict();

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

export const ControlPlaneAuthenticatedUserSchema = z.object({
  id: z.string().trim().min(1),
  username: z.string().trim().min(1).max(80),
  role: z.enum(["viewer", "operator", "admin"]),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  lastLoginAt: z.string().datetime().optional(),
}).strict();

export const ControlPlaneMobileSessionSchema = z.object({
  id: z.string().trim().min(1),
  expiresAt: z.string().datetime(),
  createdAt: z.string().datetime(),
  lastSeenAt: z.string().datetime().optional(),
  device: ControlPlaneMobileDeviceSchema,
  user: ControlPlaneAuthenticatedUserSchema,
}).strict();

export const ControlPlaneMobileLoginResponseSchema = z.object({
  data: z.object({
    sessionToken: z.string().trim().min(32),
    session: ControlPlaneMobileSessionSchema,
  }).strict(),
}).strict();

export const ControlPlaneMobileSessionsResponseSchema = z.object({
  data: z.array(ControlPlaneMobileSessionSchema),
}).strict();

export const ControlPlaneMobileSessionRevocationResponseSchema = z.object({
  data: z.object({
    revoked: z.boolean(),
  }).strict(),
}).strict();

export type ControlPlanePublicCapabilities = z.infer<typeof ControlPlanePublicCapabilitiesSchema>;
export type ControlPlanePublicIdentityPayload = z.infer<typeof ControlPlanePublicIdentityPayloadSchema>;
export type ControlPlanePublicIdentityDocument = z.infer<typeof ControlPlanePublicIdentityDocumentSchema>;
export type ControlPlaneMobileDevice = z.infer<typeof ControlPlaneMobileDeviceSchema>;
export type ControlPlaneMobileLoginInput = z.infer<typeof ControlPlaneMobileLoginInputSchema>;
export type ControlPlaneAuthenticatedUser = z.infer<typeof ControlPlaneAuthenticatedUserSchema>;
export type ControlPlaneMobileSession = z.infer<typeof ControlPlaneMobileSessionSchema>;
