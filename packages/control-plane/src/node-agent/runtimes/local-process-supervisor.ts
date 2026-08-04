import net from "node:net";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { ControlledInstance } from "@task-handoff/protocol/control-plane";
import { readLocalControlledInstanceLockOwner } from "@task-handoff/core/core/local-controlled-instance-lock";
import {
  processLockOwnerMatchesLiveProcess,
  processStartIdentity,
} from "@task-handoff/core/core/process-singleton-lock";

export const LOCAL_PROCESS_NONCE_LABEL = "task-handoff.local-process-nonce";
const REQUEST_TIMEOUT_MS = 1_000;

type LocalProcessIdentity = {
  instanceId: string;
  pid: number;
  processNonce: string;
  startIdentity?: string;
};

export type LocalProcessExit = {
  instanceId: string;
  pid?: number;
  code: number | null;
  signal: NodeJS.Signals | null;
};

function processWeb(instance: ControlledInstance) {
  return instance.runtime.port ? `http://127.0.0.1:${instance.runtime.port}` : instance.target.web;
}

async function fetchProcessIdentity(web: string, registrationToken: string): Promise<LocalProcessIdentity | undefined> {
  try {
    const response = await fetch(`${web}/api/internal/node-agent/process-identity`, {
      headers: { authorization: `Bearer ${registrationToken}` },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) return undefined;
    const body = await response.json() as { data?: { instanceId?: unknown; pid?: unknown; processNonce?: unknown; startIdentity?: unknown } };
    const identity = body.data;
    if (typeof identity?.instanceId !== "string" || typeof identity.pid !== "number" || typeof identity.processNonce !== "string") {
      return undefined;
    }
    return {
      instanceId: identity.instanceId,
      pid: identity.pid,
      processNonce: identity.processNonce,
      startIdentity: typeof identity.startIdentity === "string" ? identity.startIdentity : undefined,
    };
  } catch {
    return undefined;
  }
}

async function requestShutdown(instance: ControlledInstance) {
  const web = processWeb(instance);
  const processNonce = instance.runtime.labels?.[LOCAL_PROCESS_NONCE_LABEL];
  if (!web || !processNonce || !instance.registrationToken) return undefined;
  const identity = await fetchProcessIdentity(web, instance.registrationToken);
  if (!identity || identity.instanceId !== instance.id || identity.processNonce !== processNonce) return undefined;
  try {
    const response = await fetch(`${web}/api/internal/node-agent/shutdown`, {
      method: "POST",
      headers: { authorization: `Bearer ${instance.registrationToken}` },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    return response.ok ? identity : undefined;
  } catch {
    return undefined;
  }
}

async function fetchLegacyIdentity(instance: ControlledInstance) {
  const web = processWeb(instance);
  if (!web) return undefined;
  try {
    const [statusResponse, diagnosticsResponse] = await Promise.all([
      fetch(`${web}/api/instance/status`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) }),
      fetch(`${web}/api/diagnostics`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) }),
    ]);
    if (!statusResponse.ok || !diagnosticsResponse.ok) return undefined;
    const status = await statusResponse.json() as { data?: { id?: unknown; controlMode?: unknown } };
    const diagnostics = await diagnosticsResponse.json() as { data?: { runtime?: { pid?: unknown } } };
    const pid = diagnostics.data?.runtime?.pid;
    if (status.data?.id !== instance.id || status.data.controlMode !== "controlled" || typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) {
      return undefined;
    }
    const startIdentity = processStartIdentity(pid);
    return startIdentity ? { pid, startIdentity } : undefined;
  } catch {
    return undefined;
  }
}

async function terminate(pid: number, expectedStartIdentity: string) {
  if (processStartIdentity(pid) !== expectedStartIdentity) return false;
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return true;
  }
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // Process exited after the final liveness check.
  }
  const killDeadline = Date.now() + 1_000;
  while (Date.now() < killDeadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}

function stopError(instance: ControlledInstance, message: string) {
  return Object.assign(new Error(message), {
    statusCode: 503,
    code: "LOCAL_INSTANCE_STOP_UNCONFIRMED",
    instanceId: instance.id,
  });
}

export async function allocateLocalPort() {
  const configured = Number(process.env.TASK_HANDOFF_LOCAL_INSTANCE_PORT_START || 19000);
  const start = Number.isInteger(configured) && configured > 0 ? configured : 19000;
  for (let port = start; port < start + 1000 && port <= 65535; port += 1) {
    if (await canListen(port)) return port;
  }
  throw Object.assign(
    new Error(`No free localhost port found in range ${start}-${Math.min(start + 999, 65535)}.`),
    { statusCode: 503, code: "LOCAL_INSTANCE_PORT_UNAVAILABLE" },
  );
}

function canConnect(port: number) {
  return new Promise<boolean>((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    const finish = (connected: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(connected);
    };
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.setTimeout(250, () => finish(false));
  });
}

export async function canListenOnLocalPort(port: number) {
  // A wildcard listener owned by Docker Desktop/OrbStack can still allow a
  // loopback bind on macOS while intercepting traffic sent to that port. A
  // connection probe catches that case before the regular bind probe.
  if (await canConnect(port)) return false;
  return new Promise<boolean>((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.listen({ host: "127.0.0.1", port, exclusive: true }, () => server.close(() => resolve(true)));
  });
}

