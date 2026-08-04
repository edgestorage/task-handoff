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
const { createWebApp } = require("../packages/controlled-instance/src/web/server.ts");

function pathsFor(root) {
  return {
    configPath: path.join(root, "config.json"), dataDir: root, appCatalogDir: path.join(root, "app-catalog"),
    appSessionsDir: path.join(root, "app-sessions"), runtimeDir: path.join(root, "runtime"), eventsDir: path.join(root, "events"),
    artifactDir: path.join(root, "artifacts"), logDir: path.join(root, "logs"), webTokenPath: path.join(root, "web-token"),
  };
}

function setEnvironment(paths, workspaceRoot) {
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
    TASK_HANDOFF_CONTROL_MODE: undefined,
  };
  const previous = Object.fromEntries(Object.keys(patch).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(patch)) value === undefined ? delete process.env[key] : process.env[key] = value;
  return () => {
    for (const [key, value] of Object.entries(previous)) value === undefined ? delete process.env[key] : process.env[key] = value;
  };
}

function codexBridgeStub(overrides = {}) {
  let sequence = 0;
  return {
    id: "repository-api-codex-stub",
    agent: "codex",
    refresh() {},
    async sync() {},
    stop() {},
    async createSession(input) {
      sequence += 1;
      return { providerSessionId: `provider-${sequence}`, cwd: input.cwd, creationSource: "ai-session" };
    },
    async readSession() {},
    async archiveSession() {},
    async deleteSession() {},
    async unsubscribeSession() {},
    async mentionCatalog() { return { candidates: [], diagnostics: [] }; },
    async searchMentionFiles() { return { candidates: [], complete: true }; },
    async executeCommand() { throw new Error("not used"); },
    async startMessage() {},
    async interrupt() { throw new Error("not used"); },
    ...overrides,
  };
}

test("AI and app repository APIs use separate authoritative cwd and strict inputs", async () => {
  const aiFixture = createGitFixture();
  const appFixture = createGitFixture();
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-repository-api-"));
  const paths = pathsFor(dataRoot);
  const restore = setEnvironment(paths, aiFixture.base);
  const aiSessions = createAiSessionRegistry({ dir: path.join(dataRoot, "ai-sessions") });
  const ai = aiSessions.start({ agent: "codex", cwd: aiFixture.root, status: "running" });
  const appRuntime = new AppRuntimeManager(paths);
  let appSession = {
    id: "app-repository", appId: "terminal-tty", title: "Repository", kind: "tty", status: "running",
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), workspace: { cwd: appFixture.root },
    launch: { cwd: aiFixture.root }, paths: { sessionDir: path.join(dataRoot, "app"), logDir: path.join(dataRoot, "logs", "app") },
  };
  appRuntime.getSession = (id) => id === appSession?.id ? appSession : undefined;
  appRuntime.listSessions = () => appSession ? [appSession] : [];
  const app = await createWebApp({ staticDir: path.join(dataRoot, "missing-static"), logger: false, appRuntime, aiSessionRegistry: aiSessions, codexAppServer: codexBridgeStub() });
  try {
    const aiContext = await app.inject({ method: "GET", url: `/api/ai-sessions/${ai.id}/repository/context` });
    const appContext = await app.inject({ method: "GET", url: `/api/apps/sessions/${appSession.id}/repository/context` });
    assert.equal(aiContext.statusCode, 200);
    assert.equal(appContext.statusCode, 200);
    assert.equal(aiContext.json().data.repositoryRoot, fs.realpathSync(aiFixture.root));
    assert.equal(appContext.json().data.repositoryRoot, fs.realpathSync(appFixture.root));
    assert.notEqual(aiContext.json().data.repositoryId, appContext.json().data.repositoryId);

    const rejectedQuery = await app.inject({ method: "GET", url: `/api/ai-sessions/${ai.id}/repository/context?cwd=${encodeURIComponent(appFixture.root)}` });
    assert.equal(rejectedQuery.statusCode, 400);
    assert.equal(rejectedQuery.json().error.code, "REPOSITORY_REQUEST_INVALID");
    const rejectedBody = await app.inject({
      method: "POST", url: `/api/ai-sessions/${ai.id}/repository/index/stage`,
      payload: { expectedSnapshotId: aiContext.json().data.snapshotId, paths: [{ path: "tracked.txt", expectedVersion: "version:1234567890" }], cwd: appFixture.root },
    });
    assert.equal(rejectedBody.statusCode, 400);
    assert.equal(rejectedBody.json().error.code, "REPOSITORY_REQUEST_INVALID");

    appSession.status = "stopped";
    assert.equal((await app.inject({ method: "GET", url: `/api/apps/sessions/${appSession.id}/repository/context` })).json().data.availability, "available");
    appSession = undefined;
    const deleted = await app.inject({ method: "GET", url: "/api/apps/sessions/app-repository/repository/files?path=tracked.txt" });
    assert.equal(deleted.statusCode, 404);
    assert.equal(deleted.json().error.code, "REPOSITORY_SESSION_NOT_FOUND");
  } finally {
    await app.close();
    restore();
  }
});

