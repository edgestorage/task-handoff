const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { DatabaseSync } = require("node:sqlite");
const { nodeAgentStorePaths } = require("../packages/control-plane/src/node-agent/persistence/paths.ts");
const { nodeAgentMigrations } = require("../packages/control-plane/src/node-agent/persistence/migrations.ts");
const { openNodeAgentDatabaseSync } = require("../packages/control-plane/src/node-agent/persistence/database.ts");
const { NodeAgentState } = require("../packages/control-plane/src/node-agent/state.ts");
const { RuntimeAdapterRegistry } = require("../packages/control-plane/src/node-agent/runtimes/adapters.ts");

const WSL_RUNTIME_ID = "runtime_wsl_host";

function dataDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-wsl-publication-"));
}

function stateFor(dir, platform) {
  const state = new NodeAgentState(nodeAgentStorePaths(dir), "node_wsl", "http://127.0.0.1:8091", undefined, 8091, platform);
  state.init();
  return state;
}

function enableSwitch(dir) {
  fs.writeFileSync(path.join(dir, "runtime-settings.json"), `${JSON.stringify({
    version: 1,
    externalListener: { bindScope: "loopback", port: 8091 },
    wslRuntime: { enabled: true },
  }, null, 2)}\n`);
}

test("wsl runtime stays unpublished by default and on non-Windows hosts", (t) => {
  const dir = dataDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const windows = stateFor(dir, "win32");
  assert.equal(windows.nodeRuntimes.get(WSL_RUNTIME_ID), undefined);
  // feature/windows 起 win32 也发布进程式 Local Runtime；WSL 仍需节点级开关。
  assert.ok(windows.nodeRuntimes.get("runtime_local_host"));
  assert.ok(windows.nodeRuntimes.get("runtime_local_docker"));

  const linuxDir = dataDir();
  t.after(() => fs.rmSync(linuxDir, { recursive: true, force: true }));
  enableSwitch(linuxDir);
  const linux = stateFor(linuxDir, "linux");
  assert.equal(linux.nodeRuntimes.get(WSL_RUNTIME_ID), undefined);
  assert.ok(linux.nodeRuntimes.get("runtime_local_host"));
});

test("wsl runtime publishes on win32 when the node-level switch is enabled", (t) => {
  const dir = dataDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  enableSwitch(dir);

  const state = stateFor(dir, "win32");
  const runtime = state.nodeRuntimes.get(WSL_RUNTIME_ID);
  assert.ok(runtime, "expected the builtin wsl runtime to be published");
  assert.equal(runtime.type, "wsl");
  assert.equal(runtime.accessStrategy, "node-proxy");
  assert.equal(runtime.labels["task-handoff.node-agent.builtin"], "true");
  // 3.8：WSL 不要求 image，隔离级别为 distro，受管 artifact。
  assert.equal(runtime.capabilities.requiresImage, false);
  assert.equal(runtime.capabilities.isolation, "distro");
  assert.equal(runtime.capabilities.artifactKind, "bundled-runtime-artifact");
  assert.equal(runtime.capabilities.supportsContainerLifecycle, false);

  const registry = new RuntimeAdapterRegistry([{ type: "wsl", adapter: { resolveInstanceWeb: async () => "http://127.0.0.1:1" } }]);
  assert.ok(registry.forRuntime(runtime));

  // 重启后记录保持稳定（同一 runtimeId），不会重复创建。
  const restored = stateFor(dir, "win32");
  assert.equal(restored.nodeRuntimes.get(WSL_RUNTIME_ID).id, runtime.id);
  assert.equal(restored.nodeRuntimes.get(WSL_RUNTIME_ID).createdAt, runtime.createdAt);
});

test("the environment switch can force publication and disabling never deletes an existing record", (t) => {
  const dir = dataDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  process.env.TASK_HANDOFF_WSL_RUNTIME_ENABLED = "1";
  t.after(() => { delete process.env.TASK_HANDOFF_WSL_RUNTIME_ENABLED; });
  const enabled = stateFor(dir, "win32");
  assert.ok(enabled.nodeRuntimes.get(WSL_RUNTIME_ID));

  process.env.TASK_HANDOFF_WSL_RUNTIME_ENABLED = "0";
  const disabled = stateFor(dir, "win32");
  // D14 kill switch：关闭只停新建/发布，存量记录保留（不静默删除）。
  assert.ok(disabled.nodeRuntimes.get(WSL_RUNTIME_ID));
});

test("an existing database is upgraded in place and keeps runtime references", (t) => {
  const dir = dataDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const paths = nodeAgentStorePaths(dir);
  const timestamp = "2026-01-01T00:00:00.000Z";

  // 模拟 0016 之前的库：应用 0001..0015 并写入 ledger，再写入一个被实例引用的 runtime。
  const legacy = new DatabaseSync(paths.databasePath);
  legacy.exec("PRAGMA foreign_keys = ON");
  legacy.exec(`CREATE TABLE na_migration_ledger (
    id TEXT PRIMARY KEY NOT NULL, checksum TEXT NOT NULL, applied_at TEXT NOT NULL, details TEXT NOT NULL
  )`);
  const record = legacy.prepare("INSERT INTO na_migration_ledger VALUES (?, ?, ?, ?)");
  for (const migration of nodeAgentMigrations.filter((candidate) => candidate.id !== "0016_runtime_type_wsl")) {
    legacy.exec(migration.sql);
    record.run(migration.id, migration.checksum, timestamp, "{}");
  }
  legacy.prepare("INSERT INTO na_node_identity (node_id, created_at, updated_at) VALUES (?, ?, ?)").run("node_upgrade", timestamp, timestamp);
  legacy.prepare(`INSERT INTO na_runtimes (id, node_id, name, type, status, access_strategy, capabilities_json, labels_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run("runtime_local_host", "node_upgrade", "Local Runtime", "local", "unknown", "node-proxy", "{}", "{}", timestamp, timestamp);
  legacy.prepare(`INSERT INTO na_instances (id, node_id, runtime_id, name, status, desired_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run("inst_legacy", "node_upgrade", "runtime_local_host", "legacy", "stopped", "{}", timestamp, timestamp);
  legacy.close();

  // 打开时自动应用 0016（表重建型迁移），既有数据与 FK 必须完好。
  const upgraded = openNodeAgentDatabaseSync(paths);
  t.after(() => upgraded.close());
  assert.deepEqual(upgraded.client.prepare("PRAGMA foreign_key_check").all(), []);
  assert.equal(upgraded.client.prepare("SELECT node_id FROM na_runtimes WHERE id = 'runtime_local_host'").get().node_id, "node_upgrade");
  assert.equal(upgraded.client.prepare("SELECT runtime_id FROM na_instances WHERE id = 'inst_legacy'").get().runtime_id, "runtime_local_host");
  // CHECK 已扩展，`wsl` 现在可写入；FK 与 RESTRICT 语义保持。
  upgraded.client.prepare(`INSERT INTO na_runtimes (id, node_id, name, type, status, access_strategy, capabilities_json, labels_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run("runtime_wsl_host", "node_upgrade", "WSL", "wsl", "unknown", "node-proxy", "{}", "{}", timestamp, timestamp);
  assert.throws(() => upgraded.client.prepare("DELETE FROM na_runtimes WHERE id = 'runtime_local_host'").run(), /FOREIGN KEY constraint failed/);
});
