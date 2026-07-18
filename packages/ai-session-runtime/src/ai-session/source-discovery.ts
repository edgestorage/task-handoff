import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { findClaudeTranscriptPath } from "@task-handoff/core/core/transcript";
import type {
  AiSessionLifecycle,
  AiSessionSnapshotInput,
  AiSessionSource,
  AiSessionsSnapshot,
} from "@task-handoff/protocol/ai-sessions";
import { compact } from "../ai-session-turns";

export type AiSessionAgent = "codex" | "claude";

export type ActiveAiProcessSnapshot = {
  agent: AiSessionAgent;
  providerSessionId?: string;
  transcriptPath?: string;
  cwd?: string;
};

export type AppSessionBindingCandidate = {
  id?: unknown;
  appId?: unknown;
  title?: unknown;
  status?: unknown;
  process?: {
    pid?: unknown;
  };
  tty?: {
    cwd?: unknown;
  };
  launch?: {
    cwd?: unknown;
  };
};

export type AiSessionSourceDiscoveryRegistry = {
  createFromTranscript: (
    agent: AiSessionAgent,
    transcriptPath: string,
    options?: { providerSessionId?: string; cwd?: string },
  ) => unknown;
  prune: () => unknown;
  snapshot: () => AiSessionsSnapshot;
  reconcileActiveProcesses: (activeProcesses: ActiveAiProcessSnapshot[]) => unknown;
  applyAdapterSnapshot: (
    snapshot: Omit<AiSessionSnapshotInput, "type" | "source"> & { source?: AiSessionSource },
  ) => unknown;
};

export type AiSessionDiscoveryCommandRunner = (
  command: string,
  args: string[],
  timeout?: number,
) => string;

type ClaudeRuntimeSessionFile = {
  pid?: unknown;
  sessionId?: unknown;
  cwd?: unknown;
  status?: unknown;
};

export function scanRecentTranscripts(
  registry: AiSessionSourceDiscoveryRegistry,
  agents: readonly AiSessionAgent[] = ["claude"],
) {
  const maxFiles = Number(process.env.TASK_HANDOFF_AI_SESSION_SCAN_MAX_FILES) || 100;
  const sinceMs = Number(process.env.TASK_HANDOFF_AI_SESSION_SCAN_SINCE_MS) || 24 * 60 * 60 * 1000;
  const cutoff = Date.now() - sinceMs;
  const candidates: Array<{ agent: AiSessionAgent; filePath: string; mtimeMs: number }> = [];
  const agentSet = new Set(agents);

  const collect = (agent: AiSessionAgent, root: string) => {
    if (!agentSet.has(agent)) {
      return;
    }
    const stack = [root];
    while (stack.length > 0 && candidates.length < maxFiles * 3) {
      const current = stack.pop();
      if (!current) {
        continue;
      }
      let entries: fs.Dirent[] = [];
      try {
        entries = fs.readdirSync(current, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        const entryPath = path.join(current, entry.name);
        if (entry.isDirectory()) {
          stack.push(entryPath);
        } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
          try {
            const stat = fs.statSync(entryPath);
            if (stat.mtimeMs >= cutoff) {
              candidates.push({ agent, filePath: entryPath, mtimeMs: stat.mtimeMs });
            }
          } catch {
            // A transcript may be atomically replaced while discovery is scanning.
          }
        }
      }
    }
  };

  collect("codex", path.join(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), "sessions"));
  collect("claude", path.join(process.env.CLAUDE_HOME || path.join(os.homedir(), ".claude"), "projects"));

  for (const candidate of candidates.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, maxFiles)) {
    registry.createFromTranscript(candidate.agent, candidate.filePath, {
      providerSessionId: path.basename(candidate.filePath).match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/)?.[1]
        || path.basename(candidate.filePath, ".jsonl"),
    });
  }
  registry.prune();
  return registry.snapshot();
}

export function commandOutput(command: string, args: string[], timeout = 500) {
  try {
    return execFileSync(command, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout,
    });
  } catch {
    return "";
  }
}

function firstUuid(value: string) {
  return value.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i)?.[0];
}

function parseLsofPath(output: string, marker: string) {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim().split(/\s+/).at(-1) || "")
    .filter((entry) => entry.includes(marker) && entry.endsWith(".jsonl"))
    .sort()
    .at(-1);
}

function workingDirectoryFromLsof(output: string) {
  const cwdLine = output.split(/\r?\n/).find((line) => /\bcwd\b/.test(line));
  return cwdLine?.trim().split(/\s+/).at(-1);
}

