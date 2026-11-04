const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  normalizeControlledInstanceCapabilities,
  normalizeNodeAgentCapabilities,
  supportsControlledInstancePrivateModelCatalog,
  supportsNodeAiSessionFileAttachmentLimit,
  supportsNodeCodexManagedSettings,
} = require("../packages/protocol/src/control-plane.ts");

const REPO_ROOT = path.resolve(__dirname, "..");

function readSource(relativePath) {
  return fs.readFileSync(path.join(REPO_ROOT, relativePath), "utf8");
}

/**
 * This change deletes only the node-agent <-> controlled instance runtime
 * compatibility branches, because both sides are one internal version domain.
 * Every `Compatibility for v` site kept in that runtime domain must stay on the
 * preserved boundary list from the change design, so a new internal runtime
 * branch fails this guard instead of silently re-entering the codebase.
 */
const RETAINED_NODE_AGENT_COMPAT_SITES = new Map([
  ["packages/node-agent/src/app.ts", "客户端边界：实例能力未声明时不推送固定字段"],
  ["packages/node-agent/src/events.ts", "客户端边界：订阅方与事件信封协商"],
  ["packages/node-agent/src/identity/normalize.ts", "历史数据：node-agent 身份文档一次性导入"],
  ["packages/node-agent/src/instances/lifecycle-routes.ts", "客户端边界：可选的生命周期请求字段"],
  ["packages/node-agent/src/models/registry.ts", "历史数据与客户端边界：旧模型 id 与 assignment"],
  ["packages/node-agent/src/models/routes.ts", "客户端边界：旧控制面的严格响应解析"],
  ["packages/node-agent/src/node-update-controller.ts", "更新与救援链路"],
  ["packages/node-agent/src/persistence/legacy-migration.ts", "历史数据：P0 JSON 迁移"],
  ["packages/node-agent/src/persistence/migrations.ts", "历史数据：已发布行的可读性"],
  ["packages/node-agent/src/persistence/topology-repository.ts", "历史数据：P0 SQLite 实例快照的当前协议清洗"],
  ["packages/node-agent/src/runtimes/docker.ts", "历史数据与更新链路：卷标签迁移与 artifact 热替换"],
  ["packages/node-agent/src/schemas.ts", "客户端边界：旧控制面的可选字段"],
  ["packages/node-agent/src/stories/action-execution-service.ts", "历史数据：历史 Story Action"],
  ["packages/node-agent/src/stories/idle-retention.ts", "历史数据：缺失时间戳的旧会话"],
  ["packages/node-agent/src/stories/routes.ts", "客户端边界：管理上传响应"],
  ["packages/node-agent/src/updates.ts", "更新与救援链路"],
]);

const SCANNED_EXTENSIONS = new Set([".ts", ".tsx", ".cts", ".mts", ".js", ".jsx", ".cjs", ".mjs", ".vue", ".sh"]);

function collectCompatibilitySites(root) {
  const sites = new Map();
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === "dist" || entry.name.startsWith(".")) continue;
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(entryPath);
        continue;
      }
      if (!SCANNED_EXTENSIONS.has(path.extname(entry.name))) continue;
      const source = fs.readFileSync(entryPath, "utf8");
      if (!source.includes("Compatibility for v")) continue;
      sites.set(path.relative(REPO_ROOT, entryPath), source);
    }
  };
  visit(root);
  return sites;
}

test("client-boundary capability gates still treat absent fields as unsupported", () => {
  // control-plane, CLI and mobile clients upgrade independently from node-agent,
  // so capability documents still answer unsupported for every absent domain.
  assert.equal(supportsNodeCodexManagedSettings(undefined), false);
  assert.equal(supportsNodeAiSessionFileAttachmentLimit(undefined), false);
  assert.equal(supportsControlledInstancePrivateModelCatalog({}), false);
  assert.equal(normalizeNodeAgentCapabilities({ folderPlaces: true }).folderPlaces, true);
  assert.deepEqual(normalizeControlledInstanceCapabilities({}).features.modelRelay, { protocols: [], streaming: false });
});

