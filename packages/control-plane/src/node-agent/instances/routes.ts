import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  CONTROL_PLANE_PROTOCOL_VERSION,
  ControlledInstanceHeartbeatSchema,
  ControlledInstanceRegisterSchema,
  NODE_AGENT_PROTOCOL_VERSION_HEADER,
  type ControlledInstance,
  type ControlledInstanceHeartbeat,
  type ControlledInstanceRegister,
} from "@task-handoff/protocol/control-plane";
import { CreateNodeInstanceSchema, UpdateNodeInstanceSchema } from "../schemas.ts";
import {
  INSTANCE_DIRECTORY_PROJECTION,
  INSTANCE_PROJECTION_HEADER,
  projectInstancesForConditionalGet,
  projectInstancesForDirectory,
} from "../../shared/instances/fleet-projection.ts";

const InstanceFleetQuerySchema = z.object({
  projection: z.literal("directory").optional(),
}).strict();

function instanceFleetEtag(instances: ControlledInstance[]) {
  const digest = createHash("sha256")
    .update(JSON.stringify(projectInstancesForConditionalGet(instances)))
    .digest("base64url");
  return `"${digest}"`;
}

function normalizedEtag(value: string) {
  return value.trim().replace(/^W\//, "");
}

function ifNoneMatchMatches(header: string | string[] | undefined, etag: string) {
  if (!header) return false;
  const values = Array.isArray(header) ? header : [header];
  const expected = normalizedEtag(etag);
  return values
    .flatMap((value) => value.split(","))
    .some((value) => value.trim() === "*" || normalizedEtag(value) === expected);
}

function bearerToken(headers: Record<string, unknown>) {
  const authorization = headers.authorization;
  return typeof authorization === "string" && authorization.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length).trim()
    : undefined;
}

type Operations = {
  list(): ControlledInstance[];
  create(input: ReturnType<typeof CreateNodeInstanceSchema.parse>): ControlledInstance | Promise<ControlledInstance>;
  retryImageProvisioning(id: string): ControlledInstance;
  retryGitProvisioning(id: string): ControlledInstance;
  update(id: string, input: ReturnType<typeof UpdateNodeInstanceSchema.parse>): ControlledInstance;
  register(id: string, input: ControlledInstanceRegister, token?: string): ControlledInstance;
  heartbeat(id: string, input: ControlledInstanceHeartbeat, token?: string): ControlledInstance;
  sanitizeReport(id: string, report: "register" | "heartbeat", input: unknown): unknown;
  afterCreate(instance: ControlledInstance): void;
  afterImageRetry(instance: ControlledInstance): void;
  afterGitRetry(instance: ControlledInstance): void;
  afterUpdate(instance: ControlledInstance): void | Promise<void>;
  afterReport(instance: ControlledInstance, report: "register" | "heartbeat"): void;
};

export function registerInstanceManagementRoutes(app: FastifyInstance, operations: Operations) {
  app.get("/api/node-agent/instances", async (request, reply) => {
    const query = InstanceFleetQuerySchema.parse(request.query || {});
    const listed = operations.list();
    const directory = query.projection === INSTANCE_DIRECTORY_PROJECTION
      || request.headers[INSTANCE_PROJECTION_HEADER] === INSTANCE_DIRECTORY_PROJECTION;
    const instances = directory ? projectInstancesForDirectory(listed) : listed;
    const etag = instanceFleetEtag(instances);
    reply
      .header("etag", etag)
      .header("cache-control", "no-cache")
      .header("vary", INSTANCE_PROJECTION_HEADER);
    if (ifNoneMatchMatches(request.headers["if-none-match"], etag)) return reply.code(304).send();
    return { data: instances };
  });

  app.post("/api/node-agent/instances", async (request, reply) => {
    const instance = await operations.create(CreateNodeInstanceSchema.parse(request.body));
    operations.afterCreate(instance);
    return reply.code(201).send({ data: instance });
  });

  app.post("/api/node-agent/instances/:id/image-provisioning/retry", async (request) => {
    const instance = operations.retryImageProvisioning((request.params as { id: string }).id);
    operations.afterImageRetry(instance);
    return { data: instance };
  });

  app.post("/api/node-agent/instances/:id/git-provisioning/retry", async (request) => {
    const instance = operations.retryGitProvisioning((request.params as { id: string }).id);
    operations.afterGitRetry(instance);
    return { data: instance };
  });

  app.patch("/api/node-agent/instances/:id", async (request) => {
    const instance = operations.update(
      (request.params as { id: string }).id,
      UpdateNodeInstanceSchema.parse(request.body),
    );
    await operations.afterUpdate(instance);
    return { data: instance };
  });

  app.post("/api/node-agent/instances/:id/register", async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const payload = operations.sanitizeReport(id, "register", request.body);
    const instance = operations.register(id, ControlledInstanceRegisterSchema.parse(payload), bearerToken(request.headers));
    operations.afterReport(instance, "register");
    return reply
      .header(NODE_AGENT_PROTOCOL_VERSION_HEADER, CONTROL_PLANE_PROTOCOL_VERSION)
      .code(201)
      .send({ data: instance });
  });

  app.post("/api/node-agent/instances/:id/heartbeat", async (request) => {
    const id = (request.params as { id: string }).id;
    const payload = operations.sanitizeReport(id, "heartbeat", request.body);
    const instance = operations.heartbeat(id, ControlledInstanceHeartbeatSchema.parse(payload), bearerToken(request.headers));
    operations.afterReport(instance, "heartbeat");
    return { data: instance };
  });
}
