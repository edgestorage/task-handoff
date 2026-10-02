const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");
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

const { AppRuntimeManager } = require("../packages/app-runtime/src/runtime.ts");
const { ChromiumProfileStore } = require("../packages/app-runtime/src/managed-app-definitions/chromium/profiles.ts");
const { runConfigSync } = require("../packages/controlled-instance/src/web/config-sync.ts");
const { createWebApp } = require("../packages/controlled-instance/src/web/server.ts");

function storagePaths(root) {
  return {
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
}

function withStorageEnv(paths, extra = {}) {
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
    TASK_HANDOFF_CHROMIUM_USER_DATA_DIR: undefined,
    TASK_HANDOFF_VNC_BACKEND: "novnc",
    TASK_HANDOFF_AI_PROCESS_SCAN: "0",
    TASK_HANDOFF_AI_SESSION_SCAN: "0",
    TASK_HANDOFF_CODEX_APP_SERVER: "0",
    TASK_HANDOFF_CONTROL_MODE: undefined,
    TASK_HANDOFF_INSTANCE_ID: undefined,
    TASK_HANDOFF_INSTANCE_NAME: undefined,
    TASK_HANDOFF_NODE_AGENT_URL: undefined,
    TASK_HANDOFF_REGISTRATION_TOKEN: undefined,
    TASK_HANDOFF_NODE_ID: undefined,
    TASK_HANDOFF_PROJECT_ID: undefined,
    TASK_HANDOFF_RUNTIME_ID: undefined,
    TASK_HANDOFF_WORKSPACE: undefined,
    TASK_HANDOFF_PRIVATE_MODEL_CATALOG_JSON: undefined,
    TASK_HANDOFF_INSTANCE_PRIVATE_CONFIG_PATH: undefined,
    ...extra,
  };
  const previous = Object.fromEntries(Object.keys(patch).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

function chromiumApp() {
  return {
    id: "chromium",
    command: "chromium",
    args: ["about:blank"],
    automation: { type: "cdp" },
  };
}

test("chromium profile store persists, renames and protects the default profile", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-profile-store-"));
  const paths = storagePaths(root);
  const restoreEnv = withStorageEnv(paths);
  try {
    const store = new ChromiumProfileStore(paths.dataDir);
    const defaultProfile = store.ensureDefault();
    assert.equal(defaultProfile.name, "Default");
    assert.equal(store.ensureDefault().id, defaultProfile.id);
    assert.equal(store.defaultProfileId(), defaultProfile.id);
    assert.equal(defaultProfile.directory, path.join(paths.dataDir, "chromium-profiles", defaultProfile.id));
    assert.equal(fs.statSync(defaultProfile.directory).mode & 0o777, 0o700);
    assert.equal(fs.existsSync(path.join(paths.dataDir, "chromium-profiles", "index.json")), true);

    const work = store.create("  工作  ");
    assert.equal(work.name, "工作");
    assert.match(work.id, /^brp_[0-9a-z]{13}$/);
    assert.throws(() => store.create("工作"), (error) => error.code === "BROWSER_PROFILE_NAME_CONFLICT");
    assert.throws(() => store.create("   "), (error) => error.code === "BROWSER_PROFILE_NAME_INVALID");

    // 第二个 store 实例（实例重启）必须读到同一注册表，且默认 Profile 幂等。
    const reopened = new ChromiumProfileStore(paths.dataDir);
    assert.deepEqual(reopened.list().map((profile) => profile.id), [defaultProfile.id, work.id]);
    assert.equal(reopened.ensureDefault().id, defaultProfile.id);

    assert.throws(() => reopened.remove(defaultProfile.id), (error) => error.code === "BROWSER_PROFILE_DEFAULT_PROTECTED");
    const renamed = reopened.rename(work.id, "工作 2");
    assert.equal(renamed.name, "工作 2");
    assert.throws(() => reopened.rename(work.id, "Default"), (error) => error.code === "BROWSER_PROFILE_NAME_CONFLICT");
    assert.throws(() => reopened.rename("brp_missing00000000", "x"), (error) => error.code === "BROWSER_PROFILE_NOT_FOUND");

    reopened.setDefault(work.id);
    assert.equal(reopened.defaultProfileId(), work.id);
    reopened.remove(defaultProfile.id);
    assert.equal(reopened.list().length, 1);
    assert.equal(fs.existsSync(defaultProfile.directory), false);
    assert.equal(fs.existsSync(work.directory), true);
  } finally {
    restoreEnv();
  }
});

test("chromium profile store binds the configured user data dir to the default profile", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-profile-env-"));
  const paths = storagePaths(root);
  const userDataDir = path.join(root, "configured-chromium");
  const restoreEnv = withStorageEnv(paths, { TASK_HANDOFF_CHROMIUM_USER_DATA_DIR: userDataDir });
  try {
    const store = new ChromiumProfileStore(paths.dataDir);
    const defaultProfile = store.ensureDefault();
    assert.equal(defaultProfile.directory, userDataDir);
    assert.equal(fs.existsSync(userDataDir), true);

    // 环境变量后续变更只影响新建实例语义，已有默认 Profile 目录保持不变。
    process.env.TASK_HANDOFF_CHROMIUM_USER_DATA_DIR = path.join(root, "other-chromium");
    const reopened = new ChromiumProfileStore(paths.dataDir);
    assert.equal(reopened.ensureDefault().id, defaultProfile.id);
    assert.equal(reopened.ensureDefault().directory, userDataDir);
  } finally {
    restoreEnv();
  }
});

