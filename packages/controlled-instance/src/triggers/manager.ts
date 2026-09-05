import path from "node:path";
import { watch, type FSWatcher } from "chokidar";
import picomatch from "picomatch";
import { SchedulerExecutionRuntime, nextSchedulerTime, type SchedulerSkipReason } from "@task-handoff/core/core/scheduler-runtime";
import type { AiSessionsSnapshot, AiSessionSummary } from "@task-handoff/protocol/ai-sessions";
import type { TriggerConfig, TriggerDeployment, TriggerRun } from "@task-handoff/protocol/triggers";
import type { TaskHandoffStoragePaths } from "@task-handoff/core/storage/paths";
import type { TriggerExecutor } from "./executor.ts";
import type { TriggerStore } from "./store.ts";

type WatchState = {
  watcher: FSWatcher;
  debounce?: ReturnType<typeof setTimeout>;
  changed: Set<string>;
};

export class TriggerManager {
  private readonly watches = new Map<string, WatchState>();
  private readonly scheduler: SchedulerExecutionRuntime<TriggerExecutionEvent>;
  private previousAiSessions = new Map<string, AiSessionSummary>();

  constructor(
    private readonly store: TriggerStore,
    private readonly executor: TriggerExecutor,
    private readonly paths: TaskHandoffStoragePaths,
    private readonly publish?: (type: string, payload: unknown) => void,
  ) {
    this.scheduler = new SchedulerExecutionRuntime({
      execute: (event) => this.executeNow(event),
      skipped: (event, reason) => this.skip(event, reason),
    });
  }

  start() {
    this.stop();
    this.scheduler.start();
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
    this.scheduler.stop();
    for (const state of this.watches.values()) {
      void state.watcher.close();
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
      this.scheduler.setTimer(key, setInterval(() => {
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
      this.scheduler.setTimer(key, timer);
    };
    scheduleNext();
  }

  private startFileWatch(config: TriggerConfig, deployment: TriggerDeployment) {
    if (config.source.type !== "file-change") {
      return;
    }
    const source = config.source;
    const key = deploymentKey(deployment);
    const workspace = workspacePath();
    const roots = source.roots.map((root) => path.resolve(root)).filter((root) => pathWithin(workspace, root));
    if (!roots.length) return;
    const matches = fileTriggerMatcher(source.globs, source.ignore || []);
    const watcher = watch(roots, {
      atomic: true,
      awaitWriteFinish: { stabilityThreshold: Math.min(source.debounceMs, 500), pollInterval: 50 },
      followSymlinks: false,
      ignoreInitial: true,
      ignored: (file, stats) => {
        if (!pathWithin(workspace, path.resolve(file))) return true;
        const relative = relativeWorkspacePath(workspace, file);
        return Boolean(relative && defaultIgnored(stats?.isDirectory() ? `${relative}/` : relative));
      },
    });
    const state: WatchState = { watcher, changed: new Set() };
    watcher.on("all", (event, file) => {
      if (event !== "add" && event !== "change" && event !== "unlink") return;
      const relative = relativeWorkspacePath(workspace, file);
      if (!relative || !matches(relative)) return;
      state.changed.add(relative);
      if (state.debounce) clearTimeout(state.debounce);
      state.debounce = setTimeout(() => {
        const files = [...state.changed].sort();
        state.changed.clear();
        void this.execute(config, deployment, "file-change", `Changed files:\n${files.join("\n")}`);
      }, source.debounceMs);
    });
    watcher.on("error", (error) => {
      this.publish?.("trigger.watch.failed", { configHash: config.configHash, deploymentId: deployment.deploymentId, error: error instanceof Error ? error.message : String(error) });
    });
    this.watches.set(key, state);
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
    this.scheduler.submit(deploymentKey(deployment), { config, deployment, eventType, eventSummary }, config.policy);
  }

  private async executeNow({ config, deployment, eventType, eventSummary }: TriggerExecutionEvent) {
    this.publish?.("trigger.run.started", { configHash: config.configHash, deploymentId: deployment.deploymentId, eventType });
    try {
      const result = await this.executor.execute({ config, deployment, eventType, eventSummary });
      this.publish?.("trigger.run.completed", result);
      this.publish?.("trigger.updated", this.store.list());
    } catch (error) {
      this.publish?.("trigger.run.failed", { configHash: config.configHash, error: error instanceof Error ? error.message : String(error) });
      this.publish?.("trigger.updated", this.store.list());
    }
  }

  private skip({ config, deployment, eventType }: TriggerExecutionEvent, reason: SchedulerSkipReason) {
    const messages: Record<SchedulerSkipReason, string> = {
      cooldown: "Skipped by cooldown policy.",
      busy: "Skipped because trigger reached its concurrency limit.",
      "queue-full": "Skipped because the trigger queue is full.",
      "scheduler-stopped": "Skipped because the trigger scheduler stopped.",
      "job-disabled": "Skipped because the trigger was disabled.",
    };
    this.store.skipRun(config, deployment, eventType, messages[reason]);
    this.publish?.("trigger.run.skipped", { configHash: config.configHash, deploymentId: deployment.deploymentId, reason });
  }
}

type TriggerExecutionEvent = {
  config: TriggerConfig;
  deployment: TriggerDeployment;
  eventType: TriggerRun["eventType"];
  eventSummary?: string;
};

function deploymentKey(deployment: Pick<TriggerDeployment, "configHash" | "deploymentId">) {
  return deployment.deploymentId || deployment.configHash;
}

export function nextScheduleTime(source: Extract<TriggerConfig["source"], { type: "schedule" }>, now = new Date()) {
  if ("intervalMs" in source) return nextSchedulerTime({ type: "interval", intervalMs: source.intervalMs }, now, now);
  if (source.scheduleKind === "daily") return nextSchedulerTime({ type: "daily", timeOfDay: source.timeOfDay, timezone: source.timezone }, now);
  return nextSchedulerTime({ type: "weekly", weekdays: source.weekdays, timeOfDay: source.timeOfDay, timezone: source.timezone }, now);
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

function workspacePath() {
  return path.resolve(process.env.TASK_HANDOFF_WORKSPACE || process.env.WORKSPACE || "/workspace");
}

function defaultIgnored(relative: string) {
  return /(^|\/)(\.git|node_modules|dist|build)\//.test(relative) || /\.(log|tmp|swp)$/.test(relative);
}

export function fileTriggerMatcher(globs: string[], ignored: string[] = []) {
  const included = picomatch(globs, { dot: true });
  const excluded = ignored.length ? picomatch(ignored, { dot: true }) : () => false;
  return (relative: string) => !defaultIgnored(relative) && !excluded(relative) && included(relative);
}

function pathWithin(root: string, candidate: string) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function relativeWorkspacePath(workspace: string, file: string) {
  const resolved = path.resolve(file);
  if (!pathWithin(workspace, resolved)) return "";
  return path.relative(workspace, resolved).split(path.sep).join("/");
}
