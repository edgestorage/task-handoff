const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const DEFAULT_DESKTOP_CONTROL_PLANE_PORT = 18081;
const DEFAULT_DESKTOP_NODE_AGENT_PORT = 18091;
const NODE_AGENT_IPC_ENDPOINT_PREFIX = "ipc://";

function repoRoot() {
  return path.resolve(__dirname, "..", "..", "..");
}

function resolveControlPlanePort(env = process.env) {
  const value = Number(env.TASK_HANDOFF_DESKTOP_CONTROL_PLANE_PORT || env.TASK_HANDOFF_CONTROL_PLANE_PORT || DEFAULT_DESKTOP_CONTROL_PLANE_PORT);
  return Number.isInteger(value) && value > 0 && value <= 65535 ? value : DEFAULT_DESKTOP_CONTROL_PLANE_PORT;
}

function resolveControlPlaneHost(env = process.env) {
  return env.TASK_HANDOFF_DESKTOP_CONTROL_PLANE_HOST || env.TASK_HANDOFF_CONTROL_PLANE_HOST || "127.0.0.1";
}

function resolveNodeAgentPort(env = process.env) {
  const value = Number(env.TASK_HANDOFF_DESKTOP_NODE_AGENT_PORT || env.TASK_HANDOFF_NODE_AGENT_PORT || DEFAULT_DESKTOP_NODE_AGENT_PORT);
  return Number.isInteger(value) && value > 0 && value <= 65535 ? value : DEFAULT_DESKTOP_NODE_AGENT_PORT;
}

function resolveNodeAgentHost(env = process.env) {
  return env.TASK_HANDOFF_DESKTOP_NODE_AGENT_HOST || env.TASK_HANDOFF_NODE_AGENT_HOST || "127.0.0.1";
}

function resolveDataDir(env = process.env) {
  return path.resolve(env.TASK_HANDOFF_DESKTOP_DATA_DIR || env.TASK_HANDOFF_CONTROL_PLANE_DATA_DIR || path.join(os.homedir(), ".config", "task-handoff", "desktop-control-plane"));
}

function resolveNodeAgentDataDir(env = process.env) {
  return path.resolve(env.TASK_HANDOFF_DESKTOP_NODE_AGENT_DATA_DIR || env.TASK_HANDOFF_NODE_AGENT_DATA_DIR || path.join(resolveDataDir(env), "node-agent"));
}

function resolveNodeAgentIpcPath(env = process.env) {
  if (env.TASK_HANDOFF_DESKTOP_NODE_AGENT_IPC_PATH || env.TASK_HANDOFF_NODE_AGENT_IPC_PATH) {
    return path.resolve(env.TASK_HANDOFF_DESKTOP_NODE_AGENT_IPC_PATH || env.TASK_HANDOFF_NODE_AGENT_IPC_PATH);
  }
  const hash = require("node:crypto").createHash("sha256").update(resolveNodeAgentDataDir(env)).digest("hex").slice(0, 16);
  if (process.platform === "win32") {
    return `\\\\.\\pipe\\task-handoff-node-agent-${hash}`;
  }
  return path.join("/tmp", `task-handoff-node-agent-${process.getuid?.() ?? "user"}`, `${hash}.sock`);
}

function nodeAgentIpcEndpoint(socketPath) {
  return `${NODE_AGENT_IPC_ENDPOINT_PREFIX}${encodeURIComponent(socketPath)}`;
}

function resolveNodeAgentControlEndpoint(env = process.env) {
  return env.TASK_HANDOFF_DESKTOP_NODE_AGENT_CONTROL_ENDPOINT || env.TASK_HANDOFF_NODE_AGENT_CONTROL_ENDPOINT || nodeAgentIpcEndpoint(resolveNodeAgentIpcPath(env));
}

function resolveControlPlaneAuthMode(env = process.env) {
  const value = env.TASK_HANDOFF_DESKTOP_CONTROL_PLANE_AUTH_MODE || env.TASK_HANDOFF_CONTROL_PLANE_AUTH_MODE || "disabled";
  return value === "password" ? "password" : "disabled";
}

function resolveStaticDir(root = repoRoot(), env = process.env) {
  return path.resolve(env.TASK_HANDOFF_CONTROL_PLANE_STATIC_DIR || path.join(root, "packages", "control-plane-ui", "dist"));
}

function resolveCliEntry(root = repoRoot(), env = process.env) {
  return path.resolve(env.TASK_HANDOFF_DESKTOP_CLI || path.join(root, "bin", "task-handoff.js"));
}

function resolveNodeCommand(env = process.env, options = {}) {
  return env.TASK_HANDOFF_NODE || env.NODE || (options.packaged ? options.execPath || process.execPath : "node");
}

function controlPlaneUrl(options = {}) {
  const host = options.host || resolveControlPlaneHost(options.env);
  const port = options.port || resolveControlPlanePort(options.env);
  return `http://${host}:${port}`;
}

function nodeAgentUrl(options = {}) {
  const host = options.host || resolveNodeAgentHost(options.env);
  const port = options.port || resolveNodeAgentPort(options.env);
  return `http://${host}:${port}`;
}

function buildControlPlaneArgs(options = {}) {
  const root = options.root || repoRoot();
  const env = options.env || process.env;
  const host = options.host || resolveControlPlaneHost(env);
  const port = options.port || resolveControlPlanePort(env);
  const dataDir = options.dataDir || resolveDataDir(env);
  const staticDir = options.staticDir || resolveStaticDir(root, env);
  const cliEntry = options.cliEntry || resolveCliEntry(root, env);
  return [
    cliEntry,
    "control-plane",
    "--host",
    host,
    "--port",
    String(port),
    "--data-dir",
    dataDir,
    "--static-dir",
    staticDir,
    "--auth-mode",
    resolveControlPlaneAuthMode(env),
  ];
}

function buildNodeAgentArgs(options = {}) {
  const root = options.root || repoRoot();
  const env = options.env || process.env;
  const host = options.host || resolveNodeAgentHost(env);
  const port = options.port || resolveNodeAgentPort(env);
  const dataDir = options.dataDir || resolveNodeAgentDataDir(env);
  const ipcPath = options.ipcPath || resolveNodeAgentIpcPath(env);
  const cliEntry = options.cliEntry || resolveCliEntry(root, env);
  return [
    cliEntry,
    "node-agent",
    "--host",
    host,
    "--port",
    String(port),
    "--data-dir",
    dataDir,
    "--connection-mode",
    "local-ipc",
    "--ipc-path",
    ipcPath,
  ];
}

function validateDesktopInputs(options = {}) {
  const root = options.root || repoRoot();
  const staticDir = options.staticDir || resolveStaticDir(root, options.env || process.env);
  const cliEntry = options.cliEntry || resolveCliEntry(root, options.env || process.env);
  return {
    cliEntry,
    cliReady: fs.existsSync(cliEntry),
    staticDir,
    staticReady: fs.existsSync(path.join(staticDir, "index.html")),
  };
}

module.exports = {
  buildControlPlaneArgs,
  buildNodeAgentArgs,
  controlPlaneUrl,
  nodeAgentUrl,
  repoRoot,
  resolveCliEntry,
  resolveControlPlaneAuthMode,
  resolveControlPlaneHost,
  resolveControlPlanePort,
  resolveDataDir,
  resolveNodeAgentControlEndpoint,
  resolveNodeAgentDataDir,
  resolveNodeAgentHost,
  resolveNodeAgentIpcPath,
  resolveNodeAgentPort,
  resolveNodeCommand,
  resolveStaticDir,
  validateDesktopInputs,
};
