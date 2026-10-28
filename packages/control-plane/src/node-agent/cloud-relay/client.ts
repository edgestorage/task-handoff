import crypto from "node:crypto";
import WebSocket from "ws";
import type { NodeRelayClaimGrant, NodeRelayNodeAllocation } from "@task-handoff/cloud-contracts";
import type { NodeAgentCloudRelayStatus } from "@task-handoff/protocol/control-plane";
import { initiateNodeRelayHandshake, nodeRelayFingerprint, writeNodeAgentControlPlaneTrustOutcome, type NodeRelayFrameSocket } from "../../shared/cloud-relay/node-relay-session.ts";
import { EventConnectionRetryTimer } from "../../shared/events/connection-retry.ts";
import { WebSocketConnectionSupervisor } from "../../shared/transport/websocket-connection-supervisor.ts";
import type { NodeAgentIdentityService } from "../identity/service.ts";
import { NodeRelayCloudClient } from "./cloud-client.ts";
import { verifyNodeRelayClaimGrant } from "./claim-grant.ts";
import { NodeRelayNodeChannel, type NodeRelayTunnelHost } from "./channel.ts";
import { probeNodeRelayTargets } from "./probe.ts";
import type { NodeAgentCloudRelayBinding, NodeAgentCloudRelayStoredError } from "./types.ts";
import type { NodeAgentCloudControlPlanePin, NodeAgentCloudControlPlaneTrustContext, NodeAgentCloudControlPlaneTrustRequest } from "./trust-types.ts";
import { cloudOriginError, resolveCloudOrigin, trustedNodeRelayUrl } from "./trust.ts";
import { CloudEndpointResolver, hostMatchesSuffix, type CloudDiscoveryConfig } from "../../../../../shared/cloud-discovery.cjs";

const DEFAULT_POLL_INTERVAL_MS = 15_000;
const DEFAULT_IDLE_POLL_INTERVAL_MS = 5_000;
const DEFAULT_LEASE_RENEWAL_RATIO = 0.15;
const DEFAULT_CREDENTIAL_RENEW_BEFORE_MS = 5 * 24 * 60 * 60 * 1000;
const DEFAULT_ATTACH_TIMEOUT_MS = 10_000;
const CREDENTIAL_GRACE_MS = 5 * 60 * 1000;

type VerifiedAllocation = { allocation: NodeRelayNodeAllocation; grant: NodeRelayClaimGrant };

type ChannelAttempt = {
  id: number;
  allocationId: string;
  phase: "dialing" | "attaching" | "trust-checking" | "handshaking";
  startedAt: number;
  controller: AbortController;
  socket?: WebSocket;
};

type ChannelEntry = {
  controlPlaneId: string;
  allocationId?: string;
  expiresAt?: string;
  status: "connecting" | "connected" | "reconnecting" | "failed";
  channel?: NodeRelayNodeChannel;
  socket?: WebSocket;
  supervisor?: WebSocketConnectionSupervisor;
  retry: EventConnectionRetryTimer;
  attempt?: ChannelAttempt;
  missingPolls: number;
  connectedAt?: string;
  lastDisconnectedAt?: string;
  nextRetryAt?: string;
  error?: string;
  activePinId?: string;
  activeContextKey?: string;
  suppressedContextKey?: string;
};

export type NodeAgentCloudRelayClientOptions = {
  identity: NodeAgentIdentityService;
  host: NodeRelayTunnelHost;
  nodeId: string;
  fetchImpl?: typeof fetch;
  relayProbeFetch?: typeof fetch;
  cloudDiscovery?: CloudDiscoveryConfig;
  discoveryCachePath?: string;
  webSocket?: typeof WebSocket;
  pollIntervalMs?: number;
  idlePollIntervalMs?: number;
  attachTimeoutMs?: number;
  leaseRenewalRatio?: number;
  credentialRenewBeforeMs?: number;
  now?: () => number;
  random?: () => number;
};

function generateRelayKeyPair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  return {
    publicKey: String((publicKey.export({ format: "jwk" }) as { x: string }).x),
    privateKey: privateKey.export({ format: "der", type: "pkcs8" }).toString("base64url"),
  };
}

function relayKeySigner(binding: NodeAgentCloudRelayBinding) {
  const key = crypto.createPrivateKey({ key: Buffer.from(binding.relayPrivateKey, "base64url"), format: "der", type: "pkcs8" });
  return {
    publicKey: binding.relayPublicKey,
    sign(input: string) {
      return crypto.sign(null, Buffer.from(input), key).toString("base64url");
    },
  };
}

function controlPlaneTrustContext(binding: NodeAgentCloudRelayBinding, grant: NodeRelayClaimGrant, nodeId: string): NodeAgentCloudControlPlaneTrustContext {
  if (!grant.controlPlanePublicKey) throw relayError("NODE_AGENT_CLOUD_RELAY_CONTROL_PLANE_KEY_MISSING");
  const accessMode = grant.accessMode ?? "owner";
  const ownerAccountId = grant.ownerAccountId ?? grant.accountId;
  return {
    nodeId,
    nodeHandle: grant.nodeHandle,
    controlPlaneId: grant.controlPlaneId,
    controlPlanePublicKey: grant.controlPlanePublicKey,
    bindingId: grant.bindingId,
    bindingRevision: grant.bindingRevision,
    accountId: grant.accountId,
    ownerAccountId,
    accessMode,
    ...(accessMode === "shared" && grant.shareGrantId ? { shareGrantId: grant.shareGrantId } : {}),
    ...(accessMode === "shared" && grant.shareRole ? { shareRole: grant.shareRole } : {}),
    ...(accessMode === "shared" && grant.shareRevision ? { shareRevision: grant.shareRevision } : {}),
  };
}

function controlPlaneTrustContextKey(context: NodeAgentCloudControlPlaneTrustContext) {
  return [
    context.nodeHandle,
    context.controlPlaneId,
    context.controlPlanePublicKey,
    context.bindingId,
    context.accountId,
    context.ownerAccountId,
    context.accessMode,
    context.shareGrantId ?? "",
    context.shareRole ?? "",
  ].join("\0");
}

