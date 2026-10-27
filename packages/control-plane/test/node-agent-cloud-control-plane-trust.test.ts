import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { nodeRelayFingerprint } from "../src/shared/cloud-relay/node-relay-session.ts";
import { openNodeAgentDatabase, openNodeAgentDatabaseSync } from "../src/node-agent/persistence/database.ts";
import { AccessRepository } from "../src/node-agent/persistence/access-repository.ts";
import { nodeAgentMigrations } from "../src/node-agent/persistence/migrations.ts";
import { nodeAgentStorePaths } from "../src/node-agent/persistence/paths.ts";
import type { NodeAgentCloudControlPlaneTrustContext } from "../src/node-agent/cloud-relay/trust-types.ts";

const NOW = "2026-10-26T10:00:00.000Z";
const TTL_MS = 24 * 60 * 60 * 1000;

function fixture(t: test.TestContext) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "th-cp-trust-"));
  const paths = nodeAgentStorePaths(dataDir);
  const database = openNodeAgentDatabaseSync(paths);
  const repository = new AccessRepository(database.client);
  t.after(async () => {
    await database.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  return { dataDir, paths, database, repository };
}

function context(overrides: Partial<NodeAgentCloudControlPlaneTrustContext> = {}): NodeAgentCloudControlPlaneTrustContext {
  const publicKey = overrides.controlPlanePublicKey ?? crypto.randomBytes(32).toString("base64url");
  return {
    nodeId: "node_test_local",
    nodeHandle: "node_handle_test",
    controlPlaneId: "cp_alpha",
    controlPlanePublicKey: publicKey,
    bindingId: "binding_alpha",
    bindingRevision: 1,
    accountId: "acct_owner",
    ownerAccountId: "acct_owner",
    accessMode: "owner",
    ...overrides,
  };
}

function observe(repository: AccessRepository, value: NodeAgentCloudControlPlaneTrustContext, now = NOW) {
  return repository.observeCloudControlPlaneTrust({
    context: value,
    fingerprint: repository.cloudControlPlaneTrustFingerprint(value.controlPlanePublicKey),
    now,
    ttlMs: TTL_MS,
  });
}

test("node-agent Control Plane pending deduplicates reconnects and keeps an absolute TTL", (t) => {
  const { repository } = fixture(t);
  const value = context();
  const first = observe(repository, value);
  assert.equal(first.kind, "pending");
  if (first.kind !== "pending") return;
  const again = observe(repository, { ...value, bindingRevision: 2 }, "2026-10-26T11:00:00.000Z");
  assert.equal(again.kind, "pending");
  if (again.kind !== "pending") return;
  assert.equal(again.request.id, first.request.id);
  assert.equal(again.request.expiresAt, first.request.expiresAt);
  assert.equal(again.request.requestedAt, first.request.requestedAt);
  assert.equal(again.request.bindingRevision, 2);
  assert.equal(again.request.revision, 2);
  assert.equal(again.request.lastSeenAt, "2026-10-26T11:00:00.000Z");
});

test("node-agent Control Plane approval creates one active pin and is idempotent", (t) => {
  const { repository, paths } = fixture(t);
  const value = context();
  const pending = observe(repository, value);
  assert.equal(pending.kind, "pending");
  if (pending.kind !== "pending") return;
  const decision = {
    action: "approve" as const,
    requestId: pending.request.id,
    expectedFingerprint: repository.cloudControlPlaneTrustFingerprint(value.controlPlanePublicKey),
    expectedRevision: pending.request.revision,
    actor: { type: "local" as const, id: "cli-admin" },
  };
  const approved = repository.decideCloudControlPlaneTrust(decision, { now: NOW });
  assert.equal(approved.pin?.status, "active");
  assert.equal(approved.request.status, "approved");
  const repeated = repository.decideCloudControlPlaneTrust(decision, { now: NOW });
  assert.equal(repeated.pin?.id, approved.pin?.id);
  assert.equal(repository.listCloudControlPlaneTrust(NOW).pins.filter((pin) => pin.status === "active").length, 1);
  const active = observe(repository, { ...value, bindingRevision: 3 }, "2026-10-26T12:00:00.000Z");
  assert.equal(active.kind, "active");
  if (active.kind === "active") assert.equal(active.pin.bindingRevision, 3);

  const audit = new DatabaseSync(paths.databasePath, { readOnly: true });
  assert.equal(audit.prepare("SELECT COUNT(*) AS count FROM na_cloud_control_plane_trust_audit WHERE action = 'approve'").get().count, 1);
  audit.close();
});

test("node-agent rejected request is terminal for automatic reconnects", (t) => {
  const { repository } = fixture(t);
  const value = context({ controlPlaneId: "cp_beta" });
  const pending = observe(repository, value);
  assert.equal(pending.kind, "pending");
  if (pending.kind !== "pending") return;
  repository.decideCloudControlPlaneTrust({
    action: "reject",
    requestId: pending.request.id,
    expectedFingerprint: repository.cloudControlPlaneTrustFingerprint(value.controlPlanePublicKey),
    expectedRevision: pending.request.revision,
    reason: "not allowed",
    actor: { type: "local", id: "cli-admin" },
  }, { now: NOW });
  const rejected = observe(repository, value, "2026-10-27T09:00:00.000Z");
  assert.equal(rejected.kind, "rejected");
  if (rejected.kind !== "rejected") return;
  assert.equal(rejected.request.id, pending.request.id);
  assert.equal(repository.listCloudControlPlaneTrust(NOW).requests.length, 1);
});

test("reject is idempotent and explicit retry creates a fresh pending request with a full TTL", (t) => {
  const { repository, paths } = fixture(t);
  const value = context({ controlPlaneId: "cp_retry" });
  const pending = observe(repository, value);
  assert.equal(pending.kind, "pending");
  if (pending.kind !== "pending") return;
  const fingerprint = repository.cloudControlPlaneTrustFingerprint(value.controlPlanePublicKey);
  const rejection = {
    action: "reject" as const,
    requestId: pending.request.id,
    expectedFingerprint: fingerprint,
    expectedRevision: pending.request.revision,
    actor: { type: "local" as const, id: "cli-admin" },
  };
  const rejected = repository.decideCloudControlPlaneTrust(rejection, { now: NOW });
  const repeated = repository.decideCloudControlPlaneTrust(rejection, { now: NOW });
  assert.equal(repeated.request.status, "rejected");
  assert.equal(repeated.request.id, rejected.request.id);

  const retried = repository.retryCloudControlPlaneTrustRequest({
    requestId: rejected.request.id,
    now: "2026-10-26T12:00:00.000Z",
    ttlMs: TTL_MS,
    actor: { type: "control-plane", id: "cp_admin", connectionType: "node-relay" },
  });
  assert.notEqual(retried.id, rejected.request.id);
  assert.equal(retried.status, "pending");
  assert.equal(retried.requestedAt, "2026-10-26T12:00:00.000Z");
  assert.equal(retried.expiresAt, "2026-10-27T12:00:00.000Z");
  assert.equal(retried.revision, 1);

  const audit = new DatabaseSync(paths.databasePath, { readOnly: true });
  const retryAudit = audit.prepare("SELECT actor_type, actor_id, connection_type, reason FROM na_cloud_control_plane_trust_audit WHERE action = 'retry'").get() as Record<string, unknown>;
  assert.equal(retryAudit.actor_type, "control-plane");
  assert.equal(retryAudit.actor_id, "cp_admin");
  assert.equal(retryAudit.connection_type, "node-relay");
  assert.equal(retryAudit.reason, `explicit-retry:${rejected.request.id}`);
  audit.close();
});

test("node-agent Control Plane expiry writes a system audit record", (t) => {
  const { repository, paths } = fixture(t);
  const value = context({ controlPlaneId: "cp_expire" });
  const pending = observe(repository, value);
  assert.equal(pending.kind, "pending");
  if (pending.kind !== "pending") return;
  const afterExpiry = new Date(Date.parse(pending.request.expiresAt) + 1).toISOString();
  const snapshot = repository.listCloudControlPlaneTrust(afterExpiry);
  assert.equal(snapshot.requests.find((request) => request.id === pending.request.id)?.status, "expired");

  const audit = new DatabaseSync(paths.databasePath, { readOnly: true });
  const row = audit.prepare("SELECT action, actor_type, actor_id, request_id, pin_id, control_plane_id, control_plane_public_key_fingerprint, reason, created_at FROM na_cloud_control_plane_trust_audit WHERE action = 'expire'").get() as Record<string, unknown>;
  audit.close();
  assert.equal(row.action, "expire");
  assert.equal(row.actor_type, "system");
  assert.equal(row.actor_id, "node-agent");
  assert.equal(row.request_id, pending.request.id);
  assert.equal(row.pin_id, null);
  assert.equal(row.control_plane_id, value.controlPlaneId);
  assert.equal(row.control_plane_public_key_fingerprint, repository.cloudControlPlaneTrustFingerprint(value.controlPlanePublicKey));
  assert.equal(row.reason, "pending-ttl-expired");
  assert.equal(row.created_at, afterExpiry);
});

test("fingerprint conflicts and concurrent approvals leave no partial pin or duplicate audit", (t) => {
  const { repository, paths } = fixture(t);
  const value = context({ controlPlaneId: "cp_atomic" });
  const pending = observe(repository, value);
  assert.equal(pending.kind, "pending");
  if (pending.kind !== "pending") return;
  const fingerprint = repository.cloudControlPlaneTrustFingerprint(value.controlPlanePublicKey);
  assert.throws(() => repository.decideCloudControlPlaneTrust({
    action: "approve",
    requestId: pending.request.id,
    expectedFingerprint: `sha256:${"A".repeat(43)}`,
    expectedRevision: pending.request.revision,
    actor: { type: "local", id: "cli-admin" },
  }, { now: NOW }), { code: "NODE_AGENT_CONTROL_PLANE_TRUST_FINGERPRINT_CONFLICT" });
  assert.deepEqual(repository.listCloudControlPlaneTrust(NOW).pins, []);

  const decision = (actor: { type: "local" | "control-plane"; id: string }) => repository.decideCloudControlPlaneTrust({
    action: "approve",
    requestId: pending.request.id,
    expectedFingerprint: fingerprint,
    expectedRevision: pending.request.revision,
    actor,
  }, { now: NOW });
  const first = decision({ type: "local", id: "cli-admin" });
  const second = decision({ type: "control-plane", id: "cp_admin" });
  assert.equal(second.pin?.id, first.pin?.id);
  assert.equal(repository.listCloudControlPlaneTrust(NOW).pins.filter((pin) => pin.status === "active").length, 1);

  const audit = new DatabaseSync(paths.databasePath, { readOnly: true });
  assert.equal(audit.prepare("SELECT COUNT(*) AS count FROM na_cloud_control_plane_trust_audit WHERE action = 'approve'").get().count, 1);
  audit.close();
});

test("0018 upgrade never turns an existing cloud binding or relay pairing into an active pin", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "th-cp-trust-upgrade-"));
  const paths = nodeAgentStorePaths(dataDir);
  try {
    fs.mkdirSync(path.dirname(paths.databasePath), { recursive: true });
    const legacy = new DatabaseSync(paths.databasePath);
    legacy.exec("CREATE TABLE na_migration_ledger (id TEXT PRIMARY KEY NOT NULL, checksum TEXT NOT NULL, applied_at TEXT NOT NULL, details TEXT NOT NULL)");
    const insert = legacy.prepare("INSERT INTO na_migration_ledger (id, checksum, applied_at, details) VALUES (?, ?, ?, ?)");
    for (const migration of nodeAgentMigrations.filter((candidate) => candidate.id !== "0018_cloud_control_plane_trust")) {
      legacy.exec(migration.sql);
      insert.run(migration.id, migration.checksum, NOW, JSON.stringify({ release: "stage-b-pre-0018" }));
    }
    legacy.prepare("INSERT INTO na_control_plane_pairings (key_id, control_plane_id, secret, paired_at, updated_at) VALUES (?, ?, ?, ?, ?)")
      .run("key_legacy", "cp_legacy", crypto.randomBytes(32).toString("base64url"), NOW, NOW);
    legacy.prepare(`INSERT INTO na_cloud_relay_bindings
      (singleton_key, status, node_handle, account_id, cloud_origin, service_origin, credential, credential_expires_at,
       signing_kid, signing_public_key, relay_public_key, relay_private_key, paired_control_planes_json, last_error_json, bound_at, updated_at)
      VALUES (1, 'active', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`).run(
      "nrh_upgrade", "acct_upgrade", "https://cloud.example.test", "https://cloud.example.test",
      "credential-upgrade", "2026-12-01T00:00:00.000Z", "kid_upgrade", crypto.randomBytes(32).toString("base64url"),
      crypto.randomBytes(32).toString("base64url"), crypto.randomBytes(64).toString("base64url"),
      JSON.stringify(["cp_legacy"]), NOW, NOW,
    );
    legacy.close();

    const upgraded = await openNodeAgentDatabase(paths);
    try {
      assert.equal(upgraded.client.prepare("SELECT COUNT(*) AS count FROM na_cloud_control_plane_pins").get().count, 0);
      assert.equal(upgraded.client.prepare("SELECT COUNT(*) AS count FROM na_cloud_control_plane_trust_requests").get().count, 0);
      assert.equal(upgraded.client.prepare("SELECT node_handle FROM na_cloud_relay_bindings WHERE singleton_key = 1").get().node_handle, "nrh_upgrade");
    } finally {
      await upgraded.close();
    }
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("share revision only converges forward without a new approval", (t) => {
  const { repository } = fixture(t);
  const shared = context({
    bindingId: "binding_shared",
    accountId: "acct_guest",
    ownerAccountId: "acct_owner",
    accessMode: "shared",
    shareGrantId: "share_alpha",
    shareRole: "use",
    shareRevision: 2,
  });
  const pending = observe(repository, shared);
  assert.equal(pending.kind, "pending");
  if (pending.kind !== "pending") return;
  repository.decideCloudControlPlaneTrust({
    action: "approve",
    requestId: pending.request.id,
    expectedFingerprint: repository.cloudControlPlaneTrustFingerprint(shared.controlPlanePublicKey),
    expectedRevision: pending.request.revision,
    actor: { type: "local", id: "cli-admin" },
  }, { now: NOW });
  const converged = observe(repository, { ...shared, shareRevision: 5 }, "2026-10-26T12:00:00.000Z");
  assert.equal(converged.kind, "active");
  if (converged.kind === "active") assert.equal(converged.pin.shareRevision, 5);
  const stale = observe(repository, { ...shared, shareRevision: 4 }, "2026-10-26T13:00:00.000Z");
  assert.equal(stale.kind, "pending");
});

test("approving a rotated Control Plane key revokes the prior key unless explicitly retained", (t) => {
  const { repository } = fixture(t);
  const first = context();
  const pending = observe(repository, first);
  assert.equal(pending.kind, "pending");
  if (pending.kind !== "pending") return;
  repository.decideCloudControlPlaneTrust({
    action: "approve",
    requestId: pending.request.id,
    expectedFingerprint: repository.cloudControlPlaneTrustFingerprint(first.controlPlanePublicKey),
    expectedRevision: pending.request.revision,
    actor: { type: "local", id: "cli-admin" },
  }, { now: NOW });
  const rotated = context({ controlPlanePublicKey: crypto.randomBytes(32).toString("base64url") });
  const rotationPending = observe(repository, rotated);
  assert.equal(rotationPending.kind, "pending");
  if (rotationPending.kind !== "pending") return;
  const approved = repository.decideCloudControlPlaneTrust({
    action: "approve",
    requestId: rotationPending.request.id,
    expectedFingerprint: repository.cloudControlPlaneTrustFingerprint(rotated.controlPlanePublicKey),
    expectedRevision: rotationPending.request.revision,
    actor: { type: "local", id: "cli-admin" },
  }, { now: NOW });
  assert.equal(approved.revokedPins.length, 1);
  const pins = repository.listCloudControlPlaneTrust(NOW).pins;
  assert.equal(pins.filter((pin) => pin.status === "active").length, 1);
  assert.equal(pins.filter((pin) => pin.status === "revoked").length, 1);
});

test("explicitly retaining a rotated Control Plane key keeps both pins active", (t) => {
  const { repository } = fixture(t);
  const first = context();
  const pending = observe(repository, first);
  assert.equal(pending.kind, "pending");
  if (pending.kind !== "pending") return;
  repository.decideCloudControlPlaneTrust({
    action: "approve",
    requestId: pending.request.id,
    expectedFingerprint: repository.cloudControlPlaneTrustFingerprint(first.controlPlanePublicKey),
    expectedRevision: pending.request.revision,
    actor: { type: "local", id: "cli-admin" },
  }, { now: NOW });

  const rotated = context({ controlPlanePublicKey: crypto.randomBytes(32).toString("base64url") });
  const rotationPending = observe(repository, rotated);
  assert.equal(rotationPending.kind, "pending");
  if (rotationPending.kind !== "pending") return;
  const approved = repository.decideCloudControlPlaneTrust({
    action: "approve",
    requestId: rotationPending.request.id,
    expectedFingerprint: repository.cloudControlPlaneTrustFingerprint(rotated.controlPlanePublicKey),
    expectedRevision: rotationPending.request.revision,
    retainPreviousKey: true,
    actor: { type: "local", id: "cli-admin" },
  }, { now: NOW });

  assert.equal(approved.revokedPins.length, 0);
  const activePins = repository.listCloudControlPlaneTrust(NOW).pins.filter((pin) => pin.status === "active");
  assert.equal(activePins.length, 2);
  assert.deepEqual(
    new Set(activePins.map((pin) => pin.controlPlanePublicKey)),
    new Set([first.controlPlanePublicKey, rotated.controlPlanePublicKey]),
  );
});

test("revoking one exact pin does not block a future pending request", (t) => {
  const { repository } = fixture(t);
  const value = context({ controlPlaneId: "cp_gamma" });
  const pending = observe(repository, value);
  assert.equal(pending.kind, "pending");
  if (pending.kind !== "pending") return;
  const approved = repository.decideCloudControlPlaneTrust({
    action: "approve",
    requestId: pending.request.id,
    expectedFingerprint: repository.cloudControlPlaneTrustFingerprint(value.controlPlanePublicKey),
    expectedRevision: pending.request.revision,
    actor: { type: "local", id: "cli-admin" },
  }, { now: NOW });
  assert.ok(approved.pin);
  const revoked = repository.revokeCloudControlPlaneTrustPin({
    pinId: approved.pin!.id,
    expectedFingerprint: repository.cloudControlPlaneTrustFingerprint(value.controlPlanePublicKey),
    expectedRevision: approved.pin!.authorizationRevision,
    reason: "administrator revoke",
    actor: { type: "local", id: "cli-admin" },
  }, NOW);
  assert.equal(revoked.status, "revoked");
  const next = observe(repository, value, "2026-10-26T12:00:00.000Z");
  assert.equal(next.kind, "pending");
  if (next.kind === "pending") assert.notEqual(next.request.id, pending.request.id);
});

test("a Control Plane cannot revoke its own active trust pin", (t) => {
  const { repository } = fixture(t);
  const value = context({ controlPlaneId: "cp_self" });
  const pending = observe(repository, value);
  assert.equal(pending.kind, "pending");
  if (pending.kind !== "pending") return;
  const fingerprint = repository.cloudControlPlaneTrustFingerprint(value.controlPlanePublicKey);
  const approved = repository.decideCloudControlPlaneTrust({
    action: "approve",
    requestId: pending.request.id,
    expectedFingerprint: fingerprint,
    expectedRevision: pending.request.revision,
    actor: { type: "local", id: "cli-admin" },
  }, { now: NOW });
  assert.ok(approved.pin);

  assert.throws(() => repository.revokeCloudControlPlaneTrustPin({
    pinId: approved.pin!.id,
    expectedFingerprint: fingerprint,
    expectedRevision: approved.pin!.authorizationRevision,
    actor: { type: "control-plane", id: value.controlPlaneId },
  }, NOW), (error: any) => error.code === "NODE_AGENT_CONTROL_PLANE_TRUST_SELF_REVOKE_FORBIDDEN" && error.statusCode === 403);
  assert.equal(repository.listCloudControlPlaneTrust(NOW).pins.find((pin) => pin.id === approved.pin!.id)?.status, "active");
});

test("fingerprint and short comparison code are derived from the full public key", () => {
  const publicKey = crypto.randomBytes(32).toString("base64url");
  const fingerprint = nodeRelayFingerprint(publicKey);
  assert.match(fingerprint, /^sha256:[A-Za-z0-9_-]{43}$/);
  assert.notEqual(fingerprint, nodeRelayFingerprint(crypto.randomBytes(32).toString("base64url")));
});
