import assert from "node:assert/strict";
import test from "node:test";
import { ControlPlaneNodeAgentTunnelTransport } from "../src/control-plane/nodes/tunnel.ts";
import { CloudRelayNodeAgentTransport } from "../src/control-plane/nodes/cloud-relay-transport.ts";
import { CloudNodeRelayChannels } from "../src/control-plane/cloud-connectivity/node-relay-channels.ts";
import {
  acceptingNodeRelayConnector,
  ed25519Identity,
  linkedFrameSockets,
  nodeRelayAllocationEvent,
  nodeRelayClaimGrant,
  nodeRelayFingerprint,
  startNodeSession,
} from "./support/cloud-relay-node-harness.ts";

function cloudState(controlPlaneId: string, bindingId: string) {
  return {
    snapshot: () => ({
      status: "active",
      scopes: { deviceAccess: true, nodeRelay: true },
      cloudControlPlaneId: controlPlaneId,
      identity: { controlPlaneId, publicKey: "test", fingerprint: "test" },
      accountId: "account_a",
      bindingId,
      bindingRevision: 1,
      serviceOrigin: "https://cloud.example.com",
    }),
  };
}

function nodeStore() {
  const records = new Map<string, { nodeId: string; pairing?: { keyId: string; secret: string } }>();
  const calls = { connected: [] as string[], disconnected: [] as string[], saved: [] as string[] };
  return {
    records,
    calls,
    adapter: {
      resolve: (nodeHandle: string) => {
        const record = records.get(nodeHandle);
        if (!record) return undefined;
        return { nodeId: record.nodeId, ...(record.pairing ? { pairing: record.pairing } : {}) };
      },
      ensure: async (input: { nodeHandle: string }) => {
        await new Promise((resolve) => setImmediate(resolve));
        const nodeId = `node_${input.nodeHandle}`;
        records.set(input.nodeHandle, { nodeId });
        return { nodeId };
      },
      savePairing: (nodeId: string, pairing: { keyId: string; secret: string }) => {
        calls.saved.push(nodeId);
        for (const record of records.values()) if (record.nodeId === nodeId) record.pairing = pairing;
      },
      connected: (nodeId: string) => { calls.connected.push(nodeId); },
      disconnected: (nodeId: string, input: { reason: string }) => { calls.disconnected.push(`${nodeId}:${input.reason}`); },
    },
  };
}

function controlPlaneChannel(options: { controlPlaneId: string; bindingId: string; socket: ReturnType<typeof linkedFrameSockets>["left"] | (() => ReturnType<typeof linkedFrameSockets>["left"]); identity: ReturnType<typeof ed25519Identity>; store: ReturnType<typeof nodeStore>; audit?: Array<Record<string, unknown>>; onConnect?: (input: { paired: boolean }) => void }) {
  const tunnel = new ControlPlaneNodeAgentTunnelTransport();
  const transport = new CloudRelayNodeAgentTransport({ tunnel });
  const channels = new CloudNodeRelayChannels({
    state: cloudState(options.controlPlaneId, options.bindingId),
    connector: acceptingNodeRelayConnector({
      socket: options.socket,
      identity: { controlPlaneId: options.controlPlaneId, publicKey: options.identity.publicKey, signNodeRelayHandshake: (input) => options.identity.sign(input) },
      onConnect: (input) => options.onConnect?.({ paired: input.paired }),
    }),
    transport: () => transport,
    nodes: options.store.adapter,
    ...(options.audit ? { audit: (event) => { options.audit!.push(event); } } : {}),
  });
  return { tunnel, transport, channels };
}

