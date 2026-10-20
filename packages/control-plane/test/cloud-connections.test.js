import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { StandardReconnectBackoff } from "@task-handoff/core/core/reconnect";
import { decodeRelayFrame, encodeRelayFrame, RELAY_SESSION_PROTOCOL_VERSION, RelaySessionAudience } from "@task-handoff/cloud-contracts";
import { CloudControlConnectionManager, CloudRelayDataConnectionManager } from "../src/control-plane/cloud-connectivity/connections.ts";
import { CloudAuthorityEventConsumer } from "../src/control-plane/cloud-connectivity/authority-events.ts";
import { CloudRelayConnector, verifyCoordinatorNodeRelayAllocation, verifyCoordinatorRelayAllocation } from "../src/control-plane/cloud-connectivity/relay-connector.ts";

test("control connection uses background credential, persistent monotonic epoch and bounded retry independent of UI", async () => {
  let epoch = 0;
  const connects = [];
  const closed = [];
  const state = { backgroundCredential: () => "credential", snapshot: () => ({ status: "active", scopes: { deviceAccess: true, nodeRelay: false }, remoteAccessEnabled: true, serviceOrigin: "https://cloud.example.test", cloudControlPlaneId: "cp_cloud_a", identity: { controlPlaneId: "control_plane_a" } }), nextConnectionEpoch: () => ++epoch };
  const manager = new CloudControlConnectionManager({ state, connector: { async connect(input) { connects.push(input); return { async close(reason) { closed.push(reason); } }; } }, onEvent: async () => undefined, backoff: new StandardReconnectBackoff(() => 0.5) });
  assert.equal((await manager.connectOnce()).epoch, 1);
  assert.equal((await manager.connectOnce()).reused, true);
  assert.equal(connects.length, 1);
  manager.disconnected();
  assert.equal((await manager.connectOnce()).epoch, 2);
  assert.deepEqual(closed, []);
  assert.equal(connects[0].credential, "credential");
  assert.equal(connects[0].cloudControlPlaneId, "cp_cloud_a");
  assert.equal(connects[0].processInstanceId, connects[1].processInstanceId);
  assert.deepEqual([manager.reconnectDelay(), manager.reconnectDelay(), manager.reconnectDelay(), manager.reconnectDelay()], [0, 250, 500, 1_000]);
});

test("control registration fails over an origin reset and pins the successful transport", async () => {
  const connects = [];
  const observedFailures = [];
  let epoch = 0;
  const state = {
    backgroundCredential: () => "credential",
    snapshot: () => ({ status: "active", scopes: { deviceAccess: true, nodeRelay: false }, remoteAccessEnabled: true, serviceOrigin: "https://primary.cloud.test", cloudControlPlaneId: "cp_cloud_a", identity: { controlPlaneId: "control_plane_a" } }),
    nextConnectionEpoch: () => ++epoch,
  };
  const manager = new CloudControlConnectionManager({
    state,
    coordinatorOrigins: ["https://backup.cloud.test", "https://backup.cloud.test"],
    connector: {
      async connect(input) {
        connects.push(input.serviceOrigin);
        if (input.serviceOrigin === "https://primary.cloud.test") throw Object.assign(new Error("reset"), { code: "ECONNRESET" });
        return { async close() {} };
      },
    },
    onEvent: async () => undefined,
    onOriginFailover: (entry) => observedFailures.push(entry),
  });

  assert.equal((await manager.connectOnce()).status, "connected");
  assert.deepEqual(connects, ["https://primary.cloud.test", "https://backup.cloud.test"]);
  assert.equal((await manager.connectOnce()).reused, true);
  assert.deepEqual(connects, ["https://primary.cloud.test", "https://backup.cloud.test"]);
  assert.deepEqual(observedFailures, [{ fromOrigin: "https://primary.cloud.test", toOrigin: "https://backup.cloud.test", reason: "ECONNRESET" }]);
});

