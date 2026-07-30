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

const { AppCatalogRepository } = require("../packages/app-runtime/src/catalog.ts");
const { AppRuntimeManager } = require("../packages/app-runtime/src/runtime.ts");
const { createManagedAppRegistry } = require("../packages/app-runtime/src/managed-app-definitions/index.ts");

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    throw error;
  }
}

async function waitForFile(filePath, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(filePath)) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for ${filePath}`);
}

async function waitForProcessExit(pid, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processExists(pid)) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for process ${pid} to exit`);
}

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

test("catalog and runtime consume the same injected managed app registry", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-app-registry-"));
  let runtimeCreated = 0;
  const lifecycleEvents = [];
  const registry = createManagedAppRegistry([{
    id: "fake-tool",
    capabilities: { supportsCwdSelection: true },
    definition: () => ({
      launcher: { id: "fake-tool", name: "Fake Tool", kind: "tty", command: "/bin/sh" },
      detection: [{ type: "launcher-executable" }],
      distribution: { recipes: [] },
    }),
    createRuntime: () => {
      runtimeCreated += 1;
      return {
        prepareTtyLaunch: ({ args }) => ({
          args: [...args, "--from-provider"],
          lifecycle: {
            processExited: () => lifecycleEvents.push("exit"),
            spawnFailed: () => lifecycleEvents.push("spawn-failure"),
            stop: () => lifecycleEvents.push("stop"),
          },
        }),
      };
    },
  }]);
  const runtime = new AppRuntimeManager(storagePaths(root), registry);
  const pty = new EventEmitter();
  let spawnedArgs;
  pty.pid = 1234;
  pty.onData = () => {};
  pty.onExit = (listener) => pty.on("exit", listener);
  pty.write = () => {};
  pty.resize = () => {};
  pty.kill = () => {};
  runtime.spawnTerminalPty = (_command, args) => {
    spawnedArgs = args;
    return pty;
  };

  assert.deepEqual(runtime.catalog().map((app) => app.id), ["fake-tool"]);
  assert.equal(runtime.appInventory().items[0].capabilities.supportsCwdSelection, true);
  assert.equal(runtimeCreated, 1);
  const session = runtime.start("fake-tool", { cwd: root });
  assert.equal(spawnedArgs.at(-1), "--from-provider");
  pty.emit("exit", { exitCode: 0, signal: 0 });
  runtime.stop(session.id);
  assert.deepEqual(lifecycleEvents, ["exit", "stop"]);
  assert.throws(() => runtime.saveCustomCatalog([
    { id: "fake-tool", name: "Override", kind: "tty", command: "/bin/sh" },
  ]), /cannot override built-in app ids/);
  runtime.stopAll();
});

