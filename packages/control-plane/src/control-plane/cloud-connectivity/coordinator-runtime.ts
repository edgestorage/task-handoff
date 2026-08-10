import crypto from "node:crypto";
import WebSocket from "ws";
import { CloudAuthorityEventConsumer } from "./authority-events.ts";
import { CloudControlConnectionManager, CloudRelayDataConnectionManager } from "./connections.ts";
import { CloudConnectivityLifecycle } from "./lifecycle.ts";
import type { CloudConnectivityService } from "./service.ts";
import type { ControlPlaneIdentityService } from "../identity/service.ts";
import { CloudRelayConnector, verifyCoordinatorRelayAllocation, type RelaySessionBridge } from "./relay-connector.ts";

type RpcConnection = { request(operation: string, payload?: unknown): Promise<unknown>; close(reason?: string): Promise<void> };

export class CloudCoordinatorConnector {
  private current?: RpcConnection;
  private readonly options: { identity: ControlPlaneIdentityService; onDisconnected(): void; onRequest(operation: string, payload: unknown): Promise<unknown>; webSocket?: typeof WebSocket };

  constructor(options: { identity: ControlPlaneIdentityService; onDisconnected(): void; onRequest(operation: string, payload: unknown): Promise<unknown>; webSocket?: typeof WebSocket }) {
    this.options = options;
  }

  async connect(input: Record<string, any>) {
    const identity = this.options.identity.publicIdentity();
    const now = Date.now();
    const payload = {
      protocolVersion: "2026-08-10", audience: "task-handoff:coordinator-control",
      connectionId: `connection_${crypto.randomUUID().replaceAll("-", "_")}`,
      processInstanceId: input.processInstanceId, controlPlaneId: identity.controlPlaneId,
      publicKey: identity.publicKey, publicKeyFingerprint: identity.fingerprint,
      ...(input.bindingId ? { bindingId: input.bindingId, bindingRevision: input.bindingRevision } : {}),
      epoch: input.epoch, capabilities: ["request", "stream", "websocket"],
      issuedAt: new Date(now).toISOString(), expiresAt: new Date(now + 5 * 60_000).toISOString(),
    };
    const socketUrl = new URL("/api/v1/control-plane/connect", input.serviceOrigin);
    socketUrl.protocol = socketUrl.protocol === "https:" ? "wss:" : "ws:";
    const Socket = this.options.webSocket ?? WebSocket;
    const socket = new Socket(socketUrl.href, { followRedirects: false, handshakeTimeout: 10_000 });
    let connection: RpcConnection;
    connection = await openRpcConnection(socket, {
      register: { type: "register", registration: { ...payload, signature: this.options.identity.signCloudOutboundRegistration(payload) }, backgroundCredential: input.credential },
      onEvent: input.onEvent,
      onRequest: this.options.onRequest,
      onDisconnected: () => { if (this.current === connection) this.current = undefined; this.options.onDisconnected(); },
    });
    this.current = connection;
    return connection;
  }

  async request(operation: string, payload?: unknown) {
    if (!this.current) throw runtimeError("CLOUD_CONTROL_CONNECTION_UNAVAILABLE");
    return this.current.request(operation, payload);
  }
}

export class CloudConnectivityBackgroundRuntime {
  readonly lifecycle: CloudConnectivityLifecycle;
  readonly dataConnections: CloudRelayDataConnectionManager;
  private readonly connector: CloudCoordinatorConnector;
  private readonly control: CloudControlConnectionManager;
  private readonly events: CloudAuthorityEventConsumer;
  private timer?: ReturnType<typeof setTimeout>;
  private running = false;
  private connecting?: Promise<unknown>;
  private readonly options: { state: CloudConnectivityService; identity: ControlPlaneIdentityService; relayBridge?: RelaySessionBridge; relayConnector?: { connect(input: Record<string, unknown>): Promise<{ close(reason?: string): Promise<void> | void }> }; verifyAllocation?: (allocation: unknown) => any; webSocket?: typeof WebSocket };

  constructor(options: { state: CloudConnectivityService; identity: ControlPlaneIdentityService; relayBridge?: RelaySessionBridge; relayConnector?: { connect(input: Record<string, unknown>): Promise<{ close(reason?: string): Promise<void> | void }> }; verifyAllocation?: (allocation: unknown) => any; webSocket?: typeof WebSocket }) {
    this.options = options;
    this.connector = new CloudCoordinatorConnector({ identity: options.identity, webSocket: options.webSocket, onDisconnected: () => { this.control.disconnected(); this.schedule(); }, onRequest: (operation, payload) => this.handleRequest(operation, payload) });
    const relayConnector = options.relayConnector ?? (options.relayBridge ? new CloudRelayConnector({ identity: options.identity, bridge: options.relayBridge, webSocket: options.webSocket }) : { async connect() { throw runtimeError("CLOUD_RELAY_CONNECTOR_UNAVAILABLE"); } });
    this.dataConnections = new CloudRelayDataConnectionManager({ verifyAllocation: options.verifyAllocation ?? ((allocation) => verifyCoordinatorRelayAllocation(allocation, options.state)), connector: relayConnector });
    this.events = new CloudAuthorityEventConsumer({ state: options.state, connections: { stop: (reason) => this.control.stop(reason) }, dataConnections: this.dataConnections });
    this.control = new CloudControlConnectionManager({ state: options.state, connector: this.connector, onEvent: async (event) => { await this.events.apply(event as any); } });
    this.lifecycle = new CloudConnectivityLifecycle({ state: options.state, connections: this.control, remote: {
      revoke: async ({ bindingId }) => this.connector.request("revoke-binding", { bindingId }) as Promise<{ status: "revoked" }>,
      setRemoteAccess: async ({ bindingId, enabled }) => { await this.connector.request("set-remote-access", { bindingId, enabled }); },
    } });
  }