test("control registration starts from the discovered active origin and reports failover back to discovery", async () => {
  const connects = [];
  const marks = [];
  let epoch = 0;
  const state = {
    backgroundCredential: () => "credential",
    snapshot: () => ({ status: "active", scopes: { deviceAccess: true, nodeRelay: false }, remoteAccessEnabled: true, serviceOrigin: "https://primary.cloud.test", cloudControlPlaneId: "cp_cloud_a", identity: { controlPlaneId: "control_plane_a" } }),
    nextConnectionEpoch: () => ++epoch,
  };
  const manager = new CloudControlConnectionManager({
    state,
    originResolver: {
      activeOrigin: () => "https://discovered.cloud.test",
      endpoints: () => ["https://primary.cloud.test", "https://discovered.cloud.test"],
      markSuccess: (origin) => marks.push(`success:${origin}`),
      markFailure: (origin) => marks.push(`failure:${origin}`),
    },
    connector: {
      async connect(input) {
        connects.push(input.serviceOrigin);
        if (input.serviceOrigin === "https://discovered.cloud.test") throw Object.assign(new Error("reset"), { code: "ECONNRESET" });
        return { async close() {} };
      },
    },
    onEvent: async () => undefined,
  });

  assert.equal((await manager.connectOnce()).status, "connected");
  assert.deepEqual(connects, ["https://discovered.cloud.test", "https://primary.cloud.test"]);
  assert.deepEqual(marks, ["failure:https://discovered.cloud.test", "success:https://primary.cloud.test"]);
});