function controlPlaneTrustContextKeyFromPin(pin: NodeAgentCloudControlPlanePin) {
  return controlPlaneTrustContextKey({
    nodeId: pin.nodeId,
    nodeHandle: pin.nodeHandle,
    controlPlaneId: pin.controlPlaneId,
    controlPlanePublicKey: pin.controlPlanePublicKey,
    bindingId: pin.bindingId,
    bindingRevision: pin.bindingRevision,
    accountId: pin.accessAccountId,
    ownerAccountId: pin.ownerAccountId,
    accessMode: pin.accessMode,
    ...(pin.shareGrantId ? { shareGrantId: pin.shareGrantId } : {}),
    ...(pin.shareRole ? { shareRole: pin.shareRole } : {}),
    ...(pin.shareRevision ? { shareRevision: pin.shareRevision } : {}),
  });
}

function controlPlaneTrustContextKeyFromRequest(request: NodeAgentCloudControlPlaneTrustRequest) {
  return controlPlaneTrustContextKey({
    nodeId: request.nodeId,
    nodeHandle: request.nodeHandle,
    controlPlaneId: request.controlPlaneId,
    controlPlanePublicKey: request.controlPlanePublicKey,
    bindingId: request.bindingId,
    bindingRevision: request.bindingRevision,
    accountId: request.accessAccountId,
    ownerAccountId: request.ownerAccountId,
    accessMode: request.accessMode,
    ...(request.shareGrantId ? { shareGrantId: request.shareGrantId } : {}),
    ...(request.shareRole ? { shareRole: request.shareRole } : {}),
    ...(request.shareRevision ? { shareRevision: request.shareRevision } : {}),
  });
}

function relayErrorCode(error: unknown) {
  const code = (error as { code?: unknown } | undefined)?.code;
  return typeof code === "string" ? code : "NODE_AGENT_CLOUD_RELAY_CONNECT_FAILED";
}

function socketCloseMessage(code: number, reason: Buffer | string) {
  const text = Buffer.from(reason).toString("utf8").trim();
  return text ? `Cloud relay socket closed (${code}: ${text}).` : `Cloud relay socket closed (${code}).`;
}

function socketOpen(socket: WebSocket, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (socket.readyState === WebSocket.OPEN) {
      resolve();
      return;
    }
    let settled = false;
    const cleanup = () => {
      socket.off("open", onOpen);
      socket.off("error", onError);
      socket.off("close", onClose);
      signal.removeEventListener("abort", onAbort);
    };
    const finish = (error?: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error === undefined) resolve();
      else reject(error);
    };
    const onOpen = () => finish();
    const onError = (error: Error) => finish(error);
    const onClose = (code: number, reason: Buffer) => finish(relayError("NODE_AGENT_CLOUD_RELAY_SOCKET_CLOSED", socketCloseMessage(code, reason)));
    const onAbort = () => finish(signal.reason instanceof Error ? signal.reason : relayError("NODE_AGENT_CLOUD_RELAY_ATTEMPT_ABORTED"));
    socket.once("open", onOpen);
    socket.once("error", onError);
    socket.once("close", onClose);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}

function socketMessage(socket: WebSocket, predicate: (value: any) => boolean, options: {
  signal: AbortSignal;
  timeoutMs: number;
  timeoutCode: string;
  timeoutMessage: string;
}) {
  return new Promise<any>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => finish(relayError(options.timeoutCode, options.timeoutMessage)), options.timeoutMs);
    timer.unref?.();
    const cleanup = () => {
      clearTimeout(timer);
      socket.off("message", onMessage);
      socket.off("close", onClose);
      socket.off("error", onError);
      options.signal.removeEventListener("abort", onAbort);
    };
    const finish = (error?: unknown, value?: any) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error === undefined) resolve(value);
      else reject(error);
    };
    const onMessage = (raw: WebSocket.RawData) => {
      try {
        const value = JSON.parse(raw.toString());
        if (value?.type === "error" || value?.type === "relay-error") {
          const code = typeof value.code === "string" ? value.code : "NODE_AGENT_CLOUD_RELAY_ATTACH_REJECTED";
          const message = typeof value.message === "string" ? value.message : "The relay rejected the node channel attach.";
          finish(relayError(code, message));
          return;
        }
        if (predicate(value)) {
          finish(undefined, value);
        }
      } catch (error) {
        finish(error);
      }
    };
    const onClose = (code: number, reason: Buffer) => finish(relayError("NODE_AGENT_CLOUD_RELAY_SOCKET_CLOSED", socketCloseMessage(code, reason)));
    const onError = (error: Error) => finish(error);
    const onAbort = () => finish(options.signal.reason instanceof Error ? options.signal.reason : relayError("NODE_AGENT_CLOUD_RELAY_ATTEMPT_ABORTED"));
    socket.on("message", onMessage);
    socket.once("close", onClose);
    socket.once("error", onError);
    options.signal.addEventListener("abort", onAbort, { once: true });
    if (options.signal.aborted) onAbort();
  });
}

function relayError(code: string, message = "Cloud relay channel is unavailable.") {
  return Object.assign(new Error(message), { code, retryable: true });
}

function credentialRejected(error: unknown) {
  const record = error as { code?: unknown; statusCode?: unknown } | undefined;
  const code = typeof record?.code === "string" ? record.code : "";
  if (code === "NODE_RELAY_CREDENTIAL_INVALID" || code === "NODE_RELAY_CREDENTIAL_EXPIRED" ||
      code === "NODE_RELAY_NOT_FOUND" || code === "NODE_RELAY_NOT_ACTIVE") return true;
  return record?.statusCode === 401;
}

/**
 * Owns the node end of the account relay: redemption and credential lifecycle,
 * allocation polling, one independent channel per claiming Control Plane, and
 * the pairing each first claim pins. Nothing here touches local instances or
 * the existing direct/reverse connections.
 */
