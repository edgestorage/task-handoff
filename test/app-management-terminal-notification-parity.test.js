const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
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

const {
  builtinManagedAppDefinitions,
  detectFinalComputerCapabilities,
  managedNativeAppManifestPath,
  managedNativeAppRoot,
  selectInstallRecipe,
} = require("../packages/app-runtime/src/index.ts");
const { createWebApp } = require("../packages/controlled-instance/src/web/server.ts");

const APP_ID = "codex";
const PROTOCOL_VERSION_HEADER = "x-task-handoff-node-agent-protocol-version";

function seedManagedCodex(managedAppRoot) {
  const definition = builtinManagedAppDefinitions().find((candidate) => candidate.launcher.id === APP_ID);
  assert.ok(definition, "built-in codex definition");
  const recipe = selectInstallRecipe(definition, detectFinalComputerCapabilities()).recipe;
  assert.equal(recipe?.type, "native-package");
  const appRoot = managedNativeAppRoot(managedAppRoot, APP_ID);
  const launcher = path.join(appRoot, recipe.launchPath);
  fs.mkdirSync(path.dirname(launcher), { recursive: true });
  fs.writeFileSync(launcher, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  fs.writeFileSync(managedNativeAppManifestPath(managedAppRoot, APP_ID), JSON.stringify({
    schemaVersion: 1,
    appId: APP_ID,
    version: recipe.version,
    package: recipe.package,
    packageVersion: recipe.packageVersion,
    integrity: recipe.integrity,
    installRoot: appRoot,
    launchPath: recipe.launchPath,
    files: [recipe.launchPath],
  }, null, 2));
}

async function startNodeAgentMock() {
  const requests = [];
  const server = http.createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      let parsed = {};
      try { parsed = JSON.parse(body || "{}"); } catch {}
      requests.push({ path: request.url, body: parsed });
      if (request.url?.includes("/register")) {
        response.writeHead(201, {
          "content-type": "application/json",
          [PROTOCOL_VERSION_HEADER]: "2026-10-02",
        });
        response.end(JSON.stringify({ data: { id: "ins_0000000000000" } }));
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ data: { id: "ins_0000000000000" } }));
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    heartbeats: () => requests.filter((entry) => entry.path?.endsWith("/heartbeat")),
    close: () => new Promise((resolve) => {
      server.closeAllConnections?.();
      server.close(resolve);
    }),
  };
}

async function waitFor(predicate, message, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(message);
}

function availability(heartbeat, appId) {
  return heartbeat?.body?.appInventory?.items?.find((item) => item.id === appId)?.availability;
}

test("terminal app operation wakes the real server heartbeat with updated inventory", { skip: process.platform === "win32" }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "app-terminal-notify-"));
  const managedAppRoot = path.join(root, "managed-apps");
  seedManagedCodex(managedAppRoot);
  const mock = await startNodeAgentMock();
  const names = [
    "TASK_HANDOFF_DATA_DIR",
    "TASK_HANDOFF_LOG_DIR",
    "TASK_HANDOFF_CONFIG",
    "TASK_HANDOFF_APP_CATALOG_DIR",
    "TASK_HANDOFF_APP_SESSION_DIR",
    "TASK_HANDOFF_RUNTIME_DIR",
    "TASK_HANDOFF_EVENTS_DIR",
    "TASK_HANDOFF_ARTIFACT_DIR",
    "TASK_HANDOFF_WEB_TOKEN_FILE",
    "TASK_HANDOFF_WEB_AUTH",
    "TASK_HANDOFF_WORKSPACE_ROOTS",
    "TASK_HANDOFF_AI_SESSION_SCAN",
    "TASK_HANDOFF_AI_PROCESS_SCAN",
    "TASK_HANDOFF_CODEX_APP_SERVER",
    "TASK_HANDOFF_CONTROL_MODE",
    "TASK_HANDOFF_INSTANCE_ID",
    "TASK_HANDOFF_REGISTRATION_TOKEN",
    "TASK_HANDOFF_NODE_AGENT_URL",
    "TASK_HANDOFF_HEARTBEAT_INTERVAL_MS",
    "TASK_HANDOFF_MANAGED_APP_ROOT",
    "TASK_HANDOFF_PRIVATE_MODEL_CATALOG_JSON",
    "TASK_HANDOFF_INSTANCE_PRIVATE_CONFIG_PATH",
    "TASK_HANDOFF_RUNTIME_KIND",
  ];
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  for (const name of names) delete process.env[name];
  process.env.TASK_HANDOFF_DATA_DIR = root;
  process.env.TASK_HANDOFF_LOG_DIR = path.join(root, "logs");
  process.env.TASK_HANDOFF_CONFIG = path.join(root, "config.json");
  process.env.TASK_HANDOFF_APP_CATALOG_DIR = path.join(root, "app-catalog");
  process.env.TASK_HANDOFF_APP_SESSION_DIR = path.join(root, "app-sessions");
  process.env.TASK_HANDOFF_RUNTIME_DIR = path.join(root, "runtime");
  process.env.TASK_HANDOFF_EVENTS_DIR = path.join(root, "events");
  process.env.TASK_HANDOFF_ARTIFACT_DIR = path.join(root, "artifacts");
  process.env.TASK_HANDOFF_WEB_TOKEN_FILE = path.join(root, "web-token");
  process.env.TASK_HANDOFF_WEB_AUTH = "off";
  process.env.TASK_HANDOFF_WORKSPACE_ROOTS = root;
  process.env.TASK_HANDOFF_AI_SESSION_SCAN = "0";
  process.env.TASK_HANDOFF_AI_PROCESS_SCAN = "0";
  process.env.TASK_HANDOFF_CODEX_APP_SERVER = "0";
  process.env.TASK_HANDOFF_CONTROL_MODE = "controlled";
  process.env.TASK_HANDOFF_INSTANCE_ID = "ins_0000000000000";
  process.env.TASK_HANDOFF_REGISTRATION_TOKEN = "test-registration-token";
  process.env.TASK_HANDOFF_NODE_AGENT_URL = mock.url;
  process.env.TASK_HANDOFF_HEARTBEAT_INTERVAL_MS = "60000";
  process.env.TASK_HANDOFF_MANAGED_APP_ROOT = managedAppRoot;
  let web;
  try {
    web = await createWebApp({ staticDir: path.join(root, "missing-static"), logger: false });
    await web.ready();
    const initialHeartbeat = await waitFor(() => mock.heartbeats()[0], "initial heartbeat");
    assert.equal(availability(initialHeartbeat, APP_ID), "available");

    const requested = await web.inject({ method: "POST", url: `/api/apps/${APP_ID}/uninstall`, payload: {} });
    assert.equal(requested.statusCode, 202);
    const queued = JSON.parse(requested.payload).data.job;
    const terminalJob = await waitFor(async () => {
      const response = await web.inject({ method: "GET", url: `/api/apps/jobs/${queued.id}` });
      const job = JSON.parse(response.payload).data.job;
      return !["queued", "running"].includes(job.state) ? job : undefined;
    }, "terminal app job");
    assert.equal(terminalJob.state, "succeeded");
    const updatedHeartbeat = await waitFor(
      () => mock.heartbeats().find((entry) => availability(entry, APP_ID) === "missing-dependency"),
      "terminal inventory heartbeat must not wait for the periodic interval",
    );
    assert.equal(availability(updatedHeartbeat, APP_ID), "missing-dependency");
  } finally {
    await web?.close();
    await mock.close();
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});
