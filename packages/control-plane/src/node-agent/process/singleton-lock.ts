import os from "node:os";
import path from "node:path";
import { acquireProcessSingletonLock } from "../../shared/process/singleton-lock.ts";

export function defaultNodeAgentSingletonLockPath() {
  return path.join(os.tmpdir(), `task-handoff-node-agent-${process.getuid?.() ?? "user"}.lock`);
}

export function acquireNodeAgentSingletonLock(
  lockPath: string,
  details: { dataDir?: string; host?: string; port?: number } = {},
) {
  return acquireProcessSingletonLock(lockPath, {
    ...details,
    component: "node-agent",
    error: { label: "Node agent", code: "NODE_AGENT_ALREADY_RUNNING" },
  });
}
