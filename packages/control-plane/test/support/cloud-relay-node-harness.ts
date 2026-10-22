import crypto from "node:crypto";
import nacl from "tweetnacl";
import { NodeRelayAllocationEventSchema, OUTBOUND_CONNECTION_PROTOCOL_VERSION, RELAY_FRAMING_PROTOCOL_VERSION } from "@task-handoff/cloud-contracts";
import {
  EncryptedNodeRelayChannel,
  NODE_RELAY_DIRECTION_CONTROL_PLANE,
  NODE_RELAY_DIRECTION_NODE,
  acceptNodeRelayHandshake,
  initiateNodeRelayHandshake,
  nodeRelayFingerprint,
  type NodeRelayFrameSocket,
} from "../../src/shared/cloud-relay/node-relay-session.ts";
import { NODE_RELAY_MAIN_STREAM_ID } from "@task-handoff/protocol/node-relay-channel";
import type { CloudNodeRelayChannelConnector } from "../../src/control-plane/cloud-connectivity/node-relay-channels.ts";
import type { ConnectedNodeRelayChannel, VerifiedNodeRelayAllocation } from "../../src/control-plane/cloud-connectivity/node-relay-connector.ts";

/** Deterministic-shape Ed25519 identity with the same surface the Control Plane exposes. */
export function ed25519Identity(nodeId = "node_agent_test") {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const publicKeyRaw = String((publicKey.export({ format: "jwk" }) as { x: string }).x);
  return {
    nodeId,
    publicKey: publicKeyRaw,
    sign(input: string) { return crypto.sign(null, Buffer.from(input), privateKey).toString("base64url"); },
  };
}

export type InMemoryFrameSocket = NodeRelayFrameSocket & { bufferedAmount: number; deliver(raw: unknown, isBinary: boolean): void; drop(): void };

/** Two in-memory sockets that behave like ws peers, including pre-listener buffering. */
export function linkedFrameSockets() {
  const make = (peer: () => InMemoryFrameSocket) => {
    const listeners = new Set<(raw: unknown, isBinary: boolean) => void>();
    const queue: Array<[unknown, boolean]> = [];
    const closeListeners: Array<(code?: number, reason?: unknown) => void> = [];
    const socket = {
      readyState: 1,
      bufferedAmount: 0,
      send(data: string | Uint8Array) { peer().deliver(Buffer.from(data), true); },
      close() { socket.readyState = 3; for (const listener of closeListeners) listener(1000, "closed"); peer().drop(); },
      on(event: string, listener: (...args: any[]) => void) {
        if (event === "message") {
          listeners.add(listener);
          for (const [raw, isBinary] of queue.splice(0)) listener(raw, isBinary);
        }
        if (event === "close") closeListeners.push(listener);
      },
      off(event: string, listener: (...args: any[]) => void) { if (event === "message") listeners.delete(listener); },
      deliver(raw: unknown, isBinary: boolean) {
        if (listeners.size) { for (const listener of [...listeners]) listener(raw, isBinary); return; }
        queue.push([raw, isBinary]);
      },
      drop() { for (const listener of closeListeners) listener(1006, "dropped"); },
    };
    return socket as InMemoryFrameSocket;
  };
  let left!: InMemoryFrameSocket;
  let right!: InMemoryFrameSocket;
  left = make(() => right);
  right = make(() => left);
  return { left, right };
}

/**
 * A schema-valid `node-relay-allocation` event as the Coordinator pushes it.
 * Parsing here means any contract drift fails the fixture, not the test body.
 */
export function nodeRelayAllocationEvent(input: {
  allocationId: string;
  relayId?: string;
  nodeHandle: string;
  nodeId?: string;
  controlPlaneId: string;
  accountId: string;
  bindingId: string;
  bindingRevision?: number;
  nodePublicKeyFingerprint: string;
  displayName?: string;
  relayUrl?: string;
  expiresAt?: string;
}) {
  const now = Date.now();
  const attach = {
    protocolVersion: RELAY_FRAMING_PROTOCOL_VERSION,
    channelKind: "node" as const,
    audience: "task-handoff:relay-control-plane-attach" as const,
    allocationId: input.allocationId,
    relayId: input.relayId ?? "relay_a",
    role: "control-plane" as const,
    controlPlaneId: input.controlPlaneId,
    accountId: input.accountId,
    bindingId: input.bindingId,
    bindingRevision: input.bindingRevision ?? 1,
    nodeHandle: input.nodeHandle,
    trafficClass: "interactive" as const,
    nonce: crypto.randomBytes(24).toString("base64url"),
    issuedAt: new Date(now - 1_000).toISOString(),
    expiresAt: new Date(now + 5 * 60_000).toISOString(),
    signature: crypto.randomBytes(64).toString("base64url"),
  };
  return NodeRelayAllocationEventSchema.parse({
    type: "node-relay-allocation",
    protocolVersion: OUTBOUND_CONNECTION_PROTOCOL_VERSION,
    allocationId: input.allocationId,
    relayId: attach.relayId,
    relayRegion: "test-region",
    // Default under the test cloud origin so the Control Plane's Relay-host trust check passes.
    relayUrl: input.relayUrl ?? "wss://relay.cloud.example.com/relay",
    nodeHandle: input.nodeHandle,
    controlPlaneId: input.controlPlaneId,
    bindingId: input.bindingId,
    bindingRevision: attach.bindingRevision,
    controlPlaneAttach: attach,
    expiresAt: input.expiresAt ?? new Date(now + 5 * 60_000).toISOString(),
    nodePublicKeyFingerprint: input.nodePublicKeyFingerprint,
    ...(input.nodeId ? { nodeId: input.nodeId } : {}),
    ...(input.displayName ? { displayName: input.displayName } : {}),
  });
}

