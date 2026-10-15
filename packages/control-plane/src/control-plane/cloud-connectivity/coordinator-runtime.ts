import crypto from "node:crypto";
import WebSocket from "ws";
import { CloudAuthorityEventConsumer } from "./authority-events.ts";
import { CloudControlConnectionManager, CloudRelayDataConnectionManager } from "./connections.ts";
import { CloudConnectivityLifecycle } from "./lifecycle.ts";
import type { CloudAccountSessionService } from "./account-session.ts";
import type { CloudConnectivityService } from "./service.ts";
import type { ControlPlaneIdentityService } from "../identity/service.ts";
import { CloudRelayConnector, verifyCoordinatorRelayAllocation, type RelaySessionBridge } from "./relay-connector.ts";
import { RelayLinkProbeLoop } from "./relay-link-probe.ts";
import { RelayTraceRecorder } from "./relay-trace.ts";

type RpcConnection = { request(operation: string, payload?: unknown): Promise<unknown>; close(reason?: string): Promise<void> };
type CloudAccountScope = "account:sign-in" | "control-plane:bind";
type CreateRequestResult = { requestId: string; scope: string; expiresAt: string; authorizationUrl: string };
const ACCOUNT_REQUEST_POLL_MS = 3_000;
const ACCOUNT_REQUEST_SCOPES = ["account:read", "control-plane:manage"];
// Renewing inside the sliding window keeps the account session alive without user action, and
// surfaces a remote revocation without waiting for the next reconnect. A lapse (the Control Plane
// was offline longer than the window) still requires a fresh sign-in.
const ACCOUNT_RENEWAL_INTERVAL_MS = 12 * 60 * 60_000;

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
  /** Decoded relay traffic capture; disabled recorder unless the host injects one. */
  readonly relayTrace: RelayTraceRecorder;
  /** Background Control Plane -> Relay RTT measurements, reported as selection hints. */
  readonly relayLinks: RelayLinkProbeLoop;
  private readonly connector: CloudCoordinatorConnector;
  private readonly control: CloudControlConnectionManager;
  private readonly events: CloudAuthorityEventConsumer;
  private timer?: ReturnType<typeof setTimeout>;
  private accountTimer?: ReturnType<typeof setTimeout>;
  private accountRenewalTimer?: ReturnType<typeof setInterval>;
  private running = false;
  private connecting?: Promise<unknown>;
  private reconciling?: Promise<void>;
  private rotatingCredentials?: Promise<void>;
  private accessToken?: { value: string; expiresAt: number };
  private readonly options: CloudRuntimeOptions;
  private readonly clock: () => number;

  constructor(options: CloudRuntimeOptions) {
    this.options = { ...options, fetch: options.fetch ?? globalThis.fetch };
    this.clock = options.clock ?? Date.now;
    this.connector = new CloudCoordinatorConnector({ identity: options.identity, webSocket: options.webSocket, onDisconnected: () => { this.control.disconnected(); this.schedule(); }, onRequest: (operation, payload) => this.handleRequest(operation, payload) });
    this.relayTrace = options.relayTrace ?? new RelayTraceRecorder();
    const relayConnector = options.relayConnector ?? (options.relayBridge ? new CloudRelayConnector({ identity: options.identity, bridge: options.relayBridge, webSocket: options.webSocket, trace: this.relayTrace }) : { async connect() { throw runtimeError("CLOUD_RELAY_CONNECTOR_UNAVAILABLE"); } });
    this.dataConnections = new CloudRelayDataConnectionManager({ verifyAllocation: options.verifyAllocation ?? ((allocation) => verifyCoordinatorRelayAllocation(allocation, options.state)), connector: relayConnector });
    this.events = new CloudAuthorityEventConsumer({ state: options.state, connections: { stop: (reason) => this.control.stop(reason) }, dataConnections: this.dataConnections });
    this.control = new CloudControlConnectionManager({ state: options.state, connector: this.connector, onEvent: async (event) => { await this.events.apply(event as any); } });
    this.relayLinks = options.relayLinks ?? new RelayLinkProbeLoop({
      serviceOrigin: () => options.state.snapshot().serviceOrigin,
      // Hints only matter once the Control Plane is bound and reachable.
      enabled: () => { const snapshot = options.state.snapshot(); return snapshot.status === "active" && snapshot.remoteAccessEnabled; },
      report: (links) => this.request("report-relay-links", { links }),
      fetch: this.options.fetch,
      clock: this.clock,
      intervalMs: options.relayLinkProbeIntervalMs,
    });
    this.lifecycle = new CloudConnectivityLifecycle({ state: options.state, connections: this.control, remote: {
      revoke: async ({ bindingId }) => this.connector.request("revoke-binding", { bindingId }) as Promise<{ status: "revoked" }>,
      setRemoteAccess: async ({ bindingId, enabled }) => { await this.connector.request("set-remote-access", { bindingId, enabled }); },
    } });
  }

  start() {
    this.running = true;
    this.relayLinks.start();
    if (!this.accountRenewalTimer) {
      this.accountRenewalTimer = setInterval(() => { void this.renewAccountCredential().catch(() => undefined); }, this.options.accountRenewalIntervalMs ?? ACCOUNT_RENEWAL_INTERVAL_MS);
      this.accountRenewalTimer.unref();
    }
    // The stored access token is normally stale after a restart, so rotating once at boot keeps
    // the sliding expiry fresh and surfaces a remote revocation without waiting for the interval.
    void this.renewAccountCredential().catch(() => undefined);
    if (this.options.state.snapshot().status === "active") this.schedule(0);
  }
  async stop() {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    if (this.accountTimer) clearTimeout(this.accountTimer);
    if (this.accountRenewalTimer) clearInterval(this.accountRenewalTimer);
    this.accountRenewalTimer = undefined;
    this.relayLinks.stop();
    this.relayTrace.close();
    await Promise.all([this.control.stop("control-plane-stopping"), this.dataConnections.closeAll("control-plane-stopping")]);
  }

  /**
   * Asks the Coordinator for a browser-approvable authorization request and remembers it
   * locally, so the Control Plane UI can show "waiting for approval" without ever seeing a
   * code the user would have to copy.
   */
  async beginAccountRequest(input: { scope: CloudAccountScope; challengeCode?: string }) {
    const result = await this.request("create-control-plane-request", { scope: input.scope, ...(input.challengeCode ? { challengeCode: input.challengeCode } : {}) }) as CreateRequestResult;
    this.options.accountSession.beginRequest({ requestId: result.requestId, authorizationUrl: result.authorizationUrl, scope: result.scope, expiresAt: result.expiresAt });
    this.scheduleAccountPoll();
    return result;
  }

  /** Sign-out clears the local account session; an existing relay binding is a separate concern. */
  async signOutAccount() {
    try { await this.request("revoke-account-session", {}); } catch { /* the local session is cleared regardless */ }
    return this.options.accountSession.signOut();
  }

  /** Serialized so two callers share one credential rotation instead of replaying each other. */
  refreshAccountCredential() {
    if (!this.rotatingCredentials) this.rotatingCredentials = this.rotateAccountCredential().finally(() => { this.rotatingCredentials = undefined; });
    return this.rotatingCredentials;
  }

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
      const snapshot = this.options.state.activate(payload);
      const pending = this.options.accountSession.pendingRequest();
      if (pending) this.options.accountSession.resolveRequest({ requestId: pending.requestId, status: "delivered" });
      return snapshot;
    }
    if (operation === "deliver-account-credential") return this.acceptAccountCredential(payload);
    if (operation === "control-plane-request-resolved") {
      const requestId = String(payload?.requestId ?? "");
      if (requestId && payload?.status === "denied") this.options.accountSession.resolveRequest({ requestId, status: "denied" });
      return { accepted: true };
    }
    if (operation === "relay-allocation") {
      // The declared Relay hosts are an allowlist suffix; this is the first time the
      // Control Plane learns a host under it that actually resolves, so let the
      // background prober measure it for the next selection.
      this.relayLinks.observe(payload?.relayUrl);
      return this.dataConnections.attach(payload);
    }
    throw runtimeError("CLOUD_CONTROL_OPERATION_UNSUPPORTED");
  }

  private async ensureConnected() {
    if (!this.connecting) this.connecting = this.control.connectOnce().finally(() => { this.connecting = undefined; });
    const result = await this.connecting as { status: string; reused?: boolean };
    if (result.status !== "connected") throw runtimeError("CLOUD_CONTROL_CONNECTION_DISABLED");
    if (!result.reused && !this.reconciling) this.reconciling = this.reconcileAccount().catch(() => undefined).finally(() => { this.reconciling = undefined; });
  }

  /**
   * Runs on every fresh connection: picks up a decision the Control Plane missed while it was
   * offline and keeps the account credential rotated. Consumers degrade to polling, so a lost
   * push never leaves the UI stuck on "waiting for approval".
   */
  private async reconcileAccount() {
    const pending = this.options.accountSession.pendingRequest();
    if (pending) {
      try {
        const result = await this.request("poll-control-plane-request", { requestId: pending.requestId }) as { status?: string } | undefined;
        if (result?.status === "denied") this.options.accountSession.resolveRequest({ requestId: pending.requestId, status: "denied" });
        else if (result?.status === "expired") this.options.accountSession.resolveRequest({ requestId: pending.requestId, status: "expired" });
        else if (result?.status === "delivered") this.options.accountSession.resolveRequest({ requestId: pending.requestId, status: "delivered" });
      } catch { /* the request keeps its own TTL and the UI can retry */ }
    }
    if (this.options.accountSession.refreshCredential() && !this.hasFreshAccessToken()) await this.refreshAccountCredential();
    this.scheduleAccountPoll();
  }

  private acceptAccountCredential(payload: any) {
    const requestId = String(payload?.requestId ?? "");
    if (!payload?.accountId || !payload?.deviceSessionId || !payload?.refreshCredential) throw runtimeError("CLOUD_ACCOUNT_CREDENTIAL_INVALID");
    const snapshot = this.options.accountSession.complete({
      accountId: payload.accountId, email: typeof payload.email === "string" ? payload.email : undefined,
      deviceSessionId: payload.deviceSessionId, refreshCredential: payload.refreshCredential,
      sessionExpiresAt: typeof payload.expiresAt === "string" ? payload.expiresAt : undefined,
    });
    if (typeof payload.accessToken === "string") this.accessToken = { value: payload.accessToken, expiresAt: this.clock() + accessTokenLifetimeSeconds(payload.accessExpiresIn) * 1_000 };
    if (requestId) this.options.accountSession.resolveRequest({ requestId, status: "delivered" });
    this.scheduleAccountPoll();
    return snapshot;
  }

  private hasFreshAccessToken() {
    return Boolean(this.accessToken && this.accessToken.expiresAt > this.clock() + 30_000);
  }

  private async rotateAccountCredential() {
    const session = this.options.accountSession;
    const credentials = session.credentials();
    if (!credentials) return;
    const response = await this.options.fetch(`${session.origin}/api/v1/auth/refresh`, {
      method: "POST", headers: { "content-type": "application/json", "x-task-handoff-client": "mobile" },
      body: JSON.stringify({ refreshCredential: credentials.refreshCredential, deviceSessionId: credentials.deviceSessionId, scopes: ACCOUNT_REQUEST_SCOPES }),
    }).catch(() => undefined);
    // A network failure or a server fault must not throw away a working session; the stored
    // credential is still current and rotation can be retried on the next connection.
    if (!response) return;
    const body = await response.json().catch(() => undefined) as any;
    // The official API wraps every success in `{ data: ... }`.
    const tokens = body?.data ?? body;
    if (!response.ok) {
      // Rotation is the only authoritative "your session is gone" signal we can get here.
      if (response.status === 401 || response.status === 403 || response.status === 400) session.signOut();
      return;
    }
    if (!tokens?.refreshCredential || !tokens?.accountId || !tokens?.deviceSessionId) return;
    this.accessToken = typeof tokens.accessToken === "string" ? { value: tokens.accessToken, expiresAt: this.clock() + accessTokenLifetimeSeconds(tokens.accessExpiresIn) * 1_000 } : undefined;
    session.complete({ accountId: tokens.accountId, email: credentials.email, deviceSessionId: tokens.deviceSessionId, refreshCredential: tokens.refreshCredential, sessionExpiresAt: typeof tokens.sessionExpiresAt === "string" ? tokens.sessionExpiresAt : credentials.sessionExpiresAt }, { preservePending: true });
  }

  private async renewAccountCredential() {
    if (!this.running || !this.options.accountSession.refreshCredential() || this.hasFreshAccessToken()) return;
    await this.refreshAccountCredential();
  }

  private scheduleAccountPoll(delay = ACCOUNT_REQUEST_POLL_MS) {
    if (!this.running || this.accountTimer) return;
    if (!this.options.accountSession.hasPendingRequest()) return;
    this.accountTimer = setTimeout(() => { this.accountTimer = undefined; void this.reconcileAccount().catch(() => undefined).finally(() => this.scheduleAccountPoll()); }, delay);
    this.accountTimer.unref();
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

type CloudRuntimeOptions = {
  state: CloudConnectivityService;
  accountSession: CloudAccountSessionService;
  identity: ControlPlaneIdentityService;
  relayBridge?: RelaySessionBridge;
  relayConnector?: { connect(input: Record<string, unknown>): Promise<{ close(reason?: string): Promise<void> | void }> };
  relayTrace?: RelayTraceRecorder;
  relayLinks?: RelayLinkProbeLoop;
  relayLinkProbeIntervalMs?: number;
  accountRenewalIntervalMs?: number;
  verifyAllocation?: (allocation: unknown) => any;
  webSocket?: typeof WebSocket;
  fetch?: typeof fetch;
  clock?: () => number;
};

function accessTokenLifetimeSeconds(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 300;
}

function runtimeError(code: string) { return Object.assign(new Error("Cloud background connection is unavailable."), { code, retryable: true }); }
