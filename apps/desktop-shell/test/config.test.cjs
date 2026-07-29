const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");
const {
  buildControlPlaneArgs,
  buildDesktopChildProcessEnv,
  buildNodeAgentArgs,
  controlPlaneUrl,
  nodeAgentUrl,
  resolveControlPlaneAuthMode,
  resolveControlPlaneHost,
  resolveControlPlanePort,
  resolveDataDir,
  resolveDesktopProcessCwd,
  resolveDesktopProcessEnv,
  resolveDesktopRuntimeRoot,
  resolveNodeAgentControlEndpoint,
  resolveNodeAgentDataDir,
  resolveNodeAgentHost,
  resolveNodeAgentIpcPath,
  resolveNodeAgentPort,
  resolveNodeCommand,
  resolveStaticDir,
} = require("../src/config.cjs");

test("desktop config resolves control plane defaults", () => {
  const env = {};
  assert.equal(resolveControlPlaneHost(env), "127.0.0.1");
  assert.equal(resolveControlPlanePort(env), 18081);
  assert.equal(resolveControlPlaneAuthMode(env), "disabled");
  assert.equal(controlPlaneUrl({ env }), "http://127.0.0.1:18081");
  assert.equal(resolveNodeAgentHost(env), "127.0.0.1");
  assert.equal(resolveNodeAgentPort(env), 18091);
  assert.equal(nodeAgentUrl({ env }), "http://127.0.0.1:18091");
  assert.match(resolveDataDir(env), /desktop-control-plane$/);
  assert.match(resolveNodeAgentDataDir(env), /desktop-control-plane\/node-agent$/);
  assert.match(resolveNodeAgentIpcPath(env), /task-handoff-node-agent-.+\.sock$/);
  assert.match(resolveNodeAgentControlEndpoint(env), /^ipc:\/\//);
});

test("desktop config honors environment overrides", () => {
  const env = {
    TASK_HANDOFF_DESKTOP_CONTROL_PLANE_HOST: "0.0.0.0",
    TASK_HANDOFF_DESKTOP_CONTROL_PLANE_PORT: "19091",
    TASK_HANDOFF_DESKTOP_NODE_AGENT_HOST: "0.0.0.0",
    TASK_HANDOFF_DESKTOP_NODE_AGENT_PORT: "19092",
    TASK_HANDOFF_DESKTOP_DATA_DIR: "/tmp/task-handoff-desktop",
    TASK_HANDOFF_DESKTOP_NODE_AGENT_DATA_DIR: "/tmp/task-handoff-node-agent",
    TASK_HANDOFF_DESKTOP_NODE_AGENT_IPC_PATH: "/tmp/task-handoff-node-agent.sock",
    TASK_HANDOFF_DESKTOP_NODE_AGENT_CONTROL_ENDPOINT: "ipc://custom",
    TASK_HANDOFF_DESKTOP_CONTROL_PLANE_AUTH_MODE: "password",
    TASK_HANDOFF_CONTROL_PLANE_STATIC_DIR: "/tmp/static",
  };
  assert.equal(resolveControlPlaneHost(env), "0.0.0.0");
  assert.equal(resolveControlPlanePort(env), 19091);
  assert.equal(resolveNodeAgentHost(env), "0.0.0.0");
  assert.equal(resolveNodeAgentPort(env), 19092);
  assert.equal(nodeAgentUrl({ env }), "http://0.0.0.0:19092");
  assert.equal(resolveDataDir(env), "/tmp/task-handoff-desktop");
  assert.equal(resolveNodeAgentDataDir(env), "/tmp/task-handoff-node-agent");
  assert.equal(resolveNodeAgentIpcPath(env), "/tmp/task-handoff-node-agent.sock");
  assert.equal(resolveNodeAgentControlEndpoint(env), "ipc://custom");
  assert.equal(resolveControlPlaneAuthMode(env), "password");
  assert.equal(resolveStaticDir("/repo", env), "/tmp/static");
});

test("desktop config uses the Electron executable as Node in packaged builds", () => {
  assert.equal(resolveNodeCommand({}, { packaged: false, execPath: "/app/TaskHandoff" }), "node");
  assert.equal(resolveNodeCommand({}, { packaged: true, execPath: "/app/TaskHandoff" }), "/app/TaskHandoff");
  assert.equal(resolveNodeCommand({ TASK_HANDOFF_NODE: "/usr/local/bin/node" }, { packaged: true, execPath: "/app/TaskHandoff" }), "/usr/local/bin/node");
});

test("desktop child processes use a real writable cwd in packaged builds", () => {
  assert.equal(resolveDesktopProcessCwd({}, { packaged: false, root: "/repo" }), path.resolve("/repo"));
  assert.equal(resolveDesktopProcessCwd({}, { packaged: true, dataDir: "/tmp/task-handoff-data" }), path.resolve("/tmp/task-handoff-data"));
  assert.equal(
    resolveDesktopProcessCwd({ TASK_HANDOFF_DESKTOP_PROCESS_CWD: "/tmp/custom-cwd" }, { packaged: true, dataDir: "/tmp/task-handoff-data" }),
    path.resolve("/tmp/custom-cwd"),
  );
});

test("desktop child process environment preserves inherited paths and adds macOS executable locations", () => {
  const env = resolveDesktopProcessEnv({ PATH: "/custom/bin:/usr/bin", TOKEN: "kept" }, { platform: "darwin" });
  assert.equal(env.TOKEN, "kept");
  assert.deepEqual(env.PATH.split(path.delimiter), [
    "/custom/bin",
    "/usr/bin",
    "/usr/local/bin",
    "/opt/homebrew/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
  ]);
});

test("desktop child process environment adds Linux executable locations without duplicates", () => {
  const env = resolveDesktopProcessEnv({ PATH: "/usr/bin:/custom/bin:/usr/local/bin" }, { platform: "linux" });
  assert.deepEqual(env.PATH.split(path.delimiter), [
    "/usr/bin",
    "/custom/bin",
    "/usr/local/bin",
    "/usr/local/sbin",
    "/usr/sbin",
    "/sbin",
    "/bin",
    "/snap/bin",
  ]);
});

test("desktop child process environment does not rewrite PATH on unsupported platforms", () => {
  const source = { Path: "C:\\custom", CUSTOM: "kept" };
  assert.deepEqual(resolveDesktopProcessEnv(source, { platform: "win32" }), source);
});

test("Windows desktop child processes receive the packaged application version", () => {
  const env = buildDesktopChildProcessEnv({ Path: "C:\\custom", KEEP: "yes" }, {
    platform: "win32",
    packaged: true,
    version: "0.0.9",
  });
  assert.equal(env.Path, "C:\\custom");
  assert.equal(env.KEEP, "yes");
  assert.equal(env.ELECTRON_RUN_AS_NODE, "1");
  assert.equal(env.TASK_HANDOFF_VERSION, "0.0.9");
});

test("desktop child process environment materializes packaged runtime identity and structured overrides", () => {
  const env = buildDesktopChildProcessEnv({ PATH: "/custom/bin", KEEP: "yes" }, {
    platform: "darwin",
    packaged: true,
    version: "2.3.4",
    overrides: {
      TASK_HANDOFF_LOCAL_CONTROLLED_COMMAND_ARGV: JSON.stringify(["/app/TaskHandoff", "/runtime/bin/task-handoff.js", "web"]),
    },
  });
  assert.equal(env.KEEP, "yes");
  assert.equal(env.ELECTRON_RUN_AS_NODE, "1");
  assert.equal(env.TASK_HANDOFF_VERSION, "2.3.4");
  assert.deepEqual(JSON.parse(env.TASK_HANDOFF_LOCAL_CONTROLLED_COMMAND_ARGV), ["/app/TaskHandoff", "/runtime/bin/task-handoff.js", "web"]);
  assert.ok(env.PATH.includes("/opt/homebrew/bin"));
});

test("desktop packaged runtime resolves to real unpacked resources", () => {
  assert.equal(resolveDesktopRuntimeRoot({ packaged: false, root: "/repo" }), path.resolve("/repo"));
  assert.equal(
    resolveDesktopRuntimeRoot({ packaged: true, resourcesPath: "/Applications/TaskHandoff.app/Contents/Resources" }),
    path.join("/Applications/TaskHandoff.app/Contents/Resources", "app.asar.unpacked"),
  );
  assert.throws(() => resolveDesktopRuntimeRoot({ packaged: true }), /resources path is required/);
});

test("desktop config builds control plane cli args", () => {
  const root = path.resolve("/repo");
  const args = buildControlPlaneArgs({
    root,
    env: {},
    cliEntry: "/repo/bin/task-handoff.js",
    dataDir: "/tmp/data",
    staticDir: "/repo/packages/control-plane-ui/dist",
  });
  assert.deepEqual(args, [
    "/repo/bin/task-handoff.js",
    "control-plane",
    "--host",
    "127.0.0.1",
    "--port",
    "18081",
    "--data-dir",
    "/tmp/data",
    "--static-dir",
    "/repo/packages/control-plane-ui/dist",
    "--auth-mode",
    "disabled",
  ]);
});

test("desktop config builds node agent cli args", () => {
  const root = path.resolve("/repo");
  const args = buildNodeAgentArgs({
    root,
    env: {},
    cliEntry: "/repo/bin/task-handoff.js",
  });
  assert.deepEqual(args, [
    "/repo/bin/task-handoff.js",
    "node-agent",
    "--host",
    "127.0.0.1",
    "--port",
    "18091",
    "--data-dir",
    path.join(process.env.HOME, ".config", "task-handoff", "desktop-control-plane", "node-agent"),
    "--connection-mode",
    "local-ipc",
    "--ipc-path",
    resolveNodeAgentIpcPath({}),
  ]);
});
