import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import { ControlPlaneNodeAgentTunnelTransport } from "../src/control-plane/nodes/tunnel.ts";
import { CloudRelayNodeAgentTransport, MultiplexedNodeRelaySocket } from "../src/control-plane/nodes/cloud-relay-transport.ts";
import { NodeAgentTransportResolver } from "../src/control-plane/nodes/transport-resolver.ts";
import { acceptNodeRelayHandshake, initiateNodeRelayHandshake } from "../src/shared/cloud-relay/node-relay-session.ts";
import {
  ed25519Identity,
  linkedFrameSockets,
  nodeRelayFingerprint,
  startNodeSession,
} from "./support/cloud-relay-node-harness.ts";

/** A hand-built allocation/expectation pair, independent of the contract fixture builder. */
function allocationFixture() {
  const controlPlane = ed25519Identity();
  const node = ed25519Identity();
  const grant = {
    allocationId: "node_allocation_a",
    relayId: "relay_a",
    nodeHandle: "nrh_node_alpha",
    controlPlaneId: "control_plane_cp2",
    accountId: "account_a",
    bindingId: "binding_a",
    bindingRevision: 1,
    controlPlanePublicKey: controlPlane.publicKey,
  };
  const expectation = {
    allocationId: grant.allocationId,
    relayId: grant.relayId,
    nodeHandle: grant.nodeHandle,
    controlPlaneId: grant.controlPlaneId,
    accountId: grant.accountId,
    bindingId: grant.bindingId,
    bindingRevision: grant.bindingRevision,
    nodePublicKeyFingerprint: nodeRelayFingerprint(node.publicKey),
  };
  return { controlPlane, node, grant, expectation };
}

test("cloud-relay transport carries tunnel requests over one encrypted node channel", async () => {
  const { left, right } = linkedFrameSockets();
  const { controlPlane, node, grant, expectation } = allocationFixture();
  const tunnel = new ControlPlaneNodeAgentTunnelTransport();
  const transport = new CloudRelayNodeAgentTransport({ tunnel });
  const received: any[] = [];
  const nodeSession = startNodeSession(right, grant, node, received);
  const issuedPairing = { keyId: "key_pairing_a", secret: crypto.randomBytes(32).toString("base64url") };
  const accepted = await acceptNodeRelayHandshake({
    socket: left,
    identity: { controlPlaneId: grant.controlPlaneId, publicKey: controlPlane.publicKey, signNodeRelayHandshake: (input) => controlPlane.sign(input) },
    expectation,
    createPairing: () => issuedPairing,
  });
  assert.equal(accepted.paired, false);
  assert.deepEqual(accepted.issuedPairing, issuedPairing);
  transport.attachNode("node_alpha", { socket: left, key: accepted.key });
  await nodeSession;
  const response = await transport.request({ id: "node_alpha", connectionMode: "cloud-relay" } as any, "/health");
  assert.deepEqual(await response.json(), { data: { nodeId: "/health" } });
  assert.deepEqual(received.map((message) => message.type), ["control-plane.hello", "control-plane.identified", "control-plane.request"]);
  transport.detachNode("node_alpha", "test-done");
});

test("cloud-relay handshake refuses a node key that does not match the claimed fingerprint", async () => {
  const { left, right } = linkedFrameSockets();
  const { controlPlane, grant, expectation } = allocationFixture();
  const attacker = ed25519Identity();
  const node = (async () => {
    const { key } = await initiateNodeRelayHandshake({ socket: right, grant, node: attacker, timeoutMs: 250 });
    return key;
  })();
  await assert.rejects(
    () => acceptNodeRelayHandshake({
      socket: left,
      identity: { controlPlaneId: grant.controlPlaneId, publicKey: controlPlane.publicKey, signNodeRelayHandshake: (input) => controlPlane.sign(input) },
      expectation,
    }),
    { code: "NODE_RELAY_NODE_KEY_MISMATCH" },
  );
  await node.catch(() => undefined);
});

test("cloud-relay pairing is pinned on first claim and proved with an HMAC on reconnect", async () => {
  const { left, right } = linkedFrameSockets();
  const { controlPlane, node: nodeIdentity, grant, expectation } = allocationFixture();
  const pairing = { keyId: "key_pairing_a", secret: crypto.randomBytes(32).toString("base64url") };
  // Reconnect: the node presents the pairing it stored when this Control Plane first claimed it.
  const node = startNodeSession(right, grant, nodeIdentity, [], pairing);
  const accepted = await acceptNodeRelayHandshake({
    socket: left,
    identity: { controlPlaneId: grant.controlPlaneId, publicKey: controlPlane.publicKey, signNodeRelayHandshake: (input) => controlPlane.sign(input) },
    expectation,
    pairing,
  });
  await node;
  assert.equal(accepted.paired, true, "the retained pairing is proved on the wire");
  assert.equal(accepted.issuedPairing, undefined);
});

test("transport resolver selects the cloud-relay transport and fails closed without it", () => {
  const direct = { request: async () => new Response() } as any;
  const cloudRelay = { request: async () => new Response() } as any;
  const resolver = new NodeAgentTransportResolver({ direct });
  const node = { id: "node_alpha", connectionMode: "cloud-relay", connectionEnabled: true, connectionPath: { kind: "cloud-relay", nodeHandle: "nrh_node_alpha" } } as any;
  assert.throws(() => resolver.resolve(node), { code: "NODE_AGENT_CLOUD_RELAY_TRANSPORT_UNAVAILABLE", statusCode: 503 });
  resolver.setCloudRelay(cloudRelay);
  assert.equal(resolver.resolve(node), cloudRelay);
  assert.throws(() => resolver.resolve({ ...node, connectionEnabled: false }), { code: "NODE_AGENT_CONNECTION_DISABLED" });
});

test("relay channel sockets keep ws text frames text and binary frames binary", () => {
  const sent: Array<{ channelId: string; data: string | Buffer; binary: boolean }> = [];
  const socket = new MultiplexedNodeRelaySocket({
    sendData: (channelId: string, data: string | Buffer, binary: boolean) => sent.push({ channelId, data, binary }),
  } as never, "stream_one");

  socket.send(Buffer.from('{"frame":1}'), { binary: false });
  socket.send(Buffer.from([1, 2, 3]), { binary: true });
  socket.send("plain text");
  socket.send(Buffer.from([4, 5, 6]));

  assert.deepEqual(sent.map((entry) => entry.binary), [false, true, false, true]);
  assert.deepEqual(sent.map((entry) => entry.channelId), ["stream_one", "stream_one", "stream_one", "stream_one"]);
});
