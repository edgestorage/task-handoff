const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const { spawnPty } = require("../packages/core/src/core/pty.ts");

function terminalResult(proc) {
  let output = "";
  proc.onData((data) => {
    output += data;
  });
  return new Promise((resolve) => {
    proc.onExit((event) => resolve({ output, ...event }));
  });
}

test("Node runtime uses node-pty through the shared PTY contract", { timeout: 10_000 }, async () => {
  const proc = spawnPty(process.execPath, ["-e", "process.stdout.write('node-pty-ok')"], {
    cwd: root,
    cols: 80,
    rows: 24,
  });
  const result = await terminalResult(proc);
  assert.equal(proc.runtime, "node");
  assert.equal(proc.processGroupLeader, true);
  assert.equal(result.exitCode, 0);
  assert.match(result.output, /node-pty-ok/);
});

test("Bun runtime uses Bun.spawn terminal through the shared PTY contract", { timeout: 15_000, skip: !process.env.TASK_HANDOFF_TEST_BUN_BIN }, async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-bun-pty-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const script = path.join(directory, "probe.mjs");
  fs.writeFileSync(script, `
    import { spawnPty } from ${JSON.stringify(path.join(root, "packages/core/src/core/pty.ts"))};
    const chunks = [];
    const exits = [];
    const proc = spawnPty("/bin/sh", ["-c", "printf bun-pty-ok; sleep 30 & echo child=$!; wait"], {
      cwd: ${JSON.stringify(directory)}, cols: 81, rows: 25, env: { ...process.env },
    });
    proc.onData((data) => chunks.push(data));
    proc.onExit((event) => exits.push(event));
    await new Promise((resolve) => setTimeout(resolve, 250));
    proc.resize(100, 30);
    proc.kill("SIGTERM");
    await new Promise((resolve) => setTimeout(resolve, 250));
    process.stdout.write(JSON.stringify({ runtime: proc.runtime, group: proc.processGroupLeader, output: chunks.join(""), exits }));
  `);
  const result = spawnSync(process.env.TASK_HANDOFF_TEST_BUN_BIN, [script], { encoding: "utf8", env: { ...process.env } });
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.runtime, "bun");
  assert.equal(payload.group, true);
  assert.match(payload.output, /bun-pty-ok/);
  assert.deepEqual(payload.exits, [{ exitCode: 143, signal: "SIGTERM" }]);
});

test("private configuration decoding is runtime-independent", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-private-config-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const config = path.join(directory, "private-config.json");
  fs.writeFileSync(config, JSON.stringify({
    version: 1,
    instanceId: "instance_1",
    instanceCredential: "credential_1",
    environment: { CUSTOM_VALUE: "custom" },
    modelCatalog: { models: [] },
  }));
  const runtimes = [process.execPath, process.env.TASK_HANDOFF_TEST_BUN_BIN].filter(Boolean);
  for (const runtime of runtimes) {
    const result = spawnSync(runtime, [path.join(root, "docker/private-config.mjs"), config], { encoding: "utf8" });
    assert.equal(result.status, 0, `${runtime}: ${result.stderr}`);
    const values = Object.fromEntries(result.stdout.trim().split("\n").map((line) => {
      const [key, encoded] = line.split("\t");
      return [key, Buffer.from(encoded, "base64").toString("utf8")];
    }));
    assert.equal(values.CUSTOM_VALUE, "custom", runtime);
    assert.equal(values.TASK_HANDOFF_REGISTRATION_TOKEN, "credential_1", runtime);
    assert.equal(values.TASK_HANDOFF_INSTANCE_PRIVATE_CONFIG_PATH, config, runtime);
    assert.equal(values.TASK_HANDOFF_PRIVATE_MODEL_CATALOG_JSON, JSON.stringify({ models: [] }), runtime);
  }
});