export class NodeAgentCloudRelayClient {
  private readonly options: NodeAgentCloudRelayClientOptions;
  private readonly channels = new Map<string, ChannelEntry>();
  private readonly discoveryResolvers = new Map<string, Promise<CloudEndpointResolver | undefined>>();
  private readonly refreshControlPlaneIds = new Set<string>();
  private pollTimer?: ReturnType<typeof setTimeout>;
  private pollDueAt?: number;
  private polling = false;
  private pollAgain = false;
  private stopped = true;
  private attemptSequence = 0;
  private readonly adaptiveSelectionUnsupported = new Set<string>();
  private lastError?: NodeAgentCloudRelayStoredError;

  constructor(options: NodeAgentCloudRelayClientOptions) {
    this.options = options;
  }

  start() {
    this.stopped = false;
    if (this.binding()?.status === "active") this.schedulePoll(0);
  }

  stop() {
    this.stopped = true;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = undefined;
    this.pollDueAt = undefined;
    this.closeAllChannels("node-agent-stopped");
  }

  binding() {
    return this.options.identity.cloudRelayBinding();
  }

  async bind(input: { cloudOrigin?: string; bindingToken: string; displayName?: string }) {
    const current = this.binding();
    if (current?.status === "active") {
      throw Object.assign(new Error("This node is already bound to a cloud account."), { statusCode: 409, code: "NODE_AGENT_CLOUD_RELAY_ALREADY_BOUND" });
    }
    const explicitOrigin = input.cloudOrigin?.trim();
    const discovery = this.options.cloudDiscovery;
    const requestedOrigin = explicitOrigin || discovery?.fallbackOrigin;
    if (!requestedOrigin) {
      throw Object.assign(new Error("Cloud relay origin is required when the build has no cloud discovery record."), {
        statusCode: 400,
        code: "NODE_AGENT_CLOUD_RELAY_ORIGIN_REQUIRED",
      });
    }
    const cloudOrigin = resolveCloudOrigin(requestedOrigin);
    const parsedCloudOrigin = new URL(cloudOrigin);
    if (explicitOrigin && discovery && parsedCloudOrigin.protocol === "https:" && !discovery.allowedHostSuffixes.some((suffix) => hostMatchesSuffix(parsedCloudOrigin.hostname, suffix))) {
      throw cloudOriginError(
        "NODE_AGENT_CLOUD_RELAY_ORIGIN_UNTRUSTED",
        "Cloud relay origin must belong to the configured cloud environment.",
      );
    }
    // An explicit command-line origin is a pin, not a discovery fallback. The
    // npm package ships the production discovery record, so consulting it here
    // would silently redirect a staging --cloud-origin to production.
    const resolver = explicitOrigin ? undefined : await this.discoveryResolver(cloudOrigin);
    const cloud = await this.cloudClient(cloudOrigin, !explicitOrigin);
    const relayKeys = generateRelayKeyPair();
    // Redemption is the only step that can fail before anything local changes:
    // an invalid, expired or replayed token leaves the node exactly as it was.
    const redeemed = await cloud.redeem({
      bindingToken: input.bindingToken,
      nodeId: this.options.nodeId,
      publicKey: relayKeys.publicKey,
      ...(input.displayName ? { displayName: input.displayName } : {}),
    });
    const redeemedOrigin = new URL(redeemed.serviceOrigin).origin;
    const serviceOriginTrusted = resolver ? resolver.isTrustedOrigin(redeemedOrigin) : redeemedOrigin === cloudOrigin;
    if (!serviceOriginTrusted) {
      throw Object.assign(new Error("The cloud returned a different service origin than the one the command pinned."), {
        statusCode: 400,
        code: "NODE_AGENT_CLOUD_RELAY_ORIGIN_MISMATCH",
      });
    }
    if (!redeemed.serviceSigningKey) {
      throw Object.assign(new Error("The cloud did not return the signing key needed to verify claim grants."), {
        statusCode: 400,
        code: "NODE_AGENT_CLOUD_RELAY_TRUST_ANCHOR_MISSING",
      });
    }
    const timestamp = new Date(this.now()).toISOString();
    this.options.identity.saveCloudRelayBinding({
      status: "active",
      nodeHandle: redeemed.nodeHandle,
      accountId: redeemed.accountId,
      cloudOrigin,
      cloudOriginMode: explicitOrigin ? "pinned" : "discovered",
      serviceOrigin: redeemedOrigin,
      credential: redeemed.credential,
      credentialExpiresAt: redeemed.credentialExpiresAt,
      serviceSigningKey: redeemed.serviceSigningKey,
      relayPublicKey: relayKeys.publicKey,
      relayPrivateKey: relayKeys.privateKey,
      pairedControlPlaneIds: current?.pairedControlPlaneIds ?? [],
      boundAt: timestamp,
    });
    this.lastError = undefined;
    this.stopped = false;
    this.schedulePoll(0);
    return this.status();
  }

  async unbind() {
    const binding = this.binding();
    if (!binding) return { unbound: false, cloudUnbind: "not-bound" as const };
    let cloudUnbind: "confirmed" | "unavailable" = "unavailable";
    try {
      await (await this.boundCloudClient(binding)).unbind(binding.credential);
      cloudUnbind = "confirmed";
    } catch (error) {
      this.options.host.log.warn({
        nodeId: this.options.nodeId,
        code: (error as { code?: unknown })?.code,
      }, "node agent cloud relay unbind could not be confirmed with the cloud");
    }
    this.closeAllChannels("unbound");
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = undefined;
    this.pollDueAt = undefined;
    this.options.identity.clearCloudRelayPairings();
    this.options.identity.clearCloudRelayBinding();
    this.lastError = undefined;
    return { unbound: true, nodeHandle: binding.nodeHandle, cloudUnbind };
  }