test("each Control Plane keeps its own channel and pairing for one node, and one channel closing leaves the other live", async () => {
  const node = ed25519Identity();
  const fingerprint = nodeRelayFingerprint(node.publicKey);
  const cp1 = ed25519Identity();
  const cp2 = ed25519Identity();
  const sockets1 = linkedFrameSockets();
  const sockets2 = linkedFrameSockets();
  const store1 = nodeStore();
  const store2 = nodeStore();
  const audit: Array<Record<string, unknown>> = [];
  const cpOne = controlPlaneChannel({ controlPlaneId: "control_plane_cp1", bindingId: "binding_a", socket: sockets1.left, identity: cp1, store: store1, audit });
  const cpTwo = controlPlaneChannel({ controlPlaneId: "control_plane_cp2", bindingId: "binding_b", socket: sockets2.left, identity: cp2, store: store2, audit });

  const event1 = nodeRelayAllocationEvent({ allocationId: "node_allocation_cp1", nodeHandle: "nrh_node_alpha", controlPlaneId: "control_plane_cp1", accountId: "account_a", bindingId: "binding_a", nodePublicKeyFingerprint: fingerprint, displayName: "Alpha box" });
  const event2 = nodeRelayAllocationEvent({ allocationId: "node_allocation_cp2", nodeHandle: "nrh_node_alpha", controlPlaneId: "control_plane_cp2", accountId: "account_a", bindingId: "binding_b", nodePublicKeyFingerprint: fingerprint, displayName: "Alpha box" });
  const received1: any[] = [];
  const received2: any[] = [];
  const session1 = startNodeSession(sockets1.right, nodeRelayClaimGrant(event1, cp1.publicKey), node, received1);
  const session2 = startNodeSession(sockets2.right, nodeRelayClaimGrant(event2, cp2.publicKey), node, received2);

  await cpOne.channels.attach(event1);
  await cpTwo.channels.attach(event2);
  await Promise.all([session1, session2]);

  assert.equal(cpOne.transport.connected("node_nrh_node_alpha"), true);
  assert.equal(cpTwo.transport.connected("node_nrh_node_alpha"), true);
  assert.deepEqual(received1.map((message) => message.type), ["control-plane.hello", "control-plane.identified"]);
  assert.deepEqual(received2.map((message) => message.type), ["control-plane.hello", "control-plane.identified"]);
  assert.equal(received1[0].nodeId, "node_nrh_node_alpha");
  const pairing1 = store1.records.get("nrh_node_alpha")?.pairing;
  const pairing2 = store2.records.get("nrh_node_alpha")?.pairing;
  assert.ok(pairing1 && pairing2, "both Control Planes pinned their own pairing");
  assert.notEqual(pairing1.secret, pairing2.secret, "pairing secrets are per Control Plane");

  const first = await cpOne.transport.request({ id: "node_nrh_node_alpha", connectionMode: "cloud-relay" } as any, "/health");
  assert.deepEqual(await first.json(), { data: { nodeId: "/health" } });

  // Removing the node on one Control Plane only tears down that channel.
  cpOne.channels.closeNode("nrh_node_alpha", "control-plane-removed-node");
  assert.equal(cpOne.transport.connected("node_nrh_node_alpha"), false);
  assert.deepEqual(store1.calls.disconnected, ["node_nrh_node_alpha:control-plane-removed-node"]);
  assert.equal(cpTwo.transport.connected("node_nrh_node_alpha"), true);
  const second = await cpTwo.transport.request({ id: "node_nrh_node_alpha", connectionMode: "cloud-relay" } as any, "/health");
  assert.deepEqual(await second.json(), { data: { nodeId: "/health" } });
  assert.equal(store2.calls.disconnected.length, 0);
  cpTwo.channels.closeAll("test-done");
});

test("a reconnect proves the pinned pairing instead of enrolling a new one", async () => {
  const node = ed25519Identity();
  const fingerprint = nodeRelayFingerprint(node.publicKey);
  const cp = ed25519Identity();
  const store = nodeStore();
  const event = nodeRelayAllocationEvent({ allocationId: "node_allocation_a", nodeHandle: "nrh_node_alpha", controlPlaneId: "control_plane_cp1", accountId: "account_a", bindingId: "binding_a", nodePublicKeyFingerprint: fingerprint });
  const observed: boolean[] = [];

  const first = linkedFrameSockets();
  const one = controlPlaneChannel({ controlPlaneId: "control_plane_cp1", bindingId: "binding_a", socket: first.left, identity: cp, store, onConnect: (input) => observed.push(input.paired) });
  const firstSession = startNodeSession(first.right, nodeRelayClaimGrant(event, cp.publicKey), node, []);
  await one.channels.attach(event);
  await firstSession;
  const pinned = store.records.get("nrh_node_alpha")?.pairing;
  assert.ok(pinned);
  assert.equal(store.calls.saved.length, 1);
  one.channels.closeNode("nrh_node_alpha", "reconnect");

  // Same node, same Control Plane, a fresh allocation: the stored pairing must be proved.
  const renewed = { ...event, allocationId: "node_allocation_b" };
  const second = linkedFrameSockets();
  const two = controlPlaneChannel({ controlPlaneId: "control_plane_cp1", bindingId: "binding_a", socket: second.left, identity: cp, store, onConnect: (input) => observed.push(input.paired) });
  const secondSession = startNodeSession(second.right, nodeRelayClaimGrant(renewed, cp.publicKey), node, [], pinned);
  await two.channels.attach(renewed);
  await secondSession;
  assert.deepEqual(observed, [false, true]);
  assert.equal(store.calls.saved.length, 1, "no second pairing was enrolled");
  assert.deepEqual(store.records.get("nrh_node_alpha")?.pairing, pinned);
  two.channels.closeAll("test-done");
});

