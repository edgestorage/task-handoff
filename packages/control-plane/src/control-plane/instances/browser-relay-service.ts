import { EventEmitter } from "node:events";
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
    const socket = new RelayBrowserSocket(handlers);
    try {
      await this.attach(instanceId, socket);
      if (socket.readyState !== 1) throw browserChannelError("BROWSER_CHANNEL_CLOSED");
      return { send: async (message) => {
        if (socket.readyState !== 1) throw browserChannelError("BROWSER_CHANNEL_CLOSED");
        socket.emit("message", Buffer.from(message.bytes), message.binary);
      }, close: () => socket.close() };
    } catch (error) { socket.close(); throw error; }
  }
}

class RelayBrowserSocket extends EventEmitter implements NodeAgentWebSocket {
  readyState = 1;
  bufferedAmount = 0;
  private readonly handlers: BrowserChannelHandlers;
  constructor(handlers: BrowserChannelHandlers) { super(); this.handlers = handlers; }
  // bridgeWebSockets awaits this method and pauses its source, including the
  // multiplexed node-relay source, until browser credit becomes available.
  async sendAsync(raw: unknown, options?: { binary?: boolean }) {
    const bytes = typeof raw === "string" ? Buffer.from(raw) : Buffer.isBuffer(raw) ? raw : Buffer.from(raw as Uint8Array);
    if (this.readyState !== 1) throw browserChannelError("BROWSER_CHANNEL_CLOSED");
    this.bufferedAmount += bytes.byteLength;
    try { await this.handlers.onMessage({ bytes, binary: options?.binary ?? typeof raw !== "string" }); }
    finally { this.bufferedAmount -= bytes.byteLength; }
  }
  send(raw: unknown, options?: { binary?: boolean }) { void this.sendAsync(raw, options).catch(() => this.close(1011)); }
  close(code = 1000, reason = "Browser channel closed.") {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.emit("close", code, reason);
    this.handlers.onClose();
  }
}