  status(): NodeAgentCloudRelayStatus {
    const binding = this.binding();
    const channels = [...this.channels.values()]
      .sort((left, right) => left.controlPlaneId.localeCompare(right.controlPlaneId))
      .map((entry) => ({
        controlPlaneId: entry.controlPlaneId,
        status: entry.status,
        ...(entry.connectedAt ? { connectedAt: entry.connectedAt } : {}),
        ...(entry.lastDisconnectedAt ? { lastDisconnectedAt: entry.lastDisconnectedAt } : {}),
        ...(entry.nextRetryAt ? { nextRetryAt: entry.nextRetryAt } : {}),
        ...(entry.error ? { error: entry.error } : {}),
      }));
    const lastError = this.lastError ?? binding?.lastError;
    return {
      bound: Boolean(binding),
      ...(binding?.status === "rebind-required" ? { rebindRequired: true } : {}),
      ...(binding?.nodeHandle ? { nodeHandle: binding.nodeHandle } : {}),
      ...(binding?.accountId ? { accountId: binding.accountId } : {}),
      ...(binding?.cloudOrigin ? { cloudOrigin: binding.cloudOrigin } : {}),
      ...(binding?.boundAt ? { boundAt: binding.boundAt } : {}),
      ...(binding?.credentialExpiresAt ? { credentialExpiresAt: binding.credentialExpiresAt } : {}),
      channels,
      ...(lastError ? { lastError } : {}),
    };
  }

  /** Forces one reconciliation; used by tests and by channel failure recovery. */
  pollNow() {
    this.schedulePoll(0);
  }

  controlPlaneTrustChanged(revoked?: NodeAgentCloudControlPlanePin) {
    if (revoked) {
      for (const entry of this.channels.values()) {
        if (entry.activePinId !== revoked.id && entry.activeContextKey !== controlPlaneTrustContextKeyFromPin(revoked)) continue;
        entry.activePinId = undefined;
        entry.activeContextKey = undefined;
        entry.status = "reconnecting";
        entry.error = "The local Control Plane trust was revoked.";
        entry.lastDisconnectedAt = new Date(this.now()).toISOString();
        this.releaseChannel(entry, "control-plane-trust-revoked");
        this.refreshControlPlaneIds.add(entry.controlPlaneId);
      }
    }
    this.schedulePoll(0);
  }

  controlPlaneTrustRetried(request: NodeAgentCloudControlPlaneTrustRequest) {
    const key = controlPlaneTrustContextKeyFromRequest(request);
    for (const entry of this.channels.values()) {
      if (entry.suppressedContextKey === key) entry.suppressedContextKey = undefined;
    }
    this.refreshControlPlaneIds.add(request.controlPlaneId);
    this.schedulePoll(0);
  }

  private async cloudClient(cloudOrigin: string, useDiscovery = true) {
    const resolver = useDiscovery ? await this.discoveryResolver(cloudOrigin) : undefined;
    return new NodeRelayCloudClient({
      cloudOrigin: resolver ? () => resolver.activeOrigin : cloudOrigin,
      ...(this.options.fetchImpl ? { fetchImpl: this.options.fetchImpl } : {}),
      ...(resolver ? {
        onOriginSuccess: (origin: string) => resolver.markSuccess(origin),
        onOriginFailure: (origin: string) => resolver.markFailure(origin),
      } : {}),
    });
  }

  private boundCloudClient(binding: NodeAgentCloudRelayBinding) {
    return this.cloudClient(binding.cloudOrigin, binding.cloudOriginMode === "discovered");
  }

  private discoveryResolver(cloudOrigin: string) {
    const canonicalOrigin = new URL(cloudOrigin).origin;
    const existing = this.discoveryResolvers.get(canonicalOrigin);
    if (existing) return existing;
    const pending = (async () => {
      const discovery = this.options.cloudDiscovery;
      if (!discovery) return undefined;
      const parsed = new URL(canonicalOrigin);
      if (parsed.protocol !== "https:") return undefined;
      if (!discovery.allowedHostSuffixes.some((suffix) => hostMatchesSuffix(parsed.hostname, suffix))) return undefined;
      const resolver = new CloudEndpointResolver({
        config: { ...discovery, fallbackOrigin: canonicalOrigin },
        fallbackOrigin: canonicalOrigin,
        ...(this.options.fetchImpl ? { fetchImpl: this.options.fetchImpl } : {}),
        ...(this.options.discoveryCachePath ? { cachePath: this.options.discoveryCachePath } : {}),
        now: () => this.now(),
      });
      await resolver.initialize();
      return resolver;
    })();
    this.discoveryResolvers.set(canonicalOrigin, pending);
    return pending;
  }

  private now() {
    return this.options.now ? this.options.now() : Date.now();
  }

  private schedulePoll(delayMs: number) {
    if (this.stopped) return;
    const due = this.now() + Math.max(0, delayMs);
    if (this.pollTimer && this.pollDueAt !== undefined && this.pollDueAt <= due) return;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollDueAt = due;
    this.pollTimer = setTimeout(() => {
      this.pollTimer = undefined;
      this.pollDueAt = undefined;
      void this.poll().catch(() => {});
    }, Math.max(0, delayMs));
    this.pollTimer.unref?.();
  }

  private async poll() {
    let binding: NodeAgentCloudRelayBinding | undefined;
    try {
      binding = this.binding();
    } catch {
      // The identity store can already be closed while a poll was in flight.
      return;
    }
    if (!binding || this.stopped || binding.status !== "active") return;
    if (this.polling) {
      this.pollAgain = true;
      return;
    }
    this.polling = true;
    try {
      await this.renewCredentialIfDue(binding);
      if (this.stopped) return;
      const current = this.binding();
      if (!current || current.status !== "active") return;
      const refreshControlPlaneIds = [...this.refreshControlPlaneIds];
      const allocations = await this.reconnectAllocations(current, refreshControlPlaneIds);
      if (this.stopped) return;
      if (this.applyAllocations(current, allocations)) this.lastError = undefined;
      this.schedulePoll(allocations.length || this.channels.size ? this.pollIntervalMs() : this.idlePollIntervalMs());
    } catch (error) {
      if (this.stopped) return;
      const failed = this.binding();
      if (credentialRejected(error)) {
        this.markRebindRequired(error);
        return;
      }
      this.lastError = {
        code: (error as { code?: unknown })?.code !== undefined ? String((error as { code?: unknown }).code) : "NODE_AGENT_CLOUD_RELAY_POLL_FAILED",
        message: error instanceof Error ? error.message : String(error),
        at: new Date(this.now()).toISOString(),
        retryable: true,
      };
      if (failed?.status === "active") this.schedulePoll(this.pollRetryDelayMs());
    } finally {
      this.polling = false;
      if (this.pollAgain) {
        this.pollAgain = false;
        this.schedulePoll(0);
      }
    }
  }

