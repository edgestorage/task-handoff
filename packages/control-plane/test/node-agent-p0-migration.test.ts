import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createNodeAgentApp } from "../src/node-agent/app.ts";
import { openNodeAgentDatabaseSync } from "../src/node-agent/persistence/database.ts";
import { nodeAgentStorePaths } from "../src/node-agent/persistence/paths.ts";
import { createNodeAgentHmacHeaders } from "../src/shared/security/node-agent-auth.ts";

// Compatibility for v0.0.28: retain this fixture for the supported N-1 JSON upgrade path.
const fixturePath = path.resolve(import.meta.dirname, "../../../test/fixtures/v0.0.28-node-agent-p0.json");

function writeFixture(dataDir: string, mutate: (fixture: any) => void = () => {}) {
  const fixture = JSON.parse(fs.readFileSync(fixturePath, "utf8"));
  mutate(fixture);
  const paths = nodeAgentStorePaths(dataDir);
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(paths.identityPath, JSON.stringify(fixture.identity));
  const collections: Array<[string, string, any[]]> = [
    [paths.localFoldersDir, "id", fixture.localFolders],
    [paths.nodeRuntimesDir, "id", fixture.runtimes],
    [paths.controlledInstancesDir, "id", fixture.instances],
    [paths.instancePrivateConfigsDir, "instanceId", fixture.privateConfigs],
    [paths.nodeModelsDir, "id", fixture.models],
    [paths.modelAssignmentsDir, "instanceId", fixture.modelAssignments],
    [paths.gitCredentialPayloadsDir, "id", fixture.gitPayloads],
    [paths.gitCredentialAssignmentsDir, "id", fixture.gitAssignments],
    [paths.gitCredentialAuthorizationSetsDir, "instanceId", fixture.gitAuthorizations || []],
    [paths.gitWorkspaceProvisioningIntentsDir, "id", fixture.gitProvisioning],
  ];
  for (const [directory, key, records] of collections) {
    fs.mkdirSync(directory, { recursive: true });
    for (const record of records) fs.writeFileSync(path.join(directory, `${record[key]}.json`), JSON.stringify(record));
  }
  const modelEnvironments = fixture.modelEnvironments || {};
  if (Object.keys(modelEnvironments).length) {
    fs.mkdirSync(paths.modelEnvironmentsDir, { recursive: true });
    for (const [instanceId, environment] of Object.entries(modelEnvironments)) {
      fs.writeFileSync(path.join(paths.modelEnvironmentsDir, `${instanceId}.json`), JSON.stringify(environment));
    }
  }
  return paths;
}

