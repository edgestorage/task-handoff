const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { setTimeout: delay } = require("node:timers/promises");

const DESKTOP_NODE_AGENT_GRACEFUL_TIMEOUT_MS = 20_000;
const DESKTOP_NODE_AGENT_FORCE_TIMEOUT_MS = 2_000;

function resolveNodeAgentSingletonLockPath(options = {}) {
  const override = options.env?.TASK_HANDOFF_NODE_AGENT_LOCK_PATH || process.env.TASK_HANDOFF_NODE_AGENT_LOCK_PATH;
  if (override?.trim()) return path.resolve(override.trim());
  const temporaryDirectory = options.tmpdir || os.tmpdir();
  const userId = options.uid ?? process.getuid?.() ?? "user";
  return path.join(temporaryDirectory, `task-handoff-node-agent-${userId}.lock`);
}

function resolveControlPlaneSingletonLockPath(options = {}) {
  const override = options.env?.TASK_HANDOFF_CONTROL_PLANE_LOCK_PATH || process.env.TASK_HANDOFF_CONTROL_PLANE_LOCK_PATH;
  if (override?.trim()) return path.resolve(override.trim());
  const temporaryDirectory = options.tmpdir || os.tmpdir();
  const userId = options.uid ?? process.getuid?.() ?? "user";
  return path.join(temporaryDirectory, `task-handoff-control-plane-${userId}.lock`);
}

function readControlPlaneLockOwner(lockPath) {
  try {
    const value = JSON.parse(fs.readFileSync(path.join(lockPath, "owner.json"), "utf8"));
    if (
      value?.component !== "control-plane"
      || !Number.isInteger(value.pid)
      || value.pid <= 0
      || typeof value.token !== "string"
      || !value.token
    ) {
      return undefined;
    }
    return value;
  } catch {
    return undefined;
  }
}

function readNodeAgentLockOwner(lockPath) {
  try {
    const value = JSON.parse(fs.readFileSync(path.join(lockPath, "owner.json"), "utf8"));
    if (
      value?.component !== "node-agent"
      || !Number.isInteger(value.pid)
      || value.pid <= 0
      || typeof value.dataDir !== "string"
      || !value.dataDir
      || typeof value.token !== "string"
      || !value.token
    ) {
      return undefined;
    }
    return value;
  } catch {
    return undefined;
  }
}

function sameLockOwner(left, right) {
  return Boolean(left && right && left.pid === right.pid && left.token === right.token);
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function processStartIdentity(pid, platform = process.platform) {
  if (!Number.isInteger(pid) || pid <= 0) return undefined;
  if (platform === "linux") {
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
      const commandEnd = stat.lastIndexOf(")");
      if (commandEnd < 0) return undefined;
      const startTime = stat.slice(commandEnd + 2).trim().split(/\s+/)[19];
      return startTime ? `linux:${startTime}` : undefined;
    } catch {
      return undefined;
    }
  }
  if (["darwin", "freebsd", "openbsd", "aix", "sunos"].includes(platform)) {
    const result = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8", timeout: 1_000 });
    const startedAt = result.status === 0 ? result.stdout.trim().replace(/\s+/g, " ") : "";
    return startedAt ? `${platform}:${startedAt}` : undefined;
  }
  if (platform === "win32") {
    const command = `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().Ticks`;
    const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], { encoding: "utf8", timeout: 2_000 });
    const ticks = result.status === 0 ? result.stdout.trim() : "";
    return /^\d+$/.test(ticks) ? `win32:${ticks}` : undefined;
  }
  return undefined;
}

function inspectExistingDesktopControlPlane(options = {}) {
  const lockPath = options.lockPath || resolveControlPlaneSingletonLockPath();
  const readOwner = options.readOwner || readControlPlaneLockOwner;
  const isAlive = options.isAlive || processIsAlive;
  const processIdentity = options.processIdentity || processStartIdentity;
  const owner = readOwner(lockPath);
  if (!owner || !isAlive(owner.pid)) return { status: owner ? "stale" : "absent", owner };
  if (!owner.startIdentity) return { status: "unverified", owner };
  const currentStartIdentity = processIdentity(owner.pid);
  if (!currentStartIdentity) return { status: "unverified", owner };
  if (currentStartIdentity !== owner.startIdentity) return { status: "stale", owner };
  return { status: "running", owner };
}

function inspectStartedDesktopControlPlane(options) {
  const inspection = inspectExistingDesktopControlPlane(options.inspectOptions);
  if (inspection.status !== "running") return inspection;
  const owner = inspection.owner;
  if (
    owner.pid !== options.pid
    || path.resolve(owner.dataDir || "") !== path.resolve(options.dataDir)
    || owner.host !== options.host
    || Number(owner.port) !== options.port
  ) {
    return { status: "foreign", owner };
  }
  return inspection;
}

function inspectExistingDesktopNodeAgent(options = {}) {
  const lockPath = options.lockPath || resolveNodeAgentSingletonLockPath();
  const readOwner = options.readOwner || readNodeAgentLockOwner;
  const isAlive = options.isAlive || processIsAlive;
  const processIdentity = options.processIdentity || processStartIdentity;
  const owner = readOwner(lockPath);
  if (!owner) return { status: "absent" };
  if (path.resolve(owner.dataDir) !== path.resolve(options.dataDir)) return { status: "foreign", owner };
  if (!isAlive(owner.pid)) return { status: "stale", owner };
  if (!owner.startIdentity) return { status: "unverified", owner };
  const currentStartIdentity = processIdentity(owner.pid);
  if (!currentStartIdentity) return { status: "unverified", owner };
  if (currentStartIdentity !== owner.startIdentity) return { status: "stale", owner };
  return { status: "running", owner };
}

