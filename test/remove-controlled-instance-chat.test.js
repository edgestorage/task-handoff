const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

function sourceTree(relativeDirectory) {
  const directory = path.join(root, relativeDirectory);
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const relativePath = path.join(relativeDirectory, entry.name);
    return entry.isDirectory() ? sourceTree(relativePath) : [[relativePath, read(relativePath)]];
  });
}

test("legacy receiver CLI and package are removed", () => {
  assert.equal(fs.existsSync(path.join(root, "packages/receiver-worker")), false);
  assert.equal(fs.existsSync(path.join(root, "packages/protocol/src/sender.ts")), false);
  assert.equal(fs.existsSync(path.join(root, "apps/cli/src/mcp")), false);
  assert.equal(fs.existsSync(path.join(root, "apps/cli/src/hooks")), false);
  assert.equal(fs.existsSync(path.join(root, "bin/result-ipc.js")), false);
  assert.equal(fs.existsSync(path.join(root, "packages/terminal-ui/package.json")), false);
  assert.equal(fs.existsSync(path.join(root, "packages/terminal-ui/src/index.ts")), false);

  const rootManifest = JSON.parse(read("package.json"));
  const cliManifest = JSON.parse(read("apps/cli/package.json"));
  const cliSource = read("apps/cli/src/index.ts");
  const rollupSource = read("rollup.config.mjs");
  const lockfile = read("pnpm-lock.yaml");

  assert.deepEqual(rootManifest.bin, { "task-handoff": "bin/task-handoff.js" });
  assert.equal(cliManifest.dependencies?.["@task-handoff/receiver-worker"], undefined);
  assert.equal(cliManifest.dependencies?.["@task-handoff/terminal-ui"], undefined);
  assert.doesNotMatch(cliSource, /\.command\("(?:receiver|send|mcp|codex-approval-hook|claude-approval-hook)"\)/);
  assert.doesNotMatch(rollupSource, /receiver-worker|receiver-ink|protocol\/src\/sender|apps\/cli\/src\/(?:mcp|hooks)/);
  assert.doesNotMatch(lockfile, /receiver-worker|ink-text-input|react-ink-textarea/);
});

test("controlled instance runtime and image have no chat runtime dependency", async () => {
  const controlledManifest = JSON.parse(read("packages/controlled-instance/package.json"));
  const imageManifest = JSON.parse(read("apps/controlled-instance-image/package.json"));
  for (const manifest of [controlledManifest, imageManifest]) {
    assert.equal(manifest.dependencies?.["@task-handoff/receiver-worker"], undefined);
    assert.equal(manifest.dependencies?.["write-file-atomic"], undefined);
  }

  const controlledSources = [
    ...sourceTree("packages/controlled-instance/src"),
    ...sourceTree("apps/controlled-instance-image/src"),
  ];
  for (const [file, source] of controlledSources) {
    assert.doesNotMatch(source, /@task-handoff\/receiver-worker|integrations\/(telegram|dingding|wechat)|channelsDir|conversationsDir/, file);
  }

  const { runtimePackages } = await import("../runtime-packages.config.mjs");
  const dependencies = runtimePackages["controlled-instance"].dependencies;
  assert.equal(dependencies["@task-handoff/receiver-worker"], undefined);
  assert.doesNotMatch(JSON.stringify(dependencies), /@task-handoff\/receiver-worker|dingding|wechat/);
});

test("controlled instance UI has no chat administration routes or API clients", () => {
  const router = read("packages/controlled-instance-ui/src/router/index.ts");
  const settings = read("packages/controlled-instance-ui/src/features/desktop/SettingsModal.vue");
  const queries = read("packages/controlled-instance-ui/src/api/queries.ts");
  const events = read("packages/controlled-instance-ui/src/stores/events.ts");

  assert.doesNotMatch(router, /channels|conversations|tasks|pending|settings-view/i);
  assert.match(router, /path:\s*"\/:pathMatch\(\.\*\)\*"/);
  assert.doesNotMatch(settings, />\s*(Channels|Conversations|Tasks)\s*</);
  assert.doesNotMatch(queries, /\/api\/(receiver|channels|conversations|tasks|settings)(?:\/|"|`)/);
  assert.doesNotMatch(events, /receiver\.|channel\./);

  const aiSessionDetail = read("packages/controlled-instance-ui/src/features/desktop/AiSessionDetail.vue");
  assert.match(aiSessionDetail, /queue\.pendingCount/);
});

test("node-agent subscribes only to instance and authoritative session topics", () => {
  const forwarder = read("packages/control-plane/src/node-agent/events.ts");
  assert.match(forwarder, /topics:\s*\[AiSessionEventTopic,\s*"app\.sessions",\s*"apps",\s*"instances"\]/);
  assert.doesNotMatch(forwarder, /topics:\s*\[[^\]]*"receiver"/);
});
