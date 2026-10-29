import assert from "node:assert/strict";
import test from "node:test";
import { CLOUD_ACCOUNT_NODE_HANDLE_LABEL, NodeSchema } from "@task-handoff/protocol/control-plane";
import { cloudAccountNodeCandidates } from "../src/apps/control-plane/settings/cloudAccountNodeCandidates.ts";

const timestamp = "2026-10-29T00:00:00.000Z";
function item(nodeHandle, overrides = {}) {
  return { nodeHandle, displayName: "MacMini", publicKeyFingerprint: "fingerprint", status: "active", revision: 1, createdAt: timestamp, updatedAt: timestamp, ...overrides };
}
function account(items, relay = {}) {
  return { signedIn: true, items, nodeRelay: { channels: [], claims: [], errors: [], onboarding: [], trust: [], ...relay } };
}
function node(nodeHandle, overrides = {}) {
  return NodeSchema.parse({
    id: "node_managed", name: "MacMini", connectionMode: "local-ipc", connectionPath: { kind: "direct" },
    status: "online", labels: { [CLOUD_ACCOUNT_NODE_HANDLE_LABEL]: nodeHandle },
    createdAt: timestamp, updatedAt: timestamp, ...overrides,
  });
}

test("an account-published local node is not offered as another connection without a relay channel", () => {
  const directory = account([item("nrh_macmini"), item("nrh_another")]);
  const nodes = [node("nrh_macmini")];
  assert.deepEqual(cloudAccountNodeCandidates(directory, nodes), [directory.items[1]]);
  assert.equal(directory.items.length, 2, "the account directory remains authoritative and unmodified");
  assert.equal(nodes[0].connectionMode, "local-ipc");
});

test("existing direct and reverse connections are excluded independently of online state", () => {
  const directory = account([item("nrh_managed")]);
  for (const connectionMode of ["local-ipc", "local-loopback", "direct-http", "reverse-wss"]) {
    for (const status of ["online", "offline", "unknown"]) {
      assert.deepEqual(cloudAccountNodeCandidates(directory, [node("nrh_managed", { connectionMode, status, connectionEnabled: false })]), [], `${connectionMode}: ${status}`);
    }
  }
});

test("existing cloud-relay nodes use their connection path even without a linking label", () => {
  const directory = account([item("nrh_managed"), item("nrh_new")]);
  const managed = node(undefined, {
    labels: {}, connectionMode: "cloud-relay", connectionPath: { kind: "cloud-relay", nodeHandle: "nrh_managed" },
  });
  assert.deepEqual(cloudAccountNodeCandidates(directory, [managed]), [directory.items[1]]);
});

test("a connected channel is excluded before the managed-node snapshot arrives", () => {
  const directory = account([item("nrh_connected"), item("nrh_new")], {
    channels: [{ nodeHandle: "nrh_connected", nodeId: "node_connected", allocationId: "allocation_a", connectedAt: timestamp, connected: true }],
  });
  assert.deepEqual(cloudAccountNodeCandidates(directory, []), [directory.items[1]]);
});

test("same names do not collapse identities and an in-flight claim stays visible until managed", () => {
  const directory = account([item("nrh_local"), item("nrh_other"), item("nrh_pending")], {
    claims: [{ nodeHandle: "nrh_pending", requestedAt: timestamp }],
  });
  const nodes = [node("nrh_local")];
  assert.deepEqual(cloudAccountNodeCandidates(directory, nodes), [directory.items[1], directory.items[2]]);
  nodes.push(node(undefined, { id: "node_pending", labels: {}, connectionMode: "cloud-relay", connectionPath: { kind: "cloud-relay", nodeHandle: "nrh_pending" } }));
  assert.deepEqual(cloudAccountNodeCandidates(directory, nodes), [directory.items[1]]);
});

test("only active unmanaged account nodes can be added, including shared nodes", () => {
  const shared = item("nrh_shared", { access: { kind: "shared", shareId: "share_a", revision: 1, role: "use", expiresAt: timestamp } });
  const directory = account([item("nrh_suspended", { status: "suspended" }), item("nrh_revoked", { status: "revoked" }), shared]);
  assert.deepEqual(cloudAccountNodeCandidates(directory, []), [shared]);
  assert.deepEqual(cloudAccountNodeCandidates(undefined, []), []);
  assert.deepEqual(cloudAccountNodeCandidates(account([]), []), []);
});

test("signed trust outcomes stay reviewable after the pending node record arrives", () => {
  const pendingNode = node(undefined, {
    labels: {}, connectionMode: "cloud-relay", connectionPath: { kind: "cloud-relay", nodeHandle: "nrh_pending" },
  });
  for (const state of ["pending", "rejected", "expired"]) {
    const directory = account([item("nrh_pending"), item("nrh_new")], {
      trust: [{ nodeHandle: "nrh_pending", nodeId: pendingNode.id, state }],
      errors: [{ nodeHandle: "nrh_pending", code: "NODE_RELAY_CHANNEL_INVALID", message: "Channel unavailable", at: timestamp }],
    });
    assert.deepEqual(cloudAccountNodeCandidates(directory, []), directory.items, "trust can arrive before nodes");
    assert.deepEqual(cloudAccountNodeCandidates(directory, [pendingNode]), directory.items, state);

    directory.nodeRelay.channels.push({ nodeHandle: "nrh_pending", nodeId: pendingNode.id, connected: true });
    assert.deepEqual(cloudAccountNodeCandidates(directory, [pendingNode]), [directory.items[1]], "connection completion removes the add/review row");
  }
});

test("stale trust cannot expose another add action for an existing or cancelled node", () => {
  const pendingNode = node(undefined, {
    labels: {}, connectionMode: "cloud-relay", connectionPath: { kind: "cloud-relay", nodeHandle: "nrh_pending" },
  });
  const directory = account([item("nrh_pending")], { trust: [{ nodeHandle: "nrh_pending", nodeId: pendingNode.id, state: "pending" }] });
  assert.deepEqual(cloudAccountNodeCandidates(directory, [{ ...pendingNode, connectionEnabled: false }]), []);
  assert.deepEqual(cloudAccountNodeCandidates(directory, [{ ...pendingNode, id: "different_node" }]), []);
  assert.deepEqual(cloudAccountNodeCandidates(directory, [pendingNode, node("nrh_pending", { id: "local_node" })]), []);
});