  private pollIntervalMs() {
    return this.options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  }

  private async reconnectAllocations(binding: NodeAgentCloudRelayBinding, refreshControlPlaneIds: string[]) {
    const cloud = await this.boundCloudClient(binding);
    const request = {
      nodeId: this.options.nodeId,
      ...(refreshControlPlaneIds.length ? { refreshControlPlaneIds } : {}),
    };
    if (!refreshControlPlaneIds.length || this.adaptiveSelectionUnsupported.has(binding.serviceOrigin)) {
      return cloud.allocations(binding.credential, request);
    }
    try {
      const targets = await cloud.probeTargets(binding.credential, { nodeId: this.options.nodeId, controlPlaneIds: refreshControlPlaneIds });
      if (!targets.length) return cloud.allocations(binding.credential, request);
      const probe = await probeNodeRelayTargets({
        targets,
        serviceOrigin: binding.serviceOrigin,
        fetchImpl: this.options.relayProbeFetch ?? fetch,
        now: () => this.now(),
      });
      return await cloud.allocationsV2(binding.credential, {
        ...request,
        probeEvidence: { measurements: probe.measurements },
      });
    } catch (error) {
      if ((error as { unsupported?: unknown })?.unsupported === true) this.adaptiveSelectionUnsupported.add(binding.serviceOrigin);
      this.options.host.log.warn({
        nodeId: this.options.nodeId,
        code: (error as { code?: unknown })?.code ?? "NODE_AGENT_CLOUD_RELAY_ADAPTIVE_FALLBACK",
        reason: this.adaptiveSelectionUnsupported.has(binding.serviceOrigin) ? "unsupported" : "request-failed",
      }, "node agent cloud relay adaptive selection fell back to v1");
      return cloud.allocations(binding.credential, request);
    }
  }

  private idlePollIntervalMs() {
    return this.options.idlePollIntervalMs ?? DEFAULT_IDLE_POLL_INTERVAL_MS;
  }

  private pollRetryDelayMs() {
    const delay = this.options.random ? Math.round(250 * (0.75 + this.options.random() * 0.5)) : 250;
    return delay;
  }

  private async renewCredentialIfDue(binding: NodeAgentCloudRelayBinding) {
    const renewBefore = this.options.credentialRenewBeforeMs ?? DEFAULT_CREDENTIAL_RENEW_BEFORE_MS;
    if (Date.parse(binding.credentialExpiresAt) - this.now() > renewBefore) return;
    const renewed = await (await this.boundCloudClient(binding)).renew(binding.credential);
    this.options.identity.updateCloudRelayBinding((current) => ({
      ...current,
      credential: renewed.credential,
      credentialExpiresAt: renewed.expiresAt,
    }));
  }

  private markRebindRequired(error: unknown) {
    const record = error as { code?: unknown } | undefined;
    const at = new Date(this.now()).toISOString();
    const stored: NodeAgentCloudRelayStoredError = {
      code: typeof record?.code === "string" ? record.code : "NODE_AGENT_CLOUD_RELAY_REBIND_REQUIRED",
      message: "The node credential was refused; bind the node to an account again.",
      at,
      retryable: false,
    };
    this.closeAllChannels("credential-refused");
    this.options.identity.markCloudRelayRebindRequired(stored);
    this.lastError = stored;
    this.options.host.log.warn({ nodeId: this.options.nodeId, code: stored.code }, "node agent cloud relay requires rebinding");
  }

  /** Applies one poll result; returns false when any allocation failed verification so the caller keeps the error visible. */
  private applyAllocations(binding: NodeAgentCloudRelayBinding, allocations: NodeRelayNodeAllocation[]) {
    let complete = true;
    const seen = new Set<string>();
    for (const allocation of allocations) {
      let verified: VerifiedAllocation;
      let controlPlaneId: string;
      try {
        controlPlaneId = String(allocation.claimGrant?.controlPlaneId ?? "");
        verified = this.verifyAllocation(binding, allocation);
      } catch (error) {
        complete = false;
        this.recordAllocationError(controlPlaneId, error);
        continue;
      }
      seen.add(verified.grant.controlPlaneId);
      const entry = this.ensureEntry(verified.grant.controlPlaneId);
      entry.missingPolls = 0;
      const trustContextKey = controlPlaneTrustContextKey(controlPlaneTrustContext(binding, verified.grant, this.options.nodeId));
      if (entry.suppressedContextKey === trustContextKey) {
        entry.expiresAt = allocation.expiresAt;
        continue;
      }
      entry.suppressedContextKey = undefined;
      // A refresh is complete only when the Coordinator actually issues a new
      // allocation id. Reusing the old id would replay an attach capability
      // that the Relay has already consumed.
      if (this.refreshControlPlaneIds.has(verified.grant.controlPlaneId) && entry.allocationId === allocation.allocationId) {
        complete = false;
        entry.status = "failed";
        entry.error ??= "The Coordinator reused a consumed cloud relay allocation after a refresh request.";
        this.scheduleEntryRetry(entry);
        continue;
      }
      this.refreshControlPlaneIds.delete(verified.grant.controlPlaneId);
      const live = entry.status === "connected" || Boolean(entry.attempt);
      if (live && entry.allocationId === allocation.allocationId) {
        entry.expiresAt = allocation.expiresAt;
        continue;
      }
      this.releaseChannel(entry, "allocation-superseded");
      entry.allocationId = allocation.allocationId;
      entry.expiresAt = allocation.expiresAt;
      void this.openEntry(entry, verified);
    }
    for (const [controlPlaneId, entry] of [...this.channels]) {
      if (seen.has(controlPlaneId)) continue;
      entry.missingPolls += 1;
      // The allocation list is authoritative: once the Coordinator withdraws a
      // claim the live channel must go too, not just the reconnect attempt.
      if (entry.missingPolls >= 2) {
        complete = false;
        entry.error ??= "The cloud withdrew this Control Plane's allocation.";
        this.releaseChannel(entry, "allocation-withdrawn");
        this.channels.delete(controlPlaneId);
      }
    }
    return complete;
  }

