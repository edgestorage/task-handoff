import { createBrowserChannelSocket } from "./browser-channel-socket.ts";
import { supportsBrowserTunnel } from "@task-handoff/protocol/control-plane";
import type { BrowserChannel, BrowserChannelHandlers } from "@task-handoff/protocol/relay-browser-channel";
import { browserChannelError } from "@task-handoff/protocol/relay-browser-channel";
import type { ControlPlaneService } from "../application/service.ts";
import { assertCan, instanceScopeAllows, type ControlPlaneActor } from "../auth/authorization.ts";
import type { ControlPlaneEventBus } from "../events/bus.ts";
import type { NodeAgentWebSocket } from "../nodes/client.ts";

/** Browser authority and instance lifetime are shared by Direct and E2E adapters. */
export class BrowserRelayService {
  private readonly active = new Map<string, Set<NodeAgentWebSocket>>();
  private readonly generations = new Map<string, number>();
  private readonly service: ControlPlaneService;
  constructor(service: ControlPlaneService, events: ControlPlaneEventBus) {
    this.service = service;
    events.on((event) => {
      if (!["instance.stopped", "instance.deleted", "instance.restarted"].includes(event.type)) return;
      const instanceId = (event.payload as { instanceId?: string } | undefined)?.instanceId;
      if (!instanceId) return;
      this.generations.set(instanceId, (this.generations.get(instanceId) ?? 0) + 1);
      for (const socket of this.active.get(instanceId) ?? []) socket.close(4001, "Browser instance ended.");
      this.active.delete(instanceId);
    });
  }

  async authorize(actor: ControlPlaneActor, instanceId: string) {
    const instance = await this.service.requireControlledInstance(instanceId);
    if (actor.type !== "user" && actor.type !== "cloud-account") throw browserChannelError("BROWSER_ACCESS_USER_REQUIRED");
    if (!instanceScopeAllows(actor.nodeScope, actor.instanceScope, instanceId, instance.nodeId)) {
      throw Object.assign(browserChannelError("CONTROL_PLANE_RESOURCE_NOT_VISIBLE"), { statusCode: 404 });
    }
    assertCan(actor, "interactive-access", { type: "instance", id: instanceId, instanceId, nodeId: instance.nodeId });
    if (!supportsBrowserTunnel(instance.capabilities)) throw Object.assign(browserChannelError("BROWSER_TUNNEL_UNSUPPORTED"), { statusCode: 409 });
    return instance;
  }

  async attach(instanceId: string, socket: NodeAgentWebSocket) {
    const sockets = this.active.get(instanceId) ?? new Set<NodeAgentWebSocket>();
    sockets.add(socket);
    this.active.set(instanceId, sockets);
    const release = () => {
      sockets.delete(socket);
      if (!sockets.size && this.active.get(instanceId) === sockets) this.active.delete(instanceId);
    };
    socket.on("close", release);
    try { await this.service.proxyInstanceWebSocket(instanceId, socket, "/api/browser-tunnel", [], {}); }
    catch (error) { release(); throw error; }
  }

  async open(actor: ControlPlaneActor, instanceId: string, handlers: BrowserChannelHandlers): Promise<BrowserChannel> {
    const generation = this.generations.get(instanceId) ?? 0;
    await this.authorize(actor, instanceId);
    if ((this.generations.get(instanceId) ?? 0) !== generation) throw browserChannelError("BROWSER_CHANNEL_INSTANCE_CHANGED");
    const { socket, channel } = createBrowserChannelSocket(handlers);
    try {
      await this.attach(instanceId, socket);
      if (socket.readyState !== 1) throw browserChannelError("BROWSER_CHANNEL_CLOSED");
      return channel;
    } catch (error) { socket.close(); throw error; }
  }
}
