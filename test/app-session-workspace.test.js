const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const ts = require("typescript");
const { registerWorkspaceRequire } = require("./workspace-require.js");

registerWorkspaceRequire();
require.extensions[".ts"] = (module, filename) => {
  const source = fs.readFileSync(filename, "utf8");
  const output = ts.transpileModule(source, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
      esModuleInterop: true,
      allowSyntheticDefaultImports: true,
    },
    fileName: filename,
  });
  module._compile(output.outputText, filename);
};

const { AppRuntimeManager } = require("../packages/app-runtime/src/runtime.ts");

function pathsFor(root) {
  return {
    configPath: path.join(root, "config.json"),
    dataDir: root,
    appCatalogDir: path.join(root, "app-catalog"),
    appSessionsDir: path.join(root, "app-sessions"),
    runtimeDir: path.join(root, "runtime"),
    eventsDir: path.join(root, "events"),
    artifactDir: path.join(root, "artifacts"),
    logDir: path.join(root, "logs"),
    webTokenPath: path.join(root, "web-token"),
  };
}

function fakePty() {
  const pty = new EventEmitter();
  pty.pid = 4242;
  pty.onData = (listener) => pty.on("data", listener);
  pty.onExit = (listener) => pty.on("exit", listener);
  pty.write = () => {};
  pty.resize = () => {};
  pty.kill = () => {};
  return pty;
}

function withEnv(patch, run) {
  const previous = Object.fromEntries(Object.keys(patch).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return run();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("port availability probes run packaged Electron executables in Node mode", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-port-probe-"));
  const electronShim = path.join(root, "TaskHandoff");
  const nodeExecutable = process.execPath;
  fs.writeFileSync(
    electronShim,
    `#!/bin/sh\n[ "$ELECTRON_RUN_AS_NODE" = "1" ] || exit 91\nexec "${nodeExecutable}" "$@"\n`,
    { mode: 0o755 },
  );

  const runtime = new AppRuntimeManager(pathsFor(root));
  const originalExecPath = process.execPath;
  try {
    process.execPath = electronShim;
    assert.equal(runtime.isPortAvailable(8198), true);
  } finally {
    process.execPath = originalExecPath;
  }
});

test("app runtime materializes the exact absolute spawn cwd for every cwd fallback", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-app-workspace-"));
  const explicit = path.join(root, "explicit");
  const catalog = path.join(root, "catalog");
  const environment = path.join(root, "environment");
  for (const directory of [explicit, catalog, environment]) fs.mkdirSync(directory);

  withEnv({ TASK_HANDOFF_WORKSPACE: environment, TASK_HANDOFF_CODEX_APP_SERVER_DISABLED: "1" }, () => {
    const runtime = new AppRuntimeManager(pathsFor(root));
    runtime.hasCommand = () => true;
    const spawns = [];
    runtime.spawnTerminalPty = (_shell, _args, cwd) => {
      spawns.push(cwd);
      return fakePty();
    };
    runtime.saveCustomCatalog([{ id: "catalog-terminal", name: "Catalog terminal", kind: "tty", command: "/bin/sh", cwd: catalog }]);
    runtime.saveCustomCatalog([
      { id: "catalog-terminal", name: "Catalog terminal", kind: "tty", command: "/bin/sh", cwd: catalog },
      { id: "fallback-terminal", name: "Fallback terminal", kind: "tty", command: "/bin/sh" },
    ]);

    const sessions = [
      runtime.start("terminal-tty", { cwd: path.relative(process.cwd(), explicit) }),
      runtime.start("catalog-terminal"),
      runtime.start("fallback-terminal"),
    ];
    assert.deepEqual(sessions.map((session) => session.workspace.cwd), [explicit, catalog, environment].map((value) => path.resolve(value)));
    assert.deepEqual(sessions.map((session) => session.launch.cwd), sessions.map((session) => session.workspace.cwd));
    assert.deepEqual(spawns, sessions.map((session) => session.workspace.cwd));
  });

  withEnv({ TASK_HANDOFF_WORKSPACE: undefined, TASK_HANDOFF_CODEX_APP_SERVER_DISABLED: "1" }, () => {
    const runtime = new AppRuntimeManager(pathsFor(path.join(root, "process-fallback")));
    runtime.hasCommand = () => true;
    let spawnedCwd;
    runtime.spawnTerminalPty = (_shell, _args, cwd) => {
      spawnedCwd = cwd;
      return fakePty();
    };
    const session = runtime.start("terminal-tty");
    assert.equal(session.workspace.cwd, path.resolve(process.cwd()));
    assert.equal(spawnedCwd, session.workspace.cwd);
  });
});

test("persisted app sessions migrate workspace cwd before recovery", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-app-workspace-migrate-"));
  const paths = pathsFor(root);
  const id = "app_legacy";
  const sessionDir = path.join(paths.appSessionsDir, id);
  const logDir = path.join(paths.logDir, "app-sessions", id);
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.mkdirSync(logDir, { recursive: true });
  fs.writeFileSync(path.join(sessionDir, "metadata.json"), JSON.stringify({
    id,
    appId: "terminal-tty",
    title: "Legacy",
    kind: "tty",
    status: "running",
    createdAt: "2026-07-20T00:00:00.000Z",
    updatedAt: "2026-07-20T00:00:00.000Z",
    tty: { webPath: `/api/apps/sessions/${id}/tty`, shell: "/bin/sh", cwd: path.join(root, "legacy-cwd") },
    process: { command: "/bin/sh" },
    paths: { sessionDir, logDir },
    futureField: { ignoredByCurrentRuntime: true },
  }));

  withEnv({ TASK_HANDOFF_APP_SESSION_PERSIST: "1" }, () => {
    const runtime = new AppRuntimeManager(paths);
    const restored = runtime.getSession(id);
    assert.equal(restored.workspace.cwd, path.join(root, "legacy-cwd"));
    assert.equal(restored.status, "exited");
    const persisted = JSON.parse(fs.readFileSync(path.join(sessionDir, "metadata.json"), "utf8"));
    assert.deepEqual(persisted.workspace, { cwd: path.join(root, "legacy-cwd") });
  });
});