async function ensureDesktopNodeAgent(options) {
  const inspection = inspectExistingDesktopNodeAgent({
    dataDir: options.dataDir,
    ...(options.inspectOptions || {}),
  });
  if (inspection.status === "foreign") {
    throw new Error(
      `A node agent outside this Desktop installation is already running pid=${inspection.owner.pid} dataDir=${inspection.owner.dataDir}.`,
    );
  }
  if (inspection.status === "unverified") {
    throw new Error(`The existing Desktop node agent pid=${inspection.owner.pid} could not be verified and was not stopped.`);
  }
  if (inspection.status === "running") {
    const replaced = await stopExistingDesktopNodeAgent({
      dataDir: options.dataDir,
      logInfo: options.logInfo,
      logError: options.logError,
      ...(options.inspectOptions || {}),
      ...(options.stopOptions || {}),
    });
    if (["foreign", "unverified"].includes(replaced.status)) {
      throw new Error("The existing node agent changed ownership while Desktop was preparing its replacement.");
    }
  }
  const child = options.start();
  const health = await options.waitUntilReady(child);
  return { action: "started", child, health };
}

function lockOwnerMatchesProcess(owner, options) {
  if (!owner.startIdentity || !options.isAlive(owner.pid)) return false;
  return options.processIdentity(owner.pid) === owner.startIdentity;
}

async function waitForOwnerExit(owner, options) {
  const deadline = Date.now() + options.timeoutMs;
  while (Date.now() < deadline) {
    if (!lockOwnerMatchesProcess(owner, options) || !sameLockOwner(options.readOwner(options.lockPath), owner)) {
      return true;
    }
    await options.wait(options.pollMs);
  }
  return !lockOwnerMatchesProcess(owner, options) || !sameLockOwner(options.readOwner(options.lockPath), owner);
}

async function stopExistingDesktopNodeAgent(options) {
  const startedAt = Date.now();
  const lockPath = options.lockPath || resolveNodeAgentSingletonLockPath();
  const readOwner = options.readOwner || readNodeAgentLockOwner;
  const isAlive = options.isAlive || processIsAlive;
  const processIdentity = options.processIdentity || processStartIdentity;
  const signal = options.signal || ((pid, value) => process.kill(pid, value));
  const wait = options.wait || delay;
  const inspection = inspectExistingDesktopNodeAgent({
    dataDir: options.dataDir,
    lockPath,
    readOwner,
    isAlive,
    processIdentity,
  });
  if (inspection.status !== "running") return inspection;
  const owner = inspection.owner;

  options.logInfo?.(`[desktop-shell] stopping previous desktop node agent pid=${owner.pid}`);
  try {
    signal(owner.pid, "SIGTERM");
  } catch (error) {
    if (error?.code === "ESRCH") return { status: "stopped", owner };
    throw error;
  }

  const common = {
    lockPath,
    readOwner,
    isAlive,
    processIdentity,
    wait,
    pollMs: options.pollMs ?? 100,
  };
  if (await waitForOwnerExit(owner, { ...common, timeoutMs: options.gracefulTimeoutMs ?? DESKTOP_NODE_AGENT_GRACEFUL_TIMEOUT_MS })) {
    options.logInfo?.(`[desktop-shell] previous desktop node agent stopped pid=${owner.pid} elapsedMs=${Date.now() - startedAt}`);
    return { status: "stopped", owner };
  }

  const currentOwner = readOwner(lockPath);
  if (!sameLockOwner(currentOwner, owner)) {
    return { status: "stopped", owner };
  }
  if (!lockOwnerMatchesProcess(owner, common)) {
    return { status: "stopped", owner };
  }
  options.logError?.(`[desktop-shell] forcing previous desktop node agent to stop pid=${owner.pid} startIdentity=${owner.startIdentity} elapsedMs=${Date.now() - startedAt}`);
  try {
    signal(owner.pid, "SIGKILL");
  } catch (error) {
    if (error?.code === "ESRCH") return { status: "stopped", owner };
    throw error;
  }
  if (await waitForOwnerExit(owner, { ...common, timeoutMs: options.forceTimeoutMs ?? DESKTOP_NODE_AGENT_FORCE_TIMEOUT_MS })) {
    return { status: "forced", owner };
  }
  throw new Error(`Previous desktop node agent pid=${owner.pid} did not exit.`);
}

module.exports = {
  DESKTOP_NODE_AGENT_FORCE_TIMEOUT_MS,
  DESKTOP_NODE_AGENT_GRACEFUL_TIMEOUT_MS,
  ensureDesktopNodeAgent,
  inspectExistingDesktopControlPlane,
  inspectStartedDesktopControlPlane,
  inspectExistingDesktopNodeAgent,
  readControlPlaneLockOwner,
  readNodeAgentLockOwner,
  resolveControlPlaneSingletonLockPath,
  resolveNodeAgentSingletonLockPath,
  stopExistingDesktopNodeAgent,
};
