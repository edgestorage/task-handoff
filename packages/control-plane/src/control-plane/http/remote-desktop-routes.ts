import { randomBytes } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { controlledInstanceRemoteDesktopCapabilities } from "@task-handoff/protocol/control-plane";
import {
  DesktopCreateSchema,
  DesktopFallbackRequestSchema,
  DesktopRequestIdSchema,
  DesktopSourcesSchema,
  REMOTE_DESKTOP_FALLBACK_CONTROL_SUBPROTOCOL,
  REMOTE_DESKTOP_FALLBACK_MEDIA_SUBPROTOCOL,
  REMOTE_DESKTOP_FALLBACK_PROTOCOL_VERSION,
  REMOTE_DESKTOP_PROTOCOL_VERSION,
  REMOTE_DESKTOP_SIGNAL_SUBPROTOCOL,
  isRemoteDesktopLocalNetworkAddress,
} from "@task-handoff/protocol/remote-desktop";
import type { ControlPlaneService } from "../application/service.ts";
import { assertCan, instanceScopeAllows } from "../auth/authorization.ts";
import type { AuthorizationConnectionRegistry } from "../auth/authorization-connections.ts";
import type { ControlPlaneEventBus } from "../events/bus.ts";
import { controlPlaneRequestActor } from "./request-actor.ts";
import { DesktopAccess, desktopOwner, failure, type DesktopPrincipal } from "../remote-desktop/access.ts";
import { remoteDesktopSignalOriginAllowed } from "../remote-desktop/signal-origin.ts";
import { DesktopTurnIssuer } from "../remote-desktop/turn.ts";

