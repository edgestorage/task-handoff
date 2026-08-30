import type { FastifyInstance, FastifyRequest } from "fastify";
import { BrowserAccessHandshakeSchema } from "@task-handoff/protocol/browser-access";
import { supportsBrowserTunnel } from "@task-handoff/protocol/control-plane";
import type { ControlPlaneService } from "../application/service.ts";
import type { ControlPlaneAuth } from "../auth/service.ts";
import { assertCan } from "../auth/authorization.ts";
import type { AuthorizationConnectionRegistry } from "../auth/authorization-connections.ts";
import type { ControlPlaneEventBus } from "../events/bus.ts";
import { BrowserAccessService } from "../instances/browser-access-service.ts";
import { PUBLIC_CONTROL_PLANE_ROUTE } from "./auth-boundary.ts";
import { assertRequestInstanceVisible } from "./access-projection.ts";
import { controlPlaneRequestActor } from "./request-actor.ts";
import { IdParamsSchema } from "./route-params.ts";

export type RegisterBrowserRelayRoutesOptions = {
  app: FastifyInstance;
  service: ControlPlaneService;
  auth: ControlPlaneAuth;
  authorizationConnections: AuthorizationConnectionRegistry;
  events: ControlPlaneEventBus;
  browserAccess?: BrowserAccessService;
};

export function registerBrowserRelayRoutes(options: RegisterBrowserRelayRoutesOptions) {
  const { app, service, auth, authorizationConnections, events } = options;
  const browserAccess = options.browserAccess || new BrowserAccessService();

  app.post("/api/controlled-instances/:id/browser-access", async (request) => {
    const { id } = IdParamsSchema.parse(request.params);
    const actor = requireUserActor(request, auth);
    const instance = await assertRequestInstanceVisible(service, request, id);
    assertCan(actor, "interactive-access", { type: "instance", id, instanceId: id, nodeId: instance.nodeId });
    if (!supportsBrowserTunnel(instance.capabilities)) {
      throw Object.assign(new Error("The controlled instance does not support Browser Tunnel."), {
        statusCode: 409,
        code: "BROWSER_TUNNEL_UNSUPPORTED",
      });
    }
    const access = browserAccess.create({
      instanceId: id,
      authorization: { userId: actor.userId, authorizationRevision: actor.authorizationRevision },
    });
    return { data: BrowserAccessHandshakeSchema.parse({
      accessId: access.accessId,
      token: access.token,
      expiresAt: access.expiresAt,
      relayPath: "/browser-relay",
    }) };
  });

  app.get("/browser-relay", { websocket: true, config: PUBLIC_CONTROL_PLANE_ROUTE }, async (socket, request) => {
    let releaseAccess: (() => void) | undefined;
    let releaseAuthorization: (() => void) | undefined;
    // The desktop sends its hello as soon as the upgrade completes. Buffer
    // messages until authorization finishes and the proxy bridge owns them.
    const bufferedMessages: Array<[unknown, boolean]> = [];
    const bufferMessage = (data: unknown, isBinary = false) => bufferedMessages.push([data, Boolean(isBinary)]);
    socket.on("message", bufferMessage);
    try {
      const access = browserAccess.consume(browserAuthorizationToken(request.headers.authorization));
      if (auth.enabled?.() !== false) {
        await auth.assertAppAccessAuthorization({
          ...access.authorization,
          instanceId: access.instanceId,
          nodeId: (await service.requireControlledInstance(access.instanceId, true)).nodeId,
        });
      }
      const close = () => socket.close(4001, "Browser access authorization ended.");
      releaseAccess = browserAccess.track(access, close);
      releaseAuthorization = authorizationConnections.track(access.authorization, close);
      socket.on("close", () => { releaseAccess?.(); releaseAuthorization?.(); });
      await service.proxyInstanceWebSocket(access.instanceId, socket as any, "/api/browser-tunnel", [], {});
      socket.off("message", bufferMessage);
      for (const [data, isBinary] of bufferedMessages.splice(0)) socket.emit("message", data, isBinary);
    } catch {
      socket.off("message", bufferMessage);
      bufferedMessages.length = 0;
      releaseAccess?.();
      releaseAuthorization?.();
      socket.close(1008, "Browser access is invalid or unavailable.");
    }
  });

  events.on((event) => {
    if (!["instance.stopped", "instance.deleted", "instance.restarted"].includes(event.type)) return;
    const payload = event.payload && typeof event.payload === "object" ? event.payload as Record<string, unknown> : {};
    if (typeof payload.instanceId === "string") browserAccess.closeInstance(payload.instanceId);
  });

  return browserAccess;
}

function requireUserActor(request: FastifyRequest, auth: ControlPlaneAuth) {
  const actor = controlPlaneRequestActor(request);
  if (actor?.type === "user") return actor;
  if (auth.enabled?.() === false) return { type: "system" as const, reason: "auth-disabled", userId: "system:auth-disabled", authorizationRevision: 0 };
  throw Object.assign(new Error("A signed-in Control Plane user is required."), { statusCode: 403, code: "BROWSER_ACCESS_USER_REQUIRED" });
}

function browserAuthorizationToken(value: unknown) {
  if (typeof value !== "string" || !value.startsWith("Browser ")) return "";
  return value.slice("Browser ".length).trim();
}
