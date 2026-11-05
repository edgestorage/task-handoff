import crypto from "node:crypto";
import type { CloudNodeRelayChangedEvent } from "@task-handoff/protocol/control-plane";
import { nodeAgentControlPlaneComparisonCode, type NodeRelayFrameSocket } from "@task-handoff/runtime-shared/cloud-relay/node-relay-session";
import { verifyCoordinatorNodeRelayAllocation } from "./relay-connector.ts";
import type { CloudNodeRelayConnectorResult, VerifiedNodeRelayAllocation } from "./node-relay-connector.ts";

/** Structural surface of the Relay dialer, so tests can inject a linked socket. */
export type CloudNodeRelayChannelConnector = {
  connect(input: {
    allocation: VerifiedNodeRelayAllocation;
    serviceOrigin: string;
    pairing?: { keyId: string; secret: string };
    createPairing(): { keyId: string; secret: string };
  }): Promise<CloudNodeRelayConnectorResult>;
};

export type CloudNodeRelayChannelTransport = {
  attachNode(nodeId: string, input: { socket: NodeRelayFrameSocket; key: Uint8Array; onClosed?(reason: string): void; nodeHandle?: string; relayChannelId?: string }): unknown;
  detachNode(nodeId: string, reason: string): boolean;
  connected(nodeId: string): boolean;
};

export type CloudNodeRelayChannelsOptions = {
  state: { snapshot(): any };
  connector: CloudNodeRelayChannelConnector;
  /** Resolved lazily: the tunnel transport is wired after the runtime exists. */
  transport?: () => CloudNodeRelayChannelTransport | undefined;
  nodes: {
    /** Derived from the persisted connection switch and explicit claim opt-out. */
    claimEnabled?(nodeHandle: string): boolean;
    resolve(nodeHandle: string): { nodeId: string; pairing?: { keyId: string; secret: string }; preserveLocalConnection?: boolean } | undefined;
    inspectNode?(nodeId: string): { nodeId: string; connectionKind: string; nodeHandle?: string } | undefined;
    /** Nodes whose claim should be restored after a fresh Coordinator connection. */
    listForClaim?(): Array<{ nodeHandle: string }> | Promise<Array<{ nodeHandle: string }>>;
    linkNode?(nodeId: string, nodeHandle: string): void | Promise<void>;
    ensure(input: { nodeHandle: string; nodeId: string; displayName?: string }): { nodeId: string; pairing?: { keyId: string; secret: string }; preserveLocalConnection?: boolean } | Promise<{ nodeId: string; pairing?: { keyId: string; secret: string }; preserveLocalConnection?: boolean }>;
    savePairing(nodeId: string, pairing: { keyId: string; secret: string }): void | Promise<void>;
    connected(nodeId: string, input: { nodeHandle: string }): void | Promise<void>;
    disconnected(nodeId: string, input: { nodeHandle: string; reason: string }): void | Promise<void>;
  };
  onPreserveLocalConnection?(nodeHandle: string): void | Promise<void>;
  /** An unexpectedly closed live channel; the runtime must claim a fresh allocation. */
  onChannelClosed?(input: { nodeHandle: string; nodeId: string; relayId: string; reason: string }): void;
  /** The account-node relay projection changed and consumers must recover its HTTP snapshot. */
  onChanged?(input: NodeRelayStateChange): void;
  /** The authoritative Control Plane trust projection gained, changed, or cleared an entry. */
  onTrustChanged?(input: NodeRelayControlPlaneTrustChange): void;
  now?: () => number;
  audit?(event: { type: string; outcome: "allowed" | "denied"; nodeHandle?: string; reason: string }): void;
};

type ActiveNodeRelayChannel = {
  allocationId: string;
  relayId: string;
  nodeId: string;
  channelId?: string;
  connectedAt: string;
};

export type NodeRelayControlPlaneTrustProjection = {
  nodeHandle: string;
  nodeId: string;
  displayName?: string;
  state: "pending" | "rejected" | "expired";
  reason: string;
  controlPlaneId: string;
  controlPlaneFingerprint: string;
  comparisonCode: string;
  requestId?: string;
  requestedAt: string;
  expiresAt?: string;
  observedAt: string;
};