test("repository API exposes Files, Changes, diff, and authoritative mutation results", async () => {
  const fixture = createGitFixture();
  fixture.write("tracked.txt", "changed\n");
  fixture.write("new file.txt", "new\n");
  fs.mkdirSync(path.join(fixture.root, "nested", ".git"), { recursive: true });
  fixture.write("nested/inside.txt", "nested repository file\n");
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-repository-api-mutations-"));
  const paths = pathsFor(dataRoot);
  const restore = setEnvironment(paths, fixture.base);
  const aiSessions = createAiSessionRegistry({ dir: path.join(dataRoot, "ai-sessions") });
  const ai = aiSessions.start({ agent: "codex", cwd: fixture.root, status: "running" });
  const app = await createWebApp({ staticDir: path.join(dataRoot, "missing-static"), logger: false, appRuntime: new AppRuntimeManager(paths), aiSessionRegistry: aiSessions, codexAppServer: codexBridgeStub() });
  try {
    const base = `/api/ai-sessions/${ai.id}/repository`;
    const context = (await app.inject({ method: "GET", url: `${base}/context` })).json().data;
    const directory = await app.inject({ method: "GET", url: `${base}/directories` });
    assert.equal(directory.statusCode, 200);
    assert.equal(directory.json().data.entries.some((entry) => entry.name === "new file.txt"), true);
    const nestedEntry = directory.json().data.entries.find((entry) => entry.name === "nested");
    assert.equal(nestedEntry.kind, "nested-repository");
    assert.equal(nestedEntry.traversable, true);
    const nestedDirectory = await app.inject({ method: "GET", url: `${base}/directories?path=nested` });
    assert.equal(nestedDirectory.statusCode, 200);
    assert.deepEqual(nestedDirectory.json().data.entries.map((entry) => entry.name), ["inside.txt"]);
    const file = await app.inject({ method: "GET", url: `${base}/files?path=${encodeURIComponent("tracked.txt")}` });
    assert.equal(file.json().data.content, "changed\n");
    const changes = (await app.inject({ method: "GET", url: `${base}/changes` })).json().data;
    const unstaged = changes.entries.find((entry) => entry.path === "tracked.txt" && entry.scope === "unstaged");
    const diff = await app.inject({ method: "GET", url: `${base}/diff?scope=unstaged&path=tracked.txt&byteLimit=4096&includeContext=true&contextLines=40` });
    assert.match(diff.json().data.content, /changed/);
    assert.ok(Array.isArray(diff.json().data.contextGaps));
    assert.equal(diff.json().data.lines.some((line) => line.kind === "addition" && line.content === "changed"), true);

    const staged = await app.inject({ method: "POST", url: `${base}/index/stage`, payload: { expectedSnapshotId: context.snapshotId, paths: [{ path: "tracked.txt", expectedVersion: unstaged.version }] } });
    assert.equal(staged.statusCode, 200);
    assert.notEqual(staged.json().data.snapshotId, context.snapshotId);
    assert.equal(staged.json().data.changes.entries.some((entry) => entry.path === "tracked.txt" && entry.scope === "staged"), true);

    const staleSave = await app.inject({ method: "PUT", url: `${base}/files`, payload: { path: "tracked.txt", content: "overwrite\n", expectedVersion: file.json().data.version, expectedSnapshotId: context.snapshotId } });
    assert.equal(staleSave.statusCode, 409);
    assert.equal(staleSave.json().error.code, "REPOSITORY_STATE_STALE");
    assert.equal(fs.readFileSync(path.join(fixture.root, "tracked.txt"), "utf8"), "changed\n");
  } finally {
    await app.close();
    restore();
  }
});

