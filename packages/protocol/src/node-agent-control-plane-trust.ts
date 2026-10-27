import { z } from "zod";
import { NodeAgentControlPlaneAccessContextSchema } from "./node-relay-channel.ts";

const IdSchema = z.string().trim().min(1).max(160);
const FingerprintSchema = z.string().regex(/^sha256:[A-Za-z0-9_-]{43}$/);
const ComparisonCodeSchema = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{4}(?:-[0-9A-HJKMNP-TV-Z]{4}){3}$/);
const TimestampSchema = z.string().datetime();

export const NodeAgentControlPlaneTrustDecisionActionSchema = z.enum(["approve", "reject"]);
export const NodeAgentControlPlaneTrustRequestStatusSchema = z.enum(["pending", "approved", "rejected", "expired"]);
export const NodeAgentControlPlaneTrustPinStatusSchema = z.enum(["active", "revoked"]);
export const NodeAgentControlPlaneTrustActorTypeSchema = z.enum(["local", "control-plane", "system"]);

const TrustSummaryBaseSchema = z.object({
  controlPlaneId: IdSchema,
  fingerprint: FingerprintSchema,
  comparisonCode: ComparisonCodeSchema,
  nodeHandle: IdSchema,
  bindingId: IdSchema,
  bindingRevision: z.number().int().positive(),
  access: NodeAgentControlPlaneAccessContextSchema,
});

export const NodeAgentControlPlaneTrustRequestSchema = z.strictObject({
  ...TrustSummaryBaseSchema.shape,
  requestId: IdSchema,
  status: NodeAgentControlPlaneTrustRequestStatusSchema,
  reason: z.enum(["first-seen", "key-changed", "access-context-changed", "approved", "rejected", "expired"]),
  requestedAt: TimestampSchema,
  lastSeenAt: TimestampSchema,
  expiresAt: TimestampSchema,
  decidedAt: TimestampSchema.optional(),
  decidedByActorType: NodeAgentControlPlaneTrustActorTypeSchema.optional(),
  decidedByActorId: IdSchema.optional(),
  decisionReason: z.string().trim().min(1).max(500).optional(),
  pinId: IdSchema.optional(),
  revision: z.number().int().positive(),
});

export const NodeAgentControlPlaneTrustPinSchema = z.strictObject({
  ...TrustSummaryBaseSchema.shape,
  pinId: IdSchema,
  status: NodeAgentControlPlaneTrustPinStatusSchema,
  approvedAt: TimestampSchema,
  approvedByActorType: NodeAgentControlPlaneTrustActorTypeSchema,
  approvedByActorId: IdSchema,
  lastSeenAt: TimestampSchema,
  revokedAt: TimestampSchema.optional(),
  revokeReason: z.string().trim().min(1).max(500).optional(),
  revision: z.number().int().positive(),
});

/** The node-agent is authoritative; this is a display-safe projection with no public keys or secrets. */
export const NodeAgentControlPlaneTrustSnapshotSchema = z.strictObject({
  nodeId: IdSchema,
  nodeHandle: IdSchema.optional(),
  requests: z.array(NodeAgentControlPlaneTrustRequestSchema),
  pins: z.array(NodeAgentControlPlaneTrustPinSchema),
});

export const NodeAgentControlPlaneTrustDecisionSchema = z.discriminatedUnion("action", [
  z.strictObject({
    action: z.literal("approve"),
    expectedFingerprint: FingerprintSchema,
    expectedRevision: z.number().int().positive(),
    retainPreviousKey: z.boolean().optional(),
    reason: z.string().trim().min(1).max(500).optional(),
  }),
  z.strictObject({
    action: z.literal("reject"),
    expectedFingerprint: FingerprintSchema,
    expectedRevision: z.number().int().positive(),
    reason: z.string().trim().min(1).max(500).optional(),
  }),
]);

export const NodeAgentControlPlaneTrustRevokeSchema = z.strictObject({
  expectedFingerprint: FingerprintSchema,
  expectedRevision: z.number().int().positive(),
  reason: z.string().trim().min(1).max(500).optional(),
});

/** Explicitly reopens a rejected or expired request as a new pending request. */
export const NodeAgentControlPlaneTrustRetrySchema = z.strictObject({});

export type NodeAgentControlPlaneTrustDecisionAction = z.infer<typeof NodeAgentControlPlaneTrustDecisionActionSchema>;
export type NodeAgentControlPlaneTrustRequest = z.infer<typeof NodeAgentControlPlaneTrustRequestSchema>;
export type NodeAgentControlPlaneTrustPin = z.infer<typeof NodeAgentControlPlaneTrustPinSchema>;
export type NodeAgentControlPlaneTrustSnapshot = z.infer<typeof NodeAgentControlPlaneTrustSnapshotSchema>;
export type NodeAgentControlPlaneTrustDecision = z.infer<typeof NodeAgentControlPlaneTrustDecisionSchema>;
export type NodeAgentControlPlaneTrustRevoke = z.infer<typeof NodeAgentControlPlaneTrustRevokeSchema>;
export type NodeAgentControlPlaneTrustRetry = z.infer<typeof NodeAgentControlPlaneTrustRetrySchema>;