export type NodeRelayControlPlaneTrustChange = {
  nodeHandle: string;
  nodeId: string;
  requestId?: string;
  state?: NodeRelayControlPlaneTrustProjection["state"];
};

export type NodeRelayStateChange = CloudNodeRelayChangedEvent;

/**
 * Owns the Control Plane end of every account node channel: verifying each
 * pushed allocation against the local binding and scope, dialing the Relay,
 * completing the handshake, persisting the pairing on first claim, and routing
 * the channel into the shared tunnel transport. A channel is keyed by node
 * handle so a superseding allocation replaces the previous one.
 */
export class CloudNodeRelayChannels {
  private readonly options: CloudNodeRelayChannelsOptions;
  private readonly channels = new Map<string, ActiveNodeRelayChannel>();
  private readonly claims = new Map<string, { requestedAt: string }>();
  private readonly errors = new Map<string, { code: string; message: string; at: string }>();
  private readonly trust = new Map<string, NodeRelayControlPlaneTrustProjection>();
  private readonly claimRevisions = new Map<string, number>();
  private readonly nodeLifecycleOperations = new Map<string, Promise<void>>();
  private revision = 0;

  constructor(options: CloudNodeRelayChannelsOptions) {
    this.options = options;
  }

  /** A Control Plane claim was accepted; the channel follows when the node asks for allocations. */
  noteClaim(nodeHandle: string) {
    this.claims.set(nodeHandle, { requestedAt: new Date(this.now()).toISOString() });
    this.publishChanged("claim-noted", { nodeHandle });
  }

  hasClaimOrChannel(nodeHandle: string) {
    return this.claims.has(nodeHandle) || this.channels.has(nodeHandle);
  }

  channelState(nodeHandle: string): "live" | "disconnected" | "missing" {
    const channel = this.channels.get(nodeHandle);
    if (!channel) return "missing";
    return this.options.transport?.()?.connected(channel.nodeId) ? "live" : "disconnected";
  }

  claimAgeMs(nodeHandle: string, now = this.now()): number | undefined {
    const claim = this.claims.get(nodeHandle);
    if (!claim) return undefined;
    const requestedAt = Date.parse(claim.requestedAt);
    return Number.isFinite(requestedAt) ? Math.max(0, now - requestedAt) : Number.POSITIVE_INFINITY;
  }

  recordClaimFailure(nodeHandle: string, error: unknown) {
    this.recordError(nodeHandle, error);
  }

  trustState(nodeHandle: string) {
    return this.trust.get(nodeHandle)?.state;
  }

  forgetClaim(nodeHandle: string) {
    if (this.claims.delete(nodeHandle)) this.publishChanged("claim-forgotten", { nodeHandle });
  }

  forgetNode(nodeHandle: string) {
    this.claimRevisions.set(nodeHandle, (this.claimRevisions.get(nodeHandle) ?? 0) + 1);
    const changed = this.claims.delete(nodeHandle) || this.errors.delete(nodeHandle);
    this.clearTrust(nodeHandle);
    const closed = this.closeNode(nodeHandle, "node-relay-claim-revoked");
    if (changed && !closed) this.publishChanged("node-forgotten", { nodeHandle });
  }

  notifyChanged(reason: string, input: Pick<NodeRelayStateChange, "nodeHandle" | "nodeId"> = {}) {
    this.publishChanged(reason, input);
  }

