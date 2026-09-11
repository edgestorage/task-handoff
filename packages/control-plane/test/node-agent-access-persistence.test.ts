import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { NodeAgentIdentityService } from "../src/node-agent/identity/service.ts";
import { openNodeAgentDatabaseSync } from "../src/node-agent/persistence/database.ts";
import { nodeAgentStorePaths } from "../src/node-agent/persistence/paths.ts";
import { createNodeAgentRepository } from "../src/node-agent/persistence/repository.ts";

function fixture(t: test.TestContext, name: string) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), `task-handoff-access-${name}-`));
  const paths = nodeAgentStorePaths(dataDir);
  const database = openNodeAgentDatabaseSync(paths);
  const repository = createNodeAgentRepository(database);
  t.after(async () => {
    await repository.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const identity = new NodeAgentIdentityService(paths, repository.access);
  identity.resolveNodeId(`node_${name}`);
  return { paths, repository, identity };
}

test("prepared Control Plane connection operation rolls back on restart", (t) => {
  const { paths, repository, identity } = fixture(t, "prepared_recovery");
  const existing = identity.commitControlPlaneConnection(identity.stageControlPlaneConnection({
    url: "https://control.example.test/",
    name: "Existing",
  }));
  const staged = identity.stageControlPlaneConnection({
    url: "https://control.example.test",
    name: "Replacement",
  });
  assert.equal(repository.access.listOperations()[0].phase, "prepared");
  assert.equal(identity.listControlPlaneConnections()[0].id, staged.connection.id);

  const restarted = new NodeAgentIdentityService(paths, repository.access);
  assert.deepEqual(restarted.listControlPlaneConnections().map((record) => record.id), [existing.connection.id]);
  assert.deepEqual(restarted.listControlPlanePairings().map((record) => record.keyId), [existing.pairing.keyId]);
  assert.deepEqual(repository.access.listOperations(), []);
});

test("remote-accepted Control Plane connection operation completes on restart", (t) => {
  const { paths, repository, identity } = fixture(t, "accepted_recovery");
  const staged = identity.stageControlPlaneConnection({
    url: "https://control.example.test/",
    name: "Accepted",
  });
  identity.markControlPlaneConnectionRemoteAccepted(staged);
  assert.equal(repository.access.listOperations()[0].phase, "remote-accepted");

  const restarted = new NodeAgentIdentityService(paths, repository.access);
  assert.deepEqual(restarted.listControlPlaneConnections().map((record) => record.id), [staged.connection.id]);
  assert.deepEqual(restarted.listControlPlanePairings().map((record) => record.keyId), [staged.pairing.keyId]);
  assert.deepEqual(repository.access.listOperations(), []);
});

test("pairing invites are process-memory-only and never enter SQLite", (t) => {
  const { paths, repository, identity } = fixture(t, "invite_memory");
  const invite = identity.createPairingInvite({ expiresInMs: 60_000 });
  const tokenHash = crypto.createHash("sha256").update(invite.token).digest("hex");
  const persistedText = [
    ...repository.access.listOperations().map((record) => JSON.stringify(record)),
    JSON.stringify(repository.access.readIdentity()),
  ].join("\n");
  assert.equal(persistedText.includes(invite.token), false);
  assert.equal(persistedText.includes(tokenHash), false);

  const restarted = new NodeAgentIdentityService(paths, repository.access);
  assert.throws(
    () => restarted.completePairingInvite({ joinToken: invite.token }),
    (error: any) => error.code === "NODE_AGENT_PAIRING_INVITE_INVALID",
  );
});

test("normalized URL replacement is unique and protects its pairing", (t) => {
  const { identity } = fixture(t, "url_unique");
  const first = identity.commitControlPlaneConnection(identity.stageControlPlaneConnection({ url: "https://control.example.test/" }));
  const replacement = identity.commitControlPlaneConnection(identity.stageControlPlaneConnection({ url: "https://control.example.test" }));
  assert.deepEqual(identity.listControlPlaneConnections().map((record) => record.id), [replacement.connection.id]);
  assert.equal(identity.listControlPlanePairings().some((record) => record.keyId === first.pairing.keyId), false);
  assert.throws(
    () => identity.deleteControlPlanePairing(replacement.pairing.keyId),
    (error: any) => error.code === "NODE_AGENT_PAIRING_IN_USE",
  );
});