/** The subset of one pushed allocation the Control Plane pins against the node's hello. */
export function nodeRelayHandshakeExpectation(allocation: VerifiedNodeRelayAllocation) {
  return {
    allocationId: allocation.event.allocationId,
    relayId: allocation.event.relayId,
    nodeHandle: allocation.event.nodeHandle,
    controlPlaneId: allocation.event.controlPlaneId,
    accountId: allocation.attach.accountId,
    bindingId: allocation.event.bindingId,
    bindingRevision: allocation.event.bindingRevision,
    nodePublicKeyFingerprint: allocation.nodePublicKeyFingerprint,
  };
}

/** The node-side claim grant (the node fetches it from the cloud, never the Control Plane). */
export function nodeRelayClaimGrant(allocation: ReturnType<typeof nodeRelayAllocationEvent>, controlPlanePublicKey: string) {
  return {
    grantId: `grant_${allocation.allocationId}`,
    allocationId: allocation.allocationId,
    relayId: allocation.relayId,
    relayRegion: allocation.relayRegion,
    relayUrl: allocation.relayUrl,
    nodeHandle: allocation.nodeHandle,
    controlPlaneId: allocation.controlPlaneId,
    accountId: allocation.controlPlaneAttach.accountId,
    bindingId: allocation.bindingId,
    bindingRevision: allocation.bindingRevision,
    controlPlanePublicKey,
  };
}

/** The Control Plane side of one channel, as an injected connector for the channel owner. */
export function acceptingNodeRelayConnector(input: {
  /** A fixed socket, or a queue source for reconnects on the same channel owner. */
  socket: NodeRelayFrameSocket | (() => NodeRelayFrameSocket);
  identity: { controlPlaneId: string; publicKey: string; signNodeRelayHandshake(input: string): string };
  onConnect?(input: { allocation: { nodeHandle: string }; paired: boolean }): void;
}): CloudNodeRelayChannelConnector {
  return {
    async connect(options: {
      allocation: VerifiedNodeRelayAllocation;
      pairing?: { keyId: string; secret: string };
      createPairing(): { keyId: string; secret: string };
    }): Promise<ConnectedNodeRelayChannel> {
      const socket = typeof input.socket === "function" ? input.socket() : input.socket;
      const accepted = await acceptNodeRelayHandshake({
        socket,
        identity: input.identity,
        expectation: nodeRelayHandshakeExpectation(options.allocation),
        ...(options.pairing ? { pairing: options.pairing } : {}),
        createPairing: options.createPairing,
      });
      input.onConnect?.({ allocation: options.allocation, paired: accepted.paired });
      return {
        socket,
        key: accepted.key,
        nodeId: accepted.init.nodeId,
        paired: accepted.paired,
        ...(accepted.issuedPairing ? { issuedPairing: accepted.issuedPairing } : {}),
        allocationId: options.allocation.allocationId,
        channelId: `channel_${options.allocation.allocationId}`,
      };
    },
  };
}

/**
 * Minimal node-agent side: completes the handshake, serves the tunnel protocol
 * well enough to prove the transport works, and records inbound tunnel frames.
 */
export async function startNodeSession(
  socket: NodeRelayFrameSocket,
  grant: ReturnType<typeof nodeRelayClaimGrant>,
  identity: { nodeId: string; publicKey: string; sign(input: string): string },
  incoming: unknown[],
  pairing?: { keyId: string; secret: string },
  timeoutMs?: number,
) {
  const { key, paired, pairing: issuedPairing } = await initiateNodeRelayHandshake({ socket, grant, node: identity, ...(pairing ? { pairing } : {}), ...(timeoutMs ? { timeoutMs } : {}) });
  const session = new EncryptedNodeRelayChannel({
    socket,
    key,
    sendDirection: NODE_RELAY_DIRECTION_NODE,
    receiveDirection: NODE_RELAY_DIRECTION_CONTROL_PLANE,
    onMessage(message) {
      if (message.type === "relay-ping") return session.send({ type: "relay-pong" });
    },
    onData(frame) {
      if (frame.streamId !== NODE_RELAY_MAIN_STREAM_ID || frame.binary) return;
      const value = JSON.parse(Buffer.from(frame.data).toString("utf8"));
      incoming.push(value);
      const sendMain = (message: unknown) => session.sendData(NODE_RELAY_MAIN_STREAM_ID, JSON.stringify(message), false);
      if (value.type === "control-plane.hello") sendMain({ type: "node-agent.identify", nodeId: value.nodeId, serverTime: new Date().toISOString() });
      if (value.type === "control-plane.request") {
        sendMain({ type: "node-agent.response", requestId: value.requestId, status: 200, headers: { "content-type": "application/json" }, body: JSON.stringify({ data: { nodeId: value.route } }) });
      }
    },
  });
  session.start();
  return { session, key, paired, issuedPairing };
}

export { nodeRelayFingerprint, nacl };
