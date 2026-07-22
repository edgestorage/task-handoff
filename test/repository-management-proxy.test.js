const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const ts = require("typescript");
const { registerWorkspaceRequire } = require("./workspace-require.js");
const { createGitFixture } = require("./fixtures/git-repository.js");

registerWorkspaceRequire();
require.extensions[".ts"] = (module, filename) => {
  const output = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true, allowSyntheticDefaultImports: true },
    fileName: filename,
  });
  module._compile(output.outputText, filename);
};

const { AppRuntimeManager } = require("../packages/app-runtime/src/runtime.ts");
const { createAiSessionRegistry } = require("../packages/ai-session-runtime/src/ai-session-registry.ts");
const { ControlledInstanceGateway } = require("../packages/control-plane/src/control-plane/instances/gateway.ts");
const { createWebApp } = require("../packages/controlled-instance/src/web/server.ts");

function runtimePaths(root) {
  return {
    configPath: path.join(root, "config.json"), dataDir: root, appCatalogDir: path.join(root, "app-catalog"),
    appSessionsDir: path.join(root, "app-sessions"), runtimeDir: path.join(root, "runtime"), eventsDir: path.join(root, "events"),
    artifactDir: path.join(root, "artifacts"), logDir: path.join(root, "logs"), webTokenPath: path.join(root, "web-token"),
  };
}

function setRepositoryEnvironment(paths, workspaceRoot) {
  const patch = {
    TASK_HANDOFF_CONFIG: paths.configPath,
    TASK_HANDOFF_DATA_DIR: paths.dataDir,
    TASK_HANDOFF_APP_CATALOG_DIR: paths.appCatalogDir,
    TASK_HANDOFF_APP_SESSION_DIR: paths.appSessionsDir,
    TASK_HANDOFF_RUNTIME_DIR: paths.runtimeDir,
    TASK_HANDOFF_EVENTS_DIR: paths.eventsDir,
    TASK_HANDOFF_ARTIFACT_DIR: paths.artifactDir,
    TASK_HANDOFF_LOG_DIR: paths.logDir,
    TASK_HANDOFF_WEB_TOKEN_FILE: paths.webTokenPath,
    TASK_HANDOFF_WEB_AUTH: "off",
    TASK_HANDOFF_WORKSPACE_ROOTS: workspaceRoot,
    TASK_HANDOFF_MANAGED_WORKTREES_ROOT: path.join(paths.dataDir, "managed-worktrees"),
    TASK_HANDOFF_AI_SESSION_SCAN: "0",
    TASK_HANDOFF_AI_PROCESS_SCAN: "0",
    TASK_HANDOFF_CODEX_APP_SERVER: "0",
  };
  const previous = Object.fromEntries(Object.keys(patch).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(patch)) process.env[key] = value;
  return () => {
    for (const [key, value] of Object.entries(previous)) value === undefined ? delete process.env[key] : process.env[key] = value;
  };
}

function codexBridgeStub() {
  return {
    id: "repository-proxy-codex-stub", agent: "codex", refresh() {}, stop() {},
    async mentionCatalog() { return { candidates: [], diagnostics: [] }; },
    async searchMentionFiles() { return { candidates: [], complete: true }; },
    async executeCommand() { throw new Error("not used"); },
    async startMessage() { throw new Error("not used"); },
    async interrupt() { throw new Error("not used"); },
  };
}

function proxyBridge(controlled, requests) {
  return async (node, route, init) => {
    const envelope = JSON.parse(init.body);
    requests.push({ mode: node.connectionMode || "local", route, envelope });
    const payload = envelope.bodyBase64 ? Buffer.from(envelope.bodyBase64, "base64") : envelope.body;
    const response = await controlled.inject({ method: envelope.method, url: envelope.path, headers: envelope.headers, ...(payload === undefined ? {} : { payload }) });
    return new Response(response.rawPayload, { status: response.statusCode, headers: response.headers });
  };
}

async function jsonFromProxy(response) {
  return new Response(response.body).json();
}

