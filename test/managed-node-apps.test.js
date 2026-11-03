const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");
const ts = require("typescript");
require("./workspace-require.js").registerWorkspaceRequire();
require.extensions[".ts"] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, "utf8"), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true }, fileName: filename,
}).outputText, filename);
const { ManagedNodeApps, managedNodePackageBin } = require("../packages/app-runtime/src/managed-node-apps.ts");
const { builtinManagedAppDefinitions } = require("../packages/app-runtime/src/catalog.ts");
const { AppRuntimeManager } = require("../packages/app-runtime/src/runtime.ts");

function executable(file, body) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
}

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "instance managed apps '"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const managedRoot = path.join(root, "managed-apps");
  const hostBin = path.join(root, "host-bin");
  const home = path.join(root, "home");
  fs.mkdirSync(home, { recursive: true });
  for (const command of ["codex", "claude", "opencode"]) executable(path.join(hostBin, command), "printf host-version");
  const env = { ...process.env, HOME: home, PATH: `${hostBin}${path.delimiter}${process.env.PATH}`, SHELL: "/bin/bash" };
  delete env.ZDOTDIR;
  delete env.TASK_HANDOFF_SHELL_USER_ZDOTDIR;
  delete env.TASK_HANDOFF_SHELL_COMMAND;
  const apps = new ManagedNodeApps(managedRoot, builtinManagedAppDefinitions());
  return { root, managedRoot, hostBin, home, env, apps };
}

