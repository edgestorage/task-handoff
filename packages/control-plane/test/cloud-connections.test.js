import assert from "node:assert/strict";
import test from "node:test";
import { StandardReconnectBackoff } from "@task-handoff/core/core/reconnect";
import { decodeRelayFrame, encodeRelayFrame } from "@task-handoff/cloud-contracts";
import { CloudControlConnectionManager, CloudRelayDataConnectionManager } from "../src/control-plane/cloud-connectivity/connections.ts";
import { CloudAuthorityEventConsumer } from "../src/control-plane/cloud-connectivity/authority-events.ts";
import { CloudRelayConnector, verifyCoordinatorRelayAllocation } from "../src/control-plane/cloud-connectivity/relay-connector.ts";

test("control connection uses background credential, persistent monotonic epoch and bounded retry independent of UI", async () => {
  let epoch = 0;
  const connects = [];
  const closed = [];
  const state = { backgroundCredential: () => "credential", snapshot: () => ({ status: "active", remoteAccessEnabled: true, serviceOrigin: "https://cloud.example.test", identity: { controlPlaneId: "control_plane_a" } }), nextConnectionEpoch: () => ++epoch };
  const manager = new CloudControlConnectionManager({ state, connector: { async connect(input) { connects.push(input); return { async close(reason) { closed.push(reason); } }; } }, onEvent: async () => undefined, backoff: new StandardReconnectBackoff(() => 0.5) });
  assert.equal((await manager.connectOnce()).epoch, 1);
  assert.equal((await manager.connectOnce()).reused, true);
  assert.equal(connects.length, 1);
  manager.disconnected();
  assert.equal((await manager.connectOnce()).epoch, 2);
  assert.deepEqual(closed, []);
  assert.equal(connects[0].credential, "credential");
  assert.equal(connects[0].processInstanceId, connects[1].processInstanceId);
  assert.deepEqual([manager.reconnectDelay(), manager.reconnectDelay(), manager.reconnectDelay(), manager.reconnectDelay()], [0, 250, 500, 1_000]);
});

test("relay data connection verifies signed allocation and rejects old/double epochs", async () => {
  const closed = [];
  const manager = new CloudRelayDataConnectionManager({ verifyAllocation: async (allocation) => allocation, connector: { async connect() { return { async close(reason) { closed.push(reason); } }; } } });
  await manager.attach({ allocationId: "allocation_a", relayUrl: "wss://relay.example.test", epoch: 1 });
  await assert.rejects(() => manager.attach({ allocationId: "allocation_a", relayUrl: "wss://attacker.test", epoch: 1 }), { code: "STALE_CONNECTION_EPOCH" });
  await manager.attach({ allocationId: "allocation_a", relayUrl: "wss://relay.example.test", epoch: 2 });
  assert.deepEqual(closed, ["replaced-by-new-epoch"]);
});

test("relay data connection never dials an allocation the Coordinator did not just confirm", async () => {
  // The Coordinator only pushes the confirmed winner, so anything that does not verify — a
  // leftover loser allocation, an expired notification, a foreign binding — must die before a
  // socket is opened.
  const connects = [];
  const manager = new CloudRelayDataConnectionManager({
    verifyAllocation: async (allocation) => {
      if (allocation?.winner !== true) throw Object.assign(new Error("Cloud Relay session is invalid."), { code: "RELAY_ALLOCATION_AUTHORITY_INVALID" });
      return allocation;
    },
    connector: { async connect(input) { connects.push(input); return { async close() {} }; } },
  });
  await assert.rejects(() => manager.attach({ allocationId: "allocation_loser", winner: false }), { code: "RELAY_ALLOCATION_AUTHORITY_INVALID" });
  assert.deepEqual(connects, []);
  await manager.attach({ allocationId: "allocation_a", winner: true, epoch: 5 });
  assert.equal(connects.length, 1);
  assert.equal(connects[0].allocation.allocationId, "allocation_a");
});