test("Coordinator origin cooldowns suppress repeated dialing and expire without changing the canonical origin", async () => {
  let now = 1_000;
  let epoch = 0;
  const connects = [];
  const state = {
    backgroundCredential: () => "credential",
    snapshot: () => ({ status: "active", scopes: { deviceAccess: true, nodeRelay: false }, remoteAccessEnabled: true, serviceOrigin: "https://primary.cloud.test", cloudControlPlaneId: "cp_cloud_a", identity: { controlPlaneId: "control_plane_a" } }),
    nextConnectionEpoch: () => ++epoch,
  };
  const manager = new CloudControlConnectionManager({
    state,
    coordinatorOrigins: ["https://backup.cloud.test"],
    originCooldownMs: 5_000,
    clock: () => now,
    connector: {
      async connect(input) { connects.push(input.serviceOrigin); throw Object.assign(new Error("unavailable"), { status: 503 }); },
    },
    onEvent: async () => undefined,
  });

  await assert.rejects(() => manager.connectOnce(), { status: 503 });
  assert.deepEqual(connects, ["https://primary.cloud.test", "https://backup.cloud.test"]);
  await assert.rejects(() => manager.connectOnce(), { code: "COORDINATOR_ORIGINS_COOLING_DOWN" });
  assert.equal(connects.length, 2);

  now += 5_000;
  await assert.rejects(() => manager.connectOnce(), { status: 503 });
  assert.deepEqual(connects.slice(2), ["https://primary.cloud.test", "https://backup.cloud.test"]);
  assert.equal(state.snapshot().serviceOrigin, "https://primary.cloud.test");
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

test("relay data connection retries after a transient resume failure", { timeout: 5_000 }, async () => {
  let resumeCalls = 0;
  let resolveSecondResume;
  const secondResume = new Promise((resolve) => { resolveSecondResume = resolve; });
  const manager = new CloudRelayDataConnectionManager({
    verifyAllocation: async (value) => value,
    verifyGrant: async (grant) => ({ allocationId: grant.allocationId, relayUrl: grant.relayUrl, epoch: 1, channelKind: "access", grant }),
    connector: {
      async connect() { throw new Error("unexpected new connection"); },
      async resume() {
        resumeCalls += 1;
        if (resumeCalls === 1) throw Object.assign(new Error("socket reset"), { code: "ECONNRESET" });
        resolveSecondResume();
        return { async close() {} };
      },
    },
  });

  await assert.rejects(() => manager.applyGrant({
    allocationId: "allocation_retry",
    relayUrl: "wss://relay.example.test/connect",
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  }), { code: "ECONNRESET" });

  await Promise.race([
    secondResume,
    new Promise((_, reject) => setTimeout(() => reject(new Error("transient resume failure was not retried")), 1_000)),
  ]);
  assert.equal(resumeCalls, 2);
});

test("relay data connection persists grants with private permissions and resumes after a process restart", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-relay-sessions-"));
  const statePath = path.join(directory, "cloud-relay-sessions.json");
  const now = Date.parse("2026-10-20T00:00:00.000Z");
  const grant = relaySessionGrant({ now });
  const allocation = { allocationId: grant.allocationId, relayUrl: grant.relayUrl, epoch: now, channelKind: "access", grant };
  try {
    const first = new CloudRelayDataConnectionManager({
      verifyAllocation: async (value) => value,
      verifyGrant: async (value) => ({ allocationId: value.grant.allocationId, relayUrl: value.grant.relayUrl, epoch: Date.parse(value.grant.issuedAt), channelKind: "access", grant: value.grant }),
      connector: { async connect() { return { async close() {} }; }, async resume() { throw new Error("unexpected resume"); } },
      sessionStatePath: statePath,
      clock: () => now,
    });
    await first.attach(allocation);
    assert.equal(fs.statSync(statePath).mode & 0o777, 0o600);
    assert.equal(JSON.parse(fs.readFileSync(statePath, "utf8")).sessions[0].grant.sessionTranscriptTicket.transcriptTicketId, grant.sessionTranscriptTicket.transcriptTicketId);

    const resumed = [];
    const second = new CloudRelayDataConnectionManager({
      verifyAllocation: async (value) => value,
      verifyGrant: async (value) => ({ allocationId: value.grant.allocationId, relayUrl: value.grant.relayUrl, epoch: Date.parse(value.grant.issuedAt), channelKind: "access", grant: value.grant }),
      connector: {
        async connect() { throw new Error("unexpected new connection"); },
        async resume(input) { resumed.push(input); return { async close() {} }; },
      },
      sessionStatePath: statePath,
      clock: () => now,
    });
    assert.deepEqual(await second.resumePersistedSessions(), [grant.allocationId]);
    assert.equal(resumed.length, 1);
    assert.equal(resumed[0].grant.grantId, grant.grantId);
    assert.equal(resumed[0].grant.sessionTranscriptTicket.transcriptTicketId, grant.sessionTranscriptTicket.transcriptTicketId);

    await second.closeAll("control-plane-stopping", { preserveSessions: true });
    const third = new CloudRelayDataConnectionManager({
      verifyAllocation: async (value) => value,
      verifyGrant: async (value) => ({ allocationId: value.grant.allocationId, relayUrl: value.grant.relayUrl, epoch: Date.parse(value.grant.issuedAt), channelKind: "access", grant: value.grant }),
      connector: { async connect() { throw new Error("unexpected new connection"); }, async resume() { return { async close() {} }; } },
      sessionStatePath: statePath,
      clock: () => now,
    });
    assert.equal((await third.resumePersistedSessions()).length, 1);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("relay data connection ignores pre-upgrade grants that cannot be resumed safely", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-relay-sessions-"));
  const statePath = path.join(directory, "cloud-relay-sessions.json");
  const now = Date.parse("2026-10-20T00:00:00.000Z");
  const legacyGrant = relaySessionGrant({ now, allocationId: "allocation_legacy" });
  delete legacyGrant.accessTicketId;
  const currentGrant = relaySessionGrant({ now, allocationId: "allocation_current" });
  try {
    fs.writeFileSync(statePath, JSON.stringify({
      version: 1,
      updatedAt: new Date(now).toISOString(),
      sessions: [legacyGrant, currentGrant].map((grant) => ({ allocationId: grant.allocationId, relayUrl: grant.relayUrl, epoch: now, channelKind: "access", grant })),
    }));
    const resumed = [];
    const manager = new CloudRelayDataConnectionManager({
      verifyAllocation: async (value) => value,
      verifyGrant: async (value) => ({ allocationId: value.grant.allocationId, relayUrl: value.grant.relayUrl, epoch: Date.parse(value.grant.issuedAt), channelKind: "access", grant: value.grant }),
      connector: {
        async connect() { throw new Error("unexpected new connection"); },
        async resume(input) { resumed.push(input); return { async close() {} }; },
      },
      sessionStatePath: statePath,
      clock: () => now,
    });

    assert.deepEqual(await manager.resumePersistedSessions(), [currentGrant.allocationId]);
    assert.deepEqual(resumed.map((entry) => entry.grant.allocationId), [currentGrant.allocationId]);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("relay data connection prunes grants at expiry and clears them on terminal close", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-relay-sessions-"));
  const statePath = path.join(directory, "cloud-relay-sessions.json");
  const now = Date.parse("2026-10-20T00:00:00.000Z");
  const grant = relaySessionGrant({ now });
  try {
    const manager = new CloudRelayDataConnectionManager({
      verifyAllocation: async (value) => value,
      verifyGrant: async (value) => ({ allocationId: value.grant.allocationId, relayUrl: value.grant.relayUrl, epoch: Date.parse(value.grant.issuedAt), channelKind: "access", grant: value.grant }),
      connector: { async connect() { return { async close() {} }; }, async resume() { return { async close() {} }; } },
      sessionStatePath: statePath,
      clock: () => now,
    });
    await manager.attach({ allocationId: grant.allocationId, relayUrl: grant.relayUrl, epoch: now, channelKind: "access", grant });
    await manager.closeAll("binding-revoked");
    assert.deepEqual(JSON.parse(fs.readFileSync(statePath, "utf8")).sessions, []);

    await manager.attach({ allocationId: grant.allocationId, relayUrl: grant.relayUrl, epoch: now, channelKind: "access", grant });
    const expired = new CloudRelayDataConnectionManager({
      verifyAllocation: async (value) => value,
      verifyGrant: async (value) => ({ allocationId: value.grant.allocationId, relayUrl: value.grant.relayUrl, epoch: Date.parse(value.grant.issuedAt), channelKind: "access", grant: value.grant }),
      connector: { async connect() { return { async close() {} }; }, async resume() { return { async close() {} }; } },
      sessionStatePath: statePath,
      clock: () => Date.parse(grant.expiresAt),
    });
    assert.deepEqual(await expired.resumePersistedSessions(), []);
    assert.deepEqual(JSON.parse(fs.readFileSync(statePath, "utf8")).sessions, []);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function relaySessionGrant({ now, allocationId: allocationOverride, relayUrl: relayUrlOverride, targetPublicKeyFingerprint, accountId, deviceSessionId, controlPlaneId, bindingId, bindingRevision, ownerAccountId, accessMode, shareGrantId, shareRevision, shareRole }) {
  const issuedAt = new Date(now).toISOString();
  const expiresAt = new Date(now + 15 * 60_000).toISOString();
  const identity = {
    allocationId: allocationOverride ?? "allocation_restart",
    sessionId: "session_restart",
    relayId: "relay_restart",
    relayUrl: relayUrlOverride ?? "wss://relay.example.test/connect",
    accountId: accountId ?? "account_restart",
    deviceSessionId: deviceSessionId ?? "device_restart",
    controlPlaneId: controlPlaneId ?? "control_plane_restart",
    bindingId: bindingId ?? "binding_restart",
    bindingRevision: bindingRevision ?? 2,
    targetPublicKeyFingerprint: targetPublicKeyFingerprint ?? `sha256:${"a".repeat(43)}`,
  };
  const shared = ownerAccountId === undefined ? {} : { ownerAccountId, accessMode, shareGrantId, shareRevision, shareRole };
  const grant = {
    protocolVersion: RELAY_SESSION_PROTOCOL_VERSION,
    audience: RelaySessionAudience.Grant,
    sessionId: identity.sessionId,
    grantId: "grant_restart_1",
    generation: 1,
    accessTicketId: "access_ticket_restart",
    ...identity,
    relayRegion: "cn-north-sz1-staging",
    clientProofPublicKey: "b".repeat(43),
    controlPlaneProofPublicKey: "c".repeat(43),
    trafficClass: "interactive",
    ...shared,
    sessionTranscriptTicket: {
      protocolVersion: RELAY_SESSION_PROTOCOL_VERSION,
      audience: RelaySessionAudience.Transcript,
      transcriptTicketId: "transcript_ticket_restart",
      accountId: identity.accountId,
      deviceSessionId: identity.deviceSessionId,
      controlPlaneId: identity.controlPlaneId,
      bindingId: identity.bindingId,
      bindingRevision: identity.bindingRevision,
      targetPublicKeyFingerprint: identity.targetPublicKeyFingerprint,
      nonce: "transcript-nonce-restart".padEnd(24, "x"),
      issuedAt,
      expiresAt,
      ...shared,
    },
    revocationEpoch: 0,
    issuedAt,
    expiresAt,
    signature: "s".repeat(64),
  };
  return grant;
}

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
  const base = relaySessionGrant({ now, allocationId: "allocation_a", relayUrl: "wss://relay.cloud.example.test/connect", targetPublicKeyFingerprint: fingerprint, accountId: "account_a", deviceSessionId: "device_a", controlPlaneId: "cp_cloud_a", bindingId: "binding_a" });
  const attachFor = (grant, extra = {}) => ({ protocolVersion: "2026-08-10", audience: "task-handoff:relay-control-plane-attach", allocationId: grant.allocationId, relayId: grant.relayId, role: "control-plane", controlPlaneId: grant.controlPlaneId, accountId: grant.accountId, deviceSessionId: grant.deviceSessionId, bindingId: grant.bindingId, ticketId: grant.accessTicketId, bindingRevision: grant.bindingRevision, trafficClass: "interactive", nonce: "a".repeat(24), issuedAt: grant.issuedAt, expiresAt: new Date(now + 8 * 60_000).toISOString(), signature: "s".repeat(32), ...extra });
  const allocation = (grant, relayUrl = grant.relayUrl, attach = attachFor(grant)) => ({ type: "relay-allocation", allocationId: grant.allocationId, relayUrl, attach, grant });
  const state = { snapshot: () => ({ status: "active", scopes: { deviceAccess: true, nodeRelay: false }, remoteAccessEnabled: true, serviceOrigin: "https://cloud.example.test", accountId: "account_a", bindingId: "binding_a", bindingRevision: 2, cloudControlPlaneId: "cp_cloud_a", identity: { controlPlaneId: "control_plane_a", fingerprint } }) };
  assert.equal(verifyCoordinatorRelayAllocation(allocation(base), state).allocationId, "allocation_a");
  const untrusted = relaySessionGrant({ now, allocationId: "allocation_a", relayUrl: "wss://eu.relay.taskhandoff.com/connect", targetPublicKeyFingerprint: fingerprint, accountId: "account_a", deviceSessionId: "device_a", controlPlaneId: "cp_cloud_a", bindingId: "binding_a" });
  assert.throws(() => verifyCoordinatorRelayAllocation(allocation(untrusted), state), { code: "UNTRUSTED_RELAY_URL" });
  assert.throws(() => verifyCoordinatorRelayAllocation(allocation(base, "wss://attacker.example/connect"), state), { code: "UNTRUSTED_RELAY_URL" });
  assert.throws(() => verifyCoordinatorRelayAllocation(allocation(base, base.relayUrl, attachFor(base, { bindingRevision: 1 })), state), { code: "RELAY_ALLOCATION_AUTHORITY_INVALID" });
  assert.throws(() => verifyCoordinatorRelayAllocation(allocation(base, base.relayUrl, attachFor(base, { ticketId: "access_ticket_forged" })), state), { code: "RELAY_ALLOCATION_AUTHORITY_INVALID" });
  const shared = relaySessionGrant({ now, allocationId: "allocation_a", relayUrl: "wss://relay.cloud.example.test/connect", targetPublicKeyFingerprint: fingerprint, accountId: "account_grantee", deviceSessionId: "device_shared", controlPlaneId: "cp_cloud_a", bindingId: "binding_a", ownerAccountId: "account_a", accessMode: "shared", shareGrantId: "share_a", shareRevision: 4, shareRole: "viewer" });
  const sharedAttach = attachFor(shared, { accountId: "account_grantee", ownerAccountId: "account_a", accessMode: "shared", shareGrantId: "share_a", shareRevision: 4, shareRole: "viewer" });
  assert.equal(verifyCoordinatorRelayAllocation(allocation(shared, shared.relayUrl, sharedAttach), state).ticket.ownerAccountId, "account_a");
  assert.throws(() => verifyCoordinatorRelayAllocation(allocation(shared, shared.relayUrl, { ...sharedAttach, ownerAccountId: "account_forged" }), state), { code: "RELAY_ALLOCATION_AUTHORITY_INVALID" });
  assert.throws(() => verifyCoordinatorRelayAllocation(allocation(shared, shared.relayUrl, { ...sharedAttach, shareRevision: 3 }), state), { code: "RELAY_ALLOCATION_AUTHORITY_INVALID" });
  const localState = { snapshot: () => ({ ...state.snapshot(), serviceOrigin: "http://localhost:8080" }) };
  const local = relaySessionGrant({ now, allocationId: "allocation_a", relayUrl: "ws://localhost:8080/connect", targetPublicKeyFingerprint: fingerprint, accountId: "account_a", deviceSessionId: "device_a", controlPlaneId: "cp_cloud_a", bindingId: "binding_a" });
  assert.equal(verifyCoordinatorRelayAllocation(allocation(local), localState).allocationId, "allocation_a");
  assert.throws(() => verifyCoordinatorRelayAllocation(allocation(local, "ws://attacker.example/connect"), localState), { code: "UNTRUSTED_RELAY_URL" });
  // An ad hoc environment trusts Relay hosts at or below its service host only.
  const stagingState = { snapshot: () => ({ ...state.snapshot(), serviceOrigin: "https://staging.cloud.example.test", accountId: "account_a" }) };
  const staging = relaySessionGrant({ now, allocationId: "allocation_a", relayUrl: "wss://relay.staging.cloud.example.test/connect", targetPublicKeyFingerprint: fingerprint, accountId: "account_a", deviceSessionId: "device_a", controlPlaneId: "cp_cloud_a", bindingId: "binding_a" });
  assert.equal(verifyCoordinatorRelayAllocation(allocation(staging), stagingState).allocationId, "allocation_a");
  const foreign = relaySessionGrant({ now, allocationId: "allocation_a", relayUrl: "wss://relay.cloud.example.test/connect", targetPublicKeyFingerprint: fingerprint, accountId: "account_a", deviceSessionId: "device_a", controlPlaneId: "cp_cloud_a", bindingId: "binding_a" });
  assert.throws(() => verifyCoordinatorRelayAllocation(allocation(foreign), stagingState), { code: "UNTRUSTED_RELAY_URL" });
});

test("Control Plane validates shared node allocation identity against both owner and grantee", () => {
  const now = Date.now();
  const issuedAt = new Date(now - 1_000).toISOString();
  const expiresAt = new Date(now + 30_000).toISOString();
  const fingerprint = `sha256:${"a".repeat(43)}`;
  const controlPlaneAttach = {
    protocolVersion: "2026-08-10",
    channelKind: "node",
    audience: "task-handoff:relay-control-plane-attach",
    allocationId: "allocation_node",
    relayId: "relay_a",
    role: "control-plane",
    controlPlaneId: "cp_cloud_a",
    accountId: "account_grantee",
    ownerAccountId: "account_owner",
    accessMode: "shared",
    shareGrantId: "share_node_a",
    shareRevision: 4,
    shareRole: "use",
    bindingId: "binding_a",
    bindingRevision: 2,
    nodeHandle: "nrh_node_alpha",
    trafficClass: "interactive",
    nonce: "a".repeat(24),
    issuedAt,
    expiresAt,
    signature: "s".repeat(32),
  };
  const event = {
    type: "node-relay-allocation",
    protocolVersion: "2026-08-10",
    allocationId: "allocation_node",
    relayId: "relay_a",
    relayRegion: "eu-west",
    relayUrl: "wss://relay.cloud.example.test/connect",
    nodeHandle: "nrh_node_alpha",
    accountId: "account_grantee",
    ownerAccountId: "account_owner",
    accessMode: "shared",
    shareGrantId: "share_node_a",
    shareRevision: 4,
    shareRole: "use",
    controlPlaneId: "cp_cloud_a",
    bindingId: "binding_a",
    bindingRevision: 2,
    controlPlaneAttach,
    expiresAt,
    nodePublicKeyFingerprint: fingerprint,
  };
  const state = { snapshot: () => ({ status: "active", scopes: { deviceAccess: true, nodeRelay: true }, serviceOrigin: "https://cloud.example.test", accountId: "account_grantee", bindingId: "binding_a", bindingRevision: 2, cloudControlPlaneId: "cp_cloud_a", identity: { fingerprint } }) };
  assert.equal(verifyCoordinatorNodeRelayAllocation(event, state).nodeHandle, "nrh_node_alpha");
  assert.throws(() => verifyCoordinatorNodeRelayAllocation(event, { snapshot: () => ({ ...state.snapshot(), accountId: "account_owner" }) }), { code: "RELAY_ALLOCATION_AUTHORITY_INVALID" });
  assert.throws(() => verifyCoordinatorNodeRelayAllocation({ ...event, ownerAccountId: "account_forged" }, state), { code: "RELAY_ALLOCATION_AUTHORITY_INVALID" });
  assert.throws(() => verifyCoordinatorNodeRelayAllocation({ ...event, shareRevision: 3 }, state), { code: "RELAY_ALLOCATION_AUTHORITY_INVALID" });
  assert.throws(() => verifyCoordinatorNodeRelayAllocation({ ...event, controlPlaneAttach: { ...controlPlaneAttach, shareGrantId: "share_forged" } }, state), { code: "RELAY_ALLOCATION_AUTHORITY_INVALID" });
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
      if (message.type === "attach") queueMicrotask(() => this.emit("message", { toString: () => JSON.stringify({ type: "attached", role: "control-plane", sessionId: message.grant.sessionId, allocationId: message.grant.allocationId, channelId: "relay_channel_a", generation: message.grant.generation, state: "waiting-for-peer", leaseExpiresAt: message.grant.expiresAt }) }));
    }
    close(code, reason) { this.readyState = FakeSocket.CLOSED; queueMicrotask(() => this.emit("close", code, reason)); }
    receive(frame) { this.emit("message", Buffer.from(encodeRelayFrame(frame)), true); }
  }
  const now = Date.now(); const fingerprint = `sha256:${"a".repeat(43)}`;
  const grant = relaySessionGrant({ now, allocationId: "allocation_a", relayUrl: "ws://localhost:8080/connect", targetPublicKeyFingerprint: fingerprint, accountId: "account_a", deviceSessionId: "device_a", controlPlaneId: "cp_cloud_a", bindingId: "binding_a" });
  const attach = { protocolVersion: "2026-08-10", audience: "task-handoff:relay-control-plane-attach", allocationId: grant.allocationId, relayId: grant.relayId, role: "control-plane", controlPlaneId: grant.controlPlaneId, accountId: grant.accountId, deviceSessionId: grant.deviceSessionId, bindingId: grant.bindingId, ticketId: grant.accessTicketId, bindingRevision: grant.bindingRevision, trafficClass: "interactive", nonce: "a".repeat(24), issuedAt: grant.issuedAt, expiresAt: new Date(now + 8 * 60_000).toISOString(), signature: "s".repeat(32) };
  const identity = { acceptCloudAccessHandshake: () => ({ response: { serverEphemeralPublicKey: "c".repeat(43), transcript: "transcript", signature: "s".repeat(32) }, sessionKey: new Uint8Array(32) }), publicIdentity: () => ({ publicKey: "c".repeat(43) }), signRelayRoleProof: (payload) => ({ ...payload, signature: "s".repeat(64) }) };
  const connector = new CloudRelayConnector({ identity, bridge: {}, webSocket: FakeSocket });
  const connection = await connector.connect({ relayUrl: "ws://localhost:8080/connect", allocation: { attach, grant } });
  assert.deepEqual(sockets[0].sent.map((message) => message.type), ["attach"]);
  assert.equal(sockets[0].sent[0].grant.grantId, grant.grantId);
  assert.equal(sockets[0].sent[0].proof.role, "control-plane");
  const hello = { ticketId: grant.sessionTranscriptTicket.transcriptTicketId, deviceSessionId: grant.deviceSessionId, clientEphemeralPublicKey: "b".repeat(43) };
  sockets[0].receive({ kind: "handshake", sequence: 0, payload: Buffer.from(JSON.stringify(hello)) });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(sockets[0].frames.some((frame) => frame.kind === "handshake"), true);
  await connection.close("test-done");
  assert.equal(sockets[0].readyState, FakeSocket.CLOSED);
});