test("repository APIs cross local, direct, and reverse instance proxy transports without moving Git into control-plane", async () => {
  const fixture = createGitFixture();
  fixture.write("tracked.txt", "proxied change\n");
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-repository-proxy-"));
  const paths = runtimePaths(dataRoot);
  const restore = setRepositoryEnvironment(paths, fixture.base);
  const aiSessions = createAiSessionRegistry({ dir: path.join(dataRoot, "ai-sessions") });
  const ai = aiSessions.start({ agent: "codex", cwd: fixture.root, status: "running" });
  const controlled = await createWebApp({ staticDir: path.join(dataRoot, "missing-static"), logger: false, appRuntime: new AppRuntimeManager(paths), aiSessionRegistry: aiSessions, codexAppServer: codexBridgeStub() });
  try {
    for (const connectionMode of ["local", "direct-http", "reverse-wss"]) {
      const requests = [];
      const node = { id: `node-${connectionMode}`, connectionMode };
      const instance = { id: `instance-${connectionMode}`, name: connectionMode, nodeId: node.id, connectionStatus: "online", agentStatus: "online", target: { web: "http://controlled.invalid" } };
      const gateway = new ControlledInstanceGateway({ requireNode: () => node, nodeAgentRequest: proxyBridge(controlled, requests), nodeAgentStreamRequest: proxyBridge(controlled, requests), fetchImpl: fetch });
      const proxied = await gateway.proxyHttp(instance, `/api/ai-sessions/${ai.id}/repository/context`);
      const payload = await jsonFromProxy(proxied);
      assert.equal(proxied.status, 200);
      assert.equal(payload.data.availability, "available");
      assert.equal(requests[0].route, `/instances/${instance.id}/proxy/stream`);
      assert.equal(requests[0].envelope.path, `/api/ai-sessions/${ai.id}/repository/context`);
      assert.equal(requests[0].mode, connectionMode);
    }

    const gatewaySource = fs.readFileSync(path.join(__dirname, "../packages/control-plane/src/control-plane/instances/gateway.ts"), "utf8");
    assert.doesNotMatch(gatewaySource, /GitProcess|RepositoryFileService|RepositoryChangesService/);
  } finally {
    await controlled.close();
    restore();
  }
});

test("generic proxy limits cannot bypass repository file and diff limits", async () => {
  const fixture = createGitFixture();
  fixture.write("tracked.txt", `${"changed\n".repeat(400_000)}`);
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-repository-proxy-limits-"));
  const paths = runtimePaths(dataRoot);
  const restore = setRepositoryEnvironment(paths, fixture.base);
  const aiSessions = createAiSessionRegistry({ dir: path.join(dataRoot, "ai-sessions") });
  const ai = aiSessions.start({ agent: "codex", cwd: fixture.root, status: "running" });
  const controlled = await createWebApp({ staticDir: path.join(dataRoot, "missing-static"), logger: false, appRuntime: new AppRuntimeManager(paths), aiSessionRegistry: aiSessions, codexAppServer: codexBridgeStub() });
  const node = { id: "node-limits", connectionMode: "direct-http" };
  const instance = { id: "instance-limits", name: "limits", nodeId: node.id, connectionStatus: "online", agentStatus: "online", target: { web: "http://controlled.invalid" } };
  const requests = [];
  const gateway = new ControlledInstanceGateway({ requireNode: () => node, nodeAgentRequest: proxyBridge(controlled, requests), nodeAgentStreamRequest: proxyBridge(controlled, requests), fetchImpl: fetch });
  try {
    const diff = await gateway.proxyHttp(instance, `/api/ai-sessions/${ai.id}/repository/diff?scope=unstaged&path=tracked.txt&byteLimit=1024`);
    const diffPayload = await jsonFromProxy(diff);
    assert.equal(diff.status, 200);
    assert.equal(diffPayload.data.byteLimit, 1024);
    assert.equal(diffPayload.data.truncated, true);
    assert.equal(Buffer.byteLength(diffPayload.data.content) <= 1024, true);

    const contextResponse = await gateway.proxyHttp(instance, `/api/ai-sessions/${ai.id}/repository/context`);
    const context = (await jsonFromProxy(contextResponse)).data;
    const oversized = JSON.stringify({ path: "too-large.txt", content: "x".repeat(4 * 1024 * 1024 + 1), expectedAbsent: true, expectedSnapshotId: context.snapshotId });
    const file = await gateway.proxyHttp(instance, `/api/ai-sessions/${ai.id}/repository/files`, { method: "POST", headers: { "content-type": "application/json" }, body: oversized });
    const filePayload = await jsonFromProxy(file);
    assert.equal(file.status, 400);
    assert.equal(filePayload.error.code, "REPOSITORY_REQUEST_INVALID");
    assert.equal(fs.existsSync(path.join(fixture.root, "too-large.txt")), false);

    await assert.rejects(
      gateway.proxyHttp({ ...instance, connectionStatus: "offline", agentStatus: "offline" }, `/api/ai-sessions/${ai.id}/repository/context`),
      (error) => error.code === "INSTANCE_UNREACHABLE" && error.statusCode === 409,
    );
  } finally {
    await controlled.close();
    restore();
  }
});
