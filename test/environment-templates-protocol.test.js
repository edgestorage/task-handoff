const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  CONTROL_PLANE_PROTOCOL_VERSION,
  ControlledInstanceSchema,
  EnvironmentSourceSchema,
  EnvironmentTemplateSchema,
  InstanceDeleteInputSchema,
  InstanceDeleteResultSchema,
  sanitizeStoredControlledInstance,
  sanitizeStoredEnvironmentTemplate,
} = require("../packages/protocol/src/control-plane.ts");
const { EnvironmentTemplateStore } = require("../packages/control-plane/src/node-agent/environment-templates/store.ts");
const { nodeAgentStorePaths } = require("../packages/control-plane/src/node-agent/persistence/paths.ts");

const timestamp = "2026-08-04T00:00:00.000Z";

function template(overrides = {}) {
  return {
    id: "envtpl_one",
    name: "Configured tools",
    sourceInstanceId: "inst_source",
    nodeId: "node_one",
    status: "creating",
    createdAt: timestamp,
    updatedAt: timestamp,
    ...overrides,
  };
}

test("environment source strictly separates image and template selection", () => {
  assert.deepEqual(EnvironmentSourceSchema.parse({ type: "image", imageSelection: { imageId: "img_one", tag: "latest" } }), {
    type: "image",
    imageSelection: { imageId: "img_one", tag: "latest" },
  });
  assert.deepEqual(EnvironmentSourceSchema.parse({ type: "template", environmentTemplateId: "envtpl_one" }), {
    type: "template",
    environmentTemplateId: "envtpl_one",
  });
  assert.throws(() => EnvironmentSourceSchema.parse({
    type: "template",
    environmentTemplateId: "envtpl_one",
    imageSelection: { imageId: "img_one" },
  }));
});

test("ready and failed environment templates require lifecycle metadata", () => {
  assert.throws(() => EnvironmentTemplateSchema.parse(template({ status: "ready" })));
  assert.throws(() => EnvironmentTemplateSchema.parse(template({ status: "failed" })));
  assert.equal(EnvironmentTemplateSchema.parse(template({
    status: "ready",
    imageId: `sha256:${"a".repeat(64)}`,
    internalTag: "task-handoff/environment-template:envtpl_one",
    platform: "linux",
    architecture: "x64",
    sizeBytes: 1024,
  })).status, "ready");
});

test("template origin survives generic stored instance sanitization", () => {
  const warnings = [];
  const sanitized = sanitizeStoredControlledInstance({
    id: "inst_one",
    name: "one",
    source: { type: "local-folder", path: "/tmp/work", localFolderId: "folder_one" },
    sourceSnapshot: {},
    modelSelection: {},
    nodeId: "node_one",
    runtimeId: "runtime_local_docker",
    environmentSource: { type: "template", environmentTemplateId: "envtpl_one", future: true },
    environmentTemplateOrigin: {
      templateId: "envtpl_one",
      nodeId: "node_one",
      imageId: `sha256:${"b".repeat(64)}`,
      name: "Configured tools", platform: "linux", architecture: "x64",
      future: true,
    },
    access: { strategy: "control-plane-proxy", status: "unknown" },
    runtime: {
      labels: {},
      future: true,
    },
    createdAt: timestamp,
    updatedAt: timestamp,
    future: true,
  }, (warning) => warnings.push(warning.field));
  const parsed = ControlledInstanceSchema.parse(sanitized);
  assert.equal(parsed.environmentSource.type, "template");
  assert.equal(parsed.environmentTemplateOrigin.templateId, "envtpl_one");
  assert.ok(warnings.includes("future"));
  assert.ok(warnings.includes("runtime"));
  assert.ok(warnings.includes("environmentSource"));
  assert.equal(CONTROL_PLANE_PROTOCOL_VERSION, "2026-08-27");
});

test("instance deletion protocol requires one total volume choice and reports each resource", () => {
  assert.throws(() => InstanceDeleteInputSchema.parse({}));
  assert.throws(() => InstanceDeleteInputSchema.parse({ deleteVolumes: true, deleteWorkspace: false }));
  const result = InstanceDeleteResultSchema.parse({
    instanceId: "inst_one",
    containerDeleted: true,
    completed: true,
    deletedVolumes: [{ role: "data", name: "volume-data", mountPath: "/data", status: "deleted" }],
    retainedVolumes: [],
    volumeResults: [{ role: "data", name: "volume-data", mountPath: "/data", status: "deleted" }],
  });
  assert.equal(result.deletedVolumes.length, 1);
});

test("environment template store sanitizes history and recovers interrupted creation", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-env-template-store-"));
  const paths = nodeAgentStorePaths(dataDir);
  fs.mkdirSync(paths.environmentTemplatesDir, { recursive: true });
  fs.writeFileSync(path.join(paths.environmentTemplatesDir, "envtpl_one.json"), JSON.stringify({
    ...template(),
    future: "ignored",
  }));
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (message) => warnings.push(message);
  try {
    const store = new EnvironmentTemplateStore(paths);
    store.init();
    const recovered = store.get("envtpl_one");
    assert.equal(recovered.status, "failed");
    assert.equal(recovered.error.code, "ENVIRONMENT_TEMPLATE_CREATION_INTERRUPTED");
    assert.ok(warnings.some((message) => message.includes("future")));
    assert.equal(fs.statSync(path.join(paths.environmentTemplatesDir, "envtpl_one.json")).mode & 0o777, 0o600);
  } finally {
    console.warn = originalWarn;
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("stored environment template sanitizer reports nested unknown fields", () => {
  const warnings = [];
  const sanitized = sanitizeStoredEnvironmentTemplate(template({
    status: "failed",
    error: { code: "FAILED", message: "failed", phase: "persist", secret: "ignored" },
    future: true,
  }), (warning) => warnings.push(warning.field));
  assert.equal(EnvironmentTemplateSchema.parse(sanitized).status, "failed");
  assert.deepEqual(warnings.sort(), ["error.secret", "future"]);
});
