import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ControlPlaneAuth } from "../auth/service.ts";
import { controlPlaneRequestActor } from "./request-actor.ts";
import { PUBLIC_CONTROL_PLANE_ROUTE } from "./auth-boundary.ts";
import { CONTROL_PLANE_SESSION_COOKIE } from "../auth/service.ts";
import { CONTROL_PLANE_PERMISSION_CATALOG } from "@task-handoff/protocol/control-plane-access";

const IdParamsSchema = z.object({ id: z.string().trim().min(1) }).strict();

function userActor(request: Parameters<typeof controlPlaneRequestActor>[0]) {
  const actor = controlPlaneRequestActor(request);
  if (!actor || actor.type !== "user") throw Object.assign(new Error("A Control Plane user is required."), { code: "CONTROL_PLANE_AUTH_REQUIRED", statusCode: 401 });
  return actor;
}

export function registerControlPlaneUserRoutes(app: FastifyInstance, auth: ControlPlaneAuth) {
  app.get("/api/users", async (request) => {
    const query = z.object({ search: z.string().trim().max(160).optional(), includeArchived: z.coerce.boolean().optional() }).strict().parse(request.query);
    return { data: auth.users.list(query) };
  });
  app.post("/api/users", async (request, reply) => reply.code(201).send({ data: await auth.users.createLocalUser(request.body) }));
  app.get("/api/users/:id", async (request) => ({ data: auth.users.detail(IdParamsSchema.parse(request.params).id) }));
  app.patch("/api/users/:id", async (request) => {
    const userId = IdParamsSchema.parse(request.params).id;
    const result = await auth.users.updateUser(userId, request.body);
    auth.notifyAuthorizationChanged(userId);
    return { data: result };
  });
  app.put("/api/users/:id/access", async (request) => {
    const userId = IdParamsSchema.parse(request.params).id;
    const result = await auth.users.setAccess(userId, request.body);
    auth.notifyAuthorizationChanged(userId);
    return { data: result };
  });
  app.post("/api/users/:id/password-reset", async (request) => {
    const input = z.object({ password: z.string().min(8).max(4096), requirePasswordChange: z.boolean().optional() }).strict().parse(request.body);
    const userId = IdParamsSchema.parse(request.params).id;
    const result = await auth.users.resetLocalPassword(userId, input.password, input.requirePasswordChange !== false);
    auth.notifyAuthorizationChanged(userId);
    return { data: result };
  });
  app.get("/api/users/:id/sessions", async (request) => {
    const actor = userActor(request);
    return { data: auth.sessions.listSessions(actor.userId, IdParamsSchema.parse(request.params).id) };
  });
  app.delete("/api/users/:id/sessions", async (request) => {
    const userId = IdParamsSchema.parse(request.params).id;
    return { data: { revokedSessions: await auth.users.revokeSessions(userId) } };
  });
  app.delete("/api/users/:id/sessions/:sessionId", async (request) => {
    const actor = userActor(request);
    const params = z.object({ id: z.string().trim().min(1), sessionId: z.string().trim().min(1) }).strict().parse(request.params);
    return { data: { revoked: await auth.sessions.revokeSession(actor.userId, params.sessionId) } };
  });
  app.post("/api/users/:id/identities", async (request) => {
    const userId = IdParamsSchema.parse(request.params).id;
    const result = await auth.users.bindExternalIdentity(userId, request.body);
    auth.notifyAuthorizationChanged(userId);
    return { data: result };
  });
  app.delete("/api/users/:id/identities/:identityId", async (request) => {
    const params = z.object({ id: z.string().trim().min(1), identityId: z.string().trim().min(1) }).strict().parse(request.params);
    const result = await auth.users.unbindIdentity(params.id, params.identityId);
    auth.notifyAuthorizationChanged(params.id);
    return { data: result };
  });

  app.get("/api/roles", async () => ({ data: auth.users.roleSummaries() }));
  app.get("/api/permissions", async () => ({ data: CONTROL_PLANE_PERMISSION_CATALOG }));
  app.post("/api/roles", async (request, reply) => reply.code(201).send({ data: await auth.users.createRole(request.body) }));
  app.patch("/api/roles/:id", async (request) => {
    const roleId = IdParamsSchema.parse(request.params).id;
    const affected = auth.users.store.grants.list().filter((grant) => grant.roleIds.includes(roleId)).map((grant) => grant.userId);
    const role = await auth.users.updateRole(roleId, request.body);
    for (const userId of affected) auth.notifyAuthorizationChanged(userId);
    return { data: role };
  });
  app.delete("/api/roles/:id", async (request) => ({ data: await auth.users.archiveRole(IdParamsSchema.parse(request.params).id) }));

  app.get("/api/identity-providers", async () => ({ data: auth.identityProviders.list() }));
  app.post("/api/identity-providers", async (request, reply) => reply.code(201).send({ data: await auth.identityProviders.create(request.body) }));
  app.patch("/api/identity-providers/:id", async (request) => ({ data: await auth.identityProviders.update(IdParamsSchema.parse(request.params).id, request.body) }));
  app.delete("/api/identity-providers/:id", async (request) => ({ data: { deleted: await auth.identityProviders.remove(IdParamsSchema.parse(request.params).id) } }));

  app.get("/api/external-identity-approvals", async () => ({ data: auth.users.store.approvals.list() }));
  app.post("/api/external-identity-approvals/:id/approve", async (request) => {
    const actor = userActor(request);
    return { data: await auth.users.approveExternalIdentity(actor.userId, IdParamsSchema.parse(request.params).id, request.body) };
  });
  app.post("/api/external-identity-approvals/:id/reject", async (request) => {
    const actor = userActor(request);
    return { data: await auth.users.rejectExternalIdentity(actor.userId, IdParamsSchema.parse(request.params).id) };
  });

  app.post("/api/auth/external/:id/begin", { config: PUBLIC_CONTROL_PLANE_ROUTE }, async (request, reply) => {
    reply.header("cache-control", "no-store");
    return { data: await auth.external.begin(IdParamsSchema.parse(request.params).id) };
  });
  app.post("/api/auth/external/callback", { config: PUBLIC_CONTROL_PLANE_ROUTE }, async (request, reply) => {
    reply.header("cache-control", "no-store");
    const result = await auth.external.callback(request.body as { state: string; code: string });
    if (result.kind === "session") {
      reply.setCookie(CONTROL_PLANE_SESSION_COOKIE, result.sessionToken, { path: "/", httpOnly: true, sameSite: "lax", expires: new Date(result.expiresAt) });
      return { data: { kind: result.kind, user: result.user, authorization: result.authorization } };
    }
    return { data: result };
  });
}
