import { createHash } from "node:crypto";
import { z } from "zod";
import type { ApprovalOperation, ApprovalRequest } from "@task-handoff/protocol/operation-approvals";
import { createId } from "../../shared/persistence/store.ts";
import type { ControlPlaneEventBus } from "../events/bus.ts";

export type ApprovalStatus = "pending" | "approved" | "denied";

export const OperationApprovalPolicySchema = z.object({
  "instance.delete": z.boolean().default(true),
  "node.remove": z.boolean().default(true),
  "node.update.apply": z.boolean().default(true),
  "node.external-listener.set": z.boolean().default(false),
  "user.access.set": z.boolean().default(true),
  "user.role.update": z.boolean().default(true),
  "user.role.remove": z.boolean().default(true),
  "identity-provider.update": z.boolean().default(true),
  "identity-provider.remove": z.boolean().default(true),
  "git-credential.assign": z.boolean().default(true),
}).strict();
export type OperationApprovalPolicy = z.input<typeof OperationApprovalPolicySchema>;

type PendingApproval = {
  id: string;
  userId: string;
  sessionId: string;
  operation: ApprovalOperation;
  targetId: string;
  details?: ApprovalRequest["details"];
  digest: string;
  status: ApprovalStatus;
  createdAt: string;
  expiresAt: string;
};

export type ApprovalSummary = Pick<PendingApproval, "id" | "operation" | "targetId" | "details" | "createdAt" | "expiresAt">;

const LIFETIME_MS = 5 * 60_000;

function approvalError(code: string, message: string, statusCode = 409) {
  return Object.assign(new Error(message), { code, statusCode });
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function digest(operation: ApprovalOperation, targetId: string, input: unknown) {
  return createHash("sha256").update(canonical({ operation, targetId, input })).digest("hex");
}

function summary(entry: PendingApproval): ApprovalSummary {
  return { id: entry.id, operation: entry.operation, targetId: entry.targetId, ...(entry.details ? { details: entry.details } : {}), createdAt: entry.createdAt, expiresAt: entry.expiresAt };
}

export class OperationApprovals {
  private readonly entries = new Map<string, PendingApproval>();
  private readonly revisions = new Map<string, number>();
  private readonly timer: ReturnType<typeof setInterval>;
  private readonly events: ControlPlaneEventBus;
  private readonly policy: z.output<typeof OperationApprovalPolicySchema>;

  constructor(events: ControlPlaneEventBus, policy: unknown = {}) {
    this.events = events;
    this.policy = OperationApprovalPolicySchema.parse(policy);
    this.timer = setInterval(() => this.sweep(), 10_000);
    this.timer.unref?.();
  }

  close() { clearInterval(this.timer); }

  requiresApproval(operation: ApprovalOperation) { return this.policy[operation]; }

  private publish(entry: PendingApproval, status: ApprovalStatus | "expired" | "consumed" | "cancelled") {
    const revision = (this.revisions.get(entry.userId) ?? 0) + 1;
    this.revisions.set(entry.userId, revision);
    this.events.publish("operation-approval.changed", { request: summary(entry), status, revision }, {
      topic: "operation.approvals", audienceWebUserId: entry.userId,
    });
  }

  private sweep() {
    const now = Date.now();
    for (const [id, entry] of this.entries) {
      if (Date.parse(entry.expiresAt) > now) continue;
      this.entries.delete(id);
      this.publish(entry, "expired");
    }
  }

  snapshot(userId: string) {
    this.sweep();
    return {
      revision: this.revisions.get(userId) ?? 0,
      requests: [...this.entries.values()].filter((entry) => entry.userId === userId && entry.status === "pending").map(summary),
    };
  }

  gate(owner: { userId: string; sessionId: string }, operation: ApprovalOperation, targetId: string, input: unknown, approvalId?: string, details?: ApprovalRequest["details"]) {
    this.sweep();
    const requestDigest = digest(operation, targetId, input);
    if (approvalId) {
      const entry = this.entries.get(approvalId);
      if (!entry || entry.userId !== owner.userId || entry.sessionId !== owner.sessionId || entry.digest !== requestDigest || entry.status !== "approved") {
        throw approvalError("OPERATION_APPROVAL_INVALID", "The approval is missing, expired, or does not match this operation.");
      }
      this.entries.delete(entry.id);
      this.publish(entry, "consumed");
      return { kind: "approved" as const };
    }
    const existing = [...this.entries.values()].find((entry) => entry.userId === owner.userId && entry.sessionId === owner.sessionId && entry.digest === requestDigest);
    if (existing) return { kind: "pending" as const, id: existing.id, status: existing.status, expiresAt: existing.expiresAt };
    if (this.entries.size >= 500 || [...this.entries.values()].filter((entry) => entry.userId === owner.userId).length >= 20) {
      throw approvalError("OPERATION_APPROVAL_LIMIT", "Too many pending approvals.", 429);
    }
    const createdAt = new Date();
    const entry: PendingApproval = {
      id: createId("approval"), userId: owner.userId, sessionId: owner.sessionId,
      operation, targetId, digest: requestDigest, status: "pending",
      ...(details ? { details } : {}),
      createdAt: createdAt.toISOString(), expiresAt: new Date(createdAt.getTime() + LIFETIME_MS).toISOString(),
    };
    this.entries.set(entry.id, entry);
    this.publish(entry, "pending");
    return { kind: "pending" as const, id: entry.id, status: entry.status, expiresAt: entry.expiresAt };
  }

  status(owner: { userId: string; sessionId: string }, id: string) {
    this.sweep();
    const entry = this.entries.get(id);
    if (!entry || entry.userId !== owner.userId || entry.sessionId !== owner.sessionId) {
      throw approvalError("OPERATION_APPROVAL_NOT_FOUND", "Approval request not found.", 404);
    }
    return { id: entry.id, status: entry.status, expiresAt: entry.expiresAt };
  }

  decide(userId: string, id: string, decision: "approve" | "deny") {
    this.sweep();
    const entry = this.entries.get(id);
    if (!entry || entry.userId !== userId || entry.status !== "pending") {
      throw approvalError("OPERATION_APPROVAL_NOT_FOUND", "Pending approval request not found.", 404);
    }
    entry.status = decision === "approve" ? "approved" : "denied";
    this.publish(entry, entry.status);
    return { id: entry.id, status: entry.status };
  }

  cancel(owner: { userId: string; sessionId: string }, id: string) {
    const entry = this.entries.get(id);
    if (!entry || entry.userId !== owner.userId || entry.sessionId !== owner.sessionId) return false;
    this.entries.delete(id);
    this.publish(entry, "cancelled");
    return true;
  }
}
