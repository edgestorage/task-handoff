const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  CustomImageProfileSchema,
  InstanceImageSnapshotSchema,
  MARKET_CATALOG_PROTOCOL_VERSION,
  MarketCatalogSnapshotSchema,
  NodeImageAvailabilitySchema,
  ProjectSchema,
  parseDockerImageReference,
  sanitizeStoredControlledInstance,
  sanitizeStoredImageProfile,
  sanitizeStoredMarketCatalogSnapshot,
  sanitizeStoredProject,
} = require("../packages/protocol/src/control-plane.ts");
const {
  EmbeddedMarketCatalogProvider,
  MarketCatalogService,
} = require("../packages/control-plane/src/control-plane/catalog/market.ts");
const { ControlPlaneCatalogService } = require("../packages/control-plane/src/control-plane/catalog/service.ts");
const { ControlPlaneSettingsSchema } = require("../packages/control-plane/src/control-plane/catalog/inputs.ts");
const { JsonCollection, JsonFile } = require("../packages/control-plane/src/shared/persistence/store.ts");
const { createControlPlaneApp } = require("../packages/control-plane/src/server.ts");
const { ControlPlaneService } = require("../packages/control-plane/src/control-plane/application/service.ts");
const { controlPlaneStorePaths } = require("../packages/control-plane/src/control-plane/persistence/paths.ts");

const digest = (letter) => `sha256:${letter.repeat(64)}`;
const timestamp = () => new Date().toISOString();

function stores() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "image-market-"));
  const projects = new JsonCollection(path.join(root, "projects"));
  const images = new JsonCollection(path.join(root, "images"));
  const settings = new JsonFile(path.join(root, "settings.json"), () => ControlPlaneSettingsSchema.parse({}));
  projects.init();
  images.init();
  settings.init();
  return { projects, images, settings };
}

test("Market catalog validates date protocols, tags, and optional platform sizes", () => {
  const now = timestamp();
  const snapshot = MarketCatalogSnapshotSchema.parse({
    protocolVersion: "2026-07-28",
    catalogId: "catalog_test",
    revision: "r1",
    source: "remote",
    generatedAt: now,
    items: [{
      id: "market_test",
      publisher: "example",
      slug: "test",
      name: "Test",
      description: "Test image",
      repository: "docker.io/example/test",
      defaultTag: "latest",
      tags: [{
        name: "latest",
        reference: "docker.io/example/test:latest",
        platforms: [
          { os: "linux", architecture: "amd64", digest: digest("a"), downloadSizeBytes: 10 },
          { os: "linux", architecture: "arm64", digest: digest("b") },
        ],
        status: "active",
      }],
      capabilities: [],
      optionalApps: [],
      defaultEnv: {},
      labels: {},
      status: "active",
    }],
  });
  assert.equal(snapshot.items[0].tags[0].platforms[1].downloadSizeBytes, undefined);
  assert.throws(() => MarketCatalogSnapshotSchema.parse({ ...snapshot, protocolVersion: "market-v1" }), /YYYY-MM-DD/);
  const invalidSize = structuredClone(snapshot);
  invalidSize.items[0].tags[0].platforms[0].downloadSizeBytes = 0;
  assert.equal(MarketCatalogSnapshotSchema.safeParse(invalidSize).success, false);
});

test("stored custom profiles and controlled instances migrate before strict parsing", () => {
  const now = timestamp();
  const project = ProjectSchema.parse(sanitizeStoredProject({
    id: "proj_legacy_runtime",
    name: "Legacy runtime project",
    source: { type: "local-folder", path: "/workspace" },
    defaultImageSelection: { imageId: "img_custom" },
    defaultNodeId: "node_1",
    // Compatibility for v0.0.21: no longer part of the project model.
    defaultRuntimeId: "runtime_local_docker",
    workspacePolicy: { mode: "local-bind", path: "/workspace", readOnly: false },
    labels: {},
    createdAt: now,
    updatedAt: now,
  }));
  assert.equal(project.defaultImageSelection.imageId, "img_custom");
  assert.equal("defaultRuntimeId" in project, false);

  const custom = CustomImageProfileSchema.parse(sanitizeStoredImageProfile({
    id: "img_custom",
    name: "Custom",
    image: "docker.io/example/custom:v2",
    capabilities: [],
    optionalApps: [],
    defaultEnv: {},
    labels: {},
    createdAt: now,
    updatedAt: now,
    ignored: true,
  }));
  assert.equal(custom.origin, "custom");
  assert.equal(custom.repository, "docker.io/example/custom");
  assert.equal(custom.tag, "v2");

  const stored = sanitizeStoredControlledInstance({
    id: "inst_legacy",
    name: "Legacy",
    source: { type: "local-folder", path: "/workspace" },
    nodeId: "node_1",
    runtimeId: "runtime_1",
    imageId: "img_codex",
    imageSnapshot: {
      id: "img_codex",
      name: "Codex",
      reference: "docker.io/example/codex:latest",
      pullPolicy: "if-not-present",
      capabilities: [],
      optionalApps: [],
      defaultEnv: {},
      labels: {},
      createdAt: now,
      updatedAt: now,
    },
    createdAt: now,
    updatedAt: now,
  });
  assert.deepEqual(stored.imageSelection, { imageId: "market_taskhandoff_codex", tag: "latest" });
  assert.equal(stored.imageSnapshot.origin, "market");
  assert.equal(stored.imageSnapshot.requestedReference, "docker.io/example/codex:latest");
});