  async attach(raw: unknown) {
    let verified;
    try {
      verified = verifyCoordinatorNodeRelayAllocation(raw, this.options.state);
    } catch (error) {
      this.recordError((raw as any)?.nodeHandle, error);
      throw error;
    }
    const revision = this.claimRevisions.get(verified.nodeHandle) ?? 0;
    const assertCurrentClaim = () => {
      if ((this.claimRevisions.get(verified.nodeHandle) ?? 0) !== revision || this.options.nodes.claimEnabled?.(verified.nodeHandle) === false) {
        throw Object.assign(new Error("The node relay claim was cancelled."), { code: "NODE_RELAY_CLAIM_REVOKED", retryable: false });
      }
    };
    assertCurrentClaim();
    const resolved = this.options.nodes.resolve(verified.nodeHandle);
    const current = this.channels.get(verified.nodeHandle);
    const knownIdentity = verified.nodeId ? this.options.nodes.inspectNode?.(verified.nodeId) : undefined;
    if (resolved && verified.nodeId && resolved.nodeId !== verified.nodeId) {
      const error = nodeIdentityMismatch(verified.nodeHandle, resolved.nodeId, verified.nodeId);
      this.recordError(verified.nodeHandle, error);
      throw error;
    }
    if (resolved?.preserveLocalConnection) {
      // The node is already managed here over its original transport. A stale
      // or duplicate cloud claim must not create a second local record or
      // overwrite the original pairing.
      this.discardChannel(verified.nodeHandle, "local-connection-preserved");
      this.claims.delete(verified.nodeHandle);
      this.errors.delete(verified.nodeHandle);
      this.publishChanged("local-connection-preserved", { nodeHandle: verified.nodeHandle, nodeId: resolved.nodeId });
      await Promise.resolve(this.options.onPreserveLocalConnection?.(verified.nodeHandle)).catch(() => undefined);
      return { status: "attached" as const, preservedLocalConnection: true, nodeId: resolved.nodeId, nodeHandle: verified.nodeHandle };
    }
    if (knownIdentity?.connectionKind === "cloud-relay" && knownIdentity.nodeHandle !== verified.nodeHandle) {
      const error = nodeIdentityMismatch(verified.nodeHandle, knownIdentity.nodeId, knownIdentity.nodeHandle ?? "another node handle");
      this.recordError(verified.nodeHandle, error);
      throw error;
    }
    if (knownIdentity && knownIdentity.connectionKind !== "cloud-relay") {
      // The cloud supplied the machine identity before we dialed: this node is
      // already managed over a direct connection, so no Relay channel is opened.
      await this.options.nodes.linkNode?.(knownIdentity.nodeId, verified.nodeHandle);
      this.discardChannel(verified.nodeHandle, "local-connection-preserved");
      this.claims.delete(verified.nodeHandle);
      this.errors.delete(verified.nodeHandle);
      this.publishChanged("local-connection-preserved", { nodeHandle: verified.nodeHandle, nodeId: knownIdentity.nodeId });
      await Promise.resolve(this.options.onPreserveLocalConnection?.(verified.nodeHandle)).catch(() => undefined);
      this.options.audit?.({ type: "node-relay.channel.preserved", outcome: "allowed", nodeHandle: verified.nodeHandle, reason: "direct-connection" });
      return { status: "attached" as const, preservedLocalConnection: true, nodeId: knownIdentity.nodeId, nodeHandle: verified.nodeHandle };
    }
    const transport = this.options.transport?.();
    if (!transport) {
      const error = Object.assign(new Error("Cloud relay node transport is unavailable."), { code: "NODE_RELAY_TRANSPORT_UNAVAILABLE", retryable: true });
      this.recordError(verified.nodeHandle, error);
      throw error;
    }
    if (current && current.allocationId === verified.allocationId && transport.connected(current.nodeId)) return { status: "attached" as const, replayed: true, nodeId: current.nodeId, nodeHandle: verified.nodeHandle };
    // A superseding allocation for the same node replaces the live channel; the
    // stale one is torn down before the new session starts.
    if (current) this.closeNode(verified.nodeHandle, "allocation-superseded");
    const connection = await this.options.connector.connect({
      allocation: verified,
      serviceOrigin: this.options.state.snapshot().serviceOrigin,
      ...(resolved?.pairing ? { pairing: resolved.pairing } : {}),
      createPairing: () => ({ keyId: `key_${crypto.randomUUID().replaceAll("-", "_")}`, secret: crypto.randomBytes(32).toString("base64url") }),
    }).catch((error: unknown) => {
      assertCurrentClaim();
      this.recordError(verified.nodeHandle, error);
      // Only the Relay dialer can prove that the allocated Relay was actually
      // unreachable. Errors before this point (invalid allocation, missing local
      // transport) must not cool down the Relay.
      throw markRelayConnectionFailure(error);
    });
    try {
      assertCurrentClaim();
    } catch (error) {
      if (connection.status !== "trust-required") closeConnection(connection.socket, "node-relay-claim-revoked");
      throw error;
    }
    if (connection.status === "trust-required") {
      if (verified.nodeId && verified.nodeId !== connection.outcome.nodeId) {
        const error = nodeIdentityMismatch(verified.nodeHandle, verified.nodeId, connection.outcome.nodeId);
        this.recordError(verified.nodeHandle, error);
        throw error;
      }
      const identity = this.options.state.snapshot().identity;
      this.setTrust(verified.nodeHandle, {
        nodeHandle: verified.nodeHandle,
        nodeId: connection.outcome.nodeId,
        ...(verified.displayName ? { displayName: verified.displayName } : {}),
        state: connection.outcome.state,
        reason: connection.outcome.reason,
        controlPlaneId: connection.outcome.controlPlaneId,
        controlPlaneFingerprint: connection.outcome.controlPlanePublicKeyFingerprint,
        comparisonCode: nodeAgentControlPlaneComparisonCode(connection.outcome.controlPlaneId, identity.publicKey),
        ...(connection.outcome.requestId ? { requestId: connection.outcome.requestId } : {}),
        requestedAt: connection.outcome.requestedAt,
        ...(connection.outcome.expiresAt ? { expiresAt: connection.outcome.expiresAt } : {}),
        observedAt: new Date(this.now()).toISOString(),
      });
      this.errors.delete(verified.nodeHandle);
      this.options.audit?.({ type: "node-relay.control-plane-trust", outcome: "denied", nodeHandle: verified.nodeHandle, reason: connection.outcome.state });
      return {
        status: "trust-required" as const,
        nodeId: connection.outcome.nodeId,
        nodeHandle: verified.nodeHandle,
        trust: this.trust.get(verified.nodeHandle),
      };
    }
    if (verified.nodeId && verified.nodeId !== connection.nodeId) {
      closeConnection(connection.socket, "node-relay-node-id-mismatch");
      const error = nodeIdentityMismatch(verified.nodeHandle, verified.nodeId, connection.nodeId);
      this.recordError(verified.nodeHandle, error);
      throw error;
    }
    let identity = resolved;
    if (!identity) {
      try {
        identity = await this.options.nodes.ensure({ nodeHandle: verified.nodeHandle, nodeId: connection.nodeId, displayName: verified.displayName });
      } catch (error) {
        closeConnection(connection.socket, "node-relay-node-id-conflict");
        this.recordError(verified.nodeHandle, error);
        throw error;
      }
    }
    try {
      assertCurrentClaim();
    } catch (error) {
      closeConnection(connection.socket, "node-relay-claim-revoked");
      throw error;
    }
    if (identity.nodeId !== connection.nodeId) {
      closeConnection(connection.socket, "node-relay-node-id-mismatch");
      const error = nodeIdentityMismatch(verified.nodeHandle, identity.nodeId, connection.nodeId);
      this.recordError(verified.nodeHandle, error);
      throw error;
    }
    if (identity.preserveLocalConnection) {
      closeConnection(connection.socket, "local-connection-preserved");
      this.discardChannel(verified.nodeHandle, "local-connection-preserved");
      this.claims.delete(verified.nodeHandle);
      this.errors.delete(verified.nodeHandle);
      await Promise.resolve(this.options.onPreserveLocalConnection?.(verified.nodeHandle)).catch(() => undefined);
      return { status: "attached" as const, preservedLocalConnection: true, nodeId: identity.nodeId, nodeHandle: verified.nodeHandle };
    }
    if (connection.issuedPairing) await this.options.nodes.savePairing(identity.nodeId, connection.issuedPairing);
    const activeChannel: ActiveNodeRelayChannel = {
      allocationId: verified.allocationId,
      relayId: verified.event.relayId,
      nodeId: identity.nodeId,
      ...(connection.channelId ? { channelId: connection.channelId } : {}),
      connectedAt: new Date(this.now()).toISOString(),
    };
    this.channels.set(verified.nodeHandle, activeChannel);
    this.claims.delete(verified.nodeHandle);
    this.errors.delete(verified.nodeHandle);
    this.clearTrust(verified.nodeHandle);
    this.publishChanged("channel-attached", { nodeHandle: verified.nodeHandle, nodeId: identity.nodeId });
    transport.attachNode(identity.nodeId, {
      socket: connection.socket,
      key: connection.key,
      nodeHandle: verified.nodeHandle,
      ...(connection.channelId ? { relayChannelId: connection.channelId } : {}),
      onClosed: (reason) => this.handleClosed(verified.nodeHandle, activeChannel, reason),
    });
    await this.enqueueNodeLifecycle(identity.nodeId, () => this.options.nodes.connected(identity.nodeId, { nodeHandle: verified.nodeHandle }));
    if (this.channels.get(verified.nodeHandle) !== activeChannel) {
      // The channel can close while the node record is being persisted. Do not
      // report a successful attach that the runtime has already treated as gone.
      const error = Object.assign(new Error("Cloud relay node channel closed while attaching."), { code: "NODE_RELAY_CHANNEL_CLOSED", retryable: true });
      this.recordError(verified.nodeHandle, error);
      throw error;
    }
    this.options.audit?.({ type: "node-relay.channel.attached", outcome: "allowed", nodeHandle: verified.nodeHandle, reason: connection.paired ? "paired" : "pairing-established" });
    return { status: "attached" as const, nodeId: identity.nodeId, nodeHandle: verified.nodeHandle };
  }