  private verifyAllocation(binding: NodeAgentCloudRelayBinding, allocation: NodeRelayNodeAllocation): VerifiedAllocation {
    if (!binding.serviceSigningKey) throw relayError("NODE_AGENT_CLOUD_RELAY_TRUST_ANCHOR_MISSING");
    const grant = verifyNodeRelayClaimGrant({ grant: allocation.claimGrant, trust: binding.serviceSigningKey, now: this.now() });
    const attach = allocation.nodeAttach;
    const accessMode = grant.accessMode ?? "owner";
    const ownerAccountId = grant.ownerAccountId ?? grant.accountId;
    const authorityValid = accessMode === "shared"
      ? ownerAccountId === binding.accountId && grant.accountId !== ownerAccountId && Boolean(grant.shareGrantId) && Boolean(grant.shareRevision) && grant.shareRole === "use"
      : ownerAccountId === binding.accountId && grant.accountId === ownerAccountId && grant.shareGrantId === undefined && grant.shareRevision === undefined && grant.shareRole === undefined;
    const attachAuthorityMatches = attach.accountId === grant.accountId
      && sameOptional(attach.ownerAccountId, grant.ownerAccountId)
      && sameOptional(attach.accessMode, grant.accessMode)
      && sameOptional(attach.shareGrantId, grant.shareGrantId)
      && sameOptional(attach.shareRevision, grant.shareRevision)
      && sameOptional(attach.shareRole, grant.shareRole);
    if (grant.allocationId !== allocation.allocationId || grant.relayId !== allocation.relayId || grant.relayUrl !== allocation.relayUrl ||
        grant.nodeHandle !== binding.nodeHandle || !authorityValid || !attachAuthorityMatches || !grant.controlPlanePublicKey ||
        attach.channelKind !== "node" || attach.role !== "node-agent" || attach.allocationId !== allocation.allocationId ||
        attach.relayId !== grant.relayId || attach.controlPlaneId !== grant.controlPlaneId || attach.nodeHandle !== grant.nodeHandle ||
        attach.bindingId !== grant.bindingId || attach.bindingRevision !== grant.bindingRevision || attach.expiresAt !== grant.expiresAt) {
      throw relayError("NODE_AGENT_CLOUD_RELAY_ALLOCATION_MISMATCH");
    }
    if (!trustedNodeRelayUrl(allocation.relayUrl, binding.serviceOrigin)) throw relayError("NODE_AGENT_CLOUD_RELAY_UNTRUSTED_RELAY");
    return { allocation, grant };
  }

  private ensureEntry(controlPlaneId: string) {
    const existing = this.channels.get(controlPlaneId);
    if (existing) return existing;
    const entry: ChannelEntry = { controlPlaneId, status: "connecting", retry: new EventConnectionRetryTimer(this.options.random), missingPolls: 0 };
    this.channels.set(controlPlaneId, entry);
    return entry;
  }

  private recordAllocationError(controlPlaneId: string, error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    const code = (error as { code?: unknown })?.code !== undefined ? String((error as { code?: unknown }).code) : "NODE_AGENT_CLOUD_RELAY_ALLOCATION_INVALID";
    if (!controlPlaneId) {
      this.lastError = { code, message, at: new Date(this.now()).toISOString(), retryable: true };
      return;
    }
    const entry = this.ensureEntry(controlPlaneId);
    entry.status = "failed";
    entry.error = message;
    this.lastError = { code, message, at: new Date(this.now()).toISOString(), retryable: true };
  }