test("embedded provider returns five stable Market images and retains the last valid snapshot", async () => {
  const embedded = await new EmbeddedMarketCatalogProvider().loadCatalog();
  assert.equal(embedded.protocolVersion, MARKET_CATALOG_PROTOCOL_VERSION);
  assert.deepEqual(embedded.items.map((item) => item.id), [
    "market_taskhandoff_codex",
    "market_taskhandoff_opencode",
    "market_taskhandoff_ai",
    "market_taskhandoff_webcap",
    "market_taskhandoff_browser",
  ]);
  assert.deepEqual(embedded.items.map((item) => item.description), [
    "Minimal Codex runtime with terminal and Codex.",
    "Minimal OpenCode runtime with terminal and OpenCode.",
    "AI development runtime with Codex, Claude, and terminal.",
    "Browser automation runtime with WebCap, Codex, Claude, Chromium, and VNC.",
    "Full runtime with Codex, Claude, Chromium, VNC, and code-server.",
  ]);
  assert.deepEqual(embedded.items.map((item) => item.localizedDescriptions?.["zh-CN"]), [
    "最小 Codex 运行环境，包含终端和 Codex。",
    "最小 OpenCode 运行环境，包含终端和 OpenCode。",
    "AI 开发运行环境，包含 Codex、Claude 和终端。",
    "浏览器自动化运行环境，包含 WebCap、Codex、Claude、Chromium 和 VNC。",
    "完整运行环境，包含 Codex、Claude、Chromium、VNC 和 code-server。",
  ]);
  const market = new MarketCatalogService(embedded);
  const revision = market.getCatalog().revision;
  assert.equal(market.acceptCandidate({ broken: true }).accepted, false);
  assert.equal(market.getCatalog().revision, revision);
  assert.equal(market.getStatus().state, "failed");
  market.recordRefreshFailure(new Error("offline"));
  assert.equal(market.getStatus().state, "stale");
});

test("stored Market caches ignore unknown fields and isolate invalid items", async () => {
  const embedded = await new EmbeddedMarketCatalogProvider().loadCatalog();
  const warnings = [];
  const cached = sanitizeStoredMarketCatalogSnapshot({
    ...embedded,
    futureField: true,
    items: [...embedded.items, { id: "broken", future: true }],
  }, (warning) => warnings.push(warning));
  const parsed = MarketCatalogSnapshotSchema.parse(cached);
  assert.equal(parsed.items.length, 5);
  assert.ok(warnings.some((warning) => warning.field === "futureField"));
  assert.ok(warnings.some((warning) => warning.itemId === "broken" && warning.field === "invalid-record"));
});

test("catalog keeps Custom CRUD separate while exposing unified selectable images", () => {
  const { projects, images, settings } = stores();
  const market = new MarketCatalogService();
  const catalog = new ControlPlaneCatalogService({ projects, images, settings, market, defaultNodeId: () => "node_1" });
  const custom = catalog.createImage({ name: "Custom", reference: "docker.io/example/custom:v1" });
  const duplicate = catalog.createImage({ name: "Custom duplicate", reference: "docker.io/example/custom:v1" });
  assert.equal(custom.origin, "custom");
  assert.equal(duplicate.reference, custom.reference);
  assert.equal(catalog.listImages().length, 2);
  assert.equal(catalog.listImageOptions().length, 7);
  assert.equal(catalog.resolveImageSelection({ imageId: "market_taskhandoff_browser" }).tag, "latest");
  assert.throws(() => catalog.requireImage("market_taskhandoff_browser"), (error) => error.code === "MARKET_IMAGE_READ_ONLY");
  assert.throws(() => catalog.resolveImageSelection({ imageId: custom.id, tag: "v2" }), (error) => error.code === "CUSTOM_IMAGE_TAG_OVERRIDE");

  const availability = NodeImageAvailabilitySchema.parse({
    image: catalog.resolveImageSelection({ imageId: custom.id }),
    status: "available",
    localSizeBytes: 123,
  });
  assert.equal(availability.localSizeBytes, 123);
});

