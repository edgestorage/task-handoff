import { spawnSync, type ChildProcess } from "node:child_process";
import type { PtyProcess } from "./pty.ts";

export type ManagedProcessTree = {
  pid: number;
  child?: Pick<ChildProcess, "pid" | "exitCode" | "signalCode" | "kill">;
  pty?: Pick<PtyProcess, "pid" | "processGroupLeader" | "kill">;
  rootExited: boolean;
  stopPromise?: Promise<void>;
};

export type ManagedProcessTreeRegistryOptions = {
  stopTimeoutMs?: number;
  killTimeoutMs?: number;
};

const DEFAULT_STOP_TIMEOUT_MS = 5_000;
const DEFAULT_KILL_TIMEOUT_MS = 1_000;

/**
 * Instance-owned process-tree lifecycle state. Each runtime gets its own
 * registry; the process id is only an identifier inside that owner and never a
 * process-wide singleton key.
 */
export class ManagedProcessTreeRegistry {
  private readonly trees = new Map<number, ManagedProcessTree>();
  private readonly stopTimeoutMs: number;
  private readonly killTimeoutMs: number;

  constructor(options: ManagedProcessTreeRegistryOptions = {}) {
    this.stopTimeoutMs = options.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS;
    this.killTimeoutMs = options.killTimeoutMs ?? DEFAULT_KILL_TIMEOUT_MS;
  }

  get(pid: number | undefined) {
    return pid === undefined ? undefined : this.trees.get(pid);
  }

  has(pid: number | undefined) {
    return pid !== undefined && this.trees.has(pid);
  }

  values() {
    return this.trees.values();
  }

  track(processTree: ManagedProcessTree) {
    this.trees.set(processTree.pid, processTree);
  }

  forget(pid: number) {
    this.trees.delete(pid);
  }

  markRootExited(pid: number) {
    const processTree = this.trees.get(pid);
    if (!processTree) return;
    processTree.rootExited = true;
    if (!this.exists(processTree)) {
      this.forgetTree(processTree);
      return;
    }
    // A launcher that exits before its descendants has abandoned those
    // descendants. Reap that tree immediately instead of retaining it until the
    // owning runtime shuts down.
    this.requestStop(pid, "SIGTERM", processTree.child, processTree.pty);
  }

  signal(
    pid: number | undefined,
    signal: NodeJS.Signals,
    child?: ManagedProcessTree["child"],
    pty?: ManagedProcessTree["pty"],
  ) {
    if (!pid) return;
    const ownedProcessTree = this.trees.get(pid);
    if (ownedProcessTree && process.platform === "win32") {
      const result = spawnSync("taskkill", ["/pid", String(pid), "/t", ...(signal === "SIGKILL" ? ["/f"] : [])], {
        windowsHide: true,
        stdio: "ignore",
      });
      if (result.status === 0) return;
    }
    if (ownedProcessTree && process.platform !== "win32") {
      if (pty && !pty.processGroupLeader) {
        pty.kill(signal);
        return;
      }
      try {
        process.kill(-pid, signal);
        return;
      } catch (error: unknown) {
        const code = (error as NodeJS.ErrnoException).code;
        // The root exit callback can race with an earlier whole-group signal.
        // Once the owned group is gone (ESRCH) or no longer signalable by this
        // process (EPERM), never fall back to the positive pid because it may
        // already identify a replacement process.
        if (code === "ESRCH" || code === "EPERM") return;
        throw error;
      }
    }
    try {
      if (pty) pty.kill(signal);
      else if (child && child.exitCode == null && child.signalCode == null) child.kill(signal);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  }

  requestStop(
    pid: number | undefined,
    signal: NodeJS.Signals,
    child?: ManagedProcessTree["child"],
    pty?: ManagedProcessTree["pty"],
  ) {
    if (!pid) return;
    const processTree = this.trees.get(pid);
    this.signal(pid, signal, child, pty);
    if (!processTree || processTree.stopPromise) return;
    processTree.stopPromise = (async () => {
      let remaining = signal === "SIGKILL"
        ? [processTree]
        : await this.wait([processTree], this.stopTimeoutMs);
      if (remaining.length > 0 && signal !== "SIGKILL") {
        this.signal(pid, "SIGKILL", child, pty);
      }
      if (remaining.length > 0) {
        remaining = await this.wait(remaining, this.killTimeoutMs);
      }
      if (remaining.length === 0) this.forgetTree(processTree);
    })();
    void processTree.stopPromise.catch(() => {});
  }

  async wait(processTrees: ManagedProcessTree[], timeoutMs: number) {
    if (processTrees.length === 0) return [];
    const deadline = Date.now() + timeoutMs;
    let remaining = processTrees.filter((processTree) => this.exists(processTree));
    while (remaining.length > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      remaining = remaining.filter((processTree) => this.exists(processTree));
    }
    return remaining;
  }

  private exists(processTree: ManagedProcessTree) {
    if (process.platform === "win32") return !processTree.rootExited;
    try {
      process.kill(-processTree.pid, 0);
      return true;
    } catch (error: unknown) {
      return (error as NodeJS.ErrnoException).code === "EPERM";
    }
  }

  private forgetTree(processTree: ManagedProcessTree) {
    if (this.trees.get(processTree.pid) === processTree) this.trees.delete(processTree.pid);
  }
}