test("v0.0.28 P0 JSON migrates atomically into SQLite and runtime projections", async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-p0-migration-"));
  const paths = writeFixture(dataDir);
  const app = await createNodeAgentApp({ dataDir, nodeId: "node_v028", token: "test", logger: false });
  t.after(async () => { await app.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });

  const state = app.nodeAgentState!;
  assert.equal(state.localFolders.get("folder_v028")?.path, "/workspace/v028");
  assert.equal(state.nodeRuntimes.get("runtime_v028")?.nodeId, "node_v028");
  assert.equal(state.requireInstance("instance_v028").registrationToken, "instance-secret-v028");
  assert.equal(state.modelRegistry.resolvedEnvironment("instance_v028").OPENAI_API_KEY, "model-secret-v028");
  assert.deepEqual(state.gitCredentials.getAuthorizationSet("instance_v028").credentialIds, ["gitcred_v028"]);
  assert.equal(state.gitCredentials.getAuthorizationSet("instance_v028").generation, 9);
  assert.equal(state.gitCredentials.getWorkspaceProvisioning("instance_v028")?.operationId, "gitop_v028");
  assert.deepEqual(app.nodeAgentIdentityService?.listControlPlaneConnections().map((item) => item.url), ["https://control.example.test"]);

  const verify = new DatabaseSync(paths.databasePath, { readOnly: true });
  const migration = verify.prepare("SELECT details FROM na_migration_ledger WHERE id = ?").get("1000_import_v0_0_28_p0") as { details: string };
  assert.equal(JSON.stringify(migration).includes("git-secret-v028"), false);
  assert.equal(JSON.parse(migration.details).counts.instances, 1);
  verify.close();
  const publicResponses = await Promise.all([
    "/api/node-agent/models",
    "/api/node-agent/control-plane-pairings",
    "/api/node-agent/control-plane-connections",
    "/api/node-agent/instances/instance_v028/git-credential-authorizations",
  ].map((url) => app.inject({
    method: "GET",
    url,
    headers: createNodeAgentHmacHeaders({
      nodeId: "node_v028",
      keyId: "key_v028",
      secret: "pairing-secret-v028",
      method: "GET",
      pathWithQuery: url,
    }),
  })));
  assert.equal(publicResponses.every((response) => response.statusCode === 200), true);
  const publicAndDiagnosticText = JSON.stringify({
    responses: publicResponses.map((response) => response.json()),
    migration: JSON.parse(migration.details),
  });
  for (const secret of ["pairing-secret-v028", "model-secret-v028", "git-secret-v028", "operation-secret-v028", "must-not-migrate"]) {
    assert.equal(publicAndDiagnosticText.includes(secret), false, `${secret} leaked through a public projection or migration detail`);
  }
  assert.equal(fs.existsSync(paths.identityPath), false);
  assert.equal(fs.existsSync(`${paths.identityPath}.migrated-v0.0.28`), true);
  assert.equal(fs.existsSync(paths.controlledInstancesDir), false);
  assert.equal(fs.existsSync(`${paths.controlledInstancesDir}.migrated-v0.0.28`), true);
  assert.equal(fs.readFileSync(paths.instancePrivateConfigsDir + "/instance_v028.json", "utf8").includes("instance-secret-v028"), true);
  assert.equal(fs.statSync(dataDir).mode & 0o777, 0o700);
  assert.equal(fs.statSync(paths.databasePath).mode & 0o777, 0o600);
  assert.equal(fs.statSync(`${paths.databasePath}-wal`).mode & 0o777, 0o600);
  assert.equal(fs.statSync(`${paths.databasePath}-shm`).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.join(paths.instancePrivateConfigsDir, "instance_v028.json")).mode & 0o777, 0o600);
});

test("invalid v0.0.28 P0 relation rolls back without exposing secrets", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-p0-migration-invalid-"));
  writeFixture(dataDir, (fixture) => { fixture.instances[0].runtimeId = "runtime_missing"; });
  try {
    await assert.rejects(
      () => createNodeAgentApp({ dataDir, nodeId: "node_v028", token: "test", logger: false }),
      (error: any) => error.code === "NODE_AGENT_DATABASE_STARTUP_FAILED"
        && error.details?.phase === "initialize"
        && !JSON.stringify(error).includes("git-secret-v028")
        && !JSON.stringify(error).includes("pairing-secret-v028"),
    );
    assert.equal(fs.existsSync(path.join(dataDir, "identity.json")), true);
  } finally { fs.rmSync(dataDir, { recursive: true, force: true }); }
});

test("v0.0.28 migration isolates unreadable instances and their dependent records", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-p0-migration-isolated-instance-"));
  const paths = writeFixture(dataDir);
  fs.writeFileSync(path.join(paths.controlledInstancesDir, "instance_v028.json"), "{\"id\":\"instance_v028\"");
  try {
    const app = await createNodeAgentApp({ dataDir, nodeId: "node_v028", token: "test", logger: false });
    assert.equal(app.nodeAgentState!.listInstances().length, 0);
    await app.close();

    const verify = new DatabaseSync(paths.databasePath, { readOnly: true });
    assert.equal(verify.prepare("SELECT COUNT(*) AS count FROM na_instances").get().count, 0);
    assert.equal(verify.prepare("SELECT COUNT(*) AS count FROM na_instance_model_assignments").get().count, 0);
    const migration = verify.prepare("SELECT details FROM na_migration_ledger WHERE id = ?")
      .get("1000_import_v0_0_28_p0") as { details: string };
    assert.equal(JSON.parse(migration.details).counts.instances, 0);
    assert.equal(JSON.parse(migration.details).warningCount >= 3, true);
    verify.close();
    assert.equal(fs.existsSync(`${paths.controlledInstancesDir}.migrated-v0.0.28`), true);
  } finally { fs.rmSync(dataDir, { recursive: true, force: true }); }
});