test("catalog lists yanked Market entries but rejects them for new selections", () => {
  const { projects, images, settings } = stores();
  const market = new MarketCatalogService();
  const next = structuredClone(market.getCatalog());
  next.revision = "yanked";
  next.items[0].tags[0].status = "yanked";
  assert.equal(market.acceptCandidate(next).accepted, true);
  const catalog = new ControlPlaneCatalogService({ projects, images, settings, market, defaultNodeId: () => "node_1" });
  const listed = catalog.listImageOptions().find((image) => image.id === next.items[0].id);
  assert.equal(listed.lifecycleStatus, "yanked");
  assert.throws(() => catalog.resolveImageSelection({ imageId: next.items[0].id }), (error) => error.code === "MARKET_IMAGE_TAG_YANKED");
});

test("an instance image snapshot stays immutable when Market metadata changes", () => {
  const { projects, images, settings } = stores();
  const market = new MarketCatalogService();
  const catalog = new ControlPlaneCatalogService({ projects, images, settings, market, defaultNodeId: () => "node_1" });
  const selected = catalog.resolveImageSelection({ imageId: "market_taskhandoff_browser", tag: "latest" });
  const now = timestamp();
  const snapshot = InstanceImageSnapshotSchema.parse({
    id: selected.id,
    origin: selected.origin,
    name: selected.name,
    description: selected.description,
    cover: selected.cover,
    repository: selected.repository,
    tag: selected.tag,
    requestedReference: selected.reference,
    resolvedDigest: digest("d"),
    resolvedReference: `${selected.repository}@${digest("d")}`,
    pullPolicy: "if-not-present",
    capabilities: selected.capabilities,
    optionalApps: selected.optionalApps,
    defaultEnv: selected.defaultEnv,
    labels: selected.labels,
    market: selected.market,
    createdAt: now,
    updatedAt: now,
  });
  const changed = structuredClone(market.getCatalog());
  changed.revision = "moved-latest";
  changed.items[0].tags[0].reference = "docker.io/example/replacement:v9";
  changed.items[0].tags[0].status = "yanked";
  market.acceptCandidate(changed);
  assert.equal(snapshot.requestedReference, selected.reference);
  assert.equal(snapshot.resolvedDigest, digest("d"));
  assert.equal(snapshot.market.catalogRevision, selected.market.catalogRevision);
});

test("Docker references expose normalized repository, tag, and digest identity", () => {
  assert.deepEqual(parseDockerImageReference(`GHCR.IO/example/app:v1@${digest("A")}`), {
    reference: `ghcr.io/example/app:v1@${digest("a")}`,
    repository: "ghcr.io/example/app",
    tag: "v1",
    digest: digest("a"),
  });
});

