import crypto from "node:crypto";
import path from "node:path";
import {
  SchedulerExecutionRuntime,
  nextSchedulerTime,
  schedulerExecutionKey,
  type SchedulerSchedule,
  type SchedulerSkipReason,
} from "@task-handoff/core/core/scheduler-runtime";
import {
  StoryAutomationChangedEventType,
  StoryAutomationInputSchema,
  StoryAutomationStatusSchema,
  type StoryAutomation,
  type StoryAutomationManualRunInput,
  type StoryAutomationRun,
  type StoryAutomationStatus,
} from "@task-handoff/protocol/stories";
import { StoryAutomationInstanceCreateResultSchema, type StoryAutomationInstanceCreateInput } from "@task-handoff/protocol/story-automation-instance";
import type { ControlledInstance } from "@task-handoff/protocol/control-plane";
import type { NodeAgentState } from "../state.ts";
import type { NodeStoryStore } from "./store.ts";
import { StoryAutomationStore, type StoredStoryAutomationRun, type StoryAutomationExecutionInput } from "./automation-store.ts";

type StorySchedulerEvent = { runId: string };
type Publish = (type: string, payload: unknown, scope?: { nodeId?: string; instanceId?: string }) => void;

export class StoryScheduler {
  private readonly runtime: SchedulerExecutionRuntime<StorySchedulerEvent>;
  private readonly nextRunAt = new Map<string, string>();
  private readonly completion = new Map<string, { promise: Promise<void>; resolve: () => void }>();
  private readonly registeredAutomationIds = new Set<string>();
  private readonly state: NodeAgentState;
  private readonly stories: NodeStoryStore;
  private readonly automations: StoryAutomationStore;
  private readonly fetchImpl: typeof fetch;
  private readonly resolveInstanceWeb: (instance: ControlledInstance) => Promise<string>;
  private readonly publish?: Publish;
  private readonly now: () => Date;

  constructor(
    state: NodeAgentState,
    stories: NodeStoryStore,
    automations: StoryAutomationStore,
    fetchImpl: typeof fetch,
    resolveInstanceWeb: (instance: ControlledInstance) => Promise<string>,
    publish?: Publish,
    now: () => Date = () => new Date(),
  ) {
    this.state = state;
    this.stories = stories;
    this.automations = automations;
    this.fetchImpl = fetchImpl;
    this.resolveInstanceWeb = resolveInstanceWeb;
    this.publish = publish;
    this.now = now;
    this.runtime = new SchedulerExecutionRuntime({
      execute: ({ runId }) => this.executeRun(runId),
      skipped: ({ runId }, reason) => this.skipRun(runId, reason),
    });
  }

  start() {
    this.runtime.stop();
    this.runtime.start();
    this.nextRunAt.clear();
    this.registeredAutomationIds.clear();
    for (const automation of this.automations.list()) this.register(automation);
    for (const run of this.automations.pendingRuns()) this.resume(run);
    this.reconcileInstances();
  }

  stop() {
    this.runtime.stop();
    this.nextRunAt.clear();
  }

  refresh() {
    for (const id of this.registeredAutomationIds) this.runtime.clearTimer(id);
    this.registeredAutomationIds.clear();
    this.nextRunAt.clear();
    for (const automation of this.automations.list()) {
      if (!automation.enabled || this.blockedReason(automation)) this.runtime.clearQueued(automation.id);
      this.register(automation);
    }
  }

  clearStory(storyId: string) {
    for (const automation of this.automations.list(storyId)) {
      this.runtime.clearTimer(automation.id);
      this.runtime.clearQueued(automation.id);
      this.registeredAutomationIds.delete(automation.id);
      this.nextRunAt.delete(automation.id);
    }
  }

  status(id: string): StoryAutomationStatus {
    const automation = this.requireAutomation(id);
    const runs = this.automations.runsFor(id);
    const currentRuns = runs.filter((run) => !isTerminal(run.status));
    const blockedReason = this.blockedReason(automation);
    const lastRun = runs.find((run) => isTerminal(run.status));
    const effectiveStatus = !automation.enabled
      ? "disabled"
      : blockedReason
        ? "blocked"
        : currentRuns.length
          ? "running"
          : lastRun?.status === "failed"
            ? "error"
            : "scheduled";
    return StoryAutomationStatusSchema.parse({
      automation,
      effectiveStatus,
      blockedReason,
      nextRunAt: this.nextRunAt.get(id),
      currentRuns: currentRuns.slice(0, 20),
      lastRun,
    });
  }

  list(storyId?: string) {
    return this.automations.list(storyId).map((automation) => this.status(automation.id));
  }

