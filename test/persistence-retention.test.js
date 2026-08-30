const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { once } = require("node:events");

const { controlPlaneStorePaths } = require("../packages/control-plane/src/control-plane/persistence/paths.ts");
const { createControlPlaneApp } = require("../packages/control-plane/src/server.ts");
const { ControlPlanePersistenceMaintenance } = require("../packages/control-plane/src/control-plane/persistence/maintenance.ts");
const { NodeAgentIdentityService } = require("../packages/control-plane/src/node-agent/identity/service.ts");
const { nodeAgentStorePaths } = require("../packages/control-plane/src/node-agent/persistence/paths.ts");
const { NodeAgentPersistenceMaintenance } = require("../packages/control-plane/src/node-agent/persistence/maintenance.ts");
const { EphemeralTokenStore } = require("../packages/control-plane/src/shared/security/ephemeral-token-store.ts");
const { copyTruncateOpenLog } = require("../packages/core/src/storage/open-log-retention.ts");
const { enforceInstanceLogBudget, RotatingLogWriter } = require("../packages/app-runtime/src/log-retention.ts");

function tempDir(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `task-handoff-${name}-`));
}

test("ephemeral token store expires records and consumes each key once", () => {
  const store = new EphemeralTokenStore();
  store.put("one", { expiresAt: "2026-08-22T00:00:10.000Z", value: 1 }, Date.parse("2026-08-22T00:00:00.000Z"));
  assert.equal(store.peek("one", Date.parse("2026-08-22T00:00:05.000Z")).value, 1);
  assert.equal(store.take("one", Date.parse("2026-08-22T00:00:05.000Z")).value, 1);
  assert.equal(store.take("one", Date.parse("2026-08-22T00:00:05.000Z")), undefined);

  store.put("expired", { expiresAt: "2026-08-22T00:00:10.000Z" }, Date.parse("2026-08-22T00:00:00.000Z"));
  assert.equal(store.peek("expired", Date.parse("2026-08-22T00:00:10.000Z")), undefined);
  assert.deepEqual(store.list(Date.parse("2026-08-22T00:00:10.000Z")), []);
});

test("temporary node-agent pairing invites never enter identity persistence", () => {
  const paths = nodeAgentStorePaths(tempDir("memory-pairing-invite"));
  const legacyTimestamp = new Date().toISOString();
  fs.mkdirSync(path.dirname(paths.identityPath), { recursive: true });
  fs.writeFileSync(paths.identityPath, JSON.stringify({
    nodeId: "node_invite",
    createdAt: legacyTimestamp,
    updatedAt: legacyTimestamp,
    pairingInvites: [{ tokenHash: "legacy", createdAt: legacyTimestamp, expiresAt: new Date(Date.now() + 60_000).toISOString() }],
    controlPlanePairings: [],
    controlPlaneConnections: [],
  }));

  const first = new NodeAgentIdentityService(paths);
  const invite = first.createPairingInvite({});
  const persisted = JSON.parse(fs.readFileSync(paths.identityPath, "utf8"));
  assert.equal(persisted.pairingInvites, undefined);
  assert.throws(
    () => new NodeAgentIdentityService(paths).completePairingInvite({ joinToken: invite.token }),
    (error) => error.code === "NODE_AGENT_PAIRING_INVITE_INVALID",
  );
});

test("control-plane join invites are memory-only and expire on restart", async (t) => {
  const dataDir = tempDir("memory-node-join-invite");
  const first = await createControlPlaneApp({ dataDir, logger: false, staticDir: path.join(dataDir, "missing-ui") });
  const created = await first.inject({ method: "POST", url: "/api/node-join/invites", payload: {} });
  assert.equal(created.statusCode, 201, created.body);
  const joinToken = created.json().data.joinToken;
  assert.equal(fs.existsSync(path.join(dataDir, "node-join-invites")), false);
  await first.close();

  const restarted = await createControlPlaneApp({ dataDir, logger: false, staticDir: path.join(dataDir, "missing-ui") });
  t.after(() => restarted.close());
  const completed = await restarted.inject({
    method: "POST",
    url: "/api/node-join/complete",
    payload: {
      joinToken,
      nodeId: "node_after_restart",
      keyId: "key_after_restart",
      secret: "secret-after-restart",
    },
  });
  assert.equal(completed.statusCode, 401, completed.body);
  assert.equal(completed.json().error.code, "NODE_JOIN_TOKEN_INVALID");
});

