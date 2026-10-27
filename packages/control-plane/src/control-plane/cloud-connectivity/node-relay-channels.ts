import crypto from "node:crypto";
import { nodeAgentControlPlaneComparisonCode, type NodeRelayFrameSocket } from "../../shared/cloud-relay/node-relay-session.ts";
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
  onChannelClosed?(input: { nodeHandle: string; nodeId: string; reason: string }): void;
  now?: () => number;
  audit?(event: { type: string; outcome: "allowed" | "denied"; nodeHandle?: string; reason: string }): void;
};

type ActiveNodeRelayChannel = {
  allocationId: string;
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

  constructor(options: CloudNodeRelayChannelsOptions) {
    this.options = options;
  }

  /** A Control Plane claim was accepted; the channel follows when the node asks for allocations. */
  noteClaim(nodeHandle: string) {
    this.claims.set(nodeHandle, { requestedAt: new Date(this.now()).toISOString() });
  }

  hasClaimOrChannel(nodeHandle: string) {
    return this.claims.has(nodeHandle) || this.channels.has(nodeHandle);
  }

  recordClaimFailure(nodeHandle: string, error: unknown) {
    this.recordError(nodeHandle, error);
  }

  recordTrustProbeTimeout(nodeHandle: string) {
    this.recordError(nodeHandle, Object.assign(
      new Error("Node Agent did not answer the Control Plane trust probe before the timeout."),
      { code: "NODE_RELAY_TRUST_TIMEOUT", retryable: true },
    ));
  }

  trustState(nodeHandle: string) {
    return this.trust.get(nodeHandle)?.state;
  }

  forgetClaim(nodeHandle: string) {
    this.claims.delete(nodeHandle);
  }

  forgetNode(nodeHandle: string) {
    this.claims.delete(nodeHandle);
    this.errors.delete(nodeHandle);
    this.trust.delete(nodeHandle);
    this.closeNode(nodeHandle, "node-relay-claim-revoked");
  }

  async attach(raw: unknown) {
    let verified;
    try {
      verified = verifyCoordinatorNodeRelayAllocation(raw, this.options.state);
    } catch (error) {
      this.recordError((raw as any)?.nodeHandle, error);
      throw error;
    }
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
      this.recordError(verified.nodeHandle, error);
      throw error;
    });
    if (connection.status === "trust-required") {
      const identity = this.options.state.snapshot().identity;
      this.trust.set(verified.nodeHandle, {
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
      nodeId: identity.nodeId,
      ...(connection.channelId ? { channelId: connection.channelId } : {}),
      connectedAt: new Date(this.now()).toISOString(),
    };
    this.channels.set(verified.nodeHandle, activeChannel);
    this.claims.delete(verified.nodeHandle);
    this.errors.delete(verified.nodeHandle);
    this.trust.delete(verified.nodeHandle);
    transport.attachNode(identity.nodeId, {
      socket: connection.socket,
      key: connection.key,
      nodeHandle: verified.nodeHandle,
      ...(connection.channelId ? { relayChannelId: connection.channelId } : {}),
      onClosed: (reason) => this.handleClosed(verified.nodeHandle, activeChannel, reason),
    });
    await this.options.nodes.connected(identity.nodeId, { nodeHandle: verified.nodeHandle });
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
    void this.options.nodes.disconnected(channel.nodeId, { nodeHandle, reason });
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
    void this.options.nodes.disconnected(channel.nodeId, { nodeHandle, reason });
    this.options.audit?.({ type: "node-relay.channel.closed", outcome: "allowed", nodeHandle, reason });
    this.options.onChannelClosed?.({ nodeHandle, nodeId: channel.nodeId, reason });
  }

  /** Drops only the Relay channel; a preserved direct node keeps its own status and health. */
  private discardChannel(nodeHandle: string, reason: string) {
    const channel = this.channels.get(nodeHandle);
    if (!channel) return false;
    this.channels.delete(nodeHandle);
    this.options.transport?.()?.detachNode(channel.nodeId, reason);
    this.options.audit?.({ type: "node-relay.channel.closed", outcome: "allowed", nodeHandle, reason });
    return true;
  }

  private recordError(nodeHandle: string | undefined, error: unknown) {
    if (!nodeHandle) return;
    const code = typeof (error as any)?.code === "string" ? (error as any).code : "NODE_RELAY_CHANNEL_FAILED";
    this.errors.set(nodeHandle, { code, message: error instanceof Error ? error.message : String(error), at: new Date(this.now()).toISOString() });
    this.options.audit?.({ type: "node-relay.channel.rejected", outcome: "denied", nodeHandle, reason: code });
  }

  private now() {
    return this.options.now ? this.options.now() : Date.now();
  }
}

function closeConnection(socket: NodeRelayFrameSocket, reason: string) {
  try {
    socket.close(4409, reason);
  } catch {
    // The peer may already have closed after completing the handshake.
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