test("HTTP keeps Market, Custom, unified options, and node availability as separate boundaries", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "image-market-http-"));
  let dockerImages = [{
    repository: "docker.io/example/custom",
    tag: "v1",
    id: "sha256:local",
    size: "123MB",
    sizeBytes: 123_000_000,
    reference: "docker.io/example/custom:v1",
    repoDigests: [`docker.io/example/custom@${digest("c")}`],
  }];
  const fetchImpl = async (url) => {
    const route = new URL(String(url)).pathname.replace(/^\/api\/node-agent/, "");
    const data = route === "/health"
      ? { ok: true, role: "node-agent", nodeId: "node_market", protocolVersion: "2026-07-28", platform: "linux", arch: "x64" }
      : route === "/docker/images" ? (dockerImages || (() => { throw new Error("node offline"); })())
        : route === "/runtimes" || route === "/instances" || route === "/local-folders" || route === "/models" ? []
          : [];
    return new Response(JSON.stringify({ data }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const app = await createControlPlaneApp({
    dataDir: root,
    logger: false,
    authMode: "disabled",
    staticDir: path.join(root, "missing-ui"),
    service: { fetchImpl },
  });
  t.after(() => app.close());

  const market = await app.inject({ method: "GET", url: "/api/market/catalog" });
  assert.equal(market.statusCode, 200, market.body);
  assert.equal(market.json().data.catalog.items.length, 5);
  assert.equal(market.json().data.status.source, "embedded");

  const emptyCustom = await app.inject({ method: "GET", url: "/api/images" });
  assert.deepEqual(emptyCustom.json().data, []);
  const created = await app.inject({
    method: "POST",
    url: "/api/images",
    payload: { name: "Custom HTTP", reference: "docker.io/example/custom:v1" },
  });
  assert.equal(created.statusCode, 201, created.body);
  assert.equal(created.json().data.origin, "custom");

  const strict = await app.inject({
    method: "POST",
    url: "/api/images",
    payload: { name: "Invalid", reference: "docker.io/example/invalid:v1", origin: "market" },
  });
  assert.equal(strict.statusCode, 400, strict.body);

  const options = await app.inject({ method: "GET", url: "/api/image-options" });
  assert.equal(options.statusCode, 200, options.body);
  assert.deepEqual(new Set(options.json().data.map((image) => image.origin)), new Set(["market", "custom"]));

  const readOnly = await app.inject({ method: "DELETE", url: "/api/images/market_taskhandoff_browser" });
  assert.equal(readOnly.statusCode, 403, readOnly.body);
  assert.equal(readOnly.json().error.code, "MARKET_IMAGE_READ_ONLY");

  const node = await app.inject({
    method: "POST",
    url: "/api/nodes",
    payload: {
      id: "node_market",
      name: "Market node",
      connectionMode: "direct-http",
      endpoint: "http://node-market.example:8091",
      auth: { mode: "paired-hmac", keyId: "key_market", secret: "agent-secret" },
    },
  });
  assert.equal(node.statusCode, 201, node.body);
  const availability = await app.inject({ method: "GET", url: "/api/nodes/node_market/image-options" });
  assert.equal(availability.statusCode, 200, availability.body);
  const customAvailability = availability.json().data.find((entry) => entry.image.id === created.json().data.id);
  assert.equal(customAvailability.status, "available");
  assert.equal(customAvailability.localSizeBytes, 123_000_000);

  dockerImages = undefined;
  const offline = await app.inject({ method: "GET", url: "/api/nodes/node_market/image-options" });
  assert.equal(offline.statusCode, 200, offline.body);
  assert.ok(offline.json().data.every((entry) => entry.status === "unknown" && entry.error.includes("node offline")));
});

test("legacy embedded image migration backs up first and keeps old records on validation failure", async (t) => {
  const makeLegacyImage = (id) => ({
    id,
    name: id,
    reference: `docker.io/example/${id}:latest`,
    pullPolicy: "if-not-present",
    capabilities: [],
    optionalApps: [],
    defaultEnv: {},
    labels: {},
    createdAt: timestamp(),
    updatedAt: timestamp(),
  });
  const initialize = async (root, createProject = false) => {
    const app = await createControlPlaneApp({ dataDir: root, logger: false, authMode: "disabled", staticDir: path.join(root, "missing-ui") });
    if (createProject) {
      const response = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { name: "Migration project", source: { type: "local-folder", path: "/workspace/migration" } },
      });
      assert.equal(response.statusCode, 201, response.body);
    }
    await app.close();
  };

  const successRoot = fs.mkdtempSync(path.join(os.tmpdir(), "image-market-migrate-ok-"));
  await initialize(successRoot, true);
  const successProjectPath = path.join(successRoot, "projects", fs.readdirSync(path.join(successRoot, "projects")).find((name) => name.endsWith(".json")));
  const successProject = JSON.parse(fs.readFileSync(successProjectPath, "utf8"));
  delete successProject.defaultImageSelection;
  successProject.defaultImageId = "img_default";
  fs.writeFileSync(successProjectPath, JSON.stringify(successProject));
  fs.writeFileSync(path.join(successRoot, "images", "img_default.json"), JSON.stringify(makeLegacyImage("img_default")));
  await initialize(successRoot);
  assert.equal(fs.existsSync(path.join(successRoot, "images", "img_default.json")), false);
  assert.equal(JSON.parse(fs.readFileSync(successProjectPath, "utf8")).defaultImageSelection.imageId, "market_taskhandoff_browser");
  const backup = JSON.parse(fs.readFileSync(path.join(successRoot, "market", "legacy-image-migration-backup.json"), "utf8"));
  assert.equal(backup.images[0].id, "img_default");
  assert.equal(JSON.parse(fs.readFileSync(path.join(successRoot, "market", "catalog-state.json"), "utf8")).status, "complete");

  const failedRoot = fs.mkdtempSync(path.join(os.tmpdir(), "image-market-migrate-failed-"));
  await initialize(failedRoot);
  fs.writeFileSync(path.join(failedRoot, "images", "img_default.json"), JSON.stringify(makeLegacyImage("img_default")));
  fs.writeFileSync(path.join(failedRoot, "projects", "broken.json"), JSON.stringify({ id: "project_broken", defaultImageId: "img_default" }));
  await initialize(failedRoot);
  assert.equal(fs.existsSync(path.join(failedRoot, "images", "img_default.json")), true);
  assert.equal(fs.existsSync(path.join(failedRoot, "market", "legacy-image-migration-backup.json")), false);
  const failedState = JSON.parse(fs.readFileSync(path.join(failedRoot, "market", "catalog-state.json"), "utf8"));
  assert.equal(failedState.status, "failed");
  assert.equal(failedState.code, "PROJECT_REFERENCE_VALIDATION_FAILED");
});