test("preserved client-boundary and update-chain compatibility branches remain in place", () => {
  const expectations = [
    ["packages/control-plane/src/control-plane/instances/creator.ts", /supportsNodeAiSessionFileAttachmentLimit\(agentCapabilities\)/],
    ["packages/control-plane/src/control-plane/instances/creator.ts", /supportsNodeCodexManagedSettings\(agentCapabilities\)/],
    ["packages/control-plane/src/control-plane/instances/gateway.ts", /legacyProxyFailure/],
    ["packages/node-agent/src/app.ts", /Compatibility for older controlled instances: endpoint updates are additive/],
    ["packages/node-agent/src/events.ts", /AiSessionTransientSubscriptionSchema\.parse\(\{\}\)/],
    ["packages/node-agent/src/events.ts", /AiSessionHierarchyCapabilitiesSchema\.parse\(undefined\)/],
    ["packages/node-agent/src/instances/lifecycle-routes.ts", /gitWorkspaceProvisioning: GitWorkspaceProvisioningInputSchema\.optional\(\)/],
    ["packages/node-agent/src/models/registry.ts", /isModelEntityId\(input\.id\) \? input\.id : migratedModelEntityId\(input\.id\)/],
    ["packages/node-agent/src/schemas.ts", /defaultImageSelection: ImageSelectionSchema\.optional\(\)/],
    ["packages/node-agent/src/updates.ts", /export function resolveNodeAgentUpdateWorker/],
    ["packages/node-agent/src/runtimes/docker.ts", /Compatibility for v0\.0\.34: the controlled-instance artifact is hot-swapped/],
  ];
  for (const [file, pattern] of expectations) {
    assert.match(readSource(file), pattern, file);
  }
});

test("node-agent and control-plane historical data migrations remain readable", () => {
  const { migrateLegacyP0State } = require("../packages/node-agent/src/persistence/legacy-migration.ts");
  const { importLegacyP0Json, planLegacyP0Migration } = require("../packages/control-plane/src/control-plane/persistence/database/legacy-p0-import.ts");
  const { LegacyControlPlaneSecretReader } = require("../packages/control-plane/src/control-plane/persistence/legacy-secret-reader.ts");
  assert.equal(typeof migrateLegacyP0State, "function");
  assert.equal(typeof importLegacyP0Json, "function");
  assert.equal(typeof planLegacyP0Migration, "function");
  assert.equal(typeof LegacyControlPlaneSecretReader, "function");

  // The released `registrationToken` credential alias stays readable, and the
  // node-agent model registry still upgrades legacy model identities in place.
  assert.match(readSource("packages/node-agent/src/instances/private-config-store.ts"), /source\.instanceCredential \?\? source\.registrationToken/);
  assert.match(readSource("packages/node-agent/src/models/registry.ts"), /upgradeModelIdentity/);
  assert.match(readSource("packages/node-agent/src/persistence/legacy-migration.ts"), /Compatibility for v/);
  assert.ok(fs.existsSync(path.join(REPO_ROOT, "scripts/node-update-worker.cts")));
});

test("no `Compatibility for v` branch survives outside the preserved runtime boundaries", () => {
  const sites = collectCompatibilitySites(path.join(REPO_ROOT, "packages/node-agent/src"));
  assert.ok(sites.size > 0, "the scan must observe the retained node-agent compatibility sites");
  const unclassified = [...sites.keys()].filter((file) => !RETAINED_NODE_AGENT_COMPAT_SITES.has(file));
  assert.deepEqual(unclassified, [], "internal runtime compat branches must not be reintroduced; classify new sites explicitly");

  // The removed internal runtime branches stay removed. The Docker entrypoint
  // intentionally keeps reading the retired single-file mount so containers
  // created by older node agents keep starting until they are recreated.
  for (const file of [
    "packages/controlled-instance/src/web/private-model-catalog.ts",
    "packages/node-agent/src/instances/private-config-store.ts",
  ]) {
    assert.equal(readSource(file).includes("Compatibility for v"), false, file);
    assert.equal(readSource(file).includes("instance-private-config.json"), false, file);
  }
});
