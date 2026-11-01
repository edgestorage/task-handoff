import { z } from "zod";

/** Administrators who may review every pending operation approval. */
export const OPERATION_APPROVAL_PERMISSION = "settings:manage" as const;

export const ApprovalOperationSchema = z.enum([
  "instance.delete", "node.remove", "node.update.apply", "node.external-listener.set",
  "user.access.set", "user.role.update", "user.role.remove",
  "identity-provider.update", "identity-provider.remove", "git-credential.assign",
]);
export const ApprovalDetailSchema = z.object({ field: z.string(), value: z.string() });
export const ApprovalRequestSchema = z.object({
  id: z.string(), operation: ApprovalOperationSchema, targetId: z.string(),
  details: z.array(ApprovalDetailSchema).optional(),
  createdAt: z.string().datetime(), expiresAt: z.string().datetime(),
});
export const ApprovalWaitSchema = z.object({
  id: z.string(), status: z.enum(["pending", "approved", "denied"]), expiresAt: z.string().datetime(),
});
export const ApprovalPendingSchema = ApprovalWaitSchema.extend({ kind: z.literal("operation-approval") });
/** Identifies one in-memory approval register lifetime, so revisions never compare across restarts. */
export const ApprovalGenerationSchema = z.string().min(1).max(160);
export const ApprovalSnapshotSchema = z.object({
  generation: ApprovalGenerationSchema,
  revision: z.number().int(),
  requests: z.array(ApprovalRequestSchema),
});
export const ApprovalChangedEventSchema = z.object({
  request: ApprovalRequestSchema,
  status: z.enum(["pending", "approved", "denied", "expired", "consumed", "cancelled"]),
  generation: ApprovalGenerationSchema,
  revision: z.number().int(),
});

export type ApprovalOperation = z.infer<typeof ApprovalOperationSchema>;
export type ApprovalRequest = z.infer<typeof ApprovalRequestSchema>;
export type ApprovalWait = z.infer<typeof ApprovalWaitSchema>;
export type ApprovalGeneration = z.infer<typeof ApprovalGenerationSchema>;
export type ApprovalSnapshot = z.infer<typeof ApprovalSnapshotSchema>;
export type ApprovalChangedEvent = z.infer<typeof ApprovalChangedEventSchema>;