  start() { this.running = true; if (this.options.state.snapshot().status === "active") this.schedule(0); }
  async stop() { this.running = false; if (this.timer) clearTimeout(this.timer); await Promise.all([this.control.stop("control-plane-stopping"), this.dataConnections.closeAll("control-plane-stopping")]); }

  async publishBindingChallenge(challenge: { payload: unknown; signature: string }) {
    await this.ensureConnected();
    await this.connector.request("publish-binding-challenge", { payload: challenge.payload, signature: challenge.signature });
  }

  private async request(operation: string, payload: unknown) {
    await this.ensureConnected();
    return this.connector.request(operation, payload);
  }

  private async handleRequest(operation: string, payload: any) {
    if (operation === "consume-binding-challenge") {
      const identity = this.options.identity.publicIdentity();
      return this.options.state.consumeChallenge({ challengeCode: payload?.challengeCode, controlPlaneId: identity.controlPlaneId, fingerprint: identity.fingerprint });
    }
    if (operation === "deliver-binding-credential") {
      return this.options.state.activate(payload);
    }
    if (operation === "relay-allocation") return this.dataConnections.attach(payload);
    throw runtimeError("CLOUD_CONTROL_OPERATION_UNSUPPORTED");
  }

  private async ensureConnected() {
    if (!this.connecting) this.connecting = this.control.connectOnce().finally(() => { this.connecting = undefined; });
    const result = await this.connecting as { status: string };
    if (result.status !== "connected") throw runtimeError("CLOUD_CONTROL_CONNECTION_DISABLED");
  }

  private schedule(delay = this.control.reconnectDelay()) {
    if (!this.running || this.timer) return;
    const state = this.options.state.snapshot();
    if (state.status !== "active" || !state.remoteAccessEnabled) return;
    this.timer = setTimeout(() => { this.timer = undefined; void this.ensureConnected().catch(() => this.schedule()); }, delay);
    this.timer.unref();
  }
}

function openRpcConnection(socket: WebSocket, options: { register: unknown; onEvent(event: unknown): void; onRequest?(operation: string, payload: unknown): Promise<unknown>; onDisconnected(): void }): Promise<RpcConnection> {
  return new Promise((resolve, reject) => {
    const pending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void }>();
    let registered = false;
    let intentional = false;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    const fail = (error: Error) => { for (const item of pending.values()) item.reject(error); pending.clear(); if (!registered) reject(error); };
    const connection: RpcConnection = {
      request(operation, payload) {
        if (socket.readyState !== WebSocket.OPEN) return Promise.reject(runtimeError("CLOUD_CONTROL_CONNECTION_UNAVAILABLE"));
        const requestId = `request_${crypto.randomUUID().replaceAll("-", "_")}`;
        socket.send(JSON.stringify({ type: "request", requestId, operation, payload }));
        return new Promise((requestResolve, requestReject) => pending.set(requestId, { resolve: requestResolve, reject: requestReject }));
      },
      async close(reason = "normal") { intentional = true; if (heartbeat) clearInterval(heartbeat); socket.close(1000, reason.slice(0, 120)); },
    };
    socket.on("open", () => socket.send(JSON.stringify(options.register)));
    socket.on("message", async (raw) => {
      let message: any; try { message = JSON.parse(raw.toString()); } catch { return socket.close(1002, "invalid-json"); }
      if (message.type === "registered") { registered = true; heartbeat = setInterval(() => socket.readyState === WebSocket.OPEN && socket.send(JSON.stringify({ type: "heartbeat" })), 10_000); heartbeat.unref(); return resolve(connection); }
      if (message.type === "event") return options.onEvent(message.event);
      if (message.type === "response") { const item = pending.get(message.requestId); if (!item) return; pending.delete(message.requestId); return message.error ? item.reject(Object.assign(new Error(message.error.message), { code: message.error.code })) : item.resolve(message.data); }
      if (message.type === "request" && options.onRequest) {
        try { socket.send(JSON.stringify({ type: "response", requestId: message.requestId, data: await options.onRequest(message.operation, message.payload) })); }
        catch (error) { socket.send(JSON.stringify({ type: "response", requestId: message.requestId, error: { code: (error as any)?.code ?? "REQUEST_FAILED", message: error instanceof Error ? error.message : String(error) } })); }
      }
    });
    socket.on("error", (error) => fail(error));
    socket.on("close", () => { if (heartbeat) clearInterval(heartbeat); fail(runtimeError("CLOUD_CONTROL_CONNECTION_CLOSED")); if (!intentional) options.onDisconnected(); });
  });
}

function runtimeError(code: string) { return Object.assign(new Error("Cloud background connection is unavailable."), { code, retryable: true }); }