export function discoverActiveAiProcesses(
  commandRunner: AiSessionDiscoveryCommandRunner = commandOutput,
  agents: readonly AiSessionAgent[] = ["claude"],
): ActiveAiProcessSnapshot[] {
  const ps = commandRunner("/bin/ps", ["-Ao", "pid=,tty=,command="], 700);
  const snapshots: ActiveAiProcessSnapshot[] = [];
  const claimed = new Set<string>();
  const agentSet = new Set(agents);
  for (const line of ps.split(/\r?\n/)) {
    const match = line.trim().match(/^(\d+)\s+(\S+)\s+(.+)$/);
    if (!match || match[2] === "??") {
      continue;
    }
    const [, pid, , command] = match;
    const lower = command.toLowerCase();
    const agent = /\bclaude\b/.test(lower) ? "claude" : /\bcodex\b/.test(lower) ? "codex" : undefined;
    if (!agent || !agentSet.has(agent) || lower.includes("task-handoff")) {
      continue;
    }
    const lsof = commandRunner("/usr/sbin/lsof", ["-p", pid], 700);
    const transcriptPath = agent === "codex"
      ? parseLsofPath(lsof, "/.codex/sessions/")
      : parseLsofPath(lsof, "/.claude/projects/");
    const providerSessionId = transcriptPath ? firstUuid(transcriptPath) : firstUuid(command);
    const key = `${agent}:${providerSessionId || transcriptPath || pid}`;
    if (!claimed.add(key)) {
      continue;
    }
    snapshots.push({
      agent,
      providerSessionId,
      transcriptPath,
      cwd: workingDirectoryFromLsof(lsof),
    });
  }
  return snapshots;
}

export function reconcileActiveAiProcesses(
  registry: AiSessionSourceDiscoveryRegistry,
  agents: readonly AiSessionAgent[] = ["claude"],
  commandRunner: AiSessionDiscoveryCommandRunner = commandOutput,
) {
  registry.reconcileActiveProcesses(discoverActiveAiProcesses(commandRunner, agents));
  return registry.snapshot();
}

function claudeLifecycle(value: unknown): AiSessionLifecycle {
  const normalized = String(value || "").trim().toLowerCase();
  if (!normalized || normalized === "idle") {
    return "idle";
  }
  if (normalized === "stopped" || normalized === "exited" || normalized === "failed") {
    return normalized === "failed" ? "failed" : "idle";
  }
  return ["active", "busy", "running", "thinking", "working"].includes(normalized) ? "running" : "idle";
}

function claudeSessionsDir(claudeHome = process.env.CLAUDE_HOME || path.join(os.homedir(), ".claude")) {
  return path.join(claudeHome, "sessions");
}

function readJsonFile<T>(filePath: string): T | undefined {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
  } catch {
    return undefined;
  }
}

function readClaudeRuntimeSessions(claudeHome?: string) {
  const dir = claudeSessionsDir(claudeHome);
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return new Map<number, ClaudeRuntimeSessionFile>();
  }
  const byPid = new Map<number, ClaudeRuntimeSessionFile>();
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) {
      continue;
    }
    const record = readJsonFile<ClaudeRuntimeSessionFile>(path.join(dir, entry.name));
    const pid = Number(record?.pid || path.basename(entry.name, ".json"));
    if (record?.sessionId && Number.isInteger(pid) && pid > 0) {
      byPid.set(pid, record);
    }
  }
  return byPid;
}

export function scanClaudeAppSessionBindings(
  registry: AiSessionSourceDiscoveryRegistry,
  appSessions: AppSessionBindingCandidate[] = [],
  claudeHome = process.env.CLAUDE_HOME || path.join(os.homedir(), ".claude"),
) {
  const claudeSessionsByPid = readClaudeRuntimeSessions(claudeHome);
  for (const appSession of appSessions) {
    const appId = compact(appSession.appId, 120);
    const appSessionId = compact(appSession.id, 120);
    const status = compact(appSession.status, 80).toLowerCase();
    const pid = Number(appSession.process?.pid);
    if (appId !== "claude" || !appSessionId || (status && status !== "running") || !Number.isInteger(pid) || pid <= 0) {
      continue;
    }
    const claudeSession = claudeSessionsByPid.get(pid);
    const providerSessionId = compact(claudeSession?.sessionId, 240);
    if (!providerSessionId) {
      continue;
    }
    const cwd = compact(claudeSession?.cwd || appSession.tty?.cwd || appSession.launch?.cwd, 4096);
    registry.applyAdapterSnapshot({
      agent: "claude",
      appId,
      appSessionId,
      providerSessionId,
      title: compact(appSession.title, 240) || "Claude",
      cwd,
      transcriptPath: findClaudeTranscriptPath(providerSessionId, cwd, claudeHome),
      status: claudeLifecycle(claudeSession?.status),
    });
  }
  return registry.snapshot();
}