test("v0.0.28 migration isolates stored models whose content hash does not match their id", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-p0-migration-isolated-model-"));
  const paths = writeFixture(dataDir, (fixture) => {
    fixture.models[0].endpoint = "https://changed.example.test/v1";
    fixture.modelAssignments = [];
    fixture.modelEnvironments = {};
  });
  try {
    const app = await createNodeAgentApp({ dataDir, nodeId: "node_v028", token: "test", logger: false });
    assert.equal(app.nodeAgentState!.modelRegistry.list().length, 0);
    await app.close();

    const verify = new DatabaseSync(paths.databasePath, { readOnly: true });
    const migration = verify.prepare("SELECT details FROM na_migration_ledger WHERE id = ?")
      .get("1000_import_v0_0_28_p0") as { details: string };
    assert.equal(JSON.parse(migration.details).counts.models, 0);
    assert.equal(JSON.parse(migration.details).warningCount >= 1, true);
    verify.close();
  } finally { fs.rmSync(dataDir, { recursive: true, force: true }); }
});

test("completed v0.0.28 migration never reimports late JSON on repeat startup", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-p0-migration-repeat-"));
  const paths = writeFixture(dataDir);
  try {
    const first = await createNodeAgentApp({ dataDir, nodeId: "node_v028", token: "test", logger: false });
    await first.close();
    fs.writeFileSync(paths.identityPath, JSON.stringify({
      nodeId: "node_late_json",
      createdAt: "2026-08-02T00:00:00.000Z",
      updatedAt: "2026-08-02T00:00:00.000Z",
      controlPlanePairings: [],
      controlPlaneConnections: [],
    }));

    const restarted = await createNodeAgentApp({ dataDir, nodeId: "node_v028", token: "test", logger: false });
    assert.equal(restarted.nodeAgentIdentityService?.resolveNodeId(), "node_v028");
    await restarted.close();
    assert.equal(fs.existsSync(paths.identityPath), false);
    assert.equal(fs.readdirSync(dataDir).filter((name) => name.startsWith("identity.json.migrated-v0.0.28")).length, 2);
  } finally { fs.rmSync(dataDir, { recursive: true, force: true }); }
});

test("committed migration retries a failed legacy archive without reimporting JSON", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-p0-migration-archive-retry-"));
  const paths = writeFixture(dataDir);
  const warnings: unknown[][] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => { warnings.push(args); };
  try {
    const database = openNodeAgentDatabaseSync(paths, {
      legacyMigration: { rename: () => { throw new Error("injected archive failure"); } },
    });
    await database.close();
    assert.equal(fs.existsSync(paths.identityPath), true);
    assert.equal(warnings.some((args) => String(args[0]).includes("archive failed")), true);

    const verifyCommitted = new DatabaseSync(paths.databasePath, { readOnly: true });
    assert.equal(verifyCommitted.prepare("SELECT COUNT(*) AS count FROM na_instances").get().count, 1);
    assert.equal(verifyCommitted.prepare("SELECT COUNT(*) AS count FROM na_migration_ledger WHERE id = ?").get("1000_import_v0_0_28_p0").count, 1);
    verifyCommitted.close();

    const restarted = openNodeAgentDatabaseSync(paths);
    await restarted.close();
    assert.equal(fs.existsSync(paths.identityPath), false);
    assert.equal(fs.existsSync(`${paths.identityPath}.migrated-v0.0.28`), true);
    const verifyRestarted = new DatabaseSync(paths.databasePath, { readOnly: true });
    assert.equal(verifyRestarted.prepare("SELECT COUNT(*) AS count FROM na_instances").get().count, 1);
    verifyRestarted.close();
  } finally {
    console.warn = originalWarn;
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("v0.0.28 application migration checksum mismatch blocks startup", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-p0-migration-checksum-"));
  const paths = writeFixture(dataDir);
  try {
    const first = openNodeAgentDatabaseSync(paths);
    await first.close();
    const corrupt = new DatabaseSync(paths.databasePath);
    corrupt.prepare("UPDATE na_migration_ledger SET checksum = ? WHERE id = ?").run("wrong-checksum", "1000_import_v0_0_28_p0");
    corrupt.close();
    assert.throws(
      () => openNodeAgentDatabaseSync(paths),
      (error: any) => error.code === "NODE_AGENT_DATABASE_STARTUP_FAILED" && /checksum mismatch/.test(error.message),
    );
  } finally { fs.rmSync(dataDir, { recursive: true, force: true }); }
});

test("v0.0.28 model environment creates a normalized SQLite assignment", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-p0-model-environment-"));
  const paths = writeFixture(dataDir, (fixture) => {
    delete fixture.models[0].modelNames;
    delete fixture.models[0].protocols;
    fixture.modelAssignments = [];
    fixture.modelEnvironments = {
      instance_v028: {
        OPENAI_API_KEY: "model-secret-v028",
        OPENAI_BASE_URL: "https://models.example.test/v1",
        CODEX_MODEL: "gpt-v028",
      },
    };
  });
  try {
    const app = await createNodeAgentApp({ dataDir, nodeId: "node_v028", token: "test", logger: false });
    const model = app.nodeAgentState!.modelRegistry.list()[0];
    assert.deepEqual(model.modelNames, [{ name: "gpt-v028", order: 0 }]);
    assert.deepEqual(model.protocols, ["openai-responses"]);
    assert.equal(app.nodeAgentState!.resolvedAssignedModelEnvironment("instance_v028").OPENAI_API_KEY, "model-secret-v028");
    await app.close();
    assert.equal(fs.existsSync(paths.modelEnvironmentsDir), false);
    assert.equal(fs.existsSync(`${paths.modelEnvironmentsDir}.migrated-v0.0.28`), true);
  } finally { fs.rmSync(dataDir, { recursive: true, force: true }); }
});

