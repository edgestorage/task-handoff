const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");
const { processStartIdentity } = require("../../../shared/process-start-identity.cjs");

const DESKTOP_CONTROL_PLANE_GRACEFUL_TIMEOUT_MS = 20_000;
const DESKTOP_CONTROL_PLANE_FORCE_TIMEOUT_MS = 2_000;
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

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
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

function sameLockOwner(expected, current) {
  return Boolean(
    expected
    && current
    && expected.pid === current.pid
    && expected.token === current.token
    && expected.startIdentity === current.startIdentity,
  );
}

async function ensureDesktopControlPlaneAvailable(options = {}) {
  const inspection = inspectExistingDesktopControlPlane(options.inspectOptions || {});
  if (inspection.status === "unverified") {
    throw new Error(`The existing Control Plane pid=${inspection.owner.pid} could not be verified.`);
  }
  if (inspection.status !== "running") {
    return { action: "clear", inspection };
  }
  if (typeof options.confirmStop !== "function") {
    throw new Error("Desktop cannot replace the existing Control Plane without user confirmation.");
  }
  if (!await options.confirmStop({ owner: inspection.owner })) {
    return { action: "cancelled", inspection };
  }

  const stopped = await stopExistingDesktopControlPlane({
    ...(options.inspectOptions || {}),
    ...(options.stopOptions || {}),
    logInfo: options.logInfo,
    logError: options.logError,
    expectedOwner: inspection.owner,
  });
  if (["stopped", "forced", "stale"].includes(stopped.status)) {
    return { action: "replaced", inspection, stopped };
  }
  if (stopped.status === "changed") {
    throw new Error(`The existing Control Plane changed while Desktop was preparing to replace it.`);
  }
  if (stopped.status === "unverified") {
    throw new Error(`The existing Control Plane pid=${inspection.owner.pid} could not be verified before it was stopped.`);
  }
  throw new Error(`The existing Control Plane pid=${inspection.owner.pid} could not be stopped (status=${stopped.status}).`);
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
    if (!lockOwnerMatchesProcess(owner, options)) {
      return true;
    }
    await options.wait(options.pollMs);
  }
  return !lockOwnerMatchesProcess(owner, options);
}

async function stopDesktopLockOwner(owner, options) {
  const startedAt = Date.now();
  const common = {
    isAlive: options.isAlive,
    processIdentity: options.processIdentity,
    wait: options.wait,
    pollMs: options.pollMs ?? 100,
  };
  if (!lockOwnerMatchesProcess(owner, common)) {
    return { status: "stale", owner };
  }

  options.logInfo?.(`[desktop-shell] stopping previous ${options.label} pid=${owner.pid}`);
  try {
    options.signal(owner.pid, "SIGTERM");
  } catch (error) {
    if (error?.code === "ESRCH") return { status: "stopped", owner };
    throw error;
  }

  if (await waitForOwnerExit(owner, { ...common, timeoutMs: options.gracefulTimeoutMs })) {
    options.logInfo?.(`[desktop-shell] previous ${options.label} stopped pid=${owner.pid} elapsedMs=${Date.now() - startedAt}`);
    return { status: "stopped", owner };
  }

  if (!lockOwnerMatchesProcess(owner, common)) {
    return { status: "stopped", owner };
  }
  options.logError?.(`[desktop-shell] forcing previous ${options.label} to stop pid=${owner.pid} startIdentity=${owner.startIdentity} elapsedMs=${Date.now() - startedAt}`);
  try {
    options.signal(owner.pid, "SIGKILL");
  } catch (error) {
    if (error?.code === "ESRCH") return { status: "stopped", owner };
    throw error;
  }
  if (await waitForOwnerExit(owner, { ...common, timeoutMs: options.forceTimeoutMs })) {
    return { status: "forced", owner };
  }
  throw new Error(`Previous ${options.label} pid=${owner.pid} did not exit.`);
}

async function stopExistingDesktopControlPlane(options = {}) {
  const lockPath = options.lockPath || resolveControlPlaneSingletonLockPath();
  const readOwner = options.readOwner || readControlPlaneLockOwner;
  const isAlive = options.isAlive || processIsAlive;
  const processIdentity = options.processIdentity || processStartIdentity;
  const signal = options.signal || ((pid, value) => process.kill(pid, value));
  const wait = options.wait || delay;
  const inspection = inspectExistingDesktopControlPlane({
    lockPath,
    readOwner,
    isAlive,
    processIdentity,
  });
  if (inspection.status !== "running") return inspection;
  if (options.expectedOwner && !sameLockOwner(options.expectedOwner, inspection.owner)) {
    return { status: "changed", owner: inspection.owner };
  }
  return stopDesktopLockOwner(inspection.owner, {
    label: "Control Plane",
    isAlive,
    processIdentity,
    signal,
    wait,
    pollMs: options.pollMs,
    gracefulTimeoutMs: options.gracefulTimeoutMs ?? DESKTOP_CONTROL_PLANE_GRACEFUL_TIMEOUT_MS,
    forceTimeoutMs: options.forceTimeoutMs ?? DESKTOP_CONTROL_PLANE_FORCE_TIMEOUT_MS,
    logInfo: options.logInfo,
    logError: options.logError,
  });
}

async function stopExistingDesktopNodeAgent(options) {
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
  return stopDesktopLockOwner(inspection.owner, {
    label: "desktop node agent",
    isAlive,
    processIdentity,
    signal,
    wait,
    pollMs: options.pollMs ?? 100,
    gracefulTimeoutMs: options.gracefulTimeoutMs ?? DESKTOP_NODE_AGENT_GRACEFUL_TIMEOUT_MS,
    forceTimeoutMs: options.forceTimeoutMs ?? DESKTOP_NODE_AGENT_FORCE_TIMEOUT_MS,
    logInfo: options.logInfo,
    logError: options.logError,
  });
}

module.exports = {
  DESKTOP_CONTROL_PLANE_FORCE_TIMEOUT_MS,
  DESKTOP_CONTROL_PLANE_GRACEFUL_TIMEOUT_MS,
  DESKTOP_NODE_AGENT_FORCE_TIMEOUT_MS,
  DESKTOP_NODE_AGENT_GRACEFUL_TIMEOUT_MS,
  ensureDesktopControlPlaneAvailable,
  ensureDesktopNodeAgent,
  inspectExistingDesktopControlPlane,
  inspectStartedDesktopControlPlane,
  inspectExistingDesktopNodeAgent,
  readControlPlaneLockOwner,
  readNodeAgentLockOwner,
  resolveControlPlaneSingletonLockPath,
  resolveNodeAgentSingletonLockPath,
  stopExistingDesktopControlPlane,
  stopExistingDesktopNodeAgent,
};