  create(input: unknown) {
    const parsed = this.validateInput(input);
    const automation = this.automations.create(parsed);
    this.register(automation);
    this.publishStatus(automation.id, "created");
    return this.status(automation.id);
  }

  update(id: string, input: unknown) {
    const current = this.requireAutomation(id);
    const candidate = { ...current, ...(input as Record<string, unknown>) };
    this.validateReferences(candidate as StoryAutomation);
    const automation = this.automations.update(id, input);
    if (!automation) return undefined;
    this.refresh();
    this.publishStatus(id, "updated");
    return this.status(id);
  }

  setEnabled(id: string, enabled: boolean) {
    return this.update(id, { enabled });
  }

  delete(id: string) {
    const automation = this.requireAutomation(id);
    const deleted = this.automations.delete(id);
    if (deleted) {
      this.runtime.clearTimer(id);
      this.nextRunAt.delete(id);
      this.publish?.(StoryAutomationChangedEventType, { storyId: automation.storyId, automationId: id, change: "deleted" }, { nodeId: this.state.node.id });
    }
    return deleted;
  }

  manualRun(id: string, input: StoryAutomationManualRunInput) {
    const automation = this.requireAutomation(id);
    const scheduledFor = this.now().toISOString();
    const executionKey = schedulerExecutionKey(id, "manual", input.clientRequestId);
    const existing = this.automations.runByExecutionKey(executionKey);
    if (existing) return this.automations.run(existing.id)!;
    const run = this.prepareRun(automation, "manual", scheduledFor, executionKey);
    this.runtime.submit(id, { runId: run.id }, automation.policy);
    return this.automations.run(run.id)!;
  }

  runs(id: string) {
    this.requireAutomation(id);
    return this.automations.runsFor(id);
  }

  reconcileInstances(authoritativeInstanceId?: string) {
    for (const run of this.automations.pendingRuns().filter((candidate) => candidate.status === "running" && candidate.aiSessionId)) {
      if (authoritativeInstanceId && run.targetInstanceId !== authoritativeInstanceId) continue;
      const instance = this.state.listInstances().find((candidate) => candidate.id === run.targetInstanceId);
      const session = instance?.aiSessions.sessions.find((candidate) => candidate.id === run.aiSessionId);
      if (!session && authoritativeInstanceId !== run.targetInstanceId) continue;
      if (session && session.status !== "idle" && session.status !== "failed") continue;
      const status = session?.status === "failed" ? "failed" : "completed";
      const error = status === "failed" ? { code: "AI_SESSION_FAILED", message: "The automated AI Session failed." } : undefined;
      const updated = this.automations.transition(run.id, status, error ? { error } : {});
      this.resolveCompletion(run.id);
      this.publishRun(updated);
      this.publishStatus(run.automationId, "status");
    }
  }

  private register(automation: StoryAutomation) {
    if (!automation.enabled || this.blockedReason(automation)) return;
    const stored = this.automations.stored(automation.id)!;
    const schedule = internalSchedule(automation);
    const next = nextSchedulerTime(schedule, this.now(), new Date(stored.scheduleAnchorAt));
    this.nextRunAt.set(automation.id, next.toISOString());
    this.registeredAutomationIds.add(automation.id);
    const timer = setTimeout(() => {
      const current = this.automations.get(automation.id);
      if (!current?.enabled || this.blockedReason(current)) return;
      const scheduledFor = next.toISOString();
      try {
        const run = this.prepareRun(current, "schedule", scheduledFor, schedulerExecutionKey(current.id, "schedule", scheduledFor));
        this.runtime.submit(current.id, { runId: run.id }, current.policy);
      } catch {
        this.publishStatus(current.id, "status");
      }
      this.register(current);
      this.publishStatus(current.id, "status");
    }, Math.max(1, next.getTime() - this.now().getTime()));
    timer.unref?.();
    this.runtime.setTimer(automation.id, timer);
  }

  private prepareRun(automation: StoryAutomation, eventType: StoryAutomationRun["eventType"], scheduledFor: string, executionKey: string) {
    const executionInput = this.executionInput(automation);
    const request = instanceRequest(executionInput, executionKey);
    return this.automations.createRun({
      automationId: automation.id,
      eventType,
      scheduledFor,
      executionKey,
      requestFingerprint: fingerprint(request),
      executionInput,
    });
  }

  private resume(run: StoredStoryAutomationRun) {
    const automation = this.automations.get(run.automationId);
    if (!automation) return;
    if (run.status === "running") {
      this.runtime.submit(automation.id, { runId: run.id }, automation.policy);
      return;
    }
    this.runtime.submit(automation.id, { runId: run.id }, automation.policy);
  }

