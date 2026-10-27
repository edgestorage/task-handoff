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
  const known = new Map<string, { nodeId: string; connectionKind: string; nodeHandle?: string }>();
  const calls = { connected: [] as string[], disconnected: [] as string[], saved: [] as string[] };
  return {
    records,
    known,
    calls,
    adapter: {
      resolve: (nodeHandle: string) => {
        const record = records.get(nodeHandle);
        if (!record) return undefined;
        return { nodeId: record.nodeId, ...(record.pairing ? { pairing: record.pairing } : {}) };
      },
      inspectNode: (nodeId: string) => known.get(nodeId),
      linkNode: (nodeId: string, nodeHandle: string) => { records.set(nodeHandle, { nodeId }); },
      ensure: async (input: { nodeHandle: string; nodeId: string }) => {
        await new Promise((resolve) => setImmediate(resolve));
        records.set(input.nodeHandle, { nodeId: input.nodeId });
        return { nodeId: input.nodeId };
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

function controlPlaneChannel(options: { controlPlaneId: string; bindingId: string; socket: ReturnType<typeof linkedFrameSockets>["left"] | (() => ReturnType<typeof linkedFrameSockets>["left"]); identity: ReturnType<typeof ed25519Identity>; store: ReturnType<typeof nodeStore>; audit?: Array<Record<string, unknown>>; onConnect?: (input: { paired: boolean }) => void; onPreserveLocalConnection?: (nodeHandle: string) => void }) {
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
    ...(options.onPreserveLocalConnection ? { onPreserveLocalConnection: options.onPreserveLocalConnection } : {}),
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

  const event1 = nodeRelayAllocationEvent({ allocationId: "node_allocation_cp1", nodeHandle: "nrh_node_alpha", nodeId: node.nodeId, controlPlaneId: "control_plane_cp1", accountId: "account_a", bindingId: "binding_a", nodePublicKeyFingerprint: fingerprint, displayName: "Alpha box" });
  const event2 = nodeRelayAllocationEvent({ allocationId: "node_allocation_cp2", nodeHandle: "nrh_node_alpha", nodeId: node.nodeId, controlPlaneId: "control_plane_cp2", accountId: "account_a", bindingId: "binding_b", nodePublicKeyFingerprint: fingerprint, displayName: "Alpha box" });
  const received1: any[] = [];
  const received2: any[] = [];
  const session1 = startNodeSession(sockets1.right, nodeRelayClaimGrant(event1, cp1.publicKey), node, received1);
  const session2 = startNodeSession(sockets2.right, nodeRelayClaimGrant(event2, cp2.publicKey), node, received2);

  await cpOne.channels.attach(event1);
  await cpTwo.channels.attach(event2);
  await Promise.all([session1, session2]);

  assert.equal(cpOne.transport.connected(node.nodeId), true);
  assert.equal(cpTwo.transport.connected(node.nodeId), true);
  assert.deepEqual(received1.map((message) => message.type), ["control-plane.hello", "control-plane.identified"]);
  assert.deepEqual(received2.map((message) => message.type), ["control-plane.hello", "control-plane.identified"]);
  assert.equal(received1[0].nodeId, node.nodeId);
  assert.equal(store1.records.get("nrh_node_alpha")?.nodeId, node.nodeId);
  const pairing1 = store1.records.get("nrh_node_alpha")?.pairing;
  const pairing2 = store2.records.get("nrh_node_alpha")?.pairing;
  assert.ok(pairing1 && pairing2, "both Control Planes pinned their own pairing");
  assert.notEqual(pairing1.secret, pairing2.secret, "pairing secrets are per Control Plane");

  const first = await cpOne.transport.request({ id: node.nodeId, connectionMode: "cloud-relay" } as any, "/health");
  assert.deepEqual(await first.json(), { data: { nodeId: "/health" } });

  // Removing the node on one Control Plane only tears down that channel.
  cpOne.channels.closeNode("nrh_node_alpha", "control-plane-removed-node");
  assert.equal(cpOne.transport.connected(node.nodeId), false);
  assert.deepEqual(store1.calls.disconnected, [`${node.nodeId}:control-plane-removed-node`]);
  assert.equal(cpTwo.transport.connected(node.nodeId), true);
  const second = await cpTwo.transport.request({ id: node.nodeId, connectionMode: "cloud-relay" } as any, "/health");
  assert.deepEqual(await second.json(), { data: { nodeId: "/health" } });
  assert.equal(store2.calls.disconnected.length, 0);
  cpTwo.channels.closeAll("test-done");
});

test("a stale cloud claim preserves the locally managed node connection without attaching a relay", async () => {
  const node = ed25519Identity();
  const cp = ed25519Identity();
  const store = nodeStore();
  (store.adapter as any).resolve = () => ({ nodeId: "node_local_managed", preserveLocalConnection: true });
  const sockets = linkedFrameSockets();
  const preserved: string[] = [];
  const channel = controlPlaneChannel({ controlPlaneId: "control_plane_cp1", bindingId: "binding_a", socket: sockets.left, identity: cp, store, onPreserveLocalConnection: (nodeHandle) => preserved.push(nodeHandle) });
  const event = nodeRelayAllocationEvent({ allocationId: "node_allocation_a", nodeHandle: "nrh_node_alpha", controlPlaneId: "control_plane_cp1", accountId: "account_a", bindingId: "binding_a", nodePublicKeyFingerprint: nodeRelayFingerprint(node.publicKey) });

  const result = await channel.channels.attach(event);

  assert.deepEqual(result, { status: "attached", preservedLocalConnection: true, nodeId: "node_local_managed", nodeHandle: "nrh_node_alpha" });
  assert.equal(channel.transport.connected("node_local_managed"), false);
  assert.deepEqual(store.calls.connected, []);
  assert.equal(store.records.size, 0);
  assert.deepEqual(preserved, ["nrh_node_alpha"]);
});

test("a known direct node skips the Relay dial entirely", async () => {
  const node = ed25519Identity("node_direct_machine");
  const cp = ed25519Identity();
  const store = nodeStore();
  store.known.set(node.nodeId, { nodeId: node.nodeId, connectionKind: "direct" });
  const preserved: string[] = [];
  let connectCalls = 0;
  const channels = new CloudNodeRelayChannels({
    state: cloudState("control_plane_cp1", "binding_a"),
    connector: {
      async connect() {
        connectCalls += 1;
        throw new Error("the direct node must not be dialed over Relay");
      },
    },
    transport: () => ({
      attachNode: () => undefined,
      detachNode: () => false,
      connected: () => false,
    }),
    nodes: store.adapter,
    onPreserveLocalConnection: (nodeHandle) => preserved.push(nodeHandle),
  });
  const event = nodeRelayAllocationEvent({ allocationId: "node_allocation_a", nodeHandle: "nrh_node_alpha", nodeId: node.nodeId, controlPlaneId: "control_plane_cp1", accountId: "account_a", bindingId: "binding_a", nodePublicKeyFingerprint: nodeRelayFingerprint(node.publicKey) });

  const result = await channels.attach(event);

  assert.deepEqual(result, { status: "attached", preservedLocalConnection: true, nodeId: node.nodeId, nodeHandle: "nrh_node_alpha" });
  assert.equal(connectCalls, 0, "the Relay connector is never called for an already-direct node");
  assert.equal(store.records.get("nrh_node_alpha")?.nodeId, node.nodeId);
  assert.deepEqual(preserved, ["nrh_node_alpha"]);
});

test("a direct node drops a stale Relay channel without changing its node status", async () => {
  const node = ed25519Identity("node_direct_machine");
  const cp = ed25519Identity();
  const store = nodeStore();
  const sockets = linkedFrameSockets();
  const preserved: string[] = [];
  const channel = controlPlaneChannel({ controlPlaneId: "control_plane_cp1", bindingId: "binding_a", socket: sockets.left, identity: cp, store, onPreserveLocalConnection: (nodeHandle) => preserved.push(nodeHandle) });
  const event = nodeRelayAllocationEvent({ allocationId: "node_allocation_a", nodeHandle: "nrh_node_alpha", nodeId: node.nodeId, controlPlaneId: "control_plane_cp1", accountId: "account_a", bindingId: "binding_a", nodePublicKeyFingerprint: nodeRelayFingerprint(node.publicKey) });
  const session = startNodeSession(sockets.right, nodeRelayClaimGrant(event, cp.publicKey), node, []);
  await channel.channels.attach(event);
  await session;
  assert.equal(channel.transport.connected(node.nodeId), true);

  store.known.set(node.nodeId, { nodeId: node.nodeId, connectionKind: "direct" });
  const result = await channel.channels.attach({ ...event, allocationId: "node_allocation_b" });

  assert.deepEqual(result, { status: "attached", preservedLocalConnection: true, nodeId: node.nodeId, nodeHandle: "nrh_node_alpha" });
  assert.equal(channel.transport.connected(node.nodeId), false);
  assert.deepEqual(store.calls.disconnected, [], "the direct connection remains authoritative");
  assert.deepEqual(preserved, ["nrh_node_alpha"]);
});

test("the signed handshake identity must match the allocation identity", async () => {
  const hinted = ed25519Identity("node_cloud_hint");
  const actual = ed25519Identity("node_actual_machine");
  const cp = ed25519Identity();
  const store = nodeStore();
  const sockets = linkedFrameSockets();
  const channel = controlPlaneChannel({ controlPlaneId: "control_plane_cp1", bindingId: "binding_a", socket: sockets.left, identity: cp, store });
  const event = nodeRelayAllocationEvent({ allocationId: "node_allocation_a", nodeHandle: "nrh_node_alpha", nodeId: hinted.nodeId, controlPlaneId: "control_plane_cp1", accountId: "account_a", bindingId: "binding_a", nodePublicKeyFingerprint: nodeRelayFingerprint(actual.publicKey) });
  const session = startNodeSession(sockets.right, nodeRelayClaimGrant(event, cp.publicKey), actual, []);

  await assert.rejects(() => channel.channels.attach(event), { code: "CLOUD_RELAY_NODE_ID_MISMATCH" });
  await session.catch(() => undefined);
  assert.equal(store.records.size, 0);
  assert.deepEqual(store.calls.connected, []);
  assert.equal(channel.channels.state().errors[0]?.code, "CLOUD_RELAY_NODE_ID_MISMATCH");
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
  assert.deepEqual(store.calls.disconnected, [`${node.nodeId}:allocation-superseded`]);
  assert.equal(store.records.size, 1, "a superseding allocation reuses the same local node record");
  assert.equal(one.transport.connected(node.nodeId), true);
  one.channels.closeAll("test-done");
});

test("a live channel close requests recovery while a stale close is ignored", async () => {
  const node = ed25519Identity("node_macmini");
  const cp = ed25519Identity();
  const store = nodeStore();
  const attached: Array<{ nodeId: string; onClosed?: (reason: string) => void }> = [];
  const closed: Array<{ nodeHandle: string; nodeId: string; reason: string }> = [];
  const connector = {
    async connect(input: any) {
      return {
        socket: linkedFrameSockets().left,
        key: new Uint8Array(32),
        nodeId: node.nodeId,
        paired: true,
        allocationId: input.allocation.allocationId,
      };
    },
  };
  const transport = {
    attachNode(nodeId: string, input: { onClosed?(reason: string): void }) {
      attached.push({ nodeId, onClosed: input.onClosed });
    },
    detachNode: () => true,
    connected: () => true,
  };
  const channels = new CloudNodeRelayChannels({
    state: cloudState("control_plane_cp1", "binding_a"),
    connector,
    transport: () => transport,
    nodes: store.adapter,
    onChannelClosed: (event) => closed.push(event),
  });
  const event = nodeRelayAllocationEvent({ allocationId: "node_allocation_a", nodeHandle: "nrh_node_alpha", controlPlaneId: "control_plane_cp1", accountId: "account_a", bindingId: "binding_a", nodePublicKeyFingerprint: nodeRelayFingerprint(node.publicKey) });
  const superseding = { ...event, allocationId: "node_allocation_b" };

  await channels.attach(event);
  await channels.attach(superseding);
  store.calls.disconnected.length = 0;

  attached[0]?.onClosed?.("old-socket-late-close");
  assert.deepEqual(closed, []);
  assert.deepEqual(store.calls.disconnected, []);
  assert.equal(channels.state().channels[0]?.allocationId, superseding.allocationId);

  attached[1]?.onClosed?.("network-lost");
  assert.deepEqual(store.calls.disconnected, [`${node.nodeId}:network-lost`]);
  assert.deepEqual(closed, [{ nodeHandle: "nrh_node_alpha", nodeId: node.nodeId, reason: "network-lost" }]);
  assert.equal(channels.state().channels.length, 0);
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
  assert.equal(channel.transport.connected(attacker.nodeId), false);
  assert.deepEqual(store.calls.connected, []);
  assert.equal(channel.channels.state().errors[0]?.code, "NODE_RELAY_NODE_KEY_MISMATCH");
});

test("a trust-required outcome projects pending state without a pairing, channel, or connected node", async () => {
  const node = ed25519Identity();
  const cp = ed25519Identity();
  const store = nodeStore();
  let createPairingCalls = 0;
  let attachCalls = 0;
  const transport = {
    attachNode() { attachCalls += 1; },
    detachNode: () => true,
    connected: () => true,
  };
  const channels = new CloudNodeRelayChannels({
    state: {
      snapshot: () => ({
        status: "active",
        scopes: { deviceAccess: true, nodeRelay: true },
        cloudControlPlaneId: "control_plane_cp1",
        identity: { controlPlaneId: "control_plane_cp1", publicKey: cp.publicKey, fingerprint: nodeRelayFingerprint(cp.publicKey) },
        accountId: "account_a",
        bindingId: "binding_a",
        bindingRevision: 1,
        serviceOrigin: "https://cloud.example.com",
      }),
    },
    connector: {
      async connect() {
        return {
          status: "trust-required" as const,
          outcome: {
            type: "node-agent.control-plane-trust" as const,
            protocolVersion: "2026-10-26.1",
            audience: "task-handoff:node-agent-control-plane-trust",
            allocationId: "node_allocation_a",
            relayId: "relay_a",
            nodeHandle: "nrh_node_alpha",
            nodeId: node.nodeId,
            nodePublicKey: node.publicKey,
            nodePublicKeyFingerprint: nodeRelayFingerprint(node.publicKey),
            controlPlaneId: "control_plane_cp1",
            controlPlanePublicKeyFingerprint: nodeRelayFingerprint(cp.publicKey),
            bindingId: "binding_a",
            bindingRevision: 1,
            access: { accountId: "account_a", ownerAccountId: "account_a", accessMode: "owner" as const },
            state: "pending" as const,
            reason: "first-seen",
            requestId: "cptreq_pending",
            requestedAt: "2026-10-26T09:59:59.000Z",
            expiresAt: "2026-10-27T09:59:59.000Z",
            issuedAt: "2026-10-26T09:59:59.500Z",
          },
        };
      },
    },
    transport: () => transport,
    nodes: store.adapter,
  });
  const event = nodeRelayAllocationEvent({
    allocationId: "node_allocation_a",
    nodeHandle: "nrh_node_alpha",
    nodeId: node.nodeId,
    displayName: "Alpha box",
    controlPlaneId: "control_plane_cp1",
    accountId: "account_a",
    bindingId: "binding_a",
    nodePublicKeyFingerprint: nodeRelayFingerprint(node.publicKey),
  });

  const result = await channels.attach(event);
  assert.equal(result.status, "trust-required");
  assert.equal(createPairingCalls, 0);
  assert.equal(attachCalls, 0);
  assert.deepEqual(store.calls.saved, []);
  assert.deepEqual(store.calls.connected, []);
  assert.deepEqual(channels.state().channels, []);
  assert.equal(channels.state().trust[0]?.state, "pending");
  assert.equal(channels.state().trust[0]?.requestId, "cptreq_pending");
  assert.equal(channels.state().trust[0]?.nodeId, node.nodeId);
  assert.equal(channels.state().trust[0]?.displayName, "Alpha box");
});

test("forgetting a revoked node clears its pending claim projection", () => {
  const node = ed25519Identity();
  const cp = ed25519Identity();
  const store = nodeStore();
  const sockets = linkedFrameSockets();
  const channel = controlPlaneChannel({ controlPlaneId: "control_plane_cp1", bindingId: "binding_a", socket: sockets.left, identity: cp, store });

  channel.channels.noteClaim("nrh_node_alpha");
  assert.equal(channel.channels.state().claims.length, 1);
  assert.equal(channel.channels.state().claims[0]?.nodeHandle, "nrh_node_alpha");

  channel.channels.forgetNode("nrh_node_alpha");

  assert.deepEqual(channel.channels.state().claims, []);
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
  const refused = assert.rejects(session, { code: "NODE_RELAY_HANDSHAKE_MISMATCH" });
  await channel.channels.attach(event).catch(() => undefined);
  await refused;
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
  assert.equal(channel.transport.connected(node.nodeId), false);
  assert.deepEqual(store.calls.connected, []);
  assert.equal(channel.channels.state().errors[0]?.code, "RELAY_ALLOCATION_AUTHORITY_INVALID");
  assert.equal(channel.channels.state().channels.length, 0);
});