test("controlled app runtime stops complete process trees from the unified launcher", async (t) => {
  if (process.platform === "win32") {
    t.skip("POSIX process-group ownership is exercised on macOS and Linux");
    return;
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-app-process-tree-"));
  const logDir = path.join(root, "logs");
  const descendantPidPath = path.join(root, "descendant.pid");
  fs.mkdirSync(logDir, { recursive: true });
  const runtime = new AppRuntimeManager(storagePaths(root), createManagedAppRegistry([]));
  const script = String.raw`
    const fs = require("node:fs");
    const { spawn } = require("node:child_process");
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    fs.writeFileSync(process.argv[1], String(child.pid));
    setInterval(() => {}, 1000);
  `;
  const launcher = runtime.spawnLogged(process.execPath, ["-e", script, descendantPidPath], process.env, logDir, "tree.log", root);
  await waitForFile(descendantPidPath);
  const descendantPid = Number(fs.readFileSync(descendantPidPath, "utf8"));
  t.after(() => {
    for (const pid of [launcher.pid, descendantPid]) {
      if (!pid || !processExists(pid)) continue;
      try { process.kill(pid, "SIGKILL"); } catch {}
    }
  });

  assert.equal(processExists(launcher.pid), true);
  assert.equal(processExists(descendantPid), true);
  await runtime.stopAll();
  await Promise.all([waitForProcessExit(launcher.pid), waitForProcessExit(descendantPid)]);
});

test("controlled app runtime reaps descendants abandoned by an exited launcher", async (t) => {
  if (process.platform === "win32") {
    t.skip("POSIX process-group ownership is exercised on macOS and Linux");
    return;
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-abandoned-app-tree-"));
  const logDir = path.join(root, "logs");
  const descendantPidPath = path.join(root, "descendant.pid");
  fs.mkdirSync(logDir, { recursive: true });
  const runtime = new AppRuntimeManager(storagePaths(root), createManagedAppRegistry([]));
  const script = String.raw`
    const fs = require("node:fs");
    const { spawn } = require("node:child_process");
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    child.unref();
    fs.writeFileSync(process.argv[1], String(child.pid));
  `;
  runtime.spawnLogged(process.execPath, ["-e", script, descendantPidPath], process.env, logDir, "tree.log", root);
  await waitForFile(descendantPidPath);
  const descendantPid = Number(fs.readFileSync(descendantPidPath, "utf8"));
  t.after(() => {
    if (!processExists(descendantPid)) return;
    try { process.kill(descendantPid, "SIGKILL"); } catch {}
  });

  await waitForProcessExit(descendantPid);
  await runtime.stopAll();
});

test("terminal GUI provider applies xterm behavior to matching custom launchers", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-xterm-provider-"));
  const runtime = new AppRuntimeManager(storagePaths(root));
  const args = runtime.guiArgs({ id: "custom-xterm", name: "Custom Xterm", kind: "gui", command: "/usr/bin/xterm" }, root, 0, []);
  assert.deepEqual(args.slice(0, 4), ["-fa", process.env.TASK_HANDOFF_XTERM_FONT_FAMILY || "Monospace", "-fs", process.env.TASK_HANDOFF_XTERM_FONT_SIZE || "11"]);
  runtime.stopAll();
});

test("app inventory keeps available and missing custom apps without exposing launch configuration", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-app-inventory-"));
  const binDir = path.join(root, "bin");
  fs.mkdirSync(binDir, { recursive: true });
  const executable = path.join(binDir, "available-app");
  fs.writeFileSync(executable, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  fs.mkdirSync(path.join(root, "app-catalog"), { recursive: true });
  fs.writeFileSync(path.join(root, "app-catalog", "custom.json"), JSON.stringify({
    schemaVersion: 1,
    futureTopLevel: true,
    items: [
      {
        id: "available-custom",
        name: "Available Custom",
        kind: "tty",
        command: executable,
        args: ["--token", "secret-value"],
        env: { APP_SECRET: "secret-value" },
        futureItemField: true,
      },
      {
        id: "missing-custom",
        name: "Missing Custom",
        kind: "gui",
        command: path.join(binDir, "missing-app"),
      },
    ],
  }));

  const repository = new AppCatalogRepository(storagePaths(root));
  const inventory = repository.inventory("2026-07-15T00:00:00.000Z");
  const available = inventory.items.find((item) => item.id === "available-custom");
  const missing = inventory.items.find((item) => item.id === "missing-custom");
  assert.equal(available.availability, "available");
  assert.equal(available.source, "custom");
  assert.equal(missing.availability, "missing-dependency");
  assert.equal(missing.diagnosticCode, "APP_EXECUTABLE_NOT_FOUND");
  assert.equal(JSON.stringify(inventory).includes("secret-value"), false);
  assert.equal(JSON.stringify(inventory).includes("APP_SECRET"), false);
  assert.deepEqual(inventory.issues, []);
});

test("app inventory recovers valid custom entries and reports a sanitized issue", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-app-inventory-invalid-"));
  const appCatalogDir = path.join(root, "app-catalog");
  fs.mkdirSync(appCatalogDir, { recursive: true });
  fs.writeFileSync(path.join(appCatalogDir, "custom.json"), JSON.stringify({
    schemaVersion: 1,
    items: [
      { id: "valid-custom", name: "Valid Custom", kind: "tty", command: "/definitely/missing" },
      { id: "invalid custom", name: "Invalid Custom", kind: "tty", command: "/bin/sh" },
    ],
  }));
  const repository = new AppCatalogRepository(storagePaths(root));
  const first = repository.inventory("2026-07-15T00:00:00.000Z");
  const second = repository.inventory("2026-07-15T00:00:01.000Z");
  assert.equal(first.items.some((item) => item.id === "valid-custom"), true);
  assert.equal(first.items.some((item) => item.id === "invalid custom"), false);
  assert.deepEqual(first.issues, [{
    code: "APP_CATALOG_INVALID",
    message: "Custom app catalog could not be read completely; valid catalog entries remain available.",
  }]);
  assert.equal(second.observedAt, "2026-07-15T00:00:01.000Z");
  assert.deepEqual(second.items, first.items);

  repository.saveCustom({ schemaVersion: 1, items: [{ id: "new-custom", name: "New Custom", kind: "tty", command: "/definitely/missing" }] });
  const updated = repository.inventory("2026-07-15T00:00:02.000Z");
  assert.equal(updated.items.some((item) => item.id === "valid-custom"), false);
  assert.equal(updated.items.some((item) => item.id === "new-custom"), true);
  assert.deepEqual(updated.issues, []);
});