test("app runtime manages chromium profiles and reports disk usage", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-profile-runtime-"));
  const paths = storagePaths(root);
  const restoreEnv = withStorageEnv(paths);
  try {
    const runtime = new AppRuntimeManager(paths);
    const [defaultProfile] = runtime.appProfiles("chromium");
    assert.equal(defaultProfile.isDefault, true);

    const created = runtime.createAppProfile("chromium", "备用");
    assert.equal(created.isDefault, false);
    const createdDirectory = runtime.appProfiles("chromium").find((profile) => profile.id === created.id).directory;
    fs.writeFileSync(path.join(createdDirectory, "Cookies"), Buffer.alloc(2048));
    const listed = await runtime.listAppProfiles("chromium");
    assert.equal(listed.appId, "chromium");
    assert.equal(listed.defaultProfileId, defaultProfile.id);
    const listedCreated = listed.profiles.find((profile) => profile.id === created.id);
    assert.equal(listedCreated.diskUsageBytes, 2048);
    assert.equal(listed.profiles.find((profile) => profile.id === defaultProfile.id).runningSessionId, undefined);

    const renamed = runtime.renameAppProfile("chromium", created.id, "备用 2");
    assert.equal(renamed.name, "备用 2");
    assert.equal(runtime.setDefaultAppProfile("chromium", created.id).isDefault, true);
    assert.throws(() => runtime.removeAppProfile("chromium", created.id), (error) => error.code === "BROWSER_PROFILE_DEFAULT_PROTECTED");
    runtime.setDefaultAppProfile("chromium", defaultProfile.id);
    runtime.removeAppProfile("chromium", created.id);
    assert.equal(runtime.appProfiles("chromium").length, 1);

    assert.throws(() => runtime.appProfiles("codex"), (error) => error.code === "BROWSER_PROFILE_UNSUPPORTED");
    assert.throws(() => runtime.appProfiles("missing-app"), (error) => error.code === "APP_NOT_FOUND");
  } finally {
    restoreEnv();
  }
});

