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
  const forwarder = read("packages/control-plane/src/node-agent-events.ts");
  assert.match(forwarder, /topics:\s*\[AiSessionEventTopic,\s*"app\.sessions",\s*"instances"\]/);
  assert.doesNotMatch(forwarder, /topics:\s*\[[^\]]*"receiver"/);
});