  private async openEntry(entry: ChannelEntry, verified: VerifiedAllocation) {
    const binding = this.binding();
    if (this.stopped || !binding || binding.status !== "active") return;
    if (entry.attempt?.allocationId === verified.allocation.allocationId) return;
    if (entry.attempt) this.abortAttempt(entry, entry.attempt, "allocation-superseded");
    const attempt: ChannelAttempt = {
      id: ++this.attemptSequence,
      allocationId: verified.allocation.allocationId,
      phase: "dialing",
      startedAt: this.now(),
      controller: new AbortController(),
    };
    entry.attempt = attempt;
    entry.status = entry.connectedAt ? "reconnecting" : "connecting";
    entry.error = undefined;
    entry.nextRetryAt = undefined;
    const Socket = this.options.webSocket ?? WebSocket;
    const socket = new Socket(verified.allocation.relayUrl, { followRedirects: false, handshakeTimeout: 10_000, perMessageDeflate: false });
    attempt.socket = socket;
    entry.socket = socket;
    socket.on("error", (error) => this.log("debug", {
      nodeId: this.options.nodeId,
      controlPlaneId: entry.controlPlaneId,
      allocationId: attempt.allocationId,
      attemptId: attempt.id,
      phase: attempt.phase,
      error: error.message,
    }, "node agent cloud relay socket error"));
    this.log("info", {
      nodeId: this.options.nodeId,
      controlPlaneId: entry.controlPlaneId,
      allocationId: attempt.allocationId,
      attemptId: attempt.id,
      relayUrl: verified.allocation.relayUrl,
    }, "node agent cloud relay connecting");
    try {
      await socketOpen(socket, attempt.controller.signal);
      this.assertCurrentAttempt(entry, attempt);
      attempt.phase = "attaching";
      this.log("debug", {
        nodeId: this.options.nodeId,
        controlPlaneId: entry.controlPlaneId,
        allocationId: attempt.allocationId,
        attemptId: attempt.id,
      }, "node agent cloud relay websocket opened");
      socket.send(JSON.stringify({ type: "attach", capability: verified.allocation.nodeAttach }));
      this.log("debug", {
        nodeId: this.options.nodeId,
        controlPlaneId: entry.controlPlaneId,
        allocationId: attempt.allocationId,
        attemptId: attempt.id,
      }, "node agent cloud relay attach sent");
      const attachTimeoutMs = this.options.attachTimeoutMs ?? DEFAULT_ATTACH_TIMEOUT_MS;
      const attached = await socketMessage(socket, (value) => value?.type === "attached", {
        signal: attempt.controller.signal,
        timeoutMs: attachTimeoutMs,
        timeoutCode: "NODE_AGENT_CLOUD_RELAY_ATTACH_TIMEOUT",
        timeoutMessage: `Cloud relay attach timed out after ${attachTimeoutMs}ms.`,
      });
      this.assertCurrentAttempt(entry, attempt);
      if (attached.allocationId !== undefined && String(attached.allocationId) !== attempt.allocationId) {
        throw relayError("NODE_AGENT_CLOUD_RELAY_ATTACH_MISMATCH", "The relay attached the node to an unexpected allocation.");
      }
      this.log("info", {
        nodeId: this.options.nodeId,
        controlPlaneId: entry.controlPlaneId,
        allocationId: attempt.allocationId,
        attemptId: attempt.id,
      }, "node agent cloud relay attach accepted");
      attempt.phase = "trust-checking";
      const grant = verified.grant;
      const trustContext = controlPlaneTrustContext(binding, grant, this.options.nodeId);
      const trustContextKey = controlPlaneTrustContextKey(trustContext);
      const trustObservation = this.options.identity.observeCloudControlPlaneTrust(trustContext);
      if (trustObservation.kind !== "active") {
        const request = trustObservation.request;
        const issuedAt = new Date(this.now()).toISOString();
        writeNodeAgentControlPlaneTrustOutcome({
          socket: socket as unknown as NodeRelayFrameSocket,
          node: relayKeySigner(binding),
          outcome: {
            type: "node-agent.control-plane-trust",
            protocolVersion: "2026-10-26.1",
            audience: "task-handoff:node-agent-control-plane-trust",
            allocationId: grant.allocationId,
            relayId: grant.relayId,
            nodeHandle: grant.nodeHandle,
            nodeId: this.options.nodeId,
            nodePublicKey: binding.relayPublicKey,
            nodePublicKeyFingerprint: nodeRelayFingerprint(binding.relayPublicKey),
            controlPlaneId: grant.controlPlaneId,
            controlPlanePublicKeyFingerprint: nodeRelayFingerprint(grant.controlPlanePublicKey),
            bindingId: grant.bindingId,
            bindingRevision: grant.bindingRevision,
            access: {
              accountId: trustContext.accountId,
              ownerAccountId: trustContext.ownerAccountId,
              accessMode: trustContext.accessMode,
              ...(trustContext.shareGrantId ? { shareGrantId: trustContext.shareGrantId } : {}),
              ...(trustContext.shareRole ? { shareRole: trustContext.shareRole } : {}),
              ...(trustContext.shareRevision ? { shareRevision: trustContext.shareRevision } : {}),
            },
            state: trustObservation.kind,
            reason: trustObservation.kind === "pending" ? trustObservation.reason : trustObservation.kind,
            requestId: request.id,
            requestedAt: request.requestedAt,
            ...(trustObservation.kind === "pending" ? { expiresAt: request.expiresAt } : {}),
            issuedAt,
          },
        });
        if (trustObservation.kind === "rejected") entry.suppressedContextKey = trustContextKey;
        try {
          if (socket.readyState < WebSocket.CLOSING) socket.close(4403, `node-agent-control-plane-trust-${trustObservation.kind}`);
        } catch {
          // The Relay may already have closed after forwarding the outcome.
        }
        const error = relayError(
          `NODE_AGENT_CONTROL_PLANE_TRUST_${trustObservation.kind.toUpperCase()}`,
          trustObservation.kind === "pending"
            ? "The Control Plane must be approved locally before this node opens an encrypted channel."
            : "The local node rejected this Control Plane trust request.",
        );
        error.retryable = trustObservation.kind === "pending";
        throw error;
      }
      entry.activePinId = trustObservation.pin.id;
      entry.activeContextKey = trustContextKey;
      entry.suppressedContextKey = undefined;
      attempt.phase = "handshaking";
      const storedPairing = this.options.identity.cloudRelayPairing(grant.controlPlaneId);
      const handshake = await initiateNodeRelayHandshake({
        socket: socket as unknown as NodeRelayFrameSocket,
        grant: {
          allocationId: grant.allocationId,
          relayId: grant.relayId,
          nodeHandle: grant.nodeHandle,
          controlPlaneId: grant.controlPlaneId,
          accountId: grant.accountId,
          bindingId: grant.bindingId,
          bindingRevision: grant.bindingRevision,
          controlPlanePublicKey: grant.controlPlanePublicKey ?? "",
        },
        node: { ...relayKeySigner(binding), nodeId: this.options.nodeId },
        ...(storedPairing ? { pairing: storedPairing } : {}),
      });
      this.assertCurrentAttempt(entry, attempt);
      let pairing = storedPairing;
      if (handshake.pairing) {
        this.options.identity.saveCloudRelayPairing({ controlPlaneId: grant.controlPlaneId, keyId: handshake.pairing.keyId, secret: handshake.pairing.secret });
        pairing = handshake.pairing;
      }
      if (!pairing) throw relayError("NODE_AGENT_CLOUD_RELAY_PAIRING_MISSING");
      const channel = new NodeRelayNodeChannel({
        nodeId: this.options.nodeId,
        pairing,
        host: this.options.host,
        socket: socket as unknown as NodeRelayFrameSocket,
        key: handshake.key,
        onClosed: (reason) => this.handleChannelClosed(entry, channel, reason),
      });
      entry.channel = channel;
      const supervisor = new WebSocketConnectionSupervisor({
        ping: () => channel.sendPing(),
        onTimeout: (kind) => {
          entry.error = `Cloud relay channel ${kind} timeout.`;
          channel.close(`heartbeat-${kind}`);
        },
        onStable: () => entry.retry.reset(),
      });
      entry.supervisor = supervisor;
      supervisor.start();
      supervisor.opened();
      channel.on("pong", () => supervisor.pong());
      channel.start();
      supervisor.healthy();
      entry.status = "connected";
      entry.connectedAt = new Date(this.now()).toISOString();
      entry.error = undefined;
      entry.retry.reset();
      this.log("info", {
        nodeId: this.options.nodeId,
        controlPlaneId: entry.controlPlaneId,
        allocationId: attempt.allocationId,
        attemptId: attempt.id,
        durationMs: Math.max(0, this.now() - attempt.startedAt),
      }, "node agent cloud relay connected");
    } catch (error) {
      if (!this.attemptCurrent(entry, attempt)) return;
      if (entry.socket === socket) entry.socket = undefined;
      try {
        if (socket.readyState < WebSocket.CLOSING) socket.close(4400, "node-relay-handshake-failed");
      } catch {
        // The socket may already be gone.
      }
      entry.status = "failed";
      entry.lastDisconnectedAt = new Date(this.now()).toISOString();
      entry.error = error instanceof Error ? error.message : String(error);
      this.log("warn", {
        nodeId: this.options.nodeId,
        controlPlaneId: entry.controlPlaneId,
        allocationId: attempt.allocationId,
        attemptId: attempt.id,
        phase: attempt.phase,
        code: relayErrorCode(error),
        error: entry.error,
        durationMs: Math.max(0, this.now() - attempt.startedAt),
      }, "node agent cloud relay connect failed");
      entry.activePinId = undefined;
      entry.activeContextKey = undefined;
      if ((error as { retryable?: unknown })?.retryable === false) entry.retry.cancel();
      else this.scheduleEntryRetry(entry);
    } finally {
      if (entry.attempt === attempt) entry.attempt = undefined;
    }
  }