test("app runtime enforces one running session per chromium profile", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-profile-busy-"));
  const paths = storagePaths(root);
  const restoreEnv = withStorageEnv(paths);
  const runtime = new AppRuntimeManager(paths);
  const children = [];
  function fakeChild(name) {
    const child = new EventEmitter();
    child.stdout = { pipe() {} };
    child.stderr = { pipe() {} };
    child.pid = 20_000 + children.length;
    child.spawnfile = name;
    child.killed = false;
    child.kill = () => {
      child.killed = true;
      return true;
    };
    children.push({ name, child });
    return child;
  }
  runtime.hasCommand = () => true;
  runtime.waitForXDisplay = () => {};
  runtime.startNoVncDisplay = () => [fakeChild("Xvfb"), fakeChild("x11vnc"), fakeChild("websockify")];
  runtime.startCompositor = () => fakeChild("picom");
  runtime.spawnLogged = (command) => fakeChild(command);
  try {
    const work = runtime.createAppProfile("chromium", "工作");
    const workDirectory = runtime.appProfiles("chromium").find((profile) => profile.id === work.id).directory;
    const shared = { displayTarget: { mode: "shared", id: "main", autoCreate: true } };
    const first = runtime.start("chromium", { ...shared, profileId: work.id });
    assert.equal(first.status, "running");
    assert.equal(first.launch.profileId, work.id);

    assert.throws(
      () => runtime.start("chromium", { ...shared, profileId: work.id }),
      (error) => error.code === "BROWSER_PROFILE_BUSY" && error.details?.profileId === work.id && error.details?.sessionId === first.id,
    );
    assert.throws(() => runtime.removeAppProfile("chromium", work.id), (error) => error.code === "BROWSER_PROFILE_BUSY");
    assert.equal(runtime.renameAppProfile("chromium", work.id, "工作 2").name, "工作 2");

    const other = runtime.createAppProfile("chromium", "其它");
    const parallel = runtime.start("chromium", { ...shared, profileId: other.id });
    const ephemeral = runtime.start("chromium", { ...shared });
    assert.equal(parallel.status, "running");
    assert.equal(ephemeral.launch.profileId, undefined);

    const running = await runtime.listAppProfiles("chromium");
    assert.equal(running.profiles.find((profile) => profile.id === work.id).runningSessionId, first.id);

    // 会话删除只回收会话目录，持久 Profile 目录必须保留。
    fs.writeFileSync(path.join(workDirectory, "Cookies"), "session");
    runtime.stop(first.id);
    await runtime.delete(first.id);
    assert.equal(fs.existsSync(workDirectory), true);
    assert.equal(fs.readFileSync(path.join(workDirectory, "Cookies"), "utf8"), "session");
    const restarted = runtime.start("chromium", { ...shared, profileId: work.id });
    assert.equal(restarted.status, "running");
    runtime.stop(restarted.id);
  } finally {
    runtime.stopAll();
    restoreEnv();
  }
});

