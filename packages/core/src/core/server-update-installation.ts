import fs from "node:fs";
import path from "node:path";
import { acquireProcessSingletonLock } from "./process-singleton-lock.ts";

export const SERVER_UPDATE_LOCK_PATH = "/run/task-handoff-server-update.lock";

export function acquireServerUpdateLock(lockPath = SERVER_UPDATE_LOCK_PATH, options: { legacyGraceMs?: number } = {}) {
  const lock = acquireProcessSingletonLock(lockPath, {
    component: "server-update",
    incompleteLockStaleMs: options.legacyGraceMs ?? 30_000,
    error: { label: "TaskHandoff server update", code: "SERVER_UPDATE_ALREADY_RUNNING" },
  });
  return lock.release;
}

export function cleanUpServerUpdateLockOnSignals(releaseLock: () => void) {
  const handlers = new Map<NodeJS.Signals, () => void>();
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    const handler = () => {
      releaseLock();
      process.removeListener(signal, handler);
      process.kill(process.pid, signal);
    };
    handlers.set(signal, handler);
    process.on(signal, handler);
  }
  return () => {
    for (const [signal, handler] of handlers) process.removeListener(signal, handler);
  };
}

export function globalPrefixFromModulePath(modulePath: string) {
  let current = path.resolve(modulePath);
  while (current !== path.dirname(current)) {
    if (path.basename(current) === "node_modules" && path.basename(path.dirname(current)) === "lib") {
      return path.dirname(path.dirname(current));
    }
    current = path.dirname(current);
  }
  return undefined;
}

function parseEnvFile(file: string) {
  const values: Record<string, string> = {};
  if (!fs.existsSync(file)) return values;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator > 0) values[line.slice(0, separator)] = line.slice(separator + 1);
  }
  return values;
}

function serviceUser(unit: string) {
  if (!fs.existsSync(unit)) return "root";
  return fs.readFileSync(unit, "utf8").match(/^User=(.+)$/m)?.[1] || "root";
}

export function currentServerInstallArgs(options: {
  controlPlaneEnvFile?: string;
  nodeAgentEnvFile?: string;
  nodeAgentUnitFile?: string;
} = {}) {
  const controlPlane = parseEnvFile(options.controlPlaneEnvFile || "/etc/task-handoff/control-plane.env");
  const nodeAgent = parseEnvFile(options.nodeAgentEnvFile || "/etc/task-handoff/node-agent.env");
  return [
    "--service-user", serviceUser(options.nodeAgentUnitFile || "/etc/systemd/system/task-handoff-node-agent.service"),
    "--control-plane-data-dir", controlPlane.TASK_HANDOFF_CONTROL_PLANE_DATA_DIR || "/var/lib/task-handoff/control-plane",
    "--node-agent-data-dir", nodeAgent.TASK_HANDOFF_NODE_AGENT_DATA_DIR || "/var/lib/task-handoff/node-agent",
    "--control-plane-host", controlPlane.TASK_HANDOFF_CONTROL_PLANE_HOST || "0.0.0.0",
    "--control-plane-port", controlPlane.TASK_HANDOFF_CONTROL_PLANE_PORT || "8081",
    "--node-agent-host", nodeAgent.TASK_HANDOFF_NODE_AGENT_HOST || "127.0.0.1",
    "--node-agent-port", nodeAgent.TASK_HANDOFF_NODE_AGENT_PORT || "8091",
    "--node-agent-ipc-path", nodeAgent.TASK_HANDOFF_NODE_AGENT_IPC_PATH || "/run/task-handoff/node-agent.sock",
    "--auth-mode", controlPlane.TASK_HANDOFF_CONTROL_PLANE_AUTH_MODE || "password",
    ...(controlPlane.TASK_HANDOFF_CONTROL_PLANE_STATIC_DIR
      ? ["--static-dir", controlPlane.TASK_HANDOFF_CONTROL_PLANE_STATIC_DIR]
      : []),
  ];
}