export function registerRemoteDesktopRoutes(options: {
  app: FastifyInstance; service: ControlPlaneService; events: ControlPlaneEventBus;
  authorizationConnections: AuthorizationConnectionRegistry;
  principal(request: FastifyRequest): Promise<DesktopPrincipal>;
  renewAuthorization(principal: DesktopPrincipal): Promise<boolean>;
  turn?: DesktopTurnIssuer;
}) {
  const { app, service } = options;
  const turn = options.turn ?? DesktopTurnIssuer.fromEnvironment();
  const allowInsecurePrivateNetwork = ["1", "true", "yes", "on"].includes(String(process.env.TASK_HANDOFF_DESKTOP_ALLOW_INSECURE_PRIVATE_NETWORK || "").trim().toLowerCase());
  const fallbackCapacity = {
    maxSessions: positiveInteger(process.env.TASK_HANDOFF_DESKTOP_FALLBACK_MAX_SESSIONS, 8),
    maxTotalBitrate: positiveInteger(process.env.TASK_HANDOFF_DESKTOP_FALLBACK_MAX_TOTAL_BITRATE, 32_000_000),
  };
  const access = new DesktopAccess({
    request: (id, operation, input) => service.desktopRequest(id, operation, input),
    attach: (id, socket) => service.desktopAttach(id, socket),
    fallback: (id, role, socket, headers) => service.desktopFallback(id, role, socket, headers),
    fallbackCapacity,
    renewAuthorization: options.renewAuthorization, issueIce: () => turn.issue(),
    watch: (principal, close) => {
      const actor = principal.actor;
      if (actor.type === "user") return options.authorizationConnections.track({ userId: actor.userId, authorizationRevision: actor.authorizationRevision }, close);
      if (actor.type === "cloud-account" && actor.ownerUserId && actor.ownerAuthorizationRevision !== undefined) return options.authorizationConnections.track({ userId: actor.ownerUserId, authorizationRevision: actor.ownerAuthorizationRevision }, close);
      return () => {};
    },
  });
  const base = "/api/controlled-instances/:id";
  const noStore = { logLevel: "silent" as const, bodyLimit: 16 * 1024, onRequest: async (_request, reply) => { reply.header("cache-control", "no-store").header("referrer-policy", "no-referrer"); } };
  async function authorize(request: FastifyRequest, management = false, available = true) {
    const { id } = request.params as { id: string };
    const actor = controlPlaneRequestActor(request); if (!actor) throw failure("REMOTE_DESKTOP_UNAUTHORIZED", 401);
    const instance = await service.requireControlledInstance(id);
    if ((actor.type === "user" || actor.type === "cloud-account") && !instanceScopeAllows(actor.nodeScope, actor.instanceScope, id, instance.nodeId)) throw failure("CONTROL_PLANE_RESOURCE_NOT_VISIBLE", 404);
    assertCan(actor, management ? "update" : "interactive-access", { type: "instance", id, instanceId: id, nodeId: instance.nodeId });
    const principal = await options.principal(request); desktopOwner(principal);
    const capability = controlledInstanceRemoteDesktopCapabilities(instance.capabilities);
    if (available && !capability.available) throw failure("REMOTE_DESKTOP_UNSUPPORTED");
    return { instance, principal, capability };
  }
  app.get(`${base}/remote-desktop/sources`, noStore, async request => {
    const { instance, principal, capability } = await authorize(request);
    if (!capability.sourceProviders.some(provider => provider.available)) throw failure("REMOTE_DESKTOP_SOURCE_UNSUPPORTED");
    const result = await service.desktopRequest(instance.id, "sources", { requestId: randomBytes(16).toString("hex"), owner: desktopOwner(principal) }) as Record<string, unknown>;
    return { data: { sources: DesktopSourcesSchema.parse(result.sources) } };
  });
  async function create(request: FastifyRequest, takeover = false) {
    const { instance, principal, capability } = await authorize(request);
    const input = DesktopCreateSchema.parse(request.body);
    // Docker bridge has no browser-reachable UDP publication. Never quietly
    // launch a Docker viewer with an empty/unhealthy TURN configuration.
    const ice = turn.issue();
    // Docker normally needs TURN, but an explicit WS fallback is a safe relay
    // path when the component advertises it. WebRTC is still attempted first.
    if (capability.runtimeKind === "docker" && !ice.iceServers.length && !capability.fallback.available) throw failure("REMOTE_DESKTOP_TURN_REQUIRED");
    const viewer = takeover ? String((request.params as any).sessionId) : undefined;
    const data = await access.mutate(principal, instance.id, input.requestId, { type: takeover ? "takeover" : "create", ...input, viewer }, async () => {
      const created = await access.create(principal, instance.id, instance.nodeId, input.requestId, input.selection, viewer, ice);
      const { ticket, ...publicResult } = created;
      // Relative URL preserves the authenticated reverse-proxy origin; tickets
      // never become route segments or independently returned credential fields.
      return { ...publicResult, protocolVersion: REMOTE_DESKTOP_PROTOCOL_VERSION,
        signalUrl: `/api/controlled-instances/${encodeURIComponent(instance.id)}/remote-desktop-sessions/${encodeURIComponent(created.snapshot.viewerSessionId)}/signal?ticket=${encodeURIComponent(ticket)}` };
    });
    return { data };
  }
  app.post(`${base}/remote-desktop-sessions`, noStore, request => create(request));
  app.post(`${base}/remote-desktop-sessions/:sessionId/takeover`, noStore, request => create(request, true));
  app.get(`${base}/remote-desktop-sessions/:sessionId`, noStore, async request => {
    const { instance, principal } = await authorize(request, false, false);
    return { data: await access.snapshot(principal, instance.id, (request.params as any).sessionId) };
  });
  app.delete(`${base}/remote-desktop-sessions/:sessionId`, noStore, async request => {
    const { instance, principal } = await authorize(request, false, false);
    const input = z.object({ requestId: DesktopRequestIdSchema }).strict().parse(request.body);
    await access.stop(principal, instance.id, (request.params as any).sessionId, input.requestId);
    return { data: { stopped: true } };
  });
  app.post(`${base}/remote-desktop-sessions/:sessionId/force-stop`, noStore, async request => {
    const { instance, principal } = await authorize(request, true, false);
    const input = z.object({ requestId: DesktopRequestIdSchema }).strict().parse(request.body);
    await access.mutate(principal, instance.id, input.requestId, { type: "force-stop", viewer: (request.params as any).sessionId }, () => access.forceStop(instance.id, (request.params as any).sessionId, input.requestId));
    return { data: { stopped: true } };
  });
  app.post(`${base}/remote-desktop-sessions/:sessionId/fallback`, noStore, async request => {
    const { instance, principal, capability } = await authorize(request, false, false);
    const input = DesktopFallbackRequestSchema.parse(request.body);
    if (!capability.fallback.available) throw failure("REMOTE_DESKTOP_FALLBACK_UNAVAILABLE");
    if (!fallbackSecureContext(request)) throw failure("REMOTE_DESKTOP_FALLBACK_SECURE_CONTEXT_REQUIRED", 400);
    const id = (request.params as any).sessionId as string;
    // Fallback is a transport choice, not a second quality tier. Keep the
    // WebSocket path within the same product resolution as WebRTC while the
    // component and proxy capacity still bound frame rate and bitrate.
    const videoMaxWidth = capability.video.maxWidth || capability.fallback.maxWidth;
    const videoMaxHeight = capability.video.maxHeight || capability.fallback.maxHeight;
    const limits = {
      maxWidth: Math.min(capability.fallback.maxWidth, videoMaxWidth),
      maxHeight: Math.min(capability.fallback.maxHeight, videoMaxHeight),
      maxFps: Math.min(capability.fallback.maxFrameRate || 30, capability.video.maxFrameRate || 30),
      maxBitrate: Math.min(capability.fallback.maxBitrate || 4_000_000, 4_000_000),
    };
    const data = await access.mutate(principal, instance.id, input.requestId, { type: "fallback", sessionId: id, ...input }, async () => {
      const issued = access.issueFallback(principal, instance.id, id, limits.maxBitrate);
      return {
        protocolVersion: REMOTE_DESKTOP_FALLBACK_PROTOCOL_VERSION,
        fallbackGeneration: issued.generation,
        mediaUrl: issued.mediaUrl,
        controlUrl: issued.controlUrl,
        mediaSubprotocol: REMOTE_DESKTOP_FALLBACK_MEDIA_SUBPROTOCOL,
        controlSubprotocol: REMOTE_DESKTOP_FALLBACK_CONTROL_SUBPROTOCOL,
        ticketExpiresAt: issued.ticketExpiresAt,
        limits,
      };
    });
    return { data };
  });
  app.get(`${base}/remote-desktop/settings`, noStore, async request => {
    const { instance } = await authorize(request, true, false);
    return { data: await service.desktopRequest(instance.id, "settings-get", {}) };
  });
  app.put(`${base}/remote-desktop/settings`, noStore, async request => {
    const { instance } = await authorize(request, true, false);
    const input = z.object({ enabled: z.boolean() }).strict().parse(request.body);
    const data = await service.desktopRequest(instance.id, "settings-set", input);
    if (!input.enabled) await access.invalidate((_p, id) => id === instance.id);
    return { data };
  });
  const authorized = new WeakMap<FastifyRequest, ReturnType<DesktopAccess["consume"]>>();
  const fallbackAuthorized = new WeakMap<FastifyRequest, ReturnType<DesktopAccess["consumeFallback"]>>();
  app.get(`${base}/remote-desktop-sessions/:sessionId/signal`, {
    ...noStore, websocket: true,
    preHandler: async request => {
      const protocols = String(request.headers["sec-websocket-protocol"] ?? "").split(",").map(value => value.trim());
      if (protocols.length !== 1 || protocols[0] !== REMOTE_DESKTOP_SIGNAL_SUBPROTOCOL) throw failure("REMOTE_DESKTOP_SIGNAL_PROTOCOL", 400);
      if (!remoteDesktopSignalOriginAllowed({
        requestProtocol: request.protocol,
        host: request.headers.host,
        origin: request.headers.origin,
        remoteAddress: request.socket.remoteAddress,
        publicBaseUrl: service.getSettings().publicBaseUrl,
        allowInsecurePrivateNetwork,
      })) {
        throw failure("REMOTE_DESKTOP_SIGNAL_ORIGIN", 403);
      }
      const { instance, principal } = await authorize(request);
      const { ticket } = z.object({ ticket: z.string().min(1).max(128) }).strict().parse(request.query);
      authorized.set(request, access.consume(principal, instance.id, (request.params as any).sessionId, ticket));
    },
  }, (socket, request) => {
    const entry = authorized.get(request); authorized.delete(request);
    if (!entry) { socket.close(1008, "REMOTE_DESKTOP_TICKET_INVALID"); return; }
    void access.connect(entry, socket as any);
  });
  app.get(`${base}/remote-desktop-sessions/:sessionId/fallback/:role`, {
    ...noStore, websocket: true,
    preHandler: async request => {
      const role = (request.params as { role?: string }).role;
      if (role !== "media" && role !== "control") throw failure("REMOTE_DESKTOP_FALLBACK_ROLE", 400);
      const expected = role === "media" ? REMOTE_DESKTOP_FALLBACK_MEDIA_SUBPROTOCOL : REMOTE_DESKTOP_FALLBACK_CONTROL_SUBPROTOCOL;
      const protocols = String(request.headers["sec-websocket-protocol"] ?? "").split(",").map(value => value.trim());
      if (protocols.length !== 1 || protocols[0] !== expected) throw failure("REMOTE_DESKTOP_FALLBACK_PROTOCOL", 400);
      if (!fallbackSecureContext(request)) throw failure("REMOTE_DESKTOP_FALLBACK_SECURE_CONTEXT_REQUIRED", 403);
      if (!remoteDesktopSignalOriginAllowed({
        requestProtocol: request.protocol,
        host: request.headers.host,
        origin: request.headers.origin,
        remoteAddress: request.socket.remoteAddress,
        publicBaseUrl: service.getSettings().publicBaseUrl,
        allowInsecurePrivateNetwork,
      })) throw failure("REMOTE_DESKTOP_SIGNAL_ORIGIN", 403);
      const { instance, principal } = await authorize(request);
      const { ticket } = z.object({ ticket: z.string().min(1).max(128) }).strict().parse(request.query);
      fallbackAuthorized.set(request, access.consumeFallback(
        principal,
        instance.id,
        (request.params as any).sessionId,
        role,
        ticket,
      ));
    },
  }, (socket, request) => {
    const authorized = fallbackAuthorized.get(request); fallbackAuthorized.delete(request);
    if (!authorized) { socket.close(1008, "REMOTE_DESKTOP_FALLBACK_TICKET_INVALID"); return; }
    const role = (request.params as { role: "media" | "control" }).role;
    void access.connectFallback(authorized.entry, role, authorized.generation, socket as any).catch(() => {
      socket.close(1011, "REMOTE_DESKTOP_FALLBACK_UPSTREAM_UNAVAILABLE");
    });
  });
  const stopEvents = options.events.on(event => {
    const payload = event.payload as any;
    const id = payload?.instanceId;
    if (["instance.stopped", "instance.deleted", "instance.restarted", "instance.capabilities.changed"].includes(event.type) && typeof id === "string") void access.invalidate((_p, instanceId) => id === instanceId);
    if (["node.deleted", "node.connection.updated"].includes(event.type)) {
      const nodeId = payload?.nodeId ?? payload?.id;
      // Loss of node authentication/transport closes media immediately rather
      // than granting the normal ICE/network recovery grace.
      if (typeof nodeId === "string" && (event.type === "node.deleted" || payload?.connectionStatus !== "online")) void access.invalidate((_p, _id, node) => node === nodeId);
    }
  });
  app.addHook("onClose", async () => { stopEvents(); await access.shutdown(); });
  return access;
}

/** Native decoders and the browser fallback both require a secure context for
 * the browser API surface. Private-LAN HTTP is explicitly allowed by the same
 * deployment opt-in that already gates signaling, so a Control Plane reachable
 * only on the LAN can still provide the WebSocket fallback. */
function fallbackSecureContext(request: FastifyRequest) {
  if (request.protocol === "https") return true;
  const host = String(request.headers.host ?? "")
    .replace(/:\d+$/, "")
    .replace(/^\[|\]$/g, "")
    .toLowerCase();
  return host === "localhost" || host === "127.0.0.1" || host === "::1"
    || isRemoteDesktopLocalNetworkAddress(host);
}

function positiveInteger(value: string | undefined, fallback: number) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}