  private async executeRun(runId: string) {
    let run = this.automations.pendingRuns().find((candidate) => candidate.id === runId);
    if (!run) return;
    if (run.status === "queued") run = this.automations.transition(run.id, "dispatching");
    if (run.status === "dispatching") {
      try {
        const instance = this.state.requireInstance(run.targetInstanceId);
        if (!instance.registrationToken) throw schedulerError("STORY_AUTOMATION_INSTANCE_CREDENTIAL_MISSING", "Target instance has no registration credential.", 503);
        const url = `${await this.resolveInstanceWeb(instance)}/api/internal/node-agent/story-automation/ai-sessions`;
        let response: Response;
        try {
          response = await this.fetchImpl(url, {
            method: "POST",
            headers: { "content-type": "application/json", authorization: `Bearer ${instance.registrationToken}` },
            body: JSON.stringify(instanceRequest(run.executionInput, run.executionKey)),
          });
        } catch {
          this.publishStatus(run.automationId, "status");
          return;
        }
        const payload = await response.json().catch(() => ({})) as { data?: unknown; error?: { code?: string; message?: string } };
        if (!response.ok) throw schedulerError(payload.error?.code || "STORY_AUTOMATION_DISPATCH_FAILED", payload.error?.message || `Target instance returned HTTP ${response.status}.`, response.status);
        const result = StoryAutomationInstanceCreateResultSchema.parse(payload.data);
        run = this.automations.transition(run.id, "running", { aiSessionId: result.aiSessionId });
        this.publishRun(run);
      } catch (error) {
        const failed = this.automations.transition(run.id, "failed", { error: errorProjection(error) });
        this.publishRun(failed);
        this.publishStatus(run.automationId, "status");
        return;
      }
    }
    await this.completionFor(run.id).promise;
  }

  private skipRun(runId: string, reason: SchedulerSkipReason) {
    const run = this.automations.run(runId);
    if (!run || run.status !== "queued") return;
    const skipped = this.automations.transition(runId, "skipped", { error: { code: `STORY_AUTOMATION_${reason.replaceAll("-", "_").toUpperCase()}`, message: skipMessage(reason) } });
    this.publishRun(skipped);
  }

  private executionInput(automation: StoryAutomation): StoryAutomationExecutionInput {
    const story = this.stories.get(automation.storyId);
    if (!story) throw schedulerError("STORY_NOT_FOUND", "Story was not found.", 404);
    if (story.archivedAt) throw schedulerError("STORY_ARCHIVED", "Archived Story cannot run Automation.", 409);
    const action = story.actions.find((candidate) => candidate.id === automation.actionId);
    if (!action) throw schedulerError("STORY_ACTION_NOT_FOUND", "Story Action was not found.", 404);
    if (!action.targetInstanceId) throw schedulerError("STORY_ACTION_TARGET_REQUIRED", "Automated Story Action requires a target instance.", 409);
    const instance = this.state.requireInstance(action.targetInstanceId);
    return {
      storyId: story.id,
      actionId: action.id,
      targetInstanceId: instance.id,
      prompt: action.promptTemplate,
      sessionPreset: action.sessionPreset,
      cwd: this.runtimeCwd(instance, action.sessionPreset?.cwdFolderId),
    };
  }

  private runtimeCwd(instance: ControlledInstance, cwdFolderId?: string) {
    if (!cwdFolderId) return instance.runtime.workspacePath || instance.workspace.path || "/workspace";
    const folder = this.state.localFolders.get(cwdFolderId);
    if (!folder) throw schedulerError("NODE_LOCAL_FOLDER_NOT_FOUND", "Story Action working folder was not found.", 404);
    const runtime = this.state.requireRuntime(instance.runtimeId);
    if (runtime.type === "local") return path.resolve(folder.path);
    if (instance.source.type !== "local-folder") throw schedulerError("AI_SESSION_CWD_UNAVAILABLE", "Working folder is unavailable for this instance source.", 409);
    const relative = path.relative(path.resolve(instance.source.path), path.resolve(folder.path));
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw schedulerError("AI_SESSION_CWD_OUTSIDE_WORKSPACE", "Working folder is outside the instance workspace.", 409);
    const workspace = instance.runtime.workspacePath || instance.workspace.path || "/workspace";
    return relative ? path.posix.join(workspace, ...relative.split(path.sep)) : workspace;
  }