const canListen = canListenOnLocalPort;

export function waitForChildExit(child: ChildProcessWithoutNullStreams, timeoutMs = 3_000) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      resolve();
    }, timeoutMs);
    timer.unref();
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

export function waitForChildSpawn(child: ChildProcessWithoutNullStreams) {
  return new Promise<void>((resolve, reject) => {
    const onSpawn = () => {
      child.off("error", onError);
      resolve();
    };
    const onError = (error: Error) => {
      child.off("spawn", onSpawn);
      reject(error);
    };
    child.once("spawn", onSpawn);
    child.once("error", onError);
  });
}

export class LocalProcessSupervisor {
  private readonly children = new Map<string, ChildProcessWithoutNullStreams>();
  private readonly readyChildren = new WeakSet<ChildProcessWithoutNullStreams>();
  private readonly expectedExits = new WeakSet<ChildProcessWithoutNullStreams>();
  private readonly lockPath?: string;
  private readonly onUnexpectedExit?: (event: LocalProcessExit) => void | Promise<void>;
  private readonly onUnexpectedExitError?: (error: unknown, event: LocalProcessExit) => void;

  constructor(lockPath?: string, onUnexpectedExit?: (event: LocalProcessExit) => void | Promise<void>, onUnexpectedExitError?: (error: unknown, event: LocalProcessExit) => void) {
    this.lockPath = lockPath;
    this.onUnexpectedExit = onUnexpectedExit;
    this.onUnexpectedExitError = onUnexpectedExitError;
  }

  track(instanceId: string, child: ChildProcessWithoutNullStreams) {
    this.children.set(instanceId, child);
    child.once("exit", (code, signal) => {
      this.release(instanceId, child);
      if (this.readyChildren.has(child) && !this.expectedExits.has(child)) {
        const event = { instanceId, pid: child.pid, code, signal };
        const reportError = (error: unknown) => {
          try {
            this.onUnexpectedExitError?.(error, event);
          } catch {
            // Process exit diagnostics must not escape EventEmitter dispatch.
          }
        };
        try {
          void Promise.resolve(this.onUnexpectedExit?.(event)).catch(reportError);
        } catch (error) {
          reportError(error);
        }
      }
    });
  }

  markReady(instanceId: string, child: ChildProcessWithoutNullStreams) {
    if (this.children.get(instanceId) !== child || child.exitCode !== null || child.signalCode !== null) return false;
    this.readyChildren.add(child);
    return true;
  }

  release(instanceId: string, child: ChildProcessWithoutNullStreams) {
    if (this.children.get(instanceId) === child) this.children.delete(instanceId);
  }

  async stop(instance: ControlledInstance) {
    const child = this.children.get(instance.id);
    if (child) {
      this.expectedExits.add(child);
      if (!child.killed) child.kill("SIGTERM");
      this.children.delete(instance.id);
      await waitForChildExit(child);
      return;
    }
    const shutdownIdentity = await requestShutdown(instance);
    if (shutdownIdentity) {
      const web = processWeb(instance);
      const deadline = Date.now() + 3_000;
      while (web && Date.now() < deadline) {
        if (!await fetchProcessIdentity(web, instance.registrationToken!)) return;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      const remaining = web ? await fetchProcessIdentity(web, instance.registrationToken!) : undefined;
      if (remaining
        && remaining.instanceId === shutdownIdentity.instanceId
        && remaining.pid === shutdownIdentity.pid
        && remaining.processNonce === shutdownIdentity.processNonce
        && remaining.startIdentity === shutdownIdentity.startIdentity
        && remaining.startIdentity
        && await terminate(remaining.pid, remaining.startIdentity)) return;
      throw stopError(instance, `Controlled instance ${instance.id} accepted shutdown but its exit could not be confirmed.`);
    }
    const lockOwner = readLocalControlledInstanceLockOwner(this.lockPath);
    const legacyIdentity = await fetchLegacyIdentity(instance);
    if (legacyIdentity) {
      if (await terminate(legacyIdentity.pid, legacyIdentity.startIdentity)) return;
      throw stopError(instance, `Legacy controlled instance ${instance.id} did not exit after termination.`);
    }
    if (lockOwner?.instanceId === instance.id && processLockOwnerMatchesLiveProcess(lockOwner)) {
      throw stopError(instance, `Local controlled instance ${instance.id} is still owned by pid ${lockOwner.pid}, but its process identity could not be verified.`);
    }
  }

  async waitUntilHealthy(web: string, expected: LocalProcessIdentity, child: ChildProcessWithoutNullStreams, registrationToken: string, timeoutMs = 3_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (child.exitCode !== null || child.signalCode !== null) return false;
      const identity = await fetchProcessIdentity(web, registrationToken);
      if (identity
        && identity.instanceId === expected.instanceId
        && identity.pid === expected.pid
        && identity.processNonce === expected.processNonce
        && identity.startIdentity === expected.startIdentity) return true;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return false;
  }

  async stopAll() {
    const children = Array.from(this.children.values());
    for (const child of children) {
      this.expectedExits.add(child);
      if (!child.killed) child.kill("SIGTERM");
    }
    this.children.clear();
    await Promise.all(children.map((child) => waitForChildExit(child)));
  }
}