test("instance API exposes chromium profile management and structured errors", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-profile-api-"));
  const paths = storagePaths(root);
  const restoreEnv = withStorageEnv(paths, { TASK_HANDOFF_WEB_AUTH: "off" });
  const app = await createWebApp({ staticDir: path.join(root, "missing-static"), logger: false });
  try {
    const listed = await app.inject({ method: "GET", url: "/api/apps/chromium/profiles" });
    assert.equal(listed.statusCode, 200);
    const listPayload = JSON.parse(listed.payload).data;
    assert.equal(listPayload.appId, "chromium");
    assert.equal(listPayload.profiles.length, 1);
    assert.equal(listPayload.profiles[0].isDefault, true);
    assert.equal(typeof listPayload.profiles[0].diskUsageBytes, "number");
    const originalDefaultId = listPayload.defaultProfileId;

    const unsupported = await app.inject({ method: "GET", url: "/api/apps/codex/profiles" });
    assert.equal(unsupported.statusCode, 404);
    assert.equal(JSON.parse(unsupported.payload).error.code, "BROWSER_PROFILE_UNSUPPORTED");

    const created = await app.inject({ method: "POST", url: "/api/apps/chromium/profiles", payload: { name: "工作" } });
    assert.equal(created.statusCode, 200);
    const work = JSON.parse(created.payload).data;
    assert.equal(work.name, "工作");

    const duplicate = await app.inject({ method: "POST", url: "/api/apps/chromium/profiles", payload: { name: "工作" } });
    assert.equal(duplicate.statusCode, 409);
    assert.equal(JSON.parse(duplicate.payload).error.code, "BROWSER_PROFILE_NAME_CONFLICT");

    const invalid = await app.inject({ method: "POST", url: "/api/apps/chromium/profiles", payload: { name: "" } });
    assert.equal(invalid.statusCode, 400);
    assert.equal(JSON.parse(invalid.payload).error.code, "APP_PROFILE_CREATE_FAILED");

    const renamed = await app.inject({ method: "PATCH", url: `/api/apps/chromium/profiles/${work.id}`, payload: { name: "工作 2" } });
    assert.equal(renamed.statusCode, 200);
    assert.equal(JSON.parse(renamed.payload).data.name, "工作 2");

    const setDefault = await app.inject({ method: "POST", url: `/api/apps/chromium/profiles/${work.id}/default` });
    assert.equal(setDefault.statusCode, 200);
    assert.equal(JSON.parse(setDefault.payload).data.isDefault, true);

    const protectedDefault = await app.inject({ method: "DELETE", url: `/api/apps/chromium/profiles/${work.id}` });
    assert.equal(protectedDefault.statusCode, 409);
    assert.equal(JSON.parse(protectedDefault.payload).error.code, "BROWSER_PROFILE_DEFAULT_PROTECTED");

    const restoreDefault = await app.inject({ method: "POST", url: `/api/apps/chromium/profiles/${originalDefaultId}/default` });
    assert.equal(restoreDefault.statusCode, 200);
    assert.equal(JSON.parse(restoreDefault.payload).data.isDefault, true);

    const unknown = await app.inject({ method: "POST", url: "/api/apps/chromium/profiles/brp_missing00000000/default" });
    assert.equal(unknown.statusCode, 404);
    assert.equal(JSON.parse(unknown.payload).error.code, "BROWSER_PROFILE_NOT_FOUND");

    const removed = await app.inject({ method: "DELETE", url: `/api/apps/chromium/profiles/${work.id}` });
    assert.equal(removed.statusCode, 200);
    assert.equal(JSON.parse(removed.payload).data.removed, true);

    const launchInvalid = await app.inject({ method: "POST", url: "/api/apps/sessions", payload: { appId: "chromium", profileId: 42 } });
    assert.equal(launchInvalid.statusCode, 400);
    assert.equal(JSON.parse(launchInvalid.payload).error.code, "APP_LAUNCH_INVALID");
  } finally {
    await app.close();
    restoreEnv();
  }
});