  private handleChannelClosed(entry: ChannelEntry, channel: NodeRelayNodeChannel, reason: string) {
    if (entry.channel !== channel) return;
    entry.channel = undefined;
    entry.supervisor?.close();
    entry.supervisor = undefined;
    if (entry.socket) {
      try {
        if (entry.socket.readyState < WebSocket.CLOSING) entry.socket.close(1000, reason.slice(0, 120));
      } catch {
        // The socket is already gone.
      }
      entry.socket = undefined;
    }
    entry.status = "reconnecting";
    entry.lastDisconnectedAt = new Date(this.now()).toISOString();
    entry.error = reason;
    this.scheduleEntryRetry(entry);
  }

  private scheduleEntryRetry(entry: ChannelEntry) {
    if (this.stopped) return;
    // Relay attach capabilities are single-use. Once an attempt may have sent
    // its attach frame, only a fresh allocation can recover the channel.
    this.refreshControlPlaneIds.add(entry.controlPlaneId);
    const scheduled = entry.retry.schedule(() => {
      if (this.stopped) return;
      void this.poll();
    });
    if (scheduled) {
      entry.nextRetryAt = new Date(this.now() + scheduled.delay).toISOString();
      this.schedulePoll(Math.min(scheduled.delay, this.pollIntervalMs()));
    }
  }

  private releaseChannel(entry: ChannelEntry, reason: string) {
    entry.retry.cancel();
    entry.nextRetryAt = undefined;
    if (entry.attempt) this.abortAttempt(entry, entry.attempt, reason);
    const channel = entry.channel;
    entry.channel = undefined;
    entry.supervisor?.close();
    entry.supervisor = undefined;
    const socket = entry.socket;
    entry.socket = undefined;
    if (channel) channel.close(reason);
    else if (socket) {
      try {
        if (socket.readyState < WebSocket.CLOSING) socket.close(1000, reason.slice(0, 120));
      } catch {
        // The socket is already gone.
      }
    }
  }

  private attemptCurrent(entry: ChannelEntry, attempt: ChannelAttempt) {
    return !this.stopped && !attempt.controller.signal.aborted && entry.attempt === attempt && this.channels.get(entry.controlPlaneId) === entry;
  }

  private assertCurrentAttempt(entry: ChannelEntry, attempt: ChannelAttempt) {
    if (!this.attemptCurrent(entry, attempt)) throw relayError("NODE_AGENT_CLOUD_RELAY_ATTEMPT_SUPERSEDED", "The cloud relay connection attempt was superseded.");
  }

  private abortAttempt(entry: ChannelEntry, attempt: ChannelAttempt, reason: string) {
    if (entry.attempt === attempt) entry.attempt = undefined;
    attempt.controller.abort(relayError("NODE_AGENT_CLOUD_RELAY_ATTEMPT_ABORTED", `Cloud relay connection attempt was aborted: ${reason}.`));
    const socket = attempt.socket;
    if (socket) {
      try {
        if (socket.readyState < WebSocket.CLOSING) socket.close(1000, reason.slice(0, 120));
      } catch {
        // The socket may already be gone.
      }
    }
    this.log("debug", {
      nodeId: this.options.nodeId,
      controlPlaneId: entry.controlPlaneId,
      allocationId: attempt.allocationId,
      attemptId: attempt.id,
      phase: attempt.phase,
      reason,
    }, "node agent cloud relay attempt aborted");
  }

  private log(level: "debug" | "info" | "warn", data: Record<string, unknown>, message: string) {
    if (level === "warn") {
      this.options.host.log.warn(data, message);
      return;
    }
    this.options.host.log[level]?.(data, message);
  }

  private closeAllChannels(reason: string) {
    for (const entry of this.channels.values()) this.releaseChannel(entry, reason);
    this.channels.clear();
    this.refreshControlPlaneIds.clear();
  }
}

function sameOptional(left: unknown, right: unknown) {
  return left === undefined ? right === undefined : left === right;
}