test("managed commands reject host fallback before install and after uninstall", { skip: process.platform === "win32" }, (t) => {
  const { managedRoot, env, apps } = fixture(t);
  const launchEnv = apps.environment(env);
  for (const command of ["codex", "claude", "opencode"]) {
    let result = spawnSync(command, [], { env: launchEnv, encoding: "utf8" });
    assert.equal(result.status, 127);
    assert.match(result.stderr, /not installed in this instance/);
    assert.equal(result.stdout, "");
    const target = path.join(managedNodePackageBin(managedRoot, command), command);
    executable(target, "printf 'managed:%s:%s:%s' \"$1\" \"${DISABLE_AUTOUPDATER:-}\" \"${OPENCODE_DISABLE_AUTOUPDATE:-}\"");
    result = spawnSync(command, ["argument with spaces"], { env: launchEnv, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, `managed:argument with spaces:${command === "claude" ? "1" : ""}:${command === "opencode" ? "1" : ""}`);
    fs.rmSync(target);
    assert.equal(spawnSync(command, [], { env: launchEnv }).status, 127);
  }
  assert.equal(spawnSync("node", ["--version"], { env: launchEnv }).status, 0);
});

for (const shell of ["/bin/bash", "/bin/zsh"]) {
  test(`${shell} startup cannot redirect managed commands to host aliases or functions`, { skip: process.platform === "win32" || !fs.existsSync(shell) }, (t) => {
    const { managedRoot, hostBin, home, env, apps } = fixture(t);
    for (const command of ["codex", "claude", "opencode"]) {
      const target = path.join(managedNodePackageBin(managedRoot, command), command);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, `#!/usr/bin/env node\nconsole.log('${command}-managed');\n`, { mode: 0o755 });
    }
    const rc = `export PATH='${hostBin.replaceAll("'", "'\\''")}':/usr/bin:/bin\nalias codex='printf codex-host'\nclaude() { printf claude-host; }\nexport USER_STARTUP_RAN=yes\n`;
    fs.writeFileSync(path.join(home, shell.endsWith("zsh") ? ".zshrc" : ".bashrc"), rc);
    const prepared = apps.prepareShell(shell, ["-ic", "codex; claude; opencode; printf '%s' \"$USER_STARTUP_RAN\""], env);
    const result = spawnSync(shell, prepared.args, { env: prepared.env, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "codex-managed\nclaude-managed\nopencode-managed\nyes");
  });
}

test("apps inherit a managed SHELL and app launch cannot use a global command override", { skip: process.platform === "win32" }, (t) => {
  const { root, managedRoot, hostBin, env, apps } = fixture(t);
  const shellEnv = apps.terminalEnvironment(env);
  const absent = spawnSync(shellEnv.SHELL, ["-c", "claude"], { env: shellEnv, encoding: "utf8" });
  assert.equal(absent.status, 127);
  executable(path.join(managedNodePackageBin(managedRoot, "claude"), "claude"), "printf private-claude");
  const inherited = spawnSync("/bin/sh", ["-c", '"$SHELL" -c claude'], { env: shellEnv, encoding: "utf8" });
  assert.equal(inherited.status, 0, inherited.stderr);
  assert.equal(inherited.stdout, "private-claude");
  const previous = process.env.TASK_HANDOFF_CLAUDE_COMMAND;
  process.env.TASK_HANDOFF_CLAUDE_COMMAND = path.join(hostBin, "claude");
  const paths = { dataDir: root, appCatalogDir: path.join(root, "catalog"), appSessionsDir: path.join(root, "sessions"), logDir: path.join(root, "logs"), runtimeDir: path.join(root, "runtime") };
  const runtime = new AppRuntimeManager(paths);
  t.after(() => { runtime.stopAll(); if (previous === undefined) delete process.env.TASK_HANDOFF_CLAUDE_COMMAND; else process.env.TASK_HANDOFF_CLAUDE_COMMAND = previous; });
  assert.equal(runtime.appInventory().items.find((app) => app.id === "claude").availability, "available");
  fs.rmSync(path.join(managedNodePackageBin(managedRoot, "claude"), "claude"));
  assert.throws(() => runtime.start("claude", { cwd: root }), (error) => error.code === "APP_DEPENDENCY_MISSING");
  runtime.setAppLaunchAdmission(() => false);
  assert.throws(() => runtime.start("terminal-tty", { cwd: root }), (error) => error.code === "APP_OPERATION_IN_PROGRESS");
});

const { EventEmitter } = require("node:events");
const { InstanceShellRuntime } = require("../packages/controlled-instance/src/web/instance-shell.ts");
const { INSTANCE_SHELL_WEBSOCKET_SUBPROTOCOL } = require("../packages/protocol/src/instance-shell.ts");
class FakeSocket extends EventEmitter {
  OPEN = 1;
  readyState = 1;
  bufferedAmount = 0;
  protocol = INSTANCE_SHELL_WEBSOCKET_SUBPROTOCOL;
  sent = [];
  send(data, options) { this.sent.push({ data, binary: options?.binary === true }); }
  close() { if (this.readyState === 3) return; this.readyState = 3; this.emit("close"); }
  sendControl(frame) { this.emit("message", Buffer.from(JSON.stringify(frame)), false); }
  waitForClose() {
    if (this.readyState === 3) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("shell did not exit")), 5000);
      this.once("close", () => { clearTimeout(timer); resolve(); });
    });
  }
}
function serverControls(socket) { return socket.sent.filter((frame) => !frame.binary).map((frame) => JSON.parse(String(frame.data))); }
function serverData(socket) { return socket.sent.filter((frame) => frame.binary).map((frame) => Buffer.from(frame.data)); }
test("instance exec and terminal share private app resolution and never use host installations", { skip: process.platform === "win32" }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "instance-shell-managed-"));
  const host = path.join(root, "host-bin");
  fs.mkdirSync(host);
  fs.writeFileSync(path.join(host, "claude"), "#!/bin/sh\nprintf host-claude\n", { mode: 0o755 });
  fs.writeFileSync(path.join(root, ".bashrc"), `export PATH="${host}:$PATH"\nalias claude='printf host-alias'\n`);
  const paths = {
    configPath: path.join(root, "config.json"), dataDir: root,
    appCatalogDir: path.join(root, "catalog"), appSessionsDir: path.join(root, "sessions"),
    runtimeDir: path.join(root, "runtime"), eventsDir: path.join(root, "events"),
    artifactDir: path.join(root, "artifacts"), logDir: path.join(root, "logs"),
    triggersDir: path.join(root, "triggers"), webTokenPath: path.join(root, "token"),
  };
  const appRuntime = new AppRuntimeManager(paths);
  const runtime = new InstanceShellRuntime({
    workspace: () => root,
    environment: () => appRuntime.processEnvironment({ ...process.env, HOME: root, SHELL: "/bin/bash", PATH: `${host}${path.delimiter}${process.env.PATH}` }),
    prepareShell: (command, args, env) => appRuntime.prepareShell(command, args, env),
  });
  t.after(async () => { await runtime.shutdown(); await appRuntime.stopAll(); fs.rmSync(root, { recursive: true, force: true }); });
  const absent = new FakeSocket();
  runtime.handle(absent);
  absent.sendControl({ type: "start", mode: "exec", command: ["claude", "--version"], tty: false });
  await absent.waitForClose();
  assert.deepEqual(serverControls(absent).at(-1), { type: "exit", code: 127 });
  const error = Buffer.concat(serverData(absent).map((frame) => frame.subarray(1))).toString("utf8");
  assert.match(error, /not installed in this instance/);
  assert.doesNotMatch(error, /host-claude/);
  const bin = path.join(root, "managed-apps/node-package/claude/node_modules/.bin");
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, "claude"), "#!/usr/bin/env node\nconsole.log('instance-claude');\n", { mode: 0o755 });
  for (const tty of [false, true]) {
    const socket = new FakeSocket();
    runtime.handle(socket);
    socket.sendControl({ type: "start", mode: "exec", command: ["/bin/bash", "-ic", "claude"], tty });
    await socket.waitForClose();
    const output = Buffer.concat(serverData(socket).map((frame) => frame.subarray(1))).toString("utf8");
    assert.match(output, /instance-claude/);
    assert.doesNotMatch(output, /host-claude|host-alias/);
  }
});
