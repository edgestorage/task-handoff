import fs from "node:fs";
import path from "node:path";
import type { AiSessionsSnapshot, AiSessionSummary } from "@task-handoff/protocol/ai-sessions";
import type { TriggerConfig, TriggerDeployment, TriggerRun } from "@task-handoff/protocol/triggers";
import type { TaskHandoffStoragePaths } from "@task-handoff/core/storage/paths";
import type { TriggerExecutor } from "./executor.ts";
import type { TriggerStore } from "./store.ts";

type Timer = ReturnType<typeof setInterval> | ReturnType<typeof setTimeout>;

type WatchState = {
  watchers: fs.FSWatcher[];
  debounce?: ReturnType<typeof setTimeout>;
  changed: Set<string>;
};

export class TriggerManager {
  private readonly timers = new Map<string, Timer>();
  private readonly watches = new Map<string, WatchState>();
  private readonly running = new Set<string>();
  private readonly queued = new Map<string, { config: TriggerConfig; deployment: TriggerDeployment; eventType: TriggerRun["eventType"]; eventSummary?: string }>();
  private readonly lastRunAt = new Map<string, number>();
  private previousAiSessions = new Map<string, AiSessionSummary>();

  constructor(
    private readonly store: TriggerStore,
    private readonly executor: TriggerExecutor,
    private readonly paths: TaskHandoffStoragePaths,
    private readonly publish?: (type: string, payload: unknown) => void,
  ) {}

  start() {
    this.stop();
    const index = this.store.list();
    for (const deployment of index.deployments.filter((entry) => entry.enabled)) {
      const config = index.configs.find((entry) => entry.configHash === deployment.configHash);
      if (!config) {
        continue;
      }
      if (config.source.type === "schedule") {
        this.startSchedule(config, deployment);
      }
      if (config.source.type === "file-change") {
        this.startFileWatch(config, deployment);
      }
    }
  }

  restart() {
    this.start();
  }

  stop() {
    for (const timer of this.timers.values()) {
      clearInterval(timer);
    }
    this.timers.clear();
    for (const state of this.watches.values()) {
      for (const watcher of state.watchers) {
        watcher.close();
      }
      if (state.debounce) {
        clearTimeout(state.debounce);
      }
    }
    this.watches.clear();
  }

  handleAiSessions(snapshot: AiSessionsSnapshot) {
    const next = new Map(snapshot.sessions.map((session) => [session.id, session]));
    const pruned = this.store.pruneMissingAiSessionDeployments(new Set(next.keys()));
    if (pruned.length) {
      this.restart();
      this.publish?.("trigger.deployment.pruned", { deployments: pruned });
      this.publish?.("trigger.updated", this.store.list());
    }
    const index = this.store.list();
    for (const deployment of index.deployments.filter((entry) => entry.enabled)) {
      const config = index.configs.find((entry) => entry.configHash === deployment.configHash);
      if (!config || config.source.type !== "ai-session") {
        continue;
      }
      for (const session of snapshot.sessions) {
        const previous = this.previousAiSessions.get(session.id);
        if (!previous || !this.aiSessionMatches(config, session)) {
          continue;
        }
        const statusChanged = previous.status !== session.status;
        const phaseChanged = previous.phase !== session.phase;
        if (!statusChanged && !phaseChanged) {
          continue;
        }
        const summary = `AI session ${session.id}: ${previous.status}/${previous.phase} -> ${session.status}/${session.phase}`;
        void this.execute(config, deployment, "ai-session", summary);
      }
    }
    this.previousAiSessions = next;
  }

  private startSchedule(config: TriggerConfig, deployment: TriggerDeployment) {
    if (config.source.type !== "schedule") {
      return;
    }
    const source = config.source;
    const key = deploymentKey(deployment);
    if ("intervalMs" in source) {
      this.timers.set(key, setInterval(() => {
        void this.execute(config, deployment, "schedule", `Interval ${source.intervalMs}ms`);
      }, source.intervalMs));
      return;
    }
    const scheduleNext = () => {
      const next = nextScheduleTime(source);
      const delay = Math.max(1_000, next.getTime() - Date.now());
      const timer = setTimeout(() => {
        void this.execute(config, deployment, "schedule", scheduleSummary(source));
        scheduleNext();
      }, delay);
      this.timers.set(key, timer);
    };
    scheduleNext();
  }

