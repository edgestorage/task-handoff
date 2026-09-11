import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createControlPlaneDatabase } from "../src/control-plane/persistence/database/index.ts";
import { importLegacyP0Json, planLegacyP0Migration } from "../src/control-plane/persistence/database/legacy-p0-import.ts";
import { controlPlaneStorePaths } from "../src/control-plane/persistence/paths.ts";
import { SecretEnvelopeService } from "../src/control-plane/persistence/secret-envelope.ts";
import { ControlPlaneSecretBox } from "../src/control-plane/auth/secret-box.ts";
import { ControlPlaneModelRepository } from "../src/control-plane/models/repository.ts";
import { ControlPlaneNodeRepository } from "../src/control-plane/nodes/repository.ts";
import { ControlPlaneChatRepository } from "../src/control-plane/chat/bridges/repository.ts";
import { ControlPlaneGitRepository } from "../src/control-plane/git-credentials/repository.ts";

// Compatibility for v0.0.28: the fixture is retained to verify the supported
// one-time upgrade path, not as a current persistence format.
const fixturePath = path.resolve("test/fixtures/v0.0.28-control-plane-p0-baseline.json");

function write(directory: string, record: { id: string }) {
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, `${record.id}.json`), `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
}

type MaterializeOptions = {
  orphanBridge?: boolean;
  duplicateChatRoute?: boolean;
  orphanCredential?: boolean;
  corruptGitSecret?: boolean;
  invalidAssignmentRevision?: boolean;
  invalidAssignmentIdentity?: boolean;
  unknownChatField?: boolean;
  invalidModel?: boolean;
};

function materialize(options: MaterializeOptions = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "control-plane-p0-import-"));
  const paths = controlPlaneStorePaths(root);
  const fixture = JSON.parse(fs.readFileSync(fixturePath, "utf8"));
  for (const record of fixture.nodes) write(paths.nodesDir, record);
  for (const record of fixture.pairingRevocations) write(paths.pendingPairingRevokesDir, record);
  for (const record of fixture.models) write(paths.modelsDir, options.invalidModel ? { ...record, endpoint: "" } : record);
  for (const record of fixture.chatBridges) write(paths.chatBridgesDir, options.unknownChatField && record.channel === "telegram"
    ? { ...record, settings: { ...record.settings, undeclaredCredential: "must-not-be-public" } }
    : record);
  for (const record of fixture.chatSessions) write(paths.chatSessionsDir, options.orphanBridge ? { ...record, bridgeId: "chat_missing" } : record);
  if (options.duplicateChatRoute) {
    const record = fixture.chatSessions[0];
    write(paths.chatSessionsDir, { ...record, id: `${record.id}_duplicate` });
  }
  const legacySecrets = new ControlPlaneSecretBox(paths.gitCredentialEncryptionKeyPath);
  legacySecrets.init();
  for (const record of fixture.gitCredentials) {
    const { secret, ...metadata } = record;
    write(paths.gitCredentialsDir, { ...metadata, secretCiphertext: options.corruptGitSecret ? "v1.invalid" : legacySecrets.seal(JSON.stringify(secret)) });
  }
  for (const record of fixture.gitAssignments) write(paths.gitCredentialAssignmentsDir, {
    ...record,
    ...(options.orphanCredential ? { credentialId: "gitcred_missing" } : {}),
    ...(options.invalidAssignmentRevision ? { assignmentRevision: -1 } : {}),
    ...(options.invalidAssignmentIdentity ? { instanceId: "instance_other" } : {}),
  });
  for (const record of fixture.gitProvisioningIntents) write(paths.gitCredentialProvisioningIntentsDir, record);
  for (const record of fixture.gitAudit) write(paths.gitCredentialAuditDir, record);
  return { root, paths };
}

test("v0.0.28 P0 migration plans, imports, projects, and replays without exposing secrets", async () => {
  const current = materialize();
  const database = await createControlPlaneDatabase(current.paths);
  const secrets = new SecretEnvelopeService(current.paths.databaseEncryptionKeyPath);
  secrets.init();
  try {
    const plan = planLegacyP0Migration(current.paths);
    assert.equal(plan.nodes.length, 1);
    assert.equal(plan.models[0]?.protocols[0], "openai-responses");
    assert.equal(plan.models[0]?.modelNames[0]?.name, "gpt-legacy");
    assert.ok(plan.warnings.some((warning) => warning.domain === "nodes" && warning.field === "futureServerField"));
    assert.ok(plan.warnings.some((warning) => warning.domain === "models" && warning.field === "futureServerField"));
    assert.deepEqual(plan.sources.find((source) => source.recordId === "instance_legacy:gitcred_legacy"), {
      domain: "git-assignments",
      file: "instance_legacy:gitcred_legacy.json",
      recordId: "instance_legacy:gitcred_legacy",
      relatedIds: ["gitcred_legacy", "instance_legacy"],
    });

    const result = await importLegacyP0Json(database, secrets, current.paths, { archive: false });
    assert.equal(result.imported, true);
    const nodes = new ControlPlaneNodeRepository(database, secrets);
    const models = new ControlPlaneModelRepository(database, secrets);
    const chat = new ControlPlaneChatRepository(database, secrets);
    const git = new ControlPlaneGitRepository(database, secrets);
    assert.equal((await nodes.get("node_legacy"))?.status, "unknown");
    assert.equal((await nodes.get("node_legacy"))?.auth.pairing?.joinToken, undefined);
    assert.equal((await models.get("model_legacy"))?.key, "legacy-model-key");
    assert.equal((await chat.getBridge("chat_dingding_legacy"))?.settings.clientSecret, "dingding-client-secret");
    assert.equal((await git.getCredentialEntity("gitcred_legacy"))?.secret.kind, "https-token");
    const ledger = await database.migration("app_0001_import_v0.0.28_p0_json");
    assert.equal(ledger?.details.sourceVersion, "v0.0.28");
    assert.doesNotMatch(JSON.stringify(ledger), /legacy-(?:node|model|git|revoke)|dingding-client-secret|telegram-token/);
    assert.equal((await importLegacyP0Json(database, secrets, current.paths, { archive: false })).imported, false);
  } finally {
    await database.close();
    fs.rmSync(current.root, { recursive: true, force: true });
  }
});

for (const failure of [
  { name: "orphan Chat bridge", options: { orphanBridge: true }, code: "CONTROL_PLANE_P0_MIGRATION_ORPHAN_REFERENCE" },
  { name: "duplicate Chat route", options: { duplicateChatRoute: true }, code: "CONTROL_PLANE_P0_MIGRATION_IDENTITY_CONFLICT" },
  { name: "orphan Git credential", options: { orphanCredential: true }, code: "CONTROL_PLANE_P0_MIGRATION_ORPHAN_REFERENCE" },
  { name: "invalid legacy Git secret", options: { corruptGitSecret: true }, code: "CONTROL_PLANE_P0_MIGRATION_SECRET_INVALID" },
  { name: "invalid assignment revision", options: { invalidAssignmentRevision: true }, code: "CONTROL_PLANE_P0_MIGRATION_RECORD_INVALID" },
  { name: "inconsistent assignment identity", options: { invalidAssignmentIdentity: true }, code: "CONTROL_PLANE_P0_MIGRATION_IDENTITY_CONFLICT" },
  { name: "undeclared Chat credential field", options: { unknownChatField: true }, code: "CHAT_BRIDGE_SETTINGS_UNSUPPORTED" },
  { name: "missing required Model field", options: { invalidModel: true }, code: "CONTROL_PLANE_P0_MIGRATION_RECORD_INVALID" },
]) test(`v0.0.28 P0 migration rejects ${failure.name} before writing`, async () => {
  const current = materialize(failure.options);
  const database = await createControlPlaneDatabase(current.paths);
  const secrets = new SecretEnvelopeService(current.paths.databaseEncryptionKeyPath);
  secrets.init();
  try {
    await assert.rejects(() => importLegacyP0Json(database, secrets, current.paths, { archive: false }), (error: any) => error.code === failure.code);
    assert.equal((await database.nodes.list()).length, 0);
    assert.equal((await database.models.list()).length, 0);
    assert.equal(await database.migration("app_0001_import_v0.0.28_p0_json"), undefined);
  } finally {
    await database.close();
    fs.rmSync(current.root, { recursive: true, force: true });
  }
});

test("v0.0.28 P0 migration rejects a non-empty target without a ledger", async () => {
  const current = materialize();
  const database = await createControlPlaneDatabase(current.paths);
  const secrets = new SecretEnvelopeService(current.paths.databaseEncryptionKeyPath);
  secrets.init();
  try {
    await new ControlPlaneNodeRepository(database, secrets).put(planLegacyP0Migration(current.paths).nodes[0]!);
    await assert.rejects(
      () => importLegacyP0Json(database, secrets, current.paths, { archive: false }),
      (error: any) => error.code === "CONTROL_PLANE_P0_MIGRATION_TARGET_NOT_EMPTY",
    );
    assert.equal(await database.migration("app_0001_import_v0.0.28_p0_json"), undefined);
  } finally {
    await database.close();
    fs.rmSync(current.root, { recursive: true, force: true });
  }
});

test("v0.0.28 P0 migration rolls back all records when the import transaction fails", async () => {
  const current = materialize();
  const database = await createControlPlaneDatabase(current.paths);
  const secrets = new SecretEnvelopeService(current.paths.databaseEncryptionKeyPath);
  secrets.init();
  const failing = {
    ...database,
    transaction: <T>(operation: Parameters<typeof database.transaction<T>>[0]) => database.transaction(async (transaction) => {
      await operation(transaction);
      throw Object.assign(new Error("injected transaction failure"), { code: "INJECTED_FAILURE" });
    }),
  };
  try {
    await assert.rejects(() => importLegacyP0Json(failing, secrets, current.paths, { archive: false }), /injected transaction failure/);
    assert.equal((await database.nodes.list()).length, 0);
    assert.equal((await database.chatBridges.list()).length, 0);
    assert.equal((await database.gitCredentials.list()).length, 0);
    assert.equal(await database.migration("app_0001_import_v0.0.28_p0_json"), undefined);
  } finally {
    await database.close();
    fs.rmSync(current.root, { recursive: true, force: true });
  }
});

test("committed migration rejects changed sources and recovers a failed archive", async () => {
  const current = materialize();
  const database = await createControlPlaneDatabase(current.paths);
  const secrets = new SecretEnvelopeService(current.paths.databaseEncryptionKeyPath);
  secrets.init();
  const archiveTime = new Date("2026-08-02T03:04:05.000Z");
  const archive = path.join(current.paths.dataDir, "retired-persistence", "v0.0.28-control-plane-p0-2026-08-02T03-04-05-000Z");
  try {
    fs.mkdirSync(path.dirname(archive), { recursive: true });
    fs.writeFileSync(archive, "archive collision");
    const warnings: Record<string, unknown>[] = [];
    await importLegacyP0Json(database, secrets, current.paths, { now: () => archiveTime, onWarning: (warning) => warnings.push(warning) });
    assert.ok(warnings.some((warning) => warning.code === "CONTROL_PLANE_P0_ARCHIVE_FAILED"));
    assert.ok(fs.existsSync(current.paths.nodesDir));

    const nodePath = path.join(current.paths.nodesDir, "node_legacy.json");
    const changed = JSON.parse(fs.readFileSync(nodePath, "utf8"));
    fs.writeFileSync(nodePath, `${JSON.stringify({ ...changed, changedAfterImport: true }, null, 2)}\n`);
    await assert.rejects(
      () => importLegacyP0Json(database, secrets, current.paths, { archive: false }),
      (error: any) => error.code === "CONTROL_PLANE_P0_MIGRATION_SOURCE_CONFLICT",
    );

    delete changed.changedAfterImport;
    fs.writeFileSync(nodePath, `${JSON.stringify(changed, null, 2)}\n`);
    fs.unlinkSync(archive);
    assert.equal((await importLegacyP0Json(database, secrets, current.paths, { now: () => archiveTime })).imported, false);
    assert.equal(fs.existsSync(current.paths.nodesDir), false);
    assert.equal((await database.nodes.list()).length, 1);
    assert.equal(fs.statSync(path.dirname(archive)).mode & 0o777, 0o700);
    assert.equal(fs.statSync(archive).mode & 0o777, 0o700);
    const archivedNodeDirectory = path.join(archive, path.basename(current.paths.nodesDir));
    assert.equal(fs.statSync(archivedNodeDirectory).mode & 0o777, 0o700);
    assert.equal(fs.statSync(path.join(archivedNodeDirectory, "node_legacy.json")).mode & 0o777, 0o600);
  } finally {
    await database.close();
    fs.rmSync(current.root, { recursive: true, force: true });
  }
});
