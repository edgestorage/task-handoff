import assert from "node:assert/strict";
import test from "node:test";
import { uninstallNodeAgent } from "../packages/control-plane/src/node-agent/uninstall.ts";

const unitPath = "/etc/systemd/system/task-handoff-node-agent.service";
const envPath = "/etc/task-handoff/node-agent.env";

function harness(options = {}) {
  const events = [];
  const existing = new Set([unitPath, envPath, "/var/lib/task-handoff/node-agent"]);
  const dependencies = {
    getuid: () => options.uid ?? 0,
    exists: (target) => existing.has(target),
    readText: (target) => {
      if (target === envPath) return "TASK_HANDOFF_NODE_AGENT_DATA_DIR=/var/lib/task-handoff/node-agent\nTASK_HANDOFF_NPM_COMMAND=/opt/node/bin/npm\n";
      if (target === unitPath) return options.unitContents || "ExecStart=/usr/local/bin/task-handoff-node-agent --data-dir /var/lib/task-handoff/node-agent\n";
      assert.fail(`unexpected read: ${target}`);
    },
    remove: (target, removeOptions) => {
      events.push(["remove", target, removeOptions]);
      existing.delete(target);
    },
    run: (command, args) => {
      events.push(["run", command, args]);
      return { status: options.commandStatus ?? 0, stderr: options.commandError || "" };
    },
    confirmDeleteData: async (dataDir) => {
      events.push(["confirm", dataDir]);
      return options.confirmDelete ?? false;
    },
    log: (message) => events.push(["log", message]),
  };
  return { dependencies, events };
}

test("node-agent uninstall removes owned service resources before asking and preserves data by default", async () => {
  const { dependencies, events } = harness();
  const result = await uninstallNodeAgent({}, dependencies);

  assert.deepEqual(result, { dataDir: "/var/lib/task-handoff/node-agent", dataDeleted: false });
  assert.deepEqual(events.slice(0, 5), [
    ["run", "systemctl", ["disable", "--now", "task-handoff-node-agent.service"]],
    ["remove", unitPath, { force: true }],
    ["run", "systemctl", ["daemon-reload"]],
    ["run", "/opt/node/bin/npm", ["uninstall", "--global", "@task-handoff/node-agent", "@task-handoff/controlled-instance"]],
    ["remove", envPath, { force: true }],
  ]);
  const confirmIndex = events.findIndex(([type]) => type === "confirm");
  const packageIndex = events.findIndex(([type, command]) => type === "run" && command === "/opt/node/bin/npm");
  assert.ok(confirmIndex > packageIndex);
  assert.equal(events.some(([type, target]) => type === "remove" && target === result.dataDir), false);
});

test("node-agent uninstall deletes data only after explicit confirmation", async () => {
  const { dependencies, events } = harness({ confirmDelete: true });
  const result = await uninstallNodeAgent({}, dependencies);

  assert.equal(result.dataDeleted, true);
  assert.deepEqual(events.at(-2), ["remove", result.dataDir, { recursive: true, force: true }]);
});

test("node-agent uninstall supports explicit non-interactive data choices", async () => {
  const kept = harness({ confirmDelete: true });
  assert.equal((await uninstallNodeAgent({ keepData: true }, kept.dependencies)).dataDeleted, false);
  assert.equal(kept.events.some(([type]) => type === "confirm"), false);

  const deleted = harness();
  assert.equal((await uninstallNodeAgent({ deleteData: true }, deleted.dependencies)).dataDeleted, true);
  assert.equal(deleted.events.some(([type]) => type === "confirm"), false);
});

test("node-agent uninstall refuses non-root execution before changing state", async () => {
  const { dependencies, events } = harness({ uid: 501 });
  await assert.rejects(uninstallNodeAgent({}, dependencies), /Run this command as root/);
  assert.deepEqual(events, []);
});

test("node-agent uninstall refuses a filesystem root data directory", async () => {
  const { dependencies, events } = harness();
  await assert.rejects(uninstallNodeAgent({ dataDir: "/", deleteData: true }, dependencies), /filesystem root/);
  assert.deepEqual(events, []);
});

test("node-agent uninstall does not remove a server-bundle-owned service", async () => {
  const { dependencies, events } = harness({
    unitContents: "ExecStart=/usr/local/bin/task-handoff node-agent --data-dir /var/lib/task-handoff/node-agent\n",
  });
  await assert.rejects(uninstallNodeAgent({}, dependencies), /not owned by a standalone Node Agent installation/);
  assert.deepEqual(events, []);
});
