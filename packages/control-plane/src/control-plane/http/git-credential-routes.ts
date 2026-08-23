import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ControlPlaneService } from "../application/service.ts";
import { assertCan } from "../auth/authorization.ts";
import { controlPlaneRequestActor } from "./request-actor.ts";

const IdParamsSchema = z.object({ id: z.string().trim().min(1).max(120) }).strict();
const AssignmentParamsSchema = z.object({ id: z.string().trim().min(1).max(120), credentialId: z.string().trim().min(1).max(120) }).strict();

function requireSecretManager(request: Parameters<typeof controlPlaneRequestActor>[0]) {
  const actor = controlPlaneRequestActor(request);
  if (!actor) throw Object.assign(new Error("Authentication is required."), { code: "CONTROL_PLANE_AUTH_REQUIRED", statusCode: 401 });
  assertCan(actor, "manage-secrets", { type: "secret" });
}

export function registerControlPlaneGitCredentialRoutes(app: FastifyInstance, service: ControlPlaneService) {
  app.get("/api/git-credentials", async () => ({ data: { items: service.gitCredentials.list() } }));
  app.post("/api/git-credentials", async (request, reply) => {
    const credential = service.gitCredentials.create(request.body);
    return reply.code(201).send({ data: credential });
  });
  app.get("/api/git-credentials/:id", async (request) => {
    const id = IdParamsSchema.parse(request.params).id;
    const credential = service.gitCredentials.get(id);
    if (!credential) throw Object.assign(new Error(`Git credential ${id} was not found.`), { code: "GIT_CREDENTIAL_NOT_FOUND", statusCode: 404 });
    return { data: credential };
  });
  app.patch("/api/git-credentials/:id", async (request) => ({
    data: await service.updateGitCredential(IdParamsSchema.parse(request.params).id, request.body),
  }));
  app.delete("/api/git-credentials/:id", async (request) => ({
    data: { deleted: service.gitCredentials.remove(IdParamsSchema.parse(request.params).id) },
  }));

  app.get("/api/controlled-instances/:id/git-credential-assignments", async (request) => {
    requireSecretManager(request);
    const instanceId = IdParamsSchema.parse(request.params).id;
    await service.requireControlledInstance(instanceId, true);
    return { data: service.listInstanceGitCredentialAssignments(instanceId) };
  });

  app.post("/api/controlled-instances/:id/git-credential-assignments", async (request, reply) => {
    requireSecretManager(request);
    const instanceId = IdParamsSchema.parse(request.params).id;
    const input = z.object({ credentialId: z.string().trim().min(1).max(120) }).strict().parse(request.body);
    return reply.code(201).send({ data: await service.authorizeInstanceGitCredential(instanceId, input.credentialId) });
  });

  app.delete("/api/controlled-instances/:id/git-credential-assignments/:credentialId", async (request) => {
    requireSecretManager(request);
    const params = AssignmentParamsSchema.parse(request.params);
    return { data: { revoked: await service.revokeInstanceGitCredential(params.id, params.credentialId) } };
  });
}