test("a superseding allocation replaces the live channel for the same handle", async () => {
  const node = ed25519Identity();
  const fingerprint = nodeRelayFingerprint(node.publicKey);
  const cp = ed25519Identity();
  const store = nodeStore();
  const event = nodeRelayAllocationEvent({ allocationId: "node_allocation_a", nodeHandle: "nrh_node_alpha", controlPlaneId: "control_plane_cp1", accountId: "account_a", bindingId: "binding_a", nodePublicKeyFingerprint: fingerprint });
  const first = linkedFrameSockets();
  const second = linkedFrameSockets();
  const sockets: Array<ReturnType<typeof linkedFrameSockets>["left"]> = [first.left, second.left];
  const one = controlPlaneChannel({ controlPlaneId: "control_plane_cp1", bindingId: "binding_a", socket: () => sockets.shift()!, identity: cp, store });
  const firstSession = startNodeSession(first.right, nodeRelayClaimGrant(event, cp.publicKey), node, []);
  await one.channels.attach(event);
  await firstSession;

  const secondSession = startNodeSession(second.right, nodeRelayClaimGrant({ ...event, allocationId: "node_allocation_b" }, cp.publicKey), node, []);
  await one.channels.attach({ ...event, allocationId: "node_allocation_b" });
  await secondSession;
  assert.deepEqual(store.calls.disconnected, ["node_nrh_node_alpha:allocation-superseded"]);
  assert.equal(store.records.size, 1, "a superseding allocation reuses the same local node record");
  assert.equal(one.transport.connected("node_nrh_node_alpha"), true);
  one.channels.closeAll("test-done");
});

test("a node that cannot prove the registered key never reaches the transport", async () => {
  const registered = ed25519Identity();
  const attacker = ed25519Identity();
  const cp = ed25519Identity();
  const store = nodeStore();
  const sockets = linkedFrameSockets();
  const channel = controlPlaneChannel({ controlPlaneId: "control_plane_cp1", bindingId: "binding_a", socket: sockets.left, identity: cp, store });
  const event = nodeRelayAllocationEvent({ allocationId: "node_allocation_a", nodeHandle: "nrh_node_alpha", controlPlaneId: "control_plane_cp1", accountId: "account_a", bindingId: "binding_a", nodePublicKeyFingerprint: nodeRelayFingerprint(registered.publicKey) });
  const attackerSession = startNodeSession(sockets.right, nodeRelayClaimGrant(event, cp.publicKey), attacker, [], undefined, 250);
  await assert.rejects(() => channel.channels.attach(event), { code: "NODE_RELAY_NODE_KEY_MISMATCH" });
  await attackerSession.catch(() => undefined);
  assert.equal(channel.transport.connected("node_nrh_node_alpha"), false);
  assert.deepEqual(store.calls.connected, []);
  assert.equal(channel.channels.state().errors[0]?.code, "NODE_RELAY_NODE_KEY_MISMATCH");
});

test("a node refuses a peer that does not hold the key pinned in its claim grant", async () => {
  const node = ed25519Identity();
  const fingerprint = nodeRelayFingerprint(node.publicKey);
  const realControlPlane = ed25519Identity();
  const impostor = ed25519Identity();
  const store = nodeStore();
  const sockets = linkedFrameSockets();
  // The node fetched a grant pinning the real Control Plane; the socket is answered by someone else.
  const channel = controlPlaneChannel({ controlPlaneId: "control_plane_cp1", bindingId: "binding_a", socket: sockets.left, identity: impostor, store });
  const event = nodeRelayAllocationEvent({ allocationId: "node_allocation_a", nodeHandle: "nrh_node_alpha", controlPlaneId: "control_plane_cp1", accountId: "account_a", bindingId: "binding_a", nodePublicKeyFingerprint: fingerprint });
  const received: any[] = [];
  const session = startNodeSession(sockets.right, nodeRelayClaimGrant(event, realControlPlane.publicKey), node, received);
  await channel.channels.attach(event).catch(() => undefined);
  await assert.rejects(() => session, { code: "NODE_RELAY_HANDSHAKE_MISMATCH" });
  assert.deepEqual(received, [], "the node never opened a tunnel session with the impostor");
  channel.channels.closeAll("test-done");
});

test("an allocation that does not match the local binding is refused and recorded", async () => {
  const node = ed25519Identity();
  const cp = ed25519Identity();
  const store = nodeStore();
  const sockets = linkedFrameSockets();
  const channel = controlPlaneChannel({ controlPlaneId: "control_plane_cp1", bindingId: "binding_a", socket: sockets.left, identity: cp, store });
  const event = nodeRelayAllocationEvent({ allocationId: "node_allocation_a", nodeHandle: "nrh_node_alpha", controlPlaneId: "control_plane_cp1", accountId: "account_a", bindingId: "binding_a", bindingRevision: 2, nodePublicKeyFingerprint: nodeRelayFingerprint(node.publicKey) });
  await assert.rejects(() => channel.channels.attach(event), { code: "RELAY_ALLOCATION_AUTHORITY_INVALID" });
  assert.equal(channel.transport.connected("node_nrh_node_alpha"), false);
  assert.deepEqual(store.calls.connected, []);
  assert.equal(channel.channels.state().errors[0]?.code, "RELAY_ALLOCATION_AUTHORITY_INVALID");
  assert.equal(channel.channels.state().channels.length, 0);
});