  private validateInput(input: unknown) {
    const parsed = StoryAutomationInputSchema.parse(input);
    this.validateReferences({ ...parsed, id: "validation", createdAt: this.now().toISOString(), updatedAt: this.now().toISOString() });
    return parsed;
  }

  private validateReferences(automation: StoryAutomation) {
    this.executionInput(automation);
  }

  private blockedReason(automation: StoryAutomation) {
    try {
      this.executionInput(automation);
      return undefined;
    } catch (error) {
      const projected = errorProjection(error);
      if (["STORY_ARCHIVED", "STORY_NOT_FOUND", "STORY_ACTION_NOT_FOUND", "STORY_ACTION_TARGET_REQUIRED", "NODE_INSTANCE_NOT_FOUND", "STORY_NODE_MISMATCH"].includes(projected.code)) return projected;
      return undefined;
    }
  }

  private requireAutomation(id: string) {
    const automation = this.automations.get(id);
    if (!automation) throw schedulerError("STORY_AUTOMATION_NOT_FOUND", "Story Automation was not found.", 404);
    return automation;
  }

  private completionFor(runId: string) {
    const existing = this.completion.get(runId);
    if (existing) return existing;
    let resolve!: () => void;
    const promise = new Promise<void>((done) => { resolve = done; });
    const entry = { promise, resolve };
    this.completion.set(runId, entry);
    return entry;
  }

  private resolveCompletion(runId: string) {
    this.completion.get(runId)?.resolve();
    this.completion.delete(runId);
  }

  private publishRun(run: StoredStoryAutomationRun) {
    const publicRun = this.automations.run(run.id);
    const automation = this.automations.get(run.automationId);
    if (publicRun && automation) this.publish?.(StoryAutomationChangedEventType, { storyId: automation.storyId, automationId: automation.id, change: "run", run: publicRun }, { nodeId: this.state.node.id, instanceId: run.targetInstanceId });
  }

  private publishStatus(id: string, change: "created" | "updated" | "status") {
    const status = this.status(id);
    this.publish?.(StoryAutomationChangedEventType, { storyId: status.automation.storyId, automationId: id, change, status }, { nodeId: this.state.node.id });
  }
}

function internalSchedule(automation: StoryAutomation): SchedulerSchedule {
  const schedule = automation.schedule;
  if (schedule.scheduleKind === "interval") return { type: "interval", intervalMs: schedule.intervalMs };
  if (schedule.scheduleKind === "daily") return { type: "daily", timeOfDay: schedule.timeOfDay, timezone: schedule.timezone };
  if (schedule.scheduleKind === "weekly") return { type: "weekly", weekdays: schedule.weekdays, timeOfDay: schedule.timeOfDay, timezone: schedule.timezone };
  if (schedule.scheduleKind === "monthly") return { type: "monthly", dayOfMonth: schedule.dayOfMonth, timeOfDay: schedule.timeOfDay, timezone: schedule.timezone };
  throw new Error(`Unsupported Story automation schedule kind: ${(schedule as StoryAutomation).schedule.scheduleKind}`);
}

function instanceRequest(input: StoryAutomationExecutionInput, clientRequestId: string): StoryAutomationInstanceCreateInput {
  const preset = input.sessionPreset;
  return {
    agent: preset?.agent || "codex",
    cwd: { type: "runtime-path", path: input.cwd },
    cwdFolderId: preset?.cwdFolderId,
    gitSelection: preset?.gitSelection,
    message: input.prompt,
    permissionMode: preset?.permissionMode || "ask",
    clientRequestId,
    modelSelection: preset?.modelSelection,
    reasoningEffort: preset?.reasoningEffort,
    storyId: input.storyId,
  };
}

function fingerprint(value: unknown) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function isTerminal(status: StoryAutomationRun["status"]) {
  return status === "completed" || status === "failed" || status === "skipped";
}

function errorProjection(error: unknown) {
  const record = error && typeof error === "object" ? error as { code?: unknown; message?: unknown } : undefined;
  return {
    code: typeof record?.code === "string" ? record.code : "STORY_AUTOMATION_FAILED",
    message: typeof record?.message === "string" ? record.message : String(error),
  };
}

function skipMessage(reason: SchedulerSkipReason) {
  return ({ cooldown: "Skipped by cooldown policy.", busy: "Skipped because the concurrency limit was reached.", "queue-full": "Skipped because the queue is full.", "scheduler-stopped": "Skipped because the scheduler stopped.", "job-disabled": "Skipped because the Automation was disabled or blocked." })[reason];
}

function schedulerError(code: string, message: string, statusCode: number) {
  return Object.assign(new Error(message), { code, statusCode });
}