  closeNode(nodeHandle: string, reason: string) {
    const channel = this.channels.get(nodeHandle);
    if (!channel) return false;
    this.discardChannel(nodeHandle, reason);
    void this.enqueueNodeLifecycle(channel.nodeId, () => this.options.nodes.disconnected(channel.nodeId, { nodeHandle, reason })).catch(() => undefined);
    return true;
  }

  closeAll(reason: string) {
    for (const nodeHandle of [...this.channels.keys()]) this.closeNode(nodeHandle, reason);
  }

  state() {
    return {
      channels: [...this.channels.entries()].map(([nodeHandle, channel]) => ({
        nodeHandle,
        nodeId: channel.nodeId,
        allocationId: channel.allocationId,
        connectedAt: channel.connectedAt,
        connected: true,
      })),
      claims: [...this.claims.entries()].map(([nodeHandle, claim]) => ({ nodeHandle, requestedAt: claim.requestedAt })),
      errors: [...this.errors.entries()].map(([nodeHandle, error]) => ({ nodeHandle, ...error })),
      trust: [...this.trust.values()],
    };
  }

  private handleClosed(nodeHandle: string, channel: ActiveNodeRelayChannel, reason: string) {
    // A superseding allocation can attach before the previous socket emits its
    // close event. Only the channel that is still current may mark the node
    // offline or trigger another recovery claim.
    if (this.channels.get(nodeHandle) !== channel) return;
    this.channels.delete(nodeHandle);
    void this.enqueueNodeLifecycle(channel.nodeId, () => this.options.nodes.disconnected(channel.nodeId, { nodeHandle, reason })).catch(() => undefined);
    this.options.audit?.({ type: "node-relay.channel.closed", outcome: "allowed", nodeHandle, reason });
    this.publishChanged("channel-closed", { nodeHandle, nodeId: channel.nodeId });
    this.options.onChannelClosed?.({ nodeHandle, nodeId: channel.nodeId, relayId: channel.relayId, reason });
  }