test("authoritative revocation and clone events close both connection planes; stale revision is ignored", async () => {
  const calls = [];
  const state = { beginRevocation() { calls.push("pending"); }, confirmRevocation() { calls.push("revoked"); }, setRemoteAccess() {}, markCloneConflict() { calls.push("clone"); } };
  const consumer = new CloudAuthorityEventConsumer({ state, connections: { async stop(reason) { calls.push(`control:${reason}`); } }, dataConnections: { async closeAll(reason) { calls.push(`data:${reason}`); } } });
  assert.equal((await consumer.apply({ type: "binding-revoked", bindingRevision: 2 })).applied, true);
  assert.equal((await consumer.apply({ type: "remote-access-changed", bindingRevision: 1, enabled: true })).applied, false);
  await consumer.apply({ type: "identity-clone-detected", bindingRevision: 3 });
  assert.deepEqual(calls, ["pending", "control:binding-revoked", "data:binding-revoked", "revoked", "clone", "control:identity-clone-detected", "data:identity-clone-detected"]);
});

test("Control Plane accepts only current Coordinator-delivered allocation identity and trusted Relay origin", () => {
  const now = Date.now(); const fingerprint = `sha256:${"a".repeat(43)}`;
  const ticket = { protocolVersion: "2026-08-10", audience: "task-handoff:control-plane-access", ticketId: "ticket_a", accountId: "account_a", deviceSessionId: "device_a", controlPlaneId: "control_plane_a", bindingId: "binding_a", bindingRevision: 2, targetPublicKeyFingerprint: fingerprint, nonce: "n".repeat(24), trafficClasses: ["interactive"], issuedAt: new Date(now - 1_000).toISOString(), expiresAt: new Date(now + 30_000).toISOString(), signature: "s".repeat(32) };
  const attach = { protocolVersion: "2026-08-10", audience: "task-handoff:relay-control-plane-attach", allocationId: "allocation_a", relayId: "relay_a", role: "control-plane", controlPlaneId: ticket.controlPlaneId, accountId: ticket.accountId, deviceSessionId: ticket.deviceSessionId, bindingId: ticket.bindingId, ticketId: ticket.ticketId, bindingRevision: ticket.bindingRevision, trafficClass: "interactive", nonce: "a".repeat(24), issuedAt: ticket.issuedAt, expiresAt: ticket.expiresAt, signature: "s".repeat(32) };
  const state = { snapshot: () => ({ status: "active", remoteAccessEnabled: true, serviceOrigin: "https://cloud.thandoff.com", accountId: "account_a", bindingId: "binding_a", bindingRevision: 2, identity: { controlPlaneId: "control_plane_a", fingerprint } }) };
  assert.equal(verifyCoordinatorRelayAllocation({ type: "relay-allocation", allocationId: "allocation_a", relayUrl: "wss://eu.relay.thandoff.com/connect", attach, ticket }, state).allocationId, "allocation_a");
  assert.throws(() => verifyCoordinatorRelayAllocation({ type: "relay-allocation", allocationId: "allocation_a", relayUrl: "wss://eu.relay.taskhandoff.com/connect", attach, ticket }, state), { code: "UNTRUSTED_RELAY_URL" });
  assert.throws(() => verifyCoordinatorRelayAllocation({ type: "relay-allocation", allocationId: "allocation_a", relayUrl: "wss://attacker.example/connect", attach, ticket }, state), { code: "UNTRUSTED_RELAY_URL" });
  assert.throws(() => verifyCoordinatorRelayAllocation({ type: "relay-allocation", allocationId: "allocation_a", relayUrl: "wss://eu.relay.thandoff.com/connect", attach: { ...attach, bindingRevision: 1 }, ticket }, state), { code: "RELAY_ALLOCATION_AUTHORITY_INVALID" });
  const localState = { snapshot: () => ({ ...state.snapshot(), serviceOrigin: "http://localhost:8080" }) };
  assert.equal(verifyCoordinatorRelayAllocation({ type: "relay-allocation", allocationId: "allocation_a", relayUrl: "ws://localhost:8080/connect", attach, ticket }, localState).allocationId, "allocation_a");
  assert.throws(() => verifyCoordinatorRelayAllocation({ type: "relay-allocation", allocationId: "allocation_a", relayUrl: "ws://attacker.example/connect", attach, ticket }, localState), { code: "UNTRUSTED_RELAY_URL" });
  // A Control Plane bound to the test environment reaches that environment's Relay hosts only.
  const stagingState = { snapshot: () => ({ ...state.snapshot(), serviceOrigin: "https://th.aaasu.com" }) };
  assert.equal(verifyCoordinatorRelayAllocation({ type: "relay-allocation", allocationId: "allocation_a", relayUrl: "wss://relay1.relay.aaasu.com/connect", attach, ticket }, stagingState).allocationId, "allocation_a");
  assert.throws(() => verifyCoordinatorRelayAllocation({ type: "relay-allocation", allocationId: "allocation_a", relayUrl: "wss://relay.thandoff.com/connect", attach, ticket }, stagingState), { code: "UNTRUSTED_RELAY_URL" });
  assert.throws(() => verifyCoordinatorRelayAllocation({ type: "relay-allocation", allocationId: "allocation_a", relayUrl: "wss://relay1.relay.aaasu.com/connect", attach, ticket }, state), { code: "UNTRUSTED_RELAY_URL" });
});

