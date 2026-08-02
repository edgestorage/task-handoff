import type { FastifyInstance } from "fastify";
import {
  ControlledInstanceHeartbeatSchema,
  ControlledInstanceRegisterSchema,
  type ControlledInstance,
  type ControlledInstanceHeartbeat,
  type ControlledInstanceRegister,
} from "@task-handoff/protocol/control-plane";
import { CreateNodeInstanceSchema, UpdateNodeInstanceSchema } from "../schemas.ts";

function bearerToken(headers: Record<string, unknown>) {
  const authorization = headers.authorization;
  return typeof authorization === "string" && authorization.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length).trim()
    : undefined;
}

type Operations = {
  list(): ControlledInstance[];
  create(input: ReturnType<typeof CreateNodeInstanceSchema.parse>): ControlledInstance;
  retryImageProvisioning(id: string): ControlledInstance;
  update(id: string, input: ReturnType<typeof UpdateNodeInstanceSchema.parse>): ControlledInstance;
  register(id: string, input: ControlledInstanceRegister, token?: string): ControlledInstance;
  heartbeat(id: string, input: ControlledInstanceHeartbeat, token?: string): ControlledInstance;
  sanitizeReport(id: string, report: "register" | "heartbeat", input: unknown): unknown;
  afterCreate(instance: ControlledInstance): void;
  afterImageRetry(instance: ControlledInstance): void;
  afterUpdate(instance: ControlledInstance): void;
  afterReport(instance: ControlledInstance, report: "register" | "heartbeat"): void;
};

export function registerInstanceManagementRoutes(app: FastifyInstance, operations: Operations) {
  app.get("/api/node-agent/instances", async () => ({ data: operations.list() }));

  app.post("/api/node-agent/instances", async (request, reply) => {
    const instance = operations.create(CreateNodeInstanceSchema.parse(request.body));
    operations.afterCreate(instance);
    return reply.code(201).send({ data: instance });
  });

  app.post("/api/node-agent/instances/:id/image-provisioning/retry", async (request) => {
    const instance = operations.retryImageProvisioning((request.params as { id: string }).id);
    operations.afterImageRetry(instance);
    return { data: instance };
  });

  app.patch("/api/node-agent/instances/:id", async (request) => {
    const instance = operations.update(
      (request.params as { id: string }).id,
      UpdateNodeInstanceSchema.parse(request.body),
    );
    operations.afterUpdate(instance);
    return { data: instance };
  });

  app.post("/api/node-agent/instances/:id/register", async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const payload = operations.sanitizeReport(id, "register", request.body);
    const instance = operations.register(id, ControlledInstanceRegisterSchema.parse(payload), bearerToken(request.headers));
    operations.afterReport(instance, "register");
    return reply.code(201).send({ data: instance });
  });

  app.post("/api/node-agent/instances/:id/heartbeat", async (request) => {
    const id = (request.params as { id: string }).id;
    const payload = operations.sanitizeReport(id, "heartbeat", request.body);
    const instance = operations.heartbeat(id, ControlledInstanceHeartbeatSchema.parse(payload), bearerToken(request.headers));
    operations.afterReport(instance, "heartbeat");
    return { data: instance };
  });
}