  /** Drops only the Relay channel; a preserved direct node keeps its own status and health. */
  private discardChannel(nodeHandle: string, reason: string) {
    const channel = this.channels.get(nodeHandle);
    if (!channel) return false;
    this.channels.delete(nodeHandle);
    this.options.transport?.()?.detachNode(channel.nodeId, reason);
    this.options.audit?.({ type: "node-relay.channel.closed", outcome: "allowed", nodeHandle, reason });
    this.publishChanged("channel-discarded", { nodeHandle, nodeId: channel.nodeId });
    return true;
  }

  private enqueueNodeLifecycle(nodeId: string, operation: () => void | Promise<void>) {
    const previous = this.nodeLifecycleOperations.get(nodeId);
    if (!previous) {
      try {
        const result = operation();
        if (!result || typeof (result as PromiseLike<void>).then !== "function") return Promise.resolve();
        return this.trackNodeLifecycle(nodeId, Promise.resolve(result));
      } catch (error) {
        return this.trackNodeLifecycle(nodeId, Promise.reject(error));
      }
    }
    return this.trackNodeLifecycle(nodeId, previous.catch(() => undefined).then(operation));
  }

  private trackNodeLifecycle(nodeId: string, next: Promise<void>) {
    this.nodeLifecycleOperations.set(nodeId, next);
    const settle = () => {
      if (this.nodeLifecycleOperations.get(nodeId) === next) this.nodeLifecycleOperations.delete(nodeId);
    };
    void next.then(settle, settle);
    return next;
  }