test("config sync rejects running browser profiles and skips volatile chromium entries", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-profile-config-sync-"));
  const workspace = path.join(root, "workspace");
  const home = path.join(root, "home");
  const profileDir = path.join(root, "profiles", "brp_one0000000000");
  fs.mkdirSync(path.join(workspace, ".task-handoff", "configs"), { recursive: true });
  fs.mkdirSync(path.join(home, ".config", "chromium"), { recursive: true });
  fs.mkdirSync(path.join(profileDir, "Cache"), { recursive: true });
  fs.mkdirSync(path.join(profileDir, "Default"), { recursive: true });
  fs.writeFileSync(path.join(profileDir, "Cookies"), "cookie-db");
  fs.writeFileSync(path.join(profileDir, "SingletonLock"), "");
  fs.writeFileSync(path.join(profileDir, "Cache", "data_0"), "cache");
  fs.writeFileSync(path.join(profileDir, "Default", "Bookmarks"), "{}");
  const restoreEnv = withStorageEnv(storagePaths(root), {
    HOME: home,
    TASK_HANDOFF_WORKSPACE: workspace,
  });
  try {
    const options = {
      browserProfiles: [{ id: "brp_one0000000000", name: "工作", directory: profileDir, isDefault: false }],
      assertProfileIdle: () => {},
    };
    const exported = runConfigSync("export", "browser", undefined, options);
    const profileItem = exported.items.find((item) => item.id === "chromium-profile-brp_one0000000000");
    assert.equal(profileItem.status, "copied");
    const exportedProfile = path.join(workspace, ".task-handoff", "configs", "browser", "chromium-profile", "Cookies");
    assert.equal(fs.readFileSync(exportedProfile, "utf8"), "cookie-db");
    const exportedRoot = path.join(workspace, ".task-handoff", "configs", "browser", "chromium-profile");
    assert.equal(fs.existsSync(path.join(exportedRoot, "SingletonLock")), false);
    assert.equal(fs.existsSync(path.join(exportedRoot, "Cache")), false);
    assert.equal(fs.readFileSync(path.join(exportedRoot, "Default", "Bookmarks"), "utf8"), "{}");

    const busy = Object.assign(new Error("Browser profile brp_one0000000000 is running."), {
      code: "BROWSER_PROFILE_BUSY",
      details: { profileId: "brp_one0000000000", sessionId: "apps_busy" },
    });
    assert.throws(
      () => runConfigSync("export", "browser", undefined, { ...options, assertProfileIdle: () => { throw busy; } }),
      (error) => error.code === "BROWSER_PROFILE_BUSY" && error.statusCode === 409 && error.details.sessionId === "apps_busy",
    );
    // 失败发生在复制之前：第二次导出不能覆盖已有结果或产生部分目录。
    fs.rmSync(path.join(workspace, ".task-handoff", "configs", "browser"), { recursive: true, force: true });
    assert.throws(
      () => runConfigSync("export", "browser", undefined, { ...options, assertProfileIdle: () => { throw busy; } }),
      (error) => error.code === "BROWSER_PROFILE_BUSY",
    );
    assert.equal(fs.existsSync(path.join(workspace, ".task-handoff", "configs", "browser")), false);
  } finally {
    restoreEnv();
  }
});

test("protocol projects app inventories without profiles for older node agents", () => {
  const register = require("../packages/protocol/src/control-plane.ts");
  const payload = {
    instanceId: "inst_one",
    protocolVersion: "2026-10-02",
    appInventory: {
      observedAt: new Date().toISOString(),
      issues: [],
      items: [
        { id: "chromium", name: "Browser", kind: "gui", source: "builtin", availability: "available", capabilities: { supportsCwdSelection: false, supportsProfiles: true } },
        { id: "codex", name: "Codex", kind: "tty", source: "builtin", availability: "available", capabilities: { supportsCwdSelection: true } },
      ],
    },
  };
  const projected = register.projectControlledInstanceRegisterForNodeAgentProtocol(payload, "2026-09-29");
  assert.equal("supportsProfiles" in projected.appInventory.items[0].capabilities, false);
  assert.equal(projected.appInventory.items[0].capabilities.supportsCwdSelection, false);
  assert.equal(projected.appInventory.items[1].capabilities.supportsCwdSelection, true);
  assert.equal(payload.appInventory.items[0].capabilities.supportsProfiles, true);

  const current = register.projectControlledInstanceRegisterForNodeAgentProtocol(payload, "2026-10-02");
  assert.equal(current.appInventory.items[0].capabilities.supportsProfiles, true);
  const unknownPeer = register.projectControlledInstanceRegisterForNodeAgentProtocol(payload, undefined);
  assert.equal("supportsProfiles" in unknownPeer.appInventory.items[0].capabilities, false);

  const heartbeat = register.projectControlledInstanceHeartbeatForNodeAgentProtocol({
    ...payload,
    aiSessions: { sessions: [{ id: "ais_one", actions: { send: true, rename: true } }] },
  }, "2026-09-16");
  assert.equal("rename" in heartbeat.aiSessions.sessions[0].actions, false);
  assert.equal("supportsProfiles" in heartbeat.appInventory.items[0].capabilities, false);
});