test("instance creation sends Market default, explicit tag, and Custom references to the node boundary", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "image-market-create-"));
  const service = new ControlPlaneService(controlPlaneStorePaths(root));
  service.init();
  const now = timestamp();
  service.nodes.put({
    id: "node_create",
    name: "Create node",
    connectionMode: "direct-http",
    auth: { mode: "paired-hmac", keyId: "key_create", secret: "secret" },
    endpoint: "http://node-create.example:8091",
    status: "online",
    health: "ok",
    capabilities: {},
    labels: {},
    createdAt: now,
    updatedAt: now,
  });
  const gateway = service.nodeAgentGateway;
  gateway.listRuntimes = async () => [{
    id: "runtime_create",
    nodeId: "node_create",
    name: "Docker",
    type: "docker",
    status: "online",
    accessStrategy: "node-proxy",
    capabilities: { requiresImage: true },
    labels: {},
    createdAt: now,
    updatedAt: now,
  }];
  gateway.listModels = async () => [];
  const received = [];
  gateway.createInstance = async (node, input) => {
    received.push(input);
    return {
      id: input.id || `inst_${received.length}`,
      name: input.name || `instance-${received.length}`,
      source: input.source,
      sourceSnapshot: input.sourceSnapshot || {},
      modelSelection: {},
      nodeId: node.id,
      runtimeId: input.runtimeId,
      imageSelection: input.environmentSource?.type === "image" ? input.environmentSource.imageSelection : undefined,
      imageSnapshot: input.image,
      status: "created",
      health: "unknown",
      connectionStatus: "unknown",
      controlMode: "controlled",
      capabilities: {},
      config: input.config || {},
      workspace: { status: "unknown" },
      createdAt: now,
      updatedAt: now,
    };
  };
  gateway.assignInstanceModels = async (_node, id) => ({ instance: {
    ...received.find((entry) => entry.id === id),
    id,
    name: received.find((entry) => entry.id === id)?.name || id,
    source: received.find((entry) => entry.id === id)?.source,
    sourceSnapshot: received.find((entry) => entry.id === id)?.sourceSnapshot || {},
    modelSelection: {},
    nodeId: "node_create",
    runtimeId: "runtime_create",
    imageSelection: received.find((entry) => entry.id === id)?.imageSelection,
    imageSnapshot: received.find((entry) => entry.id === id)?.image,
    status: "created", health: "unknown", connectionStatus: "unknown", controlMode: "controlled",
    capabilities: {}, config: {}, workspace: { status: "unknown" },
    runtime: { labels: {} },
    createdAt: now, updatedAt: now,
  } });
  const custom = service.createImage({ name: "Create custom", reference: "docker.io/example/custom:v3" });
  const base = {
    nodeId: "node_create",
    runtimeId: "runtime_create",
    source: { type: "git-repository", url: "https://example.com/repository.git" },
  };
  await service.createControlledInstance({ ...base, id: "inst_default", imageSelection: { imageId: "market_taskhandoff_browser" } });
  await service.createControlledInstance({ ...base, id: "inst_explicit", imageSelection: { imageId: "market_taskhandoff_browser", tag: "latest" } });
  await service.createControlledInstance({ ...base, id: "inst_custom", imageSelection: { imageId: custom.id } });
  assert.deepEqual(received.map((input) => input.image.requestedReference), [
    "huadream/task-handoff-controlled-browser:latest",
    "huadream/task-handoff-controlled-browser:latest",
    "docker.io/example/custom:v3",
  ]);
  assert.deepEqual(received.map((input) => input.environmentSource.imageSelection.tag), [undefined, "latest", undefined]);
});
