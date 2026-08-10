import assert from "node:assert/strict";
import test from "node:test";
import { BoundedReconnectBackoff, CloudControlConnectionManager, CloudRelayDataConnectionManager } from "../src/control-plane/cloud-connectivity/connections.ts";
import { CloudAuthorityEventConsumer } from "../src/control-plane/cloud-connectivity/authority-events.ts";
import { verifyCoordinatorRelayAllocation } from "../src/control-plane/cloud-connectivity/relay-connector.ts";

test("control connection uses background credential, persistent monotonic epoch and bounded retry independent of UI", async () => {
  let epoch = 0;
  const connects = [];
  const closed = [];
  const state = { backgroundCredential: () => "credential", snapshot: () => ({ status: "active", remoteAccessEnabled: true, serviceOrigin: "https://cloud.example.test", identity: { controlPlaneId: "control_plane_a" } }), nextConnectionEpoch: () => ++epoch };
  const manager = new CloudControlConnectionManager({ state, connector: { async connect(input) { connects.push(input); return { async close(reason) { closed.push(reason); } }; } }, onEvent: async () => undefined, backoff: new BoundedReconnectBackoff(100, 400, () => 1) });
  assert.equal((await manager.connectOnce()).epoch, 1);
  assert.equal((await manager.connectOnce()).reused, true);
  assert.equal(connects.length, 1);
  manager.disconnected();
  assert.equal((await manager.connectOnce()).epoch, 2);
  assert.deepEqual(closed, []);
  assert.equal(connects[0].credential, "credential");
  assert.equal(connects[0].processInstanceId, connects[1].processInstanceId);
  assert.deepEqual([manager.reconnectDelay(), manager.reconnectDelay(), manager.reconnectDelay(), manager.reconnectDelay()], [100, 200, 400, 400]);
});

test("relay data connection verifies signed allocation and rejects old/double epochs", async () => {
  const closed = [];
  const manager = new CloudRelayDataConnectionManager({ verifyAllocation: async (allocation) => allocation, connector: { async connect() { return { async close(reason) { closed.push(reason); } }; } } });
  await manager.attach({ allocationId: "allocation_a", relayUrl: "wss://relay.example.test", epoch: 1 });
  await assert.rejects(() => manager.attach({ allocationId: "allocation_a", relayUrl: "wss://attacker.test", epoch: 1 }), { code: "STALE_CONNECTION_EPOCH" });
  await manager.attach({ allocationId: "allocation_a", relayUrl: "wss://relay.example.test", epoch: 2 });
  assert.deepEqual(closed, ["replaced-by-new-epoch"]);
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
});
