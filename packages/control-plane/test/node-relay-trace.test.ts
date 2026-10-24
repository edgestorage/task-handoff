import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ControlPlaneNodeAgentTunnelTransport } from "../src/control-plane/nodes/tunnel.ts";
import { CloudRelayNodeAgentTransport } from "../src/control-plane/nodes/cloud-relay-transport.ts";
import { acceptNodeRelayHandshake } from "../src/shared/cloud-relay/node-relay-session.ts";
import { NodeRelayTraceRecorder, nodeRelayTraceEnabled, nodeRelayTraceFromEnvironment } from "../src/control-plane/cloud-connectivity/node-relay-trace.ts";
import { ed25519Identity, linkedFrameSockets, nodeRelayFingerprint, startNodeSession } from "./support/cloud-relay-node-harness.ts";

const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "node-relay-trace-test-"));
const liveFile = (directory: string) => path.join(directory, "node-relay-trace.jsonl");
const readEntries = (directory: string) => fs.readFileSync(liveFile(directory), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));

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

test("node relay trace has its own switch, file and disabled state", () => {
  assert.equal(nodeRelayTraceEnabled({}), false);
  assert.equal(nodeRelayTraceEnabled({ TASK_HANDOFF_RELAY_TRACE: "1" }), false);
  assert.equal(nodeRelayTraceEnabled({ TASK_HANDOFF_NODE_RELAY_TRACE: "on" }), true);

  const directory = tempDir();
  const disabled = new NodeRelayTraceRecorder({ enabled: false, directory });
  disabled.record({ channelId: "relay_channel_a", nodeId: "node_alpha", direction: "out", kind: "control-plane.event", plaintext: Buffer.from("{}"), sealedBytes: 32, wireBytes: 40 });
  disabled.close();
  assert.equal(disabled.status().writtenEntries, 0);
  assert.equal(fs.existsSync(liveFile(directory)), false);

  const configured = nodeRelayTraceFromEnvironment({
    TASK_HANDOFF_NODE_RELAY_TRACE: "true",
    TASK_HANDOFF_NODE_RELAY_TRACE_BYTES: "1048576",
    TASK_HANDOFF_NODE_RELAY_TRACE_BACKUPS: "0",
    TASK_HANDOFF_NODE_RELAY_TRACE_ENTRY_BYTES: "512",
  }, directory);
  assert.deepEqual([configured.enabled, configured.status().maxBytes, configured.status().backupCount, configured.status().maxEntryBytes], [true, 1_048_576, 0, 512]);
  assert.equal(configured.status().path, liveFile(directory));
});

test("node relay trace captures both directions with node and stream metadata", async () => {
  const { left, right } = linkedFrameSockets();
  const { controlPlane, node, grant, expectation } = allocationFixture();
  const tunnel = new ControlPlaneNodeAgentTunnelTransport();
  const directory = tempDir();
  const trace = new NodeRelayTraceRecorder({ enabled: true, directory });
  const transport = new CloudRelayNodeAgentTransport({ tunnel, trace });
  const received: any[] = [];
  const nodeSessionPromise = startNodeSession(right, grant, node, received);
  const issuedPairing = { keyId: "key_pairing_a", secret: crypto.randomBytes(32).toString("base64url") };
  const accepted = await acceptNodeRelayHandshake({
    socket: left,
    identity: { controlPlaneId: grant.controlPlaneId, publicKey: controlPlane.publicKey, signNodeRelayHandshake: (input) => controlPlane.sign(input) },
    expectation,
    createPairing: () => issuedPairing,
  });
  transport.attachNode("node_alpha", {
    socket: left,
    key: accepted.key,
    nodeHandle: grant.nodeHandle,
    relayChannelId: "relay_channel_a",
  });
  const nodeSession = await nodeSessionPromise;

  const response = await transport.request({ id: "node_alpha", connectionMode: "cloud-relay" } as any, "/health");
  assert.deepEqual(await response.json(), { data: { nodeId: "/health" } });
  const broadcast = { type: "node-agent.event", event: { type: "ai.session.updated", payload: { sessionId: "session_a" } } };
  nodeSession.session.sendData(0, JSON.stringify(broadcast), false);

  const entries = readEntries(directory);
  assert.ok(entries.length >= 5);
  assert.equal(entries.every((entry) => entry.type === "node-relay-trace-entry"), true);
  const hello = entries.find((entry) => entry.direction === "out" && entry.kind === "control-plane.hello");
  const request = entries.find((entry) => entry.direction === "out" && entry.kind === "control-plane.request");
  const identify = entries.find((entry) => entry.direction === "in" && entry.kind === "node-agent.identify");
  const event = entries.find((entry) => entry.direction === "in" && entry.kind === "node-agent.event");
  assert.ok(hello && request && identify && event);
  assert.deepEqual(
    [request.channelId, request.detail.nodeId, request.detail.nodeHandle, request.detail.relayChannelId, request.detail.streamId, request.detail.binary],
    ["relay_channel_a", "node_alpha", grant.nodeHandle, "relay_channel_a", 0, false],
  );
  assert.match(request.body, /control-plane\.request/);
  assert.match(event.body, /ai\.session\.updated/);
  assert.equal(event.wireBytes, event.sealedBytes + 8);
  assert.equal(event.sealedBytes, event.plaintextBytes + 8 + 16);
  assert.equal(event.detail.streamId, 0);
  assert.equal(typeof event.bodyDigest, "string");

  trace.close();
  transport.detachNode("node_alpha", "test-done");
  nodeSession.session.close("test-done");
});
