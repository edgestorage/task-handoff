import crypto from "node:crypto";
import WebSocket from "ws";
import {
  CONTROL_PLANE_REGISTRATION_PROTOCOL_VERSION,
  CONTROL_PLANE_SHARED_ACCESS_CAPABILITY,
  OutboundConnectionRegistrationResponseSchema,
  RELAY_SESSION_RESUME_CAPABILITY,
  RESOURCE_SHARING_CAPABILITY_HEADER,
  RESOURCE_SHARING_CLIENT_CAPABILITY,
} from "@task-handoff/cloud-contracts";
import { CloudAuthorityEventConsumer } from "./authority-events.ts";
import { CloudControlConnectionManager, CloudRelayDataConnectionManager } from "./connections.ts";
import { CloudConnectivityLifecycle } from "./lifecycle.ts";
import type { CloudAccountSessionService } from "./account-session.ts";
import type { CloudConnectivityService } from "./service.ts";
import type { ControlPlaneIdentityService } from "../identity/service.ts";
import { CloudRelayConnector, verifyCoordinatorRelayAllocation, verifyCoordinatorRelaySessionGrant, type RelaySessionBridge } from "./relay-connector.ts";
import { CloudNodeRelayConnector } from "./node-relay-connector.ts";
import { CloudNodeRelayChannels, type CloudNodeRelayChannelConnector, type CloudNodeRelayChannelTransport, type CloudNodeRelayChannelsOptions } from "./node-relay-channels.ts";
import type { NodeRelayFrameSocket } from "../../shared/cloud-relay/node-relay-session.ts";
import { RelayLinkProbeLoop } from "./relay-link-probe.ts";
import { RelayTraceRecorder } from "./relay-trace.ts";
import type { CloudEndpointResolver } from "../../../../../shared/cloud-discovery.cjs";

type RpcConnection = { request(operation: string, payload?: unknown): Promise<unknown>; close(reason?: string): Promise<void> };
type CloudAccountScope = "account:sign-in" | "control-plane:bind";
type CreateRequestResult = { requestId: string; scope: string; expiresAt: string; authorizationUrl: string };
const ACCOUNT_REQUEST_POLL_MS = 3_000;
const ACCOUNT_REQUEST_SCOPES = ["account:read", "control-plane:manage"];
// Check often, but refresh only after the cached access token enters its expiry window. A remote
// revocation therefore surfaces within one access-token lifetime instead of waiting half a day.
const ACCOUNT_RENEWAL_INTERVAL_MS = 60_000;

export class CloudCoordinatorConnector {
  private current?: RpcConnection;
  private readonly options: { identity: ControlPlaneIdentityService; onDisconnected(): void; onRegistered(registration: { controlPlaneId: string; reportedControlPlaneId: string }): void; onRequest(operation: string, payload: unknown): Promise<unknown>; webSocket?: typeof WebSocket; relaySessionResume?: boolean };

  constructor(options: { identity: ControlPlaneIdentityService; onDisconnected(): void; onRegistered(registration: { controlPlaneId: string; reportedControlPlaneId: string }): void; onRequest(operation: string, payload: unknown): Promise<unknown>; webSocket?: typeof WebSocket; relaySessionResume?: boolean }) {
    this.options = options;
  }

