import { z } from "zod";

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
export const ApprovalSnapshotSchema = z.object({ revision: z.number().int(), requests: z.array(ApprovalRequestSchema) });
export const ApprovalChangedEventSchema = z.object({
  request: ApprovalRequestSchema,
  status: z.enum(["pending", "approved", "denied", "expired", "consumed", "cancelled"]),
  revision: z.number().int(),
});

export type ApprovalOperation = z.infer<typeof ApprovalOperationSchema>;
export type ApprovalRequest = z.infer<typeof ApprovalRequestSchema>;
export type ApprovalWait = z.infer<typeof ApprovalWaitSchema>;
export type ApprovalSnapshot = z.infer<typeof ApprovalSnapshotSchema>;
export type ApprovalChangedEvent = z.infer<typeof ApprovalChangedEventSchema>;
