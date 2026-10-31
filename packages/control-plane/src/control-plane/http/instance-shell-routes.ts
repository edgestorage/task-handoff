import type { FastifyInstance, FastifyRequest } from "fastify";
import { INSTANCE_SHELL_WEBSOCKET_SUBPROTOCOL } from "@task-handoff/protocol/instance-shell";
import { supportsControlledInstanceShell } from "@task-handoff/protocol/control-plane";
import type { ControlPlaneService } from "../application/service.ts";
import { assertCan, instanceScopeAllows, type ControlPlaneActor } from "../auth/authorization.ts";
import type { AuthorizationConnectionRegistry } from "../auth/authorization-connections.ts";
import type { ControlPlaneEventBus } from "../events/bus.ts";
import { assertRequestInstanceVisible } from "./access-projection.ts";
import { IdParamsSchema } from "./route-params.ts";
import { controlPlaneRequestActor } from "./request-actor.ts";

export type RegisterInstanceShellRoutesOptions = {
  app: FastifyInstance;
  service: ControlPlaneService;
  authorizationConnections: AuthorizationConnectionRegistry;
  events: ControlPlaneEventBus;
};

type ShellSocket = {
  readyState: number;
  OPEN: number;
  close: (code?: number, reason?: string) => void;
  on: (event: "close", listener: () => void) => void;
};

export function registerInstanceShellRoutes({ app, service, authorizationConnections, events }: RegisterInstanceShellRoutesOptions) {
  const connections = new Map<ShellSocket, string>();
  const authorizedRequests = new WeakMap<FastifyRequest, { instanceId: string; actor: ControlPlaneActor }>();
  const closeInstance = (instanceId: string) => {
    for (const [socket, currentInstanceId] of connections) {
      if (currentInstanceId === instanceId) socket.close(4001, "Instance lifecycle changed.");
    }
  };
  events.on((event) => {
    if (!["instance.stopped", "instance.deleted", "instance.restarted"].includes(event.type)) return;
    const payload = event.payload && typeof event.payload === "object" ? event.payload as Record<string, unknown> : {};
    if (typeof payload.instanceId === "string") closeInstance(payload.instanceId);
  });

  app.get("/api/controlled-instances/:id/shell", {
    websocket: true,
    preHandler: [
      async (request, reply) => {
        const protocols = (request.headers["sec-websocket-protocol"] || "")
          .split(",")
          .map((value) => value.trim())
          .filter(Boolean);
        if (protocols.length !== 1 || protocols[0] !== INSTANCE_SHELL_WEBSOCKET_SUBPROTOCOL) {
          return reply.code(400).send({ error: { code: "INSTANCE_SHELL_PROTOCOL_ERROR", message: "Instance shell subprotocol is required." } });
        }
      },
      async (request) => {
        const { id } = IdParamsSchema.parse(request.params);
        const actor = controlPlaneRequestActor(request);
        if (!actor) throw Object.assign(new Error("Authentication is required."), { statusCode: 401, code: "CONTROL_PLANE_AUTH_REQUIRED" });
        const instance = await assertRequestInstanceVisible(service, request, id);
        if ((actor.type === "user" || actor.type === "cloud-account")
          && !instanceScopeAllows(actor.nodeScope, actor.instanceScope, id, instance.nodeId)) {
          throw Object.assign(new Error("The requested resource is not visible."), {
            statusCode: 404,
            code: "CONTROL_PLANE_RESOURCE_NOT_VISIBLE",
          });
        }
        assertCan(actor, "interactive-access", { type: "instance", id, instanceId: id, nodeId: instance.nodeId });
        if (!supportsControlledInstanceShell(instance.capabilities)) {
          throw Object.assign(new Error("The controlled instance does not support Instance Shell."), {
            statusCode: 409,
            code: "INSTANCE_SHELL_UNSUPPORTED",
          });
        }
        authorizedRequests.set(request, { instanceId: id, actor });
      },
    ],
  }, async (socket, request) => {
    let releaseAuthorization: (() => void) | undefined;
    try {
      const authorization = authorizedRequests.get(request);
      if (!authorization) throw Object.assign(new Error("Instance Shell authorization was not completed."), { code: "INSTANCE_SHELL_UNAVAILABLE" });
      authorizedRequests.delete(request);
      const { instanceId: id, actor } = authorization;
      if (actor.type === "user") {
        releaseAuthorization = authorizationConnections.track(
          { userId: actor.userId, authorizationRevision: actor.authorizationRevision },
          () => socket.close(4001, "Authorization changed."),
        );
      } else if (actor.type === "cloud-account" && actor.ownerUserId && actor.ownerAuthorizationRevision !== undefined) {
        releaseAuthorization = authorizationConnections.track(
          { userId: actor.ownerUserId, authorizationRevision: actor.ownerAuthorizationRevision },
          () => socket.close(4001, "Authorization changed."),
        );
      }
      connections.set(socket as unknown as ShellSocket, id);
      socket.on("close", () => {
        connections.delete(socket as unknown as ShellSocket);
        releaseAuthorization?.();
      });
      await service.proxyInstanceWebSocket(id, socket as any, "/api/internal/instance-shell", [INSTANCE_SHELL_WEBSOCKET_SUBPROTOCOL], {});
    } catch (error) {
      connections.delete(socket as unknown as ShellSocket);
      releaseAuthorization?.();
      const code = error && typeof error === "object" && "code" in error ? String(error.code) : "INSTANCE_SHELL_UNAVAILABLE";
      socket.close(1008, code.slice(0, 123));
    }
  });
}