  async connect(input: Record<string, any>) {
    const identity = this.options.identity.publicIdentity();
    const now = Date.now();
    const payload = {
      protocolVersion: CONTROL_PLANE_REGISTRATION_PROTOCOL_VERSION, audience: "task-handoff:coordinator-control",
      connectionId: `connection_${crypto.randomUUID().replaceAll("-", "_")}`,
      processInstanceId: input.processInstanceId, reportedControlPlaneId: identity.controlPlaneId,
      ...(input.cloudControlPlaneId ? { expectedControlPlaneId: input.cloudControlPlaneId } : {}),
      publicKey: identity.publicKey, publicKeyFingerprint: identity.fingerprint,
      ...(input.bindingId ? { bindingId: input.bindingId, bindingRevision: input.bindingRevision } : {}),
      scopes: input.scopes,
      epoch: input.epoch, capabilities: ["request", "stream", "websocket", CONTROL_PLANE_SHARED_ACCESS_CAPABILITY, ...(this.options.relaySessionResume ? [RELAY_SESSION_RESUME_CAPABILITY] : [])],
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
      onRegistered: this.options.onRegistered,
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
  private revoking?: Promise<void>;
  private rotatingCredentials?: Promise<void>;
  private accessToken?: { value: string; expiresAt: number };
  private readonly nodeRelayChannels?: CloudNodeRelayChannels;
  private readonly onboardingHints = new Map<string, { tokenId?: string; at: string }>();
  private readonly options: CloudRuntimeOptions;
  private readonly clock: () => number;

  constructor(options: CloudRuntimeOptions) {
    this.options = { ...options, fetch: options.fetch ?? globalThis.fetch };
    this.clock = options.clock ?? Date.now;
    this.relayTrace = options.relayTrace ?? new RelayTraceRecorder();
    const relayConnector = options.relayConnector ?? (options.relayBridge ? new CloudRelayConnector({ identity: options.identity, bridge: options.relayBridge, webSocket: options.webSocket, trace: this.relayTrace }) : { async connect() { throw runtimeError("CLOUD_RELAY_CONNECTOR_UNAVAILABLE"); } });
    const verifyGrant = options.verifyRelaySessionGrant ?? ((grant) => verifyCoordinatorRelaySessionGrant(grant, options.state));
    const persistResume = options.relaySessionResumeEnabled === true && Boolean(options.cloudRelaySessionsPath)
      && typeof (relayConnector as { resume?: unknown }).resume === "function";
    this.connector = new CloudCoordinatorConnector({ identity: options.identity, webSocket: options.webSocket, relaySessionResume: persistResume, onDisconnected: () => { this.control.disconnected(); this.schedule(); }, onRegistered: (registration) => { options.state.setCloudControlPlaneId(registration.controlPlaneId); }, onRequest: (operation, payload) => this.handleRequest(operation, payload) });
    this.dataConnections = new CloudRelayDataConnectionManager({
      verifyAllocation: options.verifyAllocation ?? ((allocation) => verifyCoordinatorRelayAllocation(allocation, options.state)),
      verifyGrant,
      connector: relayConnector,
      ...(persistResume ? { sessionStatePath: options.cloudRelaySessionsPath } : {}),
      clock: this.clock,
    });
    this.events = new CloudAuthorityEventConsumer({
      state: options.state,
      connections: { stop: (reason) => this.control.stop(reason) },
      dataConnections: this.dataConnections,
      // Revocation and scope narrowing must drop node channels too; the
      // consumer is built first, so the lookup stays lazy.
      nodeChannels: { closeAll: (reason) => { this.nodeRelayChannels?.closeAll(reason); } },
    });
    this.control = new CloudControlConnectionManager({ state: options.state, connector: this.connector, coordinatorOrigins: options.coordinatorOrigins, clock: this.clock, onOriginFailover: options.onOriginFailover, ...(options.cloudDiscovery ? {
      originResolver: {
        activeOrigin: () => options.cloudDiscovery!.activeOrigin,
        endpoints: () => options.cloudDiscovery!.endpoints,
        markSuccess: (origin) => options.cloudDiscovery!.markSuccess(origin),
        markFailure: (origin) => options.cloudDiscovery!.markFailure(origin),
      },
    } : {}), onEvent: async (event) => {
      // Onboarding hints are plain bookkeeping: they carry no binding revision
      // and only wake this Control Plane to claim the node it helped install.
      if ((event as any)?.type === "node-relay-node-bound") { await this.handleNodeBound(event as any); return; }
      // Node allocations are pushed as events so the node's allocation poll can
      // return immediately. Attaching may wait for the node's E2E handshake, so
      // it must not block the event acknowledgement; failures stay visible in
      // the node-relay channel state.
      if ((event as any)?.type === "node-relay-allocation") {
        if (!this.nodeRelayChannels) return;
        void this.nodeRelayChannels.attach(event).catch(() => undefined);
        return;
      }
      if ((event as any)?.type === "relay-session-grant") {
        await this.dataConnections.applyGrant(event);
        return;
      }
      await this.events.apply(event as any);
    } });
    this.relayLinks = options.relayLinks ?? new RelayLinkProbeLoop({
      serviceOrigin: () => options.cloudDiscovery?.activeOrigin ?? options.state.snapshot().serviceOrigin,
      // Hints only matter once the Control Plane is bound and reachable, and they
      // feed both channel kinds, so either scope keeps the probe running.
      enabled: () => { const snapshot = options.state.snapshot(); return snapshot.status === "active" && (snapshot.scopes.deviceAccess || snapshot.scopes.nodeRelay); },
      report: (links) => this.request("report-relay-links", { links }),
      fetch: this.options.fetch,
      clock: this.clock,
      intervalMs: options.relayLinkProbeIntervalMs,
    });
    this.lifecycle = new CloudConnectivityLifecycle({ state: options.state, connections: {
      stop: (reason) => this.control.stop(reason),
      ensure: () => this.ensureConnected(),
    }, dataConnections: this.dataConnections, remote: {
      revoke: async ({ bindingId }) => this.connector.request("revoke-binding", { bindingId }) as Promise<{ status: "revoked" }>,
      setRemoteAccess: async ({ bindingId, scopes }) => { await this.connector.request("set-remote-access", { bindingId, scopes }); },
    }, ...(options.nodeRelay?.nodes ? {
      nodeChannels: {
        closeAll: (reason: string) => { this.nodeRelayChannels?.closeAll(reason); },
      },
    } : {}) });
    if (options.nodeRelay?.nodes) {
      this.nodeRelayChannels = new CloudNodeRelayChannels({
        state: options.state,
        connector: options.nodeRelay.connector ?? new CloudNodeRelayConnector({ identity: options.identity, webSocket: options.webSocket }),
        transport: () => options.nodeRelay?.transport?.(),
        nodes: options.nodeRelay.nodes,
        audit: options.nodeRelay.audit,
        onPreserveLocalConnection: async (nodeHandle) => { await this.revokeAccountNodeClaim(nodeHandle); },
      });
    }
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
    // A pending revocation also needs a connection: it is how the runtime
    // finishes the remote revoke after a restart or a previous network error.
    void this.dataConnections.resumePersistedSessions().catch(() => undefined);
    this.schedule(0);
  }
  async stop() {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    if (this.accountTimer) clearTimeout(this.accountTimer);
    if (this.accountRenewalTimer) clearInterval(this.accountRenewalTimer);
    this.accountRenewalTimer = undefined;
    this.relayLinks.stop();
    this.relayTrace.close();
    this.nodeRelayChannels?.closeAll("runtime-stopped");
    await Promise.all([this.control.stop("control-plane-stopping"), this.dataConnections.closeAll("control-plane-stopping", { preserveSessions: true })]);
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

  /** Account node directory, read through the signed-in account session (never the binding credential). */
  async listAccountNodes() {
    const data = await this.accountRequest("/api/v1/nodes", { method: "GET" });
    return Array.isArray(data?.items) ? data.items : [];
  }

  /**
   * Claims an account node for this Control Plane. The Relay allocation arrives
   * as a pushed event once the node asks for it; nothing is created here.
   */
  async claimAccountNode(nodeHandle: string) {
    const result = await this.request("claim-node-relay-node", this.nodeRelayBindingPayload({ nodeHandle })) as { status?: string };
    this.nodeRelayChannels?.noteClaim(nodeHandle);
    return result;
  }

  /** Removes this Control Plane's claim; other Control Planes keep their channels. */
  async revokeAccountNodeClaim(nodeHandle: string) {
    try {
      return await this.request("revoke-node-relay-claim", this.nodeRelayBindingPayload({ nodeHandle }));
    } finally {
      // Even if the remote revoke cannot be delivered now, stop using the
      // local relay channel. A later stale allocation is then ignored because
      // the node stays linked through its original local connection.
      this.nodeRelayChannels?.forgetNode(nodeHandle);
    }
  }

  /**
   * One-time node binding token plus the cloud-rendered CLI command. The
   * onboarding hint is only for a node this Control Plane is introducing to
   * the account for the first time. Publishing an already-managed node must
   * leave that node on its existing local connection instead of claiming it
   * back through the cloud relay.
   */
  async issueNodeBindingToken(input: { displayName?: string; onboarding?: boolean } = {}) {
    return await this.request("issue-node-relay-binding-token", this.nodeRelayBindingPayload({
      ...(input.displayName ? { displayName: input.displayName } : {}),
      onboarding: input.onboarding !== false,
    })) as { tokenId: string; expiresAt: string; command: string; bindingToken?: string };
  }

  async cancelNodeBindingToken(tokenId: string) {
    await this.request("cancel-node-relay-binding-token", this.nodeRelayBindingPayload({ tokenId }));
    return { tokenId, cancelled: true as const };
  }

  /**
   * Node relay RPCs are authorized against the live binding, not just the
   * long-lived outbound connection. Include the binding identity explicitly so
   * a stale connection cannot issue tokens or claims after a re-bind.
   */
  private nodeRelayBindingPayload(payload: Record<string, unknown>) {
    const bindingId = this.options.state.snapshot().bindingId;
    if (!bindingId) throw runtimeError("CLOUD_BINDING_UNAVAILABLE");
    return { ...payload, bindingId };
  }

  nodeRelayState() {
    return {
      ...(this.nodeRelayChannels?.state() ?? { channels: [], claims: [], errors: [] }),
      onboarding: [...this.onboardingHints.entries()].map(([nodeHandle, hint]) => ({ nodeHandle, ...hint })),
    };
  }

  /**
   * A node generated by this Control Plane finished binding: claim it
   * immediately, exactly like a manual claim. Failures stay recorded so the UI
   * can explain and retry without losing the node in the account directory.
   */
  private async handleNodeBound(event: { nodeHandle?: unknown; tokenId?: unknown }) {
    if (!this.nodeRelayChannels) return { applied: false, reason: "node-relay-disabled" };
    const nodeHandle = typeof event?.nodeHandle === "string" ? event.nodeHandle : "";
    if (!nodeHandle) return { applied: false, reason: "invalid-hint" };
    this.onboardingHints.set(nodeHandle, {
      ...(typeof event.tokenId === "string" ? { tokenId: event.tokenId } : {}),
      at: new Date(this.clock()).toISOString(),
    });
    await this.claimAccountNode(nodeHandle).catch(() => undefined);
    return { applied: true };
  }

  /**
   * An authenticated account request. The access token is refreshed on demand
   * and never leaves this method; a rejected token signs the session out so the
   * UI falls back to the sign-in guidance.
   */
  private async accountRequest(path: string, init: RequestInit = {}) {
    const session = this.options.accountSession;
    if (!session.credentials()) throw accountError("CLOUD_ACCOUNT_SIGNED_OUT");
    if (!this.hasFreshAccessToken()) await this.refreshAccountCredential();
    const token = this.accessToken?.value;
    if (!token) throw accountError("CLOUD_ACCOUNT_SIGNED_OUT");
    const response = await this.cloudFetch(path, {
      ...init,
      headers: {
        ...(init.body ? { "content-type": "application/json" } : {}),
        ...(init.headers as Record<string, string> | undefined),
        authorization: `Bearer ${token}`,
        "x-task-handoff-client": "control-plane",
        [RESOURCE_SHARING_CAPABILITY_HEADER]: RESOURCE_SHARING_CLIENT_CAPABILITY,
      },
    });
    const body = await response.json().catch(() => undefined) as any;
    if (response.status === 401 || response.status === 403) {
      session.signOut("credential-rejected");
      throw accountError("CLOUD_ACCOUNT_SIGNED_OUT");
    }
    if (!response.ok) throw Object.assign(new Error(body?.error?.message || `Cloud account request failed with HTTP ${response.status}`), {
      code: typeof body?.error?.code === "string" ? body.error.code : "CLOUD_ACCOUNT_REQUEST_FAILED",
      statusCode: response.status,
    });
    return body?.data ?? body;
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
      if (requestId) this.applyAccountRequestResolution(requestId, payload);
      return { accepted: true };
    }
    if (operation === "relay-allocation") {
      // Relay authorization is suffix-based; this is the first time the Control Plane
      // learns a concrete host that actually resolves, so let the background prober
      // measure it for the next selection.
      this.relayLinks.observe(payload?.relayUrl);
      return this.dataConnections.attach(payload);
    }
    if (operation === "relay-session-grant") return this.dataConnections.applyGrant(payload);
    if (operation === "node-relay-allocation") {
      if (!this.nodeRelayChannels) throw runtimeError("NODE_RELAY_UNAVAILABLE");
      return this.nodeRelayChannels.attach(payload);
    }
    throw runtimeError("CLOUD_CONTROL_OPERATION_UNSUPPORTED");
  }

  private async ensureConnected() {
    if (!this.connecting) this.connecting = this.control.connectOnce().finally(() => { this.connecting = undefined; });
    const result = await this.connecting as { status: string; reused?: boolean; revocationFallback?: boolean };
    if (result.status !== "connected") throw runtimeError("CLOUD_CONTROL_CONNECTION_DISABLED");
    // The Coordinator only accepts an unbound registration when this identity
    // has no live binding. That means the revoked credential is stale and the
    // local pending revocation can be confirmed without another remote call.
    if (result.revocationFallback) this.options.state.confirmRevocation();
    else if (this.options.state.snapshot().status === "pending-revocation") await this.completePendingRevocation();
    if (!result.reused && !this.reconciling) this.reconciling = this.reconcileAccount().catch(() => undefined).finally(() => { this.reconciling = undefined; });
  }

  /**
   * A revocation that could not reach the cloud stays pending locally. Retry it
   * on every connection (including the one opened at process start) so the
   * state eventually becomes unbound and the account can sign in / re-bind.
   */
  private async completePendingRevocation() {
    if (!this.revoking) this.revoking = (async () => {
      const snapshot = this.options.state.snapshot();
      if (snapshot.status !== "pending-revocation" || !snapshot.bindingId) return;
      try {
        const result = await this.connector.request("revoke-binding", { bindingId: snapshot.bindingId }) as { status?: string } | undefined;
        if (result?.status === "revoked") this.options.state.confirmRevocation();
      } catch (error) {
        // The binding may already be gone (for example revoked from the
        // account page). In that case local confirmation is safe and unblocks
        // a fresh sign-in/bind. Other failures stay pending for another retry.
        if ((error as { code?: string } | undefined)?.code === "BINDING_NOT_FOUND") this.options.state.confirmRevocation();
        else this.schedule(15_000);
      }
    })().finally(() => { this.revoking = undefined; });
    await this.revoking;
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
        const result = await this.request("poll-control-plane-request", { requestId: pending.requestId }) as { status?: string; errorCode?: string } | undefined;
        this.applyAccountRequestResolution(pending.requestId, result);
      } catch { /* the request keeps its own TTL and the UI can retry */ }
    }
    if (this.options.accountSession.refreshCredential() && !this.hasFreshAccessToken()) await this.refreshAccountCredential();
    this.scheduleAccountPoll();
  }