test("AI session repository API creates Direct sessions in opaque worktrees and conservatively compensates failures", async () => {
  const fixture = createGitFixture();
  const externalWorktree = fixture.createWorktree("external", "feature/external");
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-repository-api-launch-"));
  const paths = pathsFor(dataRoot);
  const restore = setEnvironment(paths, fixture.base);
  const aiSessions = createAiSessionRegistry({ dir: path.join(dataRoot, "ai-sessions") });
  const source = aiSessions.start({ agent: "codex", cwd: fixture.root, status: "running" });
  const appRuntime = new AppRuntimeManager(paths);
  appRuntime.ensureSharedResource = async () => undefined;
  const providerCreates = [];
  let providerFailure = "";
  const codexAppServer = codexBridgeStub({
    async createSession(input) {
      providerCreates.push({ cwd: input.cwd });
      if (providerFailure === "clean") throw new Error("secret provider diagnostics");
      if (providerFailure === "dirty") {
        fs.writeFileSync(path.join(input.cwd, "recovery.txt"), "preserve me\n");
        throw new Error("provider failed after user-visible state");
      }
      return { providerSessionId: `provider-${providerCreates.length}`, cwd: input.cwd, creationSource: "ai-session" };
    },
  });
  const app = await createWebApp({ staticDir: path.join(dataRoot, "missing-static"), logger: false, appRuntime, aiSessionRegistry: aiSessions, codexAppServer });
  try {
    const base = `/api/ai-sessions/${source.id}/repository`;
    const listed = (await app.inject({ method: "GET", url: `${base}/worktrees` })).json().data;
    const external = listed.items.find((item) => item.head.branch === "feature/external");
    assert.ok(external);
    assert.equal(external.managed, false);
    assert.equal(external.canCreateAiSession, true);

    const selected = await app.inject({
      method: "POST",
      url: `${base}/ai-sessions`,
      payload: { agent: "codex", workspaceSelection: { type: "worktree", repositoryContextId: listed.repositoryContextId, worktreeId: external.id }, message: "Work in the selected tree.", clientRequestId: "selected-request" },
    });
    assert.equal(selected.statusCode, 200);
    const selectedAiSessionId = selected.json().data.aiSessionId;
    assert.equal(selected.json().data.providerSessionId, "provider-1");
    assert.equal(selected.json().data.disposition, "started");
    assert.equal(providerCreates[0].cwd, fs.realpathSync(externalWorktree));
    assert.equal(JSON.stringify(selected.json()).includes(externalWorktree), false);
    assert.equal(aiSessions.get(source.id).cwd, fixture.root);

    const strict = await app.inject({
      method: "POST",
      url: `${base}/ai-sessions`,
      payload: { agent: "codex", workspaceSelection: { type: "current" }, message: "Strict request.", clientRequestId: "strict-request", cwd: externalWorktree },
    });
    assert.equal(strict.statusCode, 400);
    assert.equal(strict.json().error.code, "REPOSITORY_REQUEST_INVALID");

    const stale = await app.inject({
      method: "POST",
      url: `${base}/ai-sessions`,
      payload: { agent: "codex", workspaceSelection: { type: "worktree", repositoryContextId: `${listed.repositoryContextId}-stale`, worktreeId: external.id }, message: "Stale request.", clientRequestId: "stale-request" },
    });
    assert.equal(stale.statusCode, 409);
    assert.equal(stale.json().error.code, "REPOSITORY_STATE_STALE");
    assert.equal(providerCreates.length, 1);

    appRuntime.listSessions = () => [{ id: "occupied-app", status: "running", workspace: { cwd: externalWorktree } }];
    const directOccupied = aiSessions.start({ agent: "codex", creationSource: "ai-session", cwd: externalWorktree, status: "idle", providerSessionId: "active-provider-session" });
    const occupiedList = (await app.inject({ method: "GET", url: `${base}/worktrees` })).json().data;
    const occupiedWorktree = occupiedList.items.find((item) => item.id === external.id);
    assert.deepEqual(new Set(occupiedWorktree.activeAiSessionIds), new Set([selectedAiSessionId, directOccupied.id]));
    assert.deepEqual(occupiedWorktree.activeAppSessionIds, ["occupied-app"]);
    assert.equal(occupiedWorktree.canCreateAiSession, true);
    const occupied = await app.inject({
      method: "POST",
      url: `${base}/ai-sessions`,
      payload: { agent: "codex", workspaceSelection: { type: "worktree", repositoryContextId: listed.repositoryContextId, worktreeId: external.id }, message: "Second request.", clientRequestId: "occupied-request" },
    });
    assert.equal(occupied.statusCode, 200);
    assert.equal(occupied.json().data.providerSessionId, "provider-2");
    assert.equal(providerCreates.length, 2);
    appRuntime.listSessions = () => [];

    const contextForSuccess = (await app.inject({ method: "GET", url: `${base}/context` })).json().data;
    const combined = await app.inject({
      method: "POST",
      url: `${base}/worktrees/ai-sessions`,
      payload: { agent: "codex", worktree: { mode: "new-branch", branchName: "feature/combined", startRef: "HEAD", expectedSnapshotId: contextForSuccess.snapshotId }, message: "Combined request.", clientRequestId: "combined-request" },
    });
    assert.equal(combined.statusCode, 200);
    assert.equal(combined.json().data.providerSessionId, "provider-3");
    assert.equal(path.basename(providerCreates[2].cwd).startsWith("feature-combined-"), true);
    assert.equal(aiSessions.get(source.id).cwd, fixture.root);

    providerFailure = "clean";
    const contextForCleanup = (await app.inject({ method: "GET", url: `${base}/context` })).json().data;
    const cleanFailure = await app.inject({
      method: "POST",
      url: `${base}/worktrees/ai-sessions`,
      payload: { agent: "codex", worktree: { mode: "new-branch", branchName: "feature/cleanup", startRef: "HEAD", expectedSnapshotId: contextForCleanup.snapshotId }, message: "Fail cleanly.", clientRequestId: "cleanup-request" },
    });
    assert.equal(cleanFailure.statusCode, 400);
    assert.equal(cleanFailure.json().error.code, "REPOSITORY_OPERATION_FAILED");
    assert.deepEqual(cleanFailure.json().error.details.worktreeRemoved, true);
    assert.equal(cleanFailure.body.includes("secret provider diagnostics"), false);
    assert.equal(fixture.git(["show-ref", "--verify", "refs/heads/feature/cleanup"]).length > 0, true);
    assert.equal(fixture.git(["worktree", "list", "--porcelain"]).includes("feature/cleanup"), false);

    providerFailure = "dirty";
    const contextForRecovery = (await app.inject({ method: "GET", url: `${base}/context` })).json().data;
    const dirtyFailure = await app.inject({
      method: "POST",
      url: `${base}/worktrees/ai-sessions`,
      payload: { agent: "codex", worktree: { mode: "new-branch", branchName: "feature/recovery", startRef: "HEAD", expectedSnapshotId: contextForRecovery.snapshotId }, message: "Fail with state.", clientRequestId: "recovery-request" },
    });
    assert.equal(dirtyFailure.statusCode, 400);
    assert.deepEqual(dirtyFailure.json().error.details.worktreeRemoved, false);
    assert.deepEqual(dirtyFailure.json().error.details.recoverable, true);
    const afterRecovery = (await app.inject({ method: "GET", url: `${base}/worktrees` })).json().data;
    const retained = afterRecovery.items.find((item) => item.id === dirtyFailure.json().error.details.worktreeId);
    assert.ok(retained);
    assert.equal(retained.managed, true);
    assert.equal(retained.dirty, true);
    assert.equal(aiSessions.get(source.id).cwd, fixture.root);
  } finally {
    await app.close();
    restore();
  }
});