test("relay attach acknowledges the Coordinator before the client completes the end-to-end handshake", { timeout: 5_000 }, async () => {
  const sockets = [];
  class FakeSocket {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;
    readyState = FakeSocket.CONNECTING;
    sent = [];
    frames = [];
    listeners = new Map();
    constructor(url) { this.url = url; sockets.push(this); queueMicrotask(() => { this.readyState = FakeSocket.OPEN; this.emit("open"); }); }
    on(event, listener) { this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]); }
    once(event, listener) { const wrapper = (...args) => { this.off(event, wrapper); listener(...args); }; this.on(event, wrapper); }
    off(event, listener) { this.listeners.set(event, (this.listeners.get(event) ?? []).filter((item) => item !== listener)); }
    emit(event, ...args) { for (const listener of [...(this.listeners.get(event) ?? [])]) listener(...args); }
    send(data) {
      if (typeof data !== "string") { this.frames.push(decodeRelayFrame(data)); return; }
      const message = JSON.parse(data);
      this.sent.push(message);
      if (message.type === "attach") queueMicrotask(() => this.emit("message", { toString: () => JSON.stringify({ type: "attached", channelId: "relay_channel_a" }) }));
    }
    close(code, reason) { this.readyState = FakeSocket.CLOSED; queueMicrotask(() => this.emit("close", code, reason)); }
    receive(frame) { this.emit("message", Buffer.from(encodeRelayFrame(frame)), true); }
  }
  const now = Date.now(); const fingerprint = `sha256:${"a".repeat(43)}`;
  const ticket = { protocolVersion: "2026-08-10", audience: "task-handoff:control-plane-access", ticketId: "ticket_a", accountId: "account_a", deviceSessionId: "device_a", controlPlaneId: "control_plane_a", bindingId: "binding_a", bindingRevision: 2, targetPublicKeyFingerprint: fingerprint, nonce: "n".repeat(24), trafficClasses: ["interactive"], issuedAt: new Date(now - 1_000).toISOString(), expiresAt: new Date(now + 30_000).toISOString(), signature: "s".repeat(32) };
  const attach = { protocolVersion: "2026-08-10", audience: "task-handoff:relay-control-plane-attach", allocationId: "allocation_a", relayId: "relay_a", role: "control-plane", controlPlaneId: ticket.controlPlaneId, accountId: ticket.accountId, deviceSessionId: ticket.deviceSessionId, bindingId: ticket.bindingId, ticketId: ticket.ticketId, bindingRevision: ticket.bindingRevision, trafficClass: "interactive", nonce: "a".repeat(24), issuedAt: ticket.issuedAt, expiresAt: ticket.expiresAt, signature: "s".repeat(32) };
  const identity = { acceptCloudAccessHandshake: () => ({ response: { serverEphemeralPublicKey: "c".repeat(43), transcript: "transcript", signature: "s".repeat(32) }, sessionKey: new Uint8Array(32) }), publicIdentity: () => ({ publicKey: "c".repeat(43) }) };
  const connector = new CloudRelayConnector({ identity, bridge: {}, webSocket: FakeSocket });
  const connection = await connector.connect({ relayUrl: "ws://localhost:8080/connect", allocation: { attach, ticket } });
  assert.deepEqual(sockets[0].sent.map((message) => message.type), ["attach"]);
  const hello = { ticketId: ticket.ticketId, deviceSessionId: ticket.deviceSessionId, clientEphemeralPublicKey: "b".repeat(43) };
  sockets[0].receive({ kind: "handshake", sequence: 0, payload: Buffer.from(JSON.stringify(hello)) });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(sockets[0].frames.some((frame) => frame.kind === "handshake"), true);
  await connection.close("test-done");
  assert.equal(sockets[0].readyState, FakeSocket.CLOSED);
});
