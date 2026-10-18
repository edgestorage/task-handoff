import crypto from "node:crypto";
import type { NodeRelayFrameSocket } from "../../shared/cloud-relay/node-relay-session.ts";
import { verifyCoordinatorNodeRelayAllocation } from "./relay-connector.ts";
import type { ConnectedNodeRelayChannel, VerifiedNodeRelayAllocation } from "./node-relay-connector.ts";

/** Structural surface of the Relay dialer, so tests can inject a linked socket. */
export type CloudNodeRelayChannelConnector = {
  connect(input: {
    allocation: VerifiedNodeRelayAllocation;
    serviceOrigin: string;
    pairing?: { keyId: string; secret: string };
    createPairing(): { keyId: string; secret: string };
  }): Promise<ConnectedNodeRelayChannel>;
};

export type CloudNodeRelayChannelTransport = {
  attachNode(nodeId: string, input: { socket: NodeRelayFrameSocket; key: Uint8Array; onClosed?(reason: string): void }): unknown;
  detachNode(nodeId: string, reason: string): boolean;
  connected(nodeId: string): boolean;
};

export type CloudNodeRelayChannelsOptions = {
  state: { snapshot(): any };
  connector: CloudNodeRelayChannelConnector;
  /** Resolved lazily: the tunnel transport is wired after the runtime exists. */
  transport?: () => CloudNodeRelayChannelTransport | undefined;
  nodes: {
    resolve(nodeHandle: string): { nodeId: string; pairing?: { keyId: string; secret: string } } | undefined;
    ensure(input: { nodeHandle: string; displayName?: string }): { nodeId: string; pairing?: { keyId: string; secret: string } } | Promise<{ nodeId: string; pairing?: { keyId: string; secret: string } }>;
    savePairing(nodeId: string, pairing: { keyId: string; secret: string }): void | Promise<void>;
    connected(nodeId: string, input: { nodeHandle: string }): void | Promise<void>;
    disconnected(nodeId: string, input: { nodeHandle: string; reason: string }): void | Promise<void>;
  };
  now?: () => number;
  audit?(event: { type: string; outcome: "allowed" | "denied"; nodeHandle?: string; reason: string }): void;
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
  private readonly channels = new Map<string, { allocationId: string; nodeId: string; channelId?: string; connectedAt: string }>();
  private readonly claims = new Map<string, { requestedAt: string }>();
  private readonly errors = new Map<string, { code: string; message: string; at: string }>();

  constructor(options: CloudNodeRelayChannelsOptions) {
    this.options = options;
  }

  /** A Control Plane claim was accepted; the channel follows when the node asks for allocations. */
  noteClaim(nodeHandle: string) {
    this.claims.set(nodeHandle, { requestedAt: new Date(this.now()).toISOString() });
  }

  forgetClaim(nodeHandle: string) {
    this.claims.delete(nodeHandle);
  }

  forgetNode(nodeHandle: string) {
    this.errors.delete(nodeHandle);
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
    const transport = this.options.transport?.();
    if (!transport) {
      const error = Object.assign(new Error("Cloud relay node transport is unavailable."), { code: "NODE_RELAY_TRANSPORT_UNAVAILABLE", retryable: true });
      this.recordError(verified.nodeHandle, error);
      throw error;
    }
    const resolved = this.options.nodes.resolve(verified.nodeHandle) ?? await this.options.nodes.ensure({ nodeHandle: verified.nodeHandle, displayName: verified.displayName });
    const current = this.channels.get(verified.nodeHandle);
    if (current && current.allocationId === verified.allocationId && transport.connected(resolved.nodeId)) return { status: "attached" as const, replayed: true, nodeId: resolved.nodeId, nodeHandle: verified.nodeHandle };
    // A superseding allocation for the same node replaces the live channel; the
    // stale one is torn down before the new session starts.
    if (current) this.closeNode(verified.nodeHandle, "allocation-superseded");
    const connection = await this.options.connector.connect({
      allocation: verified,
      serviceOrigin: this.options.state.snapshot().serviceOrigin,
      ...(resolved.pairing ? { pairing: resolved.pairing } : {}),
      createPairing: () => ({ keyId: `key_${crypto.randomUUID().replaceAll("-", "_")}`, secret: crypto.randomBytes(32).toString("base64url") }),
    }).catch((error: unknown) => {
      this.recordError(verified.nodeHandle, error);
      throw error;
    });
    if (connection.issuedPairing) await this.options.nodes.savePairing(resolved.nodeId, connection.issuedPairing);
    this.channels.set(verified.nodeHandle, {
      allocationId: verified.allocationId,
      nodeId: resolved.nodeId,
      ...(connection.channelId ? { channelId: connection.channelId } : {}),
      connectedAt: new Date(this.now()).toISOString(),
    });
    this.claims.delete(verified.nodeHandle);
    this.errors.delete(verified.nodeHandle);
    transport.attachNode(resolved.nodeId, {
      socket: connection.socket,
      key: connection.key,
      onClosed: (reason) => this.handleClosed(verified.nodeHandle, reason),
    });
    await this.options.nodes.connected(resolved.nodeId, { nodeHandle: verified.nodeHandle });
    this.options.audit?.({ type: "node-relay.channel.attached", outcome: "allowed", nodeHandle: verified.nodeHandle, reason: connection.paired ? "paired" : "pairing-established" });
    return { status: "attached" as const, nodeId: resolved.nodeId, nodeHandle: verified.nodeHandle };
  }

  closeNode(nodeHandle: string, reason: string) {
    const channel = this.channels.get(nodeHandle);
    if (!channel) return false;
    this.channels.delete(nodeHandle);
    this.options.transport?.()?.detachNode(channel.nodeId, reason);
    void this.options.nodes.disconnected(channel.nodeId, { nodeHandle, reason });
    this.options.audit?.({ type: "node-relay.channel.closed", outcome: "allowed", nodeHandle, reason });
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
    };
  }

  private handleClosed(nodeHandle: string, reason: string) {
    const channel = this.channels.get(nodeHandle);
    if (!channel) return;
    this.channels.delete(nodeHandle);
    void this.options.nodes.disconnected(channel.nodeId, { nodeHandle, reason });
    this.options.audit?.({ type: "node-relay.channel.closed", outcome: "allowed", nodeHandle, reason });
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
