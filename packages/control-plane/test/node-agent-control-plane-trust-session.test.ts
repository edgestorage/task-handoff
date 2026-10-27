import assert from "node:assert/strict";
import test from "node:test";
import {
  NODE_AGENT_CONTROL_PLANE_TRUST_AUDIENCE,
  NODE_AGENT_CONTROL_PLANE_TRUST_PROTOCOL_VERSION,
  nodeAgentControlPlaneTrustSigningInput,
} from "@task-handoff/protocol/node-relay-channel";
import {
  nodeRelayFingerprint,
  verifyNodeAgentControlPlaneTrustOutcome,
  type NodeRelayHandshakeExpectation,
} from "../src/shared/cloud-relay/node-relay-session.ts";
import { ed25519Identity } from "./support/cloud-relay-node-harness.ts";

const NOW = Date.parse("2026-10-26T10:00:00.000Z");

function fixture() {
  const node = ed25519Identity("node_trust_test");
  const controlPlane = ed25519Identity("control_plane_trust_test");
  const expectation: NodeRelayHandshakeExpectation = {
    allocationId: "allocation_trust",
    relayId: "relay_trust",
    nodeHandle: "nrh_trust_node",
    controlPlaneId: "control_plane_trust_test",
    controlPlanePublicKey: controlPlane.publicKey,
    accountId: "account_trust",
    ownerAccountId: "account_trust",
    accessMode: "owner",
    bindingId: "binding_trust",
    bindingRevision: 7,
    nodePublicKeyFingerprint: nodeRelayFingerprint(node.publicKey),
    now: () => NOW,
  };
  const payload = {
    type: "node-agent.control-plane-trust" as const,
    protocolVersion: NODE_AGENT_CONTROL_PLANE_TRUST_PROTOCOL_VERSION,
    audience: NODE_AGENT_CONTROL_PLANE_TRUST_AUDIENCE,
    allocationId: "allocation_trust",
    relayId: "relay_trust",
    nodeHandle: "nrh_trust_node",
    nodeId: "node_trust_test",
    nodePublicKey: node.publicKey,
    nodePublicKeyFingerprint: nodeRelayFingerprint(node.publicKey),
    controlPlaneId: "control_plane_trust_test",
    controlPlanePublicKeyFingerprint: nodeRelayFingerprint(controlPlane.publicKey),
    bindingId: "binding_trust",
    bindingRevision: 7,
    access: { accountId: "account_trust", ownerAccountId: "account_trust", accessMode: "owner" as const },
    state: "pending" as const,
    reason: "first-seen" as const,
    requestId: "cptreq_trust",
    requestedAt: "2026-10-26T09:59:59.000Z",
    expiresAt: "2026-10-27T09:59:59.000Z",
    issuedAt: "2026-10-26T09:59:59.500Z",
  };
  return { node, controlPlane, expectation, payload };
}

function sign(node: ReturnType<typeof ed25519Identity>, payload: Record<string, unknown>) {
  return { ...payload, signature: node.sign(nodeAgentControlPlaneTrustSigningInput(payload)) };
}

test("node-agent Control Plane trust outcome binds the node signature, allocation, CP key and access context", () => {
  const { node, expectation, payload } = fixture();
  const outcome = sign(node, payload);
  assert.deepEqual(verifyNodeAgentControlPlaneTrustOutcome({ outcome, expectation, now: NOW }), outcome);

  const tampered = { ...outcome, reason: "key-changed" };
  assert.throws(() => verifyNodeAgentControlPlaneTrustOutcome({ outcome: tampered, expectation, now: NOW }), { code: "NODE_AGENT_CONTROL_PLANE_TRUST_OUTCOME_SIGNATURE_INVALID" });

  const wrongAllocation = sign(node, { ...payload, allocationId: "allocation_other" });
  assert.throws(() => verifyNodeAgentControlPlaneTrustOutcome({ outcome: wrongAllocation, expectation, now: NOW }), { code: "NODE_AGENT_CONTROL_PLANE_TRUST_OUTCOME_MISMATCH" });

  const wrongControlPlane = ed25519Identity("control_plane_other");
  const wrongControlPlaneOutcome = sign(node, { ...payload, controlPlanePublicKeyFingerprint: nodeRelayFingerprint(wrongControlPlane.publicKey) });
  assert.throws(() => verifyNodeAgentControlPlaneTrustOutcome({ outcome: wrongControlPlaneOutcome, expectation, now: NOW }), { code: "NODE_AGENT_CONTROL_PLANE_TRUST_OUTCOME_MISMATCH" });

  const wrongAccess = sign(node, { ...payload, access: { accountId: "account_other", ownerAccountId: "account_other", accessMode: "owner" } });
  assert.throws(() => verifyNodeAgentControlPlaneTrustOutcome({ outcome: wrongAccess, expectation, now: NOW }), { code: "NODE_AGENT_CONTROL_PLANE_TRUST_ACCESS_MISMATCH" });

  const wrongNodeFingerprint = sign(node, { ...payload, nodePublicKeyFingerprint: `sha256:${"A".repeat(43)}` });
  assert.throws(() => verifyNodeAgentControlPlaneTrustOutcome({ outcome: wrongNodeFingerprint, expectation, now: NOW }), { code: "NODE_AGENT_CONTROL_PLANE_TRUST_NODE_KEY_MISMATCH" });
});

test("node-agent Control Plane trust outcome rejects expired pending requests and malformed states", () => {
  const { node, expectation, payload } = fixture();
  const expired = sign(node, { ...payload, expiresAt: "2026-10-26T09:59:59.999Z" });
  assert.throws(() => verifyNodeAgentControlPlaneTrustOutcome({ outcome: expired, expectation, now: NOW }), { code: "NODE_AGENT_CONTROL_PLANE_TRUST_OUTCOME_EXPIRED" });

  const contradictory = { ...payload, reason: "rejected", signature: "s".repeat(86) };
  assert.throws(() => verifyNodeAgentControlPlaneTrustOutcome({ outcome: contradictory, expectation, now: NOW }), { code: "NODE_AGENT_CONTROL_PLANE_TRUST_OUTCOME_INVALID" });

  const unknownField = { ...payload, channelKey: "must-not-cross-the-wire", signature: "s".repeat(86) };
  assert.throws(() => verifyNodeAgentControlPlaneTrustOutcome({ outcome: unknownField, expectation, now: NOW }), { code: "NODE_AGENT_CONTROL_PLANE_TRUST_OUTCOME_INVALID" });
});
