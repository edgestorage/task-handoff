import { z } from "zod";

export const StoredNodeAgentIdSchema = z.string().trim().min(1).max(160);
export const StoredNodeAgentDateTimeSchema = z.string().datetime();
const StoredSecretSchema = z.string().min(1).max(4096);
const StoredUrlSchema = z.string().trim().url().max(2048);

export const StoredNodeAgentPairingInviteSchema = z.object({
  tokenHash: z.string().trim().min(1).max(256),
  expiresAt: StoredNodeAgentDateTimeSchema,
  createdAt: StoredNodeAgentDateTimeSchema,
  controlPlaneName: z.string().trim().min(1).max(160).optional(),
  controlPlaneUrl: StoredUrlSchema.optional(),
}).strip();

export const StoredNodeAgentRemoteControlPlaneSchema = z.object({
  id: StoredNodeAgentIdSchema,
  keyId: StoredNodeAgentIdSchema,
  name: z.string().trim().min(1).max(160).optional(),
  url: StoredUrlSchema.optional(),
  secret: StoredSecretSchema,
  pairedAt: StoredNodeAgentDateTimeSchema,
  updatedAt: StoredNodeAgentDateTimeSchema,
  active: z.boolean().default(true),
}).strip();

export const NodeAgentPairingInviteSchema = z
  .object({
    controlPlaneName: z.string().trim().min(1).max(160).optional(),
    controlPlaneUrl: z.string().trim().max(2048).optional(),
    expiresInMs: z.number().int().positive().max(60 * 60 * 1000).optional(),
  })
  .strict();

export const NodeAgentPairingCompleteSchema = z
  .object({
    joinToken: z.string().trim().min(1).max(4096),
    controlPlaneId: z.string().trim().min(1).max(160).optional(),
    controlPlaneName: z.string().trim().min(1).max(160).optional(),
    controlPlaneUrl: z.string().trim().max(2048).optional(),
  })
  .strict();

export const NodeAgentRemoteConnectSchema = z
  .object({
    controlPlaneUrl: z.string().trim().url().max(2048),
    joinToken: z.string().trim().min(1).max(4096),
    controlPlaneName: z.string().trim().min(1).max(160).optional(),
    activate: z.boolean().optional(),
  })
  .strict();
