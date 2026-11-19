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

const { createWebApp } = require("../packages/controlled-instance/src/web/server.ts");
const { builtinManagedAppDefinitions } = require("../packages/app-runtime/src/catalog.ts");
const { managedAppLauncherPath } = require("../packages/app-runtime/src/managed-node-apps.ts");

const environmentKeys = [
  "TASK_HANDOFF_DATA_DIR",
  "TASK_HANDOFF_LOG_DIR",
  "TASK_HANDOFF_CONFIG",
  "TASK_HANDOFF_WEB_AUTH",
  "TASK_HANDOFF_AI_SESSION_SCAN",
  "TASK_HANDOFF_NODE_AGENT_URL",
];

test("OpenCode capability follows installation without restarting the instance", { timeout: 15_000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-opencode-provider-"));
  const previousEnvironment = Object.fromEntries(environmentKeys.map((key) => [key, process.env[key]]));
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
    for (const [key, value] of Object.entries(previousEnvironment)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  process.env.TASK_HANDOFF_DATA_DIR = path.join(root, "data");
  process.env.TASK_HANDOFF_LOG_DIR = path.join(root, "logs");
  process.env.TASK_HANDOFF_CONFIG = path.join(root, "config.json");
  process.env.TASK_HANDOFF_WEB_AUTH = "off";
  process.env.TASK_HANDOFF_AI_SESSION_SCAN = "0";
  delete process.env.TASK_HANDOFF_NODE_AGENT_URL;
  const definition = builtinManagedAppDefinitions().find((entry) => entry.launcher.id === "opencode");
  const command = managedAppLauncherPath(path.join(root, "data", "managed-apps"), definition);
  assert.ok(command);

  const web = await createWebApp({ staticDir: path.join(root, "missing-static"), logger: false });
  try {
    const readProviders = async () => {
      const response = await web.inject({ method: "GET", url: "/api/instance/capabilities" });
      assert.equal(response.statusCode, 200);
      return JSON.parse(response.payload).data.features.aiSessionProviders.map((provider) => provider.agent);
    };

    assert.deepEqual(await readProviders(), []);
    fs.mkdirSync(path.dirname(command), { recursive: true });
    fs.writeFileSync(command, "#!/bin/sh\nexit 0\n", { mode: 0o755 });

    assert.deepEqual(await readProviders(), ["opencode"]);
  } finally {
    await web.close();
  }
});