  private recordError(nodeHandle: string | undefined, error: unknown) {
    if (!nodeHandle) return;
    const code = typeof (error as any)?.code === "string" ? (error as any).code : "NODE_RELAY_CHANNEL_FAILED";
    this.errors.set(nodeHandle, { code, message: error instanceof Error ? error.message : String(error), at: new Date(this.now()).toISOString() });
    this.options.audit?.({ type: "node-relay.channel.rejected", outcome: "denied", nodeHandle, reason: code });
    this.publishChanged("channel-error", { nodeHandle });
  }

  private setTrust(nodeHandle: string, trust: NodeRelayControlPlaneTrustProjection) {
    const previous = this.trust.get(nodeHandle);
    this.trust.set(nodeHandle, trust);
    if (previous?.nodeId === trust.nodeId && previous.state === trust.state && previous.requestId === trust.requestId) return;
    this.publishChanged("trust-changed", { nodeHandle, nodeId: trust.nodeId });
    this.options.onTrustChanged?.({
      nodeHandle,
      nodeId: trust.nodeId,
      ...(trust.requestId ? { requestId: trust.requestId } : {}),
      state: trust.state,
    });
  }

  private clearTrust(nodeHandle: string) {
    const previous = this.trust.get(nodeHandle);
    if (!previous) return;
    this.trust.delete(nodeHandle);
    this.publishChanged("trust-cleared", { nodeHandle, nodeId: previous.nodeId });
    this.options.onTrustChanged?.({
      nodeHandle,
      nodeId: previous.nodeId,
      ...(previous.requestId ? { requestId: previous.requestId } : {}),
    });
  }

  private now() {
    return this.options.now ? this.options.now() : Date.now();
  }

  private publishChanged(reason: string, input: { nodeHandle?: string; nodeId?: string }) {
    const nodeHandle = typeof input.nodeHandle === "string" && input.nodeHandle.length <= 240 ? input.nodeHandle : undefined;
    const nodeId = typeof input.nodeId === "string" && input.nodeId.length <= 120 ? input.nodeId : undefined;
    this.options.onChanged?.({
      revision: ++this.revision,
      reason: reason.slice(0, 120),
      ...(nodeHandle ? { nodeHandle } : {}),
      ...(nodeId ? { nodeId } : {}),
    });
  }
}

function closeConnection(socket: NodeRelayFrameSocket, reason: string) {
  try {
    socket.close(4409, reason);
  } catch {
    // The peer may already have closed after completing the handshake.
  }
}

function markRelayConnectionFailure(error: unknown) {
  const marked = error && typeof error === "object" ? error : Object.assign(new Error(String(error)), { code: "NODE_RELAY_CHANNEL_FAILED", retryable: true });
  try {
    return Object.assign(marked as Record<string, unknown>, { relayConnectionFailed: true });
  } catch {
    return Object.assign(new Error((marked as Error).message ?? "Cloud relay connection failed."), {
      code: (marked as { code?: unknown }).code ?? "NODE_RELAY_CHANNEL_FAILED",
      retryable: (marked as { retryable?: unknown }).retryable ?? true,
      cause: marked,
      relayConnectionFailed: true,
    });
  }
}

function nodeIdentityMismatch(nodeHandle: string, localNodeId: string, relayNodeId: string) {
  return Object.assign(new Error(
    `Cloud relay handle ${nodeHandle} is bound to node ${localNodeId}, but the node agent reported ${relayNodeId}.`,
  ), {
    code: "CLOUD_RELAY_NODE_ID_MISMATCH",
    retryable: false,
  });
}