  private applyAccountRequestResolution(requestId: string, result: { status?: unknown; errorCode?: unknown } | undefined) {
    const status = result?.status;
    if (status !== "denied" && status !== "expired" && status !== "delivered" && status !== "delivery-failed") return;
    this.options.accountSession.resolveRequest({
      requestId,
      status,
      ...(typeof result?.errorCode === "string" ? { errorCode: result.errorCode } : {}),
    });
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
    const response = await this.cloudFetch("/api/v1/auth/refresh", {
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
      if (response.status === 401 || response.status === 403 || response.status === 400) session.signOut("credential-rejected");
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

  private scheduleAccountPoll(delay = this.options.accountRequestPollMs ?? ACCOUNT_REQUEST_POLL_MS) {
    if (!this.running || this.accountTimer) return;
    if (!this.options.accountSession.hasPendingRequest()) return;
    this.accountTimer = setTimeout(() => { this.accountTimer = undefined; void this.reconcileAccount().catch(() => undefined).finally(() => this.scheduleAccountPoll()); }, delay);
    this.accountTimer.unref();
  }

  private cloudFetch(path: string, init?: RequestInit) {
    if (this.options.cloudDiscovery) return this.options.cloudDiscovery.request(path, init);
    return this.options.fetch(`${this.options.accountSession.origin}${path}`, init);
  }

  private schedule(delay = this.control.reconnectDelay()) {
    if (!this.running || this.timer) return;
    const state = this.options.state.snapshot();
    const active = state.status === "active" && (state.scopes.deviceAccess || state.scopes.nodeRelay);
    const revoking = state.status === "pending-revocation" && Boolean(state.bindingId) && Boolean(this.options.state.revocationCredential());
    if (!active && !revoking) return;
    this.timer = setTimeout(() => { this.timer = undefined; void this.ensureConnected().catch(() => this.schedule()); }, delay);
    this.timer.unref();
  }
}

function openRpcConnection(socket: WebSocket, options: { register: unknown; onEvent(event: unknown): void; onRegistered?(registration: { controlPlaneId: string; reportedControlPlaneId: string }): void; onRequest?(operation: string, payload: unknown): Promise<unknown>; onDisconnected(): void }): Promise<RpcConnection> {
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
      if (message.type === "registered") { const registration = OutboundConnectionRegistrationResponseSchema.parse(message); options.onRegistered?.(registration); registered = true; heartbeat = setInterval(() => socket.readyState === WebSocket.OPEN && socket.send(JSON.stringify({ type: "heartbeat" })), 10_000); heartbeat.unref(); return resolve(connection); }
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
  accountRequestPollMs?: number;
  verifyAllocation?: (allocation: unknown) => any;
  verifyRelaySessionGrant?: (grant: unknown) => any;
  relaySessionResumeEnabled?: boolean;
  cloudRelaySessionsPath?: string;
  cloudDiscovery?: CloudEndpointResolver;
  /** Alternate Coordinator transports; the persisted canonical origin stays first. */
  coordinatorOrigins?: readonly string[];
  onOriginFailover?: (entry: { fromOrigin: string; toOrigin: string; reason: string }) => void;
  nodeRelay?: {
    connector?: CloudNodeRelayChannelConnector;
    transport?: () => CloudNodeRelayChannelTransport | undefined;
    nodes: CloudNodeRelayChannelsOptions["nodes"];
    audit?: CloudNodeRelayChannelsOptions["audit"];
  };
  webSocket?: typeof WebSocket;
  fetch?: typeof fetch;
  clock?: () => number;
};

function accessTokenLifetimeSeconds(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 300;
}

function runtimeError(code: string) { return Object.assign(new Error("Cloud background connection is unavailable."), { code, retryable: true }); }
function accountError(code: string) { return Object.assign(new Error("Cloud account session is unavailable."), { code, statusCode: 409 }); }