test("controlled instance routes create, bind, and close one Direct AI session identity", async () => {
  const fixture = createGitFixture();
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-direct-route-"));
  const paths = pathsFor(dataRoot);
  const restore = setEnvironment(paths, fixture.base);
  const aiSessions = createAiSessionRegistry({ dir: path.join(dataRoot, "ai-sessions") });
  const appRuntime = new AppRuntimeManager(paths);
  appRuntime.ensureSharedResource = async () => undefined;
  let runningApps = [];
  let providerSequence = 0;
  const archived = [];
  const bridge = codexBridgeStub({
    async createSession(input) {
      providerSequence += 1;
      return { providerSessionId: `thread-route-${providerSequence}`, cwd: input.cwd, creationSource: "ai-session" };
    },
    async archiveSession(providerSessionId) {
      archived.push(providerSessionId);
    },
  });
  appRuntime.listSessions = () => runningApps;
  appRuntime.start = (agent, options) => {
    assert.equal(agent, "codex");
    const providerSessionId = options.aiSessionResume.providerSessionId;
    const appSession = { id: "app-route", appId: "codex", status: "running", workspace: { cwd: fixture.root } };
    runningApps = [appSession];
    aiSessions.applyAdapterSnapshot({
      source: "control",
      agent: "codex",
      appId: "codex",
      appSessionId: appSession.id,
      providerSessionId,
      cwd: fixture.root,
      status: "idle",
      phase: "unknown",
    });
    return appSession;
  };
  appRuntime.stop = (appSessionId) => {
    runningApps = runningApps.filter((session) => session.id !== appSessionId);
  };
  const app = await createWebApp({ staticDir: path.join(dataRoot, "missing-static"), logger: false, appRuntime, aiSessionRegistry: aiSessions, codexAppServer: bridge });
  try {
    const created = await app.inject({
      method: "POST",
      url: "/api/ai-sessions",
      payload: { agent: "codex", cwd: { type: "runtime-path", path: fixture.root }, message: "Create directly.", clientRequestId: "route-create" },
    });
    assert.equal(created.statusCode, 200);
    const identity = created.json().data;
    assert.equal(identity.providerSessionId, "thread-route-1");
    assert.equal(aiSessions.get(identity.aiSessionId).appSessionId, undefined);

    const opened = await app.inject({
      method: "POST",
      url: `/api/ai-sessions/${identity.aiSessionId}/open-app`,
      payload: { clientRequestId: "route-open" },
    });
    assert.equal(opened.statusCode, 200);
    assert.equal(opened.json().data.aiSessionId, identity.aiSessionId);
    assert.equal(opened.json().data.providerSessionId, identity.providerSessionId);
    assert.equal(opened.json().data.appSessionId, "app-route");

    const closed = await app.inject({
      method: "POST",
      url: `/api/ai-sessions/${identity.aiSessionId}/close`,
      payload: { clientRequestId: "route-close" },
    });
    assert.equal(closed.statusCode, 200);
    assert.equal(closed.json().data.aiSessionId, identity.aiSessionId);
    assert.deepEqual(archived, ["thread-route-1"]);
    assert.equal(aiSessions.get(identity.aiSessionId), undefined);
    const repeated = await app.inject({
      method: "POST",
      url: `/api/ai-sessions/${identity.aiSessionId}/close`,
      payload: { clientRequestId: "route-close-repeat" },
    });
    assert.equal(repeated.json().data.disposition, "already-closed");
    assert.deepEqual(archived, ["thread-route-1"]);

    const shutdownSession = await app.inject({
      method: "POST",
      url: "/api/ai-sessions",
      payload: { agent: "codex", cwd: { type: "runtime-path", path: fixture.root }, message: "Close on shutdown.", clientRequestId: "route-shutdown" },
    });
    assert.equal(shutdownSession.statusCode, 200);
    assert.ok(aiSessions.get(shutdownSession.json().data.aiSessionId));
  } finally {
    await app.close();
    restore();
  }
  assert.deepEqual(archived, ["thread-route-1", "thread-route-2"]);
  assert.deepEqual(aiSessions.all(), []);
});
