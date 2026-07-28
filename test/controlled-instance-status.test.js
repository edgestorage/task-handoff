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
        { id: "chromium", kind: "gui", availability: "missing-dependency" },
      ],
    }),
  });
  assert.equal(capabilities.features.tty, true);
  assert.equal(capabilities.features.gui, false);
  assert.equal(capabilities.features.browser, false);
  assert.equal(capabilities.features.screenshots, false);
});