  private startFileWatch(config: TriggerConfig, deployment: TriggerDeployment) {
    if (config.source.type !== "file-change") {
      return;
    }
    const source = config.source;
    const key = deploymentKey(deployment);
    const state: WatchState = { watchers: [], changed: new Set() };
    for (const root of config.source.roots) {
      const resolved = path.resolve(root);
      const workspace = workspacePath();
      if (!resolved.startsWith(workspace)) {
        continue;
      }
      if (!fs.existsSync(resolved)) {
        continue;
      }
      for (const watchRoot of watchRoots(resolved)) {
        const watcher = fs.watch(watchRoot, (_event, filename) => {
          const file = filename ? path.join(watchRoot, String(filename)) : watchRoot;
          if (!this.fileMatches(config, file)) {
            return;
          }
          state.changed.add(path.relative(workspace, file));
          if (state.debounce) {
            clearTimeout(state.debounce);
          }
          state.debounce = setTimeout(() => {
            const files = [...state.changed].sort();
            state.changed.clear();
            void this.execute(config, deployment, "file-change", `Changed files:\n${files.join("\n")}`);
          }, source.debounceMs);
        });
        state.watchers.push(watcher);
      }
    }
    if (state.watchers.length) {
      this.watches.set(key, state);
    }
  }

  private fileMatches(config: TriggerConfig, file: string) {
    if (config.source.type !== "file-change") {
      return false;
    }
    const relative = path.relative(workspacePath(), file).replaceAll(path.sep, "/");
    if (defaultIgnored(relative) || (config.source.ignore || []).some((pattern) => globLike(pattern, relative))) {
      return false;
    }
    return config.source.globs.some((pattern) => globLike(pattern, relative));
  }

  private aiSessionMatches(config: TriggerConfig, session: AiSessionSummary) {
    if (config.source.type !== "ai-session") {
      return false;
    }
    if (config.source.agent && session.agent !== config.source.agent) {
      return false;
    }
    if (config.source.statuses?.length && !config.source.statuses.includes(session.status)) {
      return false;
    }
    if (config.source.phases?.length && !config.source.phases.includes(session.phase)) {
      return false;
    }
    return true;
  }

  private async execute(config: TriggerConfig, deployment: TriggerDeployment, eventType: TriggerRun["eventType"], eventSummary?: string) {
    const key = deploymentKey(deployment);
    const now = Date.now();
    const cooldownMs = config.policy.cooldownMs || 0;
    const lastRunAt = this.lastRunAt.get(key) || 0;
    if (cooldownMs && now - lastRunAt < cooldownMs) {
      this.store.skipRun(config, deployment, eventType, "Skipped by cooldown policy.");
      this.publish?.("trigger.run.skipped", { configHash: config.configHash, deploymentId: deployment.deploymentId, reason: "cooldown" });
      return;
    }
    if (this.running.has(key)) {
      if (config.policy.whenBusy === "queue") {
        this.queued.set(key, { config, deployment, eventType, eventSummary });
      } else {
        this.store.skipRun(config, deployment, eventType, "Skipped because trigger is already running.");
        this.publish?.("trigger.run.skipped", { configHash: config.configHash, deploymentId: deployment.deploymentId, reason: "busy" });
      }
      return;
    }
    this.running.add(key);
    this.lastRunAt.set(key, now);
    this.publish?.("trigger.run.started", { configHash: config.configHash, deploymentId: deployment.deploymentId, eventType });
    try {
      const result = await this.executor.execute({ config, deployment, eventType, eventSummary });
      this.publish?.("trigger.run.completed", result);
      this.publish?.("trigger.updated", this.store.list());
    } catch (error) {
      this.publish?.("trigger.run.failed", { configHash: config.configHash, error: error instanceof Error ? error.message : String(error) });
      this.publish?.("trigger.updated", this.store.list());
    } finally {
      this.running.delete(key);
      const queued = this.queued.get(key);
      if (queued) {
        this.queued.delete(key);
        setTimeout(() => {
          void this.execute(queued.config, queued.deployment, queued.eventType, queued.eventSummary);
        }, 0);
      }
    }
  }
}

