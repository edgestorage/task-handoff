import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { encodeRelayFrame } from "@task-handoff/cloud-contracts";
import {
  NODE_AGENT_CONTROL_PLANE_TRUST_AUDIENCE,
  NODE_AGENT_CONTROL_PLANE_TRUST_PROTOCOL_VERSION,
  nodeAgentControlPlaneTrustSigningInput,
} from "@task-handoff/protocol/node-relay-channel";
import { CloudNodeRelayConnector } from "../src/control-plane/cloud-connectivity/node-relay-connector.ts";
import { nodeRelayFingerprint } from "../src/shared/cloud-relay/node-relay-session.ts";
import { ed25519Identity } from "./support/cloud-relay-node-harness.ts";

async function verifyCoalescedTrust(frameFirst: boolean) {
  const node = ed25519Identity("node_coalesced_trust");
  const controlPlane = ed25519Identity("control_plane_coalesced_trust");
  const issuedAt = new Date();
  const payload = {
    type: "node-agent.control-plane-trust" as const,
    protocolVersion: NODE_AGENT_CONTROL_PLANE_TRUST_PROTOCOL_VERSION,
    audience: NODE_AGENT_CONTROL_PLANE_TRUST_AUDIENCE,
    allocationId: "nal_coalesced_trust",
    relayId: "relay_coalesced_trust",
    nodeHandle: "nrh_coalesced_trust",
    nodeId: node.nodeId,
    nodePublicKey: node.publicKey,
    nodePublicKeyFingerprint: nodeRelayFingerprint(node.publicKey),
    controlPlaneId: controlPlane.nodeId,
    controlPlanePublicKeyFingerprint: nodeRelayFingerprint(controlPlane.publicKey),
    bindingId: "bnd_coalesced_trust",
    bindingRevision: 1,
    access: { accountId: "acct_coalesced_trust", ownerAccountId: "acct_coalesced_trust", accessMode: "owner" as const },
    state: "pending" as const,
    reason: "first-seen" as const,
    requestId: "cptreq_coalesced_trust",
    requestedAt: issuedAt.toISOString(),
    expiresAt: new Date(issuedAt.getTime() + 60_000).toISOString(),
    issuedAt: issuedAt.toISOString(),
  };
  const outcome = {
    ...payload,
    signature: node.sign(nodeAgentControlPlaneTrustSigningInput(payload)),
  };
  const outcomeFrame = encodeRelayFrame({
    kind: "handshake",
    sequence: 0,
    payload: Buffer.from(JSON.stringify(outcome)),
  });

  class CoalescedSocket extends EventEmitter {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSING = 2;
    static readonly CLOSED = 3;
    readyState = CoalescedSocket.OPEN;

    constructor(_url: string) {
      super();
      queueMicrotask(() => this.emit("open"));
    }

    send(raw: string | Uint8Array) {
      if (typeof raw !== "string" || JSON.parse(raw).type !== "attach") return;
      const attached = Buffer.from(JSON.stringify({ type: "attached", channelId: "relay_channel_coalesced_trust" }));
      queueMicrotask(() => {
        if (frameFirst) {
          this.emit("message", outcomeFrame, true);
          this.emit("message", attached, false);
        } else {
          this.emit("message", attached, false);
          this.emit("message", outcomeFrame, true);
        }
      });
    }

    close(code?: number, reason?: string) {
      if (this.readyState === CoalescedSocket.CLOSED) return;
      this.readyState = CoalescedSocket.CLOSED;
      queueMicrotask(() => this.emit("close", code, reason));
    }
  }

  const connector = new CloudNodeRelayConnector({
    identity: {
      publicIdentity: () => ({ publicKey: controlPlane.publicKey }),
      signNodeRelayHandshake: (input: string) => controlPlane.sign(input),
    } as any,
    webSocket: CoalescedSocket as any,
    attachTimeoutMs: 200,
    handshakeTimeoutMs: 50,
  });

  const connection = await connector.connect({
    allocation: {
      allocationId: payload.allocationId,
      relayUrl: "wss://cloud.example.test/connect",
      epoch: 1,
      channelKind: "node",
      attach: {
        channelKind: "node",
        accountId: payload.access.accountId,
        ownerAccountId: payload.access.ownerAccountId,
        accessMode: payload.access.accessMode,
      },
      event: {
        allocationId: payload.allocationId,
        relayId: payload.relayId,
        nodeHandle: payload.nodeHandle,
        controlPlaneId: controlPlane.nodeId,
        accountId: payload.access.accountId,
        bindingId: payload.bindingId,
        bindingRevision: payload.bindingRevision,
      },
      nodeHandle: payload.nodeHandle,
      nodePublicKeyFingerprint: payload.nodePublicKeyFingerprint,
    },
    serviceOrigin: "https://cloud.example.test",
    createPairing: () => ({ keyId: "pairing_coalesced_trust", secret: "secret" }),
  });

  assert.equal(connection.status, "trust-required");
  assert.equal(connection.outcome.state, "pending");
  assert.equal(connection.outcome.requestId, payload.requestId);
}

test("a node trust outcome coalesced after the attach acknowledgement is not dropped", { timeout: 2_000 }, async () => {
  await verifyCoalescedTrust(false);
});

test("a node trust outcome coalesced before the attach acknowledgement is not dropped", { timeout: 2_000 }, async () => {
  await verifyCoalescedTrust(true);
});