test("control-plane maintenance removes invites and retires redacted legacy projections", () => {
  const paths = controlPlaneStorePaths(tempDir("control-plane-retention"));
  const nodeJoinInvitesDir = path.join(paths.dataDir, "node-join-invites");
  const controlledInstancesDir = path.join(paths.dataDir, "controlled-instances");
  const nodeRuntimesDir = path.join(paths.dataDir, "node-runtimes");
  fs.mkdirSync(nodeJoinInvitesDir, { recursive: true });
  fs.writeFileSync(path.join(nodeJoinInvitesDir, "invite.json"), JSON.stringify({ tokenHash: "secret" }));
  fs.mkdirSync(controlledInstancesDir, { recursive: true });
  fs.writeFileSync(path.join(controlledInstancesDir, "inst_old.json"), JSON.stringify({
    id: "inst_old",
    registrationToken: "must-not-survive",
    updatedAt: new Date(0).toISOString(),
  }));
  fs.writeFileSync(path.join(controlledInstancesDir, "inst_old.pre-cleanup.bak"), JSON.stringify({ id: "inst_old", registrationToken: "backup-secret" }));
  fs.mkdirSync(nodeRuntimesDir, { recursive: true });
  fs.writeFileSync(path.join(nodeRuntimesDir, "runtime_old.json"), JSON.stringify({ id: "runtime_old" }));

  const maintenance = new ControlPlanePersistenceMaintenance(paths, { now: () => 1_000, retentionMs: 500 });
  maintenance.run();
  assert.equal(fs.existsSync(nodeJoinInvitesDir), false);
  assert.equal(fs.existsSync(controlledInstancesDir), false);
  const retiredRoot = path.join(paths.dataDir, "retired-persistence");
  const retiredInstanceDir = fs.readdirSync(retiredRoot).find((name) => name.endsWith("-controlled-instances"));
  const retired = JSON.parse(fs.readFileSync(path.join(retiredRoot, retiredInstanceDir, "inst_old.json"), "utf8"));
  assert.equal(retired.registrationToken, undefined);
  const retiredBackup = JSON.parse(fs.readFileSync(path.join(retiredRoot, retiredInstanceDir, "inst_old.pre-cleanup.bak"), "utf8"));
  assert.equal(retiredBackup.registrationToken, undefined);

  new ControlPlanePersistenceMaintenance(paths, { now: () => 1_501, retentionMs: 500 }).run();
  assert.deepEqual(fs.readdirSync(retiredRoot), []);
});

test("node-agent maintenance retains active data and ages orphan data through trash", (t) => {
  const paths = nodeAgentStorePaths(tempDir("node-agent-retention"));
  const root = path.join(paths.dataDir, "local-instances");
  fs.mkdirSync(path.join(root, "inst_active"), { recursive: true });
  fs.mkdirSync(path.join(root, "inst_orphan"), { recursive: true });
  const external = tempDir("external-workspace");
  if (process.platform !== "win32") {
    fs.symlinkSync(external, path.join(root, "inst_link"));
  }

  new NodeAgentPersistenceMaintenance(paths, { now: () => 2_000, retentionMs: 500 }).run(["inst_active"]);
  assert.equal(fs.existsSync(path.join(root, "inst_active")), true);
  assert.equal(fs.existsSync(path.join(root, "inst_orphan")), false);
  assert.equal(fs.existsSync(external), true);
  if (process.platform !== "win32") assert.equal(fs.lstatSync(path.join(root, "inst_link")).isSymbolicLink(), true);

  new NodeAgentPersistenceMaintenance(paths, { now: () => 2_501, retentionMs: 500 }).run(["inst_active"]);
  assert.deepEqual(fs.readdirSync(path.join(paths.dataDir, "local-instances-trash")), []);
});

test("node-agent maintenance copy-truncates its open process logs", () => {
  const paths = nodeAgentStorePaths(tempDir("node-agent-open-logs"));
  fs.mkdirSync(paths.logsDir, { recursive: true });
  const outPath = path.join(paths.logsDir, "node-agent.out.log");
  const errPath = path.join(paths.logsDir, "node-agent.err.log");
  fs.writeFileSync(outPath, "o".repeat(10 * 1024 * 1024 + 1));
  fs.writeFileSync(errPath, "error\n");

  const maintenance = new NodeAgentPersistenceMaintenance(paths);
  assert.deepEqual(maintenance.capNodeAgentLogs(), [outPath]);
  assert.equal(fs.statSync(outPath).size, 0);
  assert.equal(fs.statSync(path.join(paths.logsDir, "node-agent.out.1.log")).size, 10 * 1024 * 1024);
  assert.equal(fs.readFileSync(errPath, "utf8"), "error\n");
});

test("rotating log writer bounds each generation", async () => {
  const logPath = path.join(tempDir("rotating-log"), "tty.log");
  fs.writeFileSync(logPath, "z".repeat(100));
  const writer = new RotatingLogWriter(logPath, 32, 2);
  const finished = once(writer, "finish");
  writer.write("a".repeat(20));
  writer.write("b".repeat(20));
  writer.end("c".repeat(20));
  await finished;

  const files = fs.readdirSync(path.dirname(logPath)).sort();
  assert.deepEqual(files, ["tty.1.log", "tty.2.log", "tty.log"]);
  assert.ok(files.every((name) => fs.statSync(path.join(path.dirname(logPath), name)).size <= 32));
});

test("open process logs are copy-truncated and global budget preserves active current logs", () => {
  const root = tempDir("log-budget");
  const openLog = path.join(root, "controlled-instance.out.log");
  fs.writeFileSync(openLog, "0123456789".repeat(5));
  assert.equal(copyTruncateOpenLog(openLog, 16, 2), true);
  assert.equal(fs.statSync(openLog).size, 0);
  assert.equal(fs.readFileSync(path.join(root, "controlled-instance.out.1.log"), "utf8"), "4567890123456789");

  const budgetRoot = path.join(root, "budget");
  const active = path.join(budgetRoot, "app-sessions", "active");
  const inactive = path.join(budgetRoot, "app-sessions", "inactive");
  fs.mkdirSync(active, { recursive: true });
  fs.mkdirSync(inactive, { recursive: true });
  fs.writeFileSync(path.join(active, "tty.log"), "a".repeat(20));
  fs.writeFileSync(path.join(inactive, "tty.log"), "b".repeat(20));
  const deleted = enforceInstanceLogBudget(budgetRoot, [active], 30);
  assert.ok(deleted.includes(path.join(inactive, "tty.log")));
  assert.equal(fs.existsSync(path.join(active, "tty.log")), true);
});