function deploymentKey(deployment: Pick<TriggerDeployment, "configHash" | "deploymentId">) {
  return deployment.deploymentId || deployment.configHash;
}

function nextScheduleTime(source: Extract<TriggerConfig["source"], { type: "schedule" }>) {
  if ("intervalMs" in source) {
    return new Date(Date.now() + source.intervalMs);
  }
  const [hour, minute] = source.timeOfDay.split(":").map(Number);
  const now = new Date();
  for (let dayOffset = 0; dayOffset <= 14; dayOffset += 1) {
    const base = new Date(now.getTime() + dayOffset * 86_400_000);
    if (source.scheduleKind === "weekly" && !source.weekdays.includes(zonedParts(base, source.timezone).weekday)) {
      continue;
    }
    const candidate = zonedDateTime(base, source.timezone, hour, minute);
    if (candidate.getTime() > now.getTime() + 500) {
      return candidate;
    }
  }
  return new Date(Date.now() + 86_400_000);
}

function scheduleSummary(source: Extract<TriggerConfig["source"], { type: "schedule" }>) {
  if ("intervalMs" in source) {
    return `Interval ${source.intervalMs}ms`;
  }
  if (source.scheduleKind === "daily") {
    return `Daily at ${source.timeOfDay} ${source.timezone}`;
  }
  return `Weekly on ${source.weekdays.join(",")} at ${source.timeOfDay} ${source.timezone}`;
}

function zonedDateTime(day: Date, timeZone: string, hour: number, minute: number) {
  const parts = zonedParts(day, timeZone);
  const utcGuess = Date.UTC(parts.year, parts.month - 1, parts.day, hour, minute, 0, 0);
  const guess = new Date(utcGuess);
  const guessParts = zonedParts(guess, timeZone);
  const offsetMinutes = (Date.UTC(guessParts.year, guessParts.month - 1, guessParts.day, guessParts.hour, guessParts.minute) - guess.getTime()) / 60_000;
  return new Date(utcGuess - offsetMinutes * 60_000);
}

function zonedParts(date: Date, timeZone: string) {
  const values = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const value = (type: Intl.DateTimeFormatPartTypes) => values.find((part) => part.type === type)?.value || "";
  const weekdayMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    year: Number(value("year")),
    month: Number(value("month")),
    day: Number(value("day")),
    hour: Number(value("hour")),
    minute: Number(value("minute")),
    weekday: weekdayMap[value("weekday")] ?? 0,
  };
}

function workspacePath() {
  return path.resolve(process.env.TASK_HANDOFF_WORKSPACE || process.env.WORKSPACE || "/workspace");
}

function defaultIgnored(relative: string) {
  return /(^|\/)(\.git|node_modules|dist|build)\//.test(relative) || /\.(log|tmp|swp)$/.test(relative);
}

function globLike(pattern: string, value: string) {
  if (pattern === "**/*" || pattern === "**") {
    return true;
  }
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replaceAll("**", ".*")
    .replaceAll("*", "[^/]*");
  return new RegExp(`^${escaped}$`).test(value);
}

function watchRoots(root: string) {
  if (process.platform === "darwin" || process.platform === "win32") {
    return [root];
  }
  const roots = [root];
  const stack = [root];
  while (stack.length) {
    const current = stack.pop() as string;
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      const child = path.join(current, entry.name);
      const relative = path.relative(workspacePath(), child).replaceAll(path.sep, "/");
      if (defaultIgnored(`${relative}/`)) {
        continue;
      }
      roots.push(child);
      stack.push(child);
    }
  }
  return roots;
}
