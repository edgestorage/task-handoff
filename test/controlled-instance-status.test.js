const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const ts = require("typescript");
const { registerWorkspaceRequire } = require("./workspace-require.js");

registerWorkspaceRequire();
require.extensions[".ts"] = (module, filename) => {
  const output = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true, allowSyntheticDefaultImports: true },
    fileName: filename,
  });
  module._compile(output.outputText, filename);
};

const { controlledInstanceCapabilities, runtimeDiagnostics } = require("../packages/controlled-instance/src/web/status.ts");
const {
  ControlledInstanceCapabilitiesSchema,
  normalizeControlledInstanceCapabilities,
  supportsAiSessionPersistenceSettings,
  supportsAiSessionFileSizeLimitSettings,
  supportsAiSessionTimelineCapability,
  supportsAiSessionWorkspaceSelection,
} = require("../packages/protocol/src/control-plane.ts");

function storagePaths(root) {
  const paths = {
    configPath: path.join(root, "config.json"),
    dataDir: root,
    appCatalogDir: path.join(root, "app-catalog"),
    appSessionsDir: path.join(root, "app-sessions"),
    triggersDir: path.join(root, "triggers"),
    runtimeDir: path.join(root, "runtime"),
    eventsDir: path.join(root, "events"),
    artifactDir: path.join(root, "artifacts"),
    logDir: path.join(root, "logs"),
    webTokenPath: path.join(root, "web-token"),
  };
  for (const [key, value] of Object.entries(paths)) {
    fs.mkdirSync(key.endsWith("Path") ? path.dirname(value) : value, { recursive: true });
  }
  return paths;
}

test("runtime diagnostics require only commands declared by the image profile", () => {
  const previous = {
    profile: process.env.TASK_HANDOFF_IMAGE_PROFILE,
    capabilities: process.env.TASK_HANDOFF_IMAGE_CAPABILITIES,
    codex: process.env.TASK_HANDOFF_CODEX_COMMAND,
  };
  process.env.TASK_HANDOFF_IMAGE_PROFILE = "codex";
  process.env.TASK_HANDOFF_IMAGE_CAPABILITIES = "terminal,codex";
  process.env.TASK_HANDOFF_CODEX_COMMAND = process.execPath;
  try {
    const diagnostics = runtimeDiagnostics(storagePaths(fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-status-"))), undefined);
    assert.deepEqual(diagnostics.image, { profile: "codex", capabilities: ["terminal", "codex"] });
    assert.equal(diagnostics.commands.find((command) => command.name === "codex").required, true);
    assert.equal(diagnostics.commands.find((command) => command.name === "claude").required, false);
    assert.equal(diagnostics.commands.find((command) => command.name === "chromium").required, false);
  } finally {
    for (const [key, value] of Object.entries({
      TASK_HANDOFF_IMAGE_PROFILE: previous.profile,
      TASK_HANDOFF_IMAGE_CAPABILITIES: previous.capabilities,
      TASK_HANDOFF_CODEX_COMMAND: previous.codex,
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("instance capabilities are projected from available inventory items", () => {
  const capabilities = controlledInstanceCapabilities({
    appInventory: () => ({
      observedAt: new Date().toISOString(),
      issues: [],
      items: [
        { id: "terminal-tty", kind: "tty", availability: "available" },
        { id: "codex", kind: "tty", availability: "available" },
        { id: "opencode", kind: "tty", availability: "missing-dependency" },
        { id: "chromium", kind: "gui", availability: "missing-dependency" },
      ],
    }),
  }, {
    sessionReadAgents: ["codex"],
    turnReadAgents: ["codex"],
    liveItemAgents: ["codex"],
  }, [
    { agent: "codex", actions: { create: true, send: true }, timeline: { sessionRead: true, turnRead: true, liveItems: true } },
    { agent: "opencode", actions: { create: true, send: true }, timeline: { sessionRead: true, turnRead: true, liveItems: true } },
  ]);
  assert.equal(capabilities.features.tty, true);
  assert.equal(capabilities.features.gui, false);
  assert.equal(capabilities.features.browser, false);
  assert.equal(capabilities.features.screenshots, false);
  assert.equal(capabilities.features.aiSessionPersistenceSettings, true);
  assert.equal(supportsAiSessionPersistenceSettings(capabilities), true);
  assert.equal(supportsAiSessionFileSizeLimitSettings(capabilities), true);
  assert.deepEqual(capabilities.features.aiSessionTimeline, {
    sessionReadAgents: ["codex"],
    turnReadAgents: ["codex"],
    liveItemAgents: ["codex"],
  });
  assert.deepEqual(capabilities.features.aiSessionProviders.map((provider) => provider.agent), ["codex"]);
  assert.deepEqual(capabilities.features.aiSessionConversationAttachments.uploadAgents, ["codex"]);
  assert.equal(ControlledInstanceCapabilitiesSchema.safeParse(capabilities).success, true);
  assert.equal("protocolVersion" in capabilities, false);
});

test("controlled instance capability normalization isolates malformed feature domains", () => {
  const malformed = {
    futureDocumentField: "preserved",
    features: {
      aiSessionWorkspaceSelection: true,
      aiSessionTimeline: true,
      futureFeature: { enabled: true },
    },
  };
  assert.equal(ControlledInstanceCapabilitiesSchema.safeParse(malformed).success, false);

  const normalized = normalizeControlledInstanceCapabilities(malformed);
  assert.equal(supportsAiSessionWorkspaceSelection(normalized), true);
  assert.equal(supportsAiSessionPersistenceSettings(normalized), false);
  assert.equal(supportsAiSessionTimelineCapability(normalized, "codex", "session-read"), false);
  assert.deepEqual(normalized.features.aiSessionTimeline, {
    sessionReadAgents: [],
    turnReadAgents: [],
    liveItemAgents: [],
  });
  assert.deepEqual(normalized.features.futureFeature, { enabled: true });
  assert.equal(normalized.futureDocumentField, "preserved");
});