test("v0.0.28 migration preflights malformed, duplicate, and orphan records without secrets", async (t) => {
  const cases: Array<{ name: string; mutate: (fixture: any) => void; expected: string }> = [
    { name: "required field", mutate: (fixture) => { fixture.runtimes[0].name = ""; }, expected: "required field" },
    { name: "duplicate pairing id", mutate: (fixture) => {
      delete fixture.identity.remoteControlPlanes;
      const timestamp = "2026-08-01T00:00:00.000Z";
      fixture.identity.controlPlanePairings = [
        { id: "cp_one", keyId: "key_duplicate", secret: "secret-one", pairedAt: timestamp, updatedAt: timestamp },
        { id: "cp_two", keyId: "key_duplicate", secret: "secret-two", pairedAt: timestamp, updatedAt: timestamp },
      ];
      fixture.identity.controlPlaneConnections = [];
    }, expected: "duplicated" },
    { name: "orphan runtime", mutate: (fixture) => { fixture.instances[0].runtimeId = "runtime_missing"; }, expected: "missing runtime" },
    { name: "orphan model", mutate: (fixture) => { fixture.modelAssignments[0].modelEntityIds = ["model_missing"]; }, expected: "missing model" },
    { name: "orphan Git credential", mutate: (fixture) => { fixture.gitAssignments[0].credentialId = "gitcred_missing"; }, expected: "missing credential payload" },
    { name: "orphan private config", mutate: (fixture) => { fixture.privateConfigs[0].instanceId = "instance_missing"; }, expected: "missing instance" },
    { name: "orphan pairing", mutate: (fixture) => {
      delete fixture.identity.remoteControlPlanes;
      fixture.identity.controlPlanePairings = [];
      fixture.identity.controlPlaneConnections = [{
        id: "connection_orphan", pairingKeyId: "key_missing", url: "https://control.example.test",
        enabled: true, createdAt: "2026-08-01T00:00:00.000Z", updatedAt: "2026-08-01T00:00:00.000Z",
      }];
    }, expected: "missing pairing" },
  ];

  for (const item of cases) await t.test(item.name, async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-p0-migration-invalid-case-"));
    const paths = writeFixture(dataDir, item.mutate);
    try {
      await assert.rejects(
        () => createNodeAgentApp({ dataDir, nodeId: "node_v028", token: "test", logger: false }),
        (error: any) => error.code === "NODE_AGENT_DATABASE_STARTUP_FAILED"
          && error.cause?.code === "NODE_AGENT_LEGACY_MIGRATION_FAILED"
          && error.message.includes(item.expected)
          && !JSON.stringify(error).includes("git-secret-v028")
          && !JSON.stringify(error).includes("pairing-secret-v028"),
      );
      const verify = new DatabaseSync(paths.databasePath, { readOnly: true });
      assert.equal(verify.prepare("SELECT COUNT(*) AS count FROM na_instances").get().count, 0);
      assert.equal(verify.prepare("SELECT COUNT(*) AS count FROM na_migration_ledger WHERE id = ?").get("1000_import_v0_0_28_p0").count, 0);
      verify.close();
      assert.equal(fs.existsSync(paths.identityPath), true);
    } finally { fs.rmSync(dataDir, { recursive: true, force: true }); }
  });
});
