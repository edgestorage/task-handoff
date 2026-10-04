import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { ApprovalOperation, ApprovalRequest } from "@task-handoff/protocol/operation-approvals";
import type { ControlPlaneAuth } from "../auth/service.ts";
import { controlPlaneRequestActor } from "./request-actor.ts";
import { OperationApprovals } from "../approvals/operation-approvals.ts";
import { createId } from "../../shared/persistence/store.ts";

const IdSchema = z.object({ id: z.string().min(1) }).strict();
const DecisionSchema = z.object({ decision: z.enum(["approve", "deny"]) }).strict();

function forbidden(message: string, statusCode = 403) {
  return Object.assign(new Error(message), { code: "OPERATION_APPROVAL_FORBIDDEN", statusCode });
}

function cliToken(request: FastifyRequest) {
  return /^Bearer ([^\s]+)$/.exec(request.headers.authorization || "")?.[1];
}

async function cliOwner(request: FastifyRequest, auth: ControlPlaneAuth) {
  const token = cliToken(request);
  if (!token) throw forbidden("A CLI session is required.", 401);
  const actor = auth.enabled()
    ? await auth.authorizationForSessionToken(token, ["cli"])
    : await auth.disabledModeAuthorization(token, ["cli"]);
  if (!actor || actor.type !== "user") throw forbidden("A CLI session is required.", 401);
  if (!auth.enabled()) throw forbidden("Web sign-in is required to approve CLI operations.");
  return { userId: actor.userId, sessionId: token.split(".")[0] };
}

function webOwner(request: FastifyRequest, auth: ControlPlaneAuth) {
  const actor = controlPlaneRequestActor(request);
  if (!auth.enabled() || cliToken(request) || actor?.type !== "user") throw forbidden("A signed-in Web session is required.");
  return actor.userId;
}

async function gateOperation(
  request: FastifyRequest,
  auth: ControlPlaneAuth,
  approvals: OperationApprovals,
  operation: ApprovalOperation,
  targetId: string,
  input: unknown,
  details?: ApprovalRequest["details"],
) {
  const token = cliToken(request);
  if (!auth.enabled() && request.headers.authorization !== undefined) throw forbidden("Web sign-in is required to approve CLI operations.");
  if (!token) return undefined;
  const cliActor = auth.enabled()
    ? await auth.authorizationForSessionToken(token, ["cli"])
    : await auth.disabledModeAuthorization(token, ["cli"]);
  if (!cliActor) return undefined;
  if (!approvals.requiresApproval(operation)) {
    if (request.headers["x-task-handoff-approval-id"] !== undefined) throw forbidden("This operation does not require an approval.", 400);
    return undefined;
  }
  const owner = await cliOwner(request, auth);
  const approvalId = request.headers["x-task-handoff-approval-id"];
  if (approvalId !== undefined && (typeof approvalId !== "string" || !approvalId)) throw forbidden("Invalid approval identifier.", 400);
  return approvals.gate(owner, operation, targetId, input, typeof approvalId === "string" ? approvalId : undefined, details);
}

export async function executeApprovedOperation<T>(
  request: FastifyRequest,
  reply: FastifyReply,
  auth: ControlPlaneAuth,
  approvals: OperationApprovals,
  operation: ApprovalOperation,
  targetId: string,
  input: unknown,
  details: ApprovalRequest["details"],
  execute: () => Promise<T>,
  successStatus = 200,
) {
  const approval = await gateOperation(request, auth, approvals, operation, targetId, input, details);
  if (approval?.kind === "pending") {
    return reply.code(202).send({ data: { kind: "operation-approval", id: approval.id, status: approval.status, expiresAt: approval.expiresAt } });
  }
  const approvalId = approval?.kind === "approved" ? request.headers["x-task-handoff-approval-id"] : undefined;
  try {
    const result = await execute();
    if (typeof approvalId === "string") {
      const actor = controlPlaneRequestActor(request);
      if (actor?.type === "user") await auditOperationApproval(auth, request.server, {
        action: "operation-approval.execute", userId: actor.userId, approvalId, operation,
        result: result && typeof result === "object" && (("deleted" in result && result.deleted === false) || ("completed" in result && result.completed === false)) ? "incomplete" : "completed",
      });
    }
    return reply.code(successStatus).send({ data: result });
  } catch (error) {
    const actor = controlPlaneRequestActor(request);
    if (typeof approvalId === "string" && actor?.type === "user") await auditOperationApproval(auth, request.server, { action: "operation-approval.execute", userId: actor.userId, approvalId, operation, result: "unknown" });
    throw error;
  }
}

export function registerOperationApprovalRoutes(app: FastifyInstance, auth: ControlPlaneAuth, approvals: OperationApprovals, decisionGuard: (request: FastifyRequest) => Promise<void>) {
  app.get("/api/operation-approvals/support", async (request) => {
    await cliOwner(request, auth);
    return { data: { supported: true } };
  });
  app.get("/api/operation-approvals/:id/status", async (request) => ({
    data: approvals.status(await cliOwner(request, auth), IdSchema.parse(request.params).id),
  }));
  app.delete("/api/operation-approvals/:id", async (request) => ({
    data: { cancelled: approvals.cancel(await cliOwner(request, auth), IdSchema.parse(request.params).id) },
  }));
  app.get("/api/operation-approvals", async (request) => ({
    data: approvals.snapshot(webOwner(request, auth)),
  }));
  app.post("/api/operation-approvals/:id/decision", { preHandler: decisionGuard }, async (request) => {
    const userId = webOwner(request, auth);
    const decision = DecisionSchema.parse(request.body).decision;
    const result = approvals.decide(userId, IdSchema.parse(request.params).id, decision);
    await auditOperationApproval(auth, app, { action: `operation-approval.${decision}`, userId, approvalId: result.id });
    return { data: result };
  });
}

export async function auditOperationApproval(
  auth: ControlPlaneAuth,
  app: FastifyInstance,
  input: { action: string; userId: string; approvalId: string; operation?: ApprovalOperation; result?: "completed" | "incomplete" | "unknown" },
) {
  try {
    await auth.users.store.audit.put({
      id: createId("uaudit"), action: input.action, actorUserId: input.userId,
      targetType: "operation-approval", targetId: input.approvalId,
      details: { ...(input.operation ? { operation: input.operation } : {}), ...(input.result ? { result: input.result } : {}) },
      createdAt: new Date().toISOString(),
    });
  } catch (error) {
    app.log.warn({ error }, "operation approval audit unavailable");
  }
}
