import crypto from "node:crypto";
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
import type { NodeAgentState } from "../state.ts";
import type { NodeStoryStore, StoryAutomationContext } from "./store.ts";
import { StoryAutomationStore, type StoredStoryAutomationRun, type StoryAutomationExecutionInput } from "./automation-store.ts";
import { StoryActionExecutionService } from "./action-execution-service.ts";

type StorySchedulerEvent = { runId: string };
type Publish = (type: string, payload: unknown, scope?: { nodeId?: string; instanceId?: string }) => void;

export class StoryScheduler {
  private readonly runtime: SchedulerExecutionRuntime<StorySchedulerEvent>;
  private readonly nextRunAt = new Map<string, string>();
  private readonly completion = new Map<string, { promise: Promise<void>; resolve: () => void }>();
  private readonly registeredAutomationIds = new Set<string>();
  private readonly backgroundMutations = new Set<Promise<void>>();
  private readonly state: NodeAgentState;
  private readonly stories: NodeStoryStore;
  private readonly automations: StoryAutomationStore;
  private readonly publish?: Publish;
  private readonly now: () => Date;
  private readonly actionExecution: StoryActionExecutionService;

  constructor(
    state: NodeAgentState,
    stories: NodeStoryStore,
    automations: StoryAutomationStore,
    fetchImpl: typeof fetch,
    resolveInstanceWeb: ConstructorParameters<typeof StoryActionExecutionService>[3],
    publish?: Publish,
    now: () => Date = () => new Date(),
    actionExecution?: StoryActionExecutionService,
  ) {
    this.state = state;
    this.stories = stories;
    this.automations = automations;
    this.publish = publish;
    this.now = now;
    this.actionExecution = actionExecution || new StoryActionExecutionService(state, stories, fetchImpl, resolveInstanceWeb);
    this.runtime = new SchedulerExecutionRuntime({
      execute: ({ runId }) => this.executeRun(runId),
      skipped: ({ runId }, reason) => this.trackMutation(this.skipRun(runId, reason)),
    });
  }

  async start() {
    this.runtime.stop();
    this.runtime.start();
    this.nextRunAt.clear();
    this.registeredAutomationIds.clear();
    for (const automation of await this.automations.list()) await this.register(automation);
    for (const run of await this.automations.pendingRuns()) await this.resume(run);
    await this.reconcileInstances();
  }

  async stop() {
    this.runtime.stop();
    this.nextRunAt.clear();
    await Promise.allSettled([...this.backgroundMutations]);
  }

  async refresh() {
    for (const id of this.registeredAutomationIds) this.runtime.clearTimer(id);
    this.registeredAutomationIds.clear();
    this.nextRunAt.clear();
    for (const automation of await this.automations.list()) {
      if (!automation.enabled || await this.blockedReason(automation)) this.runtime.clearQueued(automation.id);
      await this.register(automation);
    }
  }

  async clearStory(storyId: string) {
    for (const automation of await this.automations.list(storyId)) {
      this.runtime.clearTimer(automation.id);
      this.runtime.clearQueued(automation.id);
      this.registeredAutomationIds.delete(automation.id);
      this.nextRunAt.delete(automation.id);
    }
  }

  async status(id: string): Promise<StoryAutomationStatus> {
    const automation = await this.requireAutomation(id);
    const runs = await this.automations.runsFor(id);
    const currentRuns = runs.filter((run) => !isTerminal(run.status));
    const blockedReason = await this.blockedReason(automation);
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

  async list(storyId?: string) {
    return Promise.all((await this.automations.list(storyId)).map((automation) => this.status(automation.id)));
  }

  async create(input: unknown) {
    const parsed = await this.validateInput(input);
    const automation = await this.automations.create(parsed);
    await this.register(automation);
    await this.publishStatus(automation.id, "created");
    return this.status(automation.id);
  }

  async validateCreate(input: unknown, storyOverride?: StoryAutomationContext) {
    const parsed = StoryAutomationInputSchema.parse(input);
    await this.validateReferences({ ...parsed, id: "validation", createdAt: this.now().toISOString(), updatedAt: this.now().toISOString() } as StoryAutomation, storyOverride);
    return parsed;
  }

  async activateCreated(id: string) {
    const automation = await this.requireAutomation(id);
    await this.register(automation);
    await this.publishStatus(id, "created");
    return this.status(id);
  }

  async update(id: string, input: unknown, expectedUpdatedAt?: string) {
    const current = await this.requireAutomation(id);
    const candidate = { ...current, ...(input as Record<string, unknown>) };
    await this.validateReferences(candidate as StoryAutomation);
    const automation = await this.automations.update(id, input, expectedUpdatedAt);
    if (!automation) return undefined;
    await this.refresh();
    await this.publishStatus(id, "updated");
    return this.status(id);
  }

  setEnabled(id: string, enabled: boolean) {
    return this.update(id, { enabled });
  }

  async delete(id: string, expectedUpdatedAt?: string) {
    const automation = await this.requireAutomation(id);
    const deleted = await this.automations.delete(id, expectedUpdatedAt);
    if (deleted) {
      this.runtime.clearTimer(id);
      this.nextRunAt.delete(id);
      this.publish?.(StoryAutomationChangedEventType, { storyId: automation.storyId, automationId: id, change: "deleted" }, { nodeId: this.state.node.id });
    }
    return deleted;
  }

  async manualRun(id: string, input: StoryAutomationManualRunInput) {
    const automation = await this.requireAutomation(id);
    const scheduledFor = this.now().toISOString();
    const executionKey = schedulerExecutionKey(id, "manual", input.clientRequestId);
    const existing = await this.automations.runByExecutionKey(executionKey);
    if (existing) return this.automations.run(existing.id);
    const run = await this.prepareRun(automation, "manual", scheduledFor, executionKey);
    this.runtime.submit(id, { runId: run.id }, automation.policy);
    return this.automations.run(run.id);
  }

  async runs(id: string) {
    await this.requireAutomation(id);
    return this.automations.runsFor(id);
  }

  async reconcileInstances(authoritativeInstanceId?: string) {
    for (const run of (await this.automations.pendingRuns()).filter((candidate) => candidate.status === "running" && candidate.aiSessionId)) {
      if (authoritativeInstanceId && run.targetInstanceId !== authoritativeInstanceId) continue;
      const instance = this.state.listInstances().find((candidate) => candidate.id === run.targetInstanceId);
      const session = instance?.aiSessions.sessions.find((candidate) => candidate.id === run.aiSessionId);
      if (!session && authoritativeInstanceId !== run.targetInstanceId) continue;
      if (session && session.status !== "idle" && session.status !== "failed") continue;
      const status = session?.status === "failed" ? "failed" : "completed";
      const error = status === "failed" ? { code: "AI_SESSION_FAILED", message: "The automated AI Session failed." } : undefined;
      const updated = await this.automations.transition(run.id, status, error ? { error } : {});
      this.resolveCompletion(run.id);
      await this.publishRun(updated);
      await this.publishStatus(run.automationId, "status");
    }
  }

  private async register(automation: StoryAutomation) {
    if (!automation.enabled || await this.blockedReason(automation)) return;
    const stored = await this.automations.stored(automation.id);
    if (!stored) return;
    const schedule = internalSchedule(automation);
    const next = nextSchedulerTime(schedule, this.now(), new Date(stored.scheduleAnchorAt));
    this.nextRunAt.set(automation.id, next.toISOString());
    this.registeredAutomationIds.add(automation.id);
    const timer = setTimeout(() => { void this.trackMutation(this.handleTimer(automation.id, next)); }, Math.max(1, next.getTime() - this.now().getTime()));
    timer.unref?.();
    this.runtime.setTimer(automation.id, timer);
  }

  private async handleTimer(automationId: string, next: Date) {
    const current = await this.automations.get(automationId);
    if (!current?.enabled || await this.blockedReason(current)) return;
    const scheduledFor = next.toISOString();
    try {
      const run = await this.prepareRun(current, "schedule", scheduledFor, schedulerExecutionKey(current.id, "schedule", scheduledFor));
      this.runtime.submit(current.id, { runId: run.id }, current.policy);
    } catch {
      await this.publishStatus(current.id, "status");
    }
    await this.register(current);
    await this.publishStatus(current.id, "status");
  }

  private async prepareRun(automation: StoryAutomation, eventType: StoryAutomationRun["eventType"], scheduledFor: string, executionKey: string) {
    const executionInput = await this.executionInput(automation);
    const request = this.actionExecution.request(executionInput, executionKey);
    return this.automations.createRun({
      automationId: automation.id,
      eventType,
      scheduledFor,
      executionKey,
      requestFingerprint: fingerprint(request),
      executionInput,
    });
  }

  private async resume(run: StoredStoryAutomationRun) {
    const automation = await this.automations.get(run.automationId);
    if (!automation) return;
    if (run.status === "running") {
      this.runtime.submit(automation.id, { runId: run.id }, automation.policy);
      return;
    }
    this.runtime.submit(automation.id, { runId: run.id }, automation.policy);
  }

  private async executeRun(runId: string) {
    let run = (await this.automations.pendingRuns()).find((candidate) => candidate.id === runId);
    if (!run) return;
    if (run.status === "queued") run = await this.automations.transition(run.id, "dispatching");
    if (run.status === "dispatching") {
      try {
        try {
          const result = await this.actionExecution.dispatch(run.executionInput, run.executionKey);
          run = await this.automations.transition(run.id, "running", { aiSessionId: result.aiSessionId });
          await this.publishRun(run);
        } catch (error) {
          if (error && typeof error === "object" && "retryable" in error && error.retryable === true) {
            await this.publishStatus(run.automationId, "status");
            return;
          }
          throw error;
        }
      } catch (error) {
        const failed = await this.automations.transition(run.id, "failed", { error: errorProjection(error) });
        await this.publishRun(failed);
        await this.publishStatus(run.automationId, "status");
        return;
      }
    }
    await this.completionFor(run.id).promise;
  }

  private async skipRun(runId: string, reason: SchedulerSkipReason) {
    const run = await this.automations.run(runId);
    if (!run || run.status !== "queued") return;
    const skipped = await this.automations.transition(runId, "skipped", { error: { code: `STORY_AUTOMATION_${reason.replaceAll("-", "_").toUpperCase()}`, message: skipMessage(reason) } });
    await this.publishRun(skipped);
  }

  private async executionInput(automation: StoryAutomation, storyOverride?: StoryAutomationContext): Promise<StoryAutomationExecutionInput> {
    return this.actionExecution.resolve(automation.storyId, automation.actionId, storyOverride);
  }

  private async validateInput(input: unknown) {
    const parsed = StoryAutomationInputSchema.parse(input);
    await this.validateReferences({ ...parsed, id: "validation", createdAt: this.now().toISOString(), updatedAt: this.now().toISOString() } as StoryAutomation);
    return parsed;
  }

  private async validateReferences(automation: StoryAutomation, storyOverride?: StoryAutomationContext) {
    await this.executionInput(automation, storyOverride);
  }

  private async blockedReason(automation: StoryAutomation) {
    try {
      await this.executionInput(automation);
      return undefined;
    } catch (error) {
      const projected = errorProjection(error);
      if (["STORY_ARCHIVED", "STORY_DELETING", "STORY_NOT_FOUND", "STORY_ACTION_NOT_FOUND", "STORY_ACTION_TARGET_REQUIRED", "NODE_INSTANCE_NOT_FOUND", "STORY_NODE_MISMATCH"].includes(projected.code)) return projected;
      return undefined;
    }
  }

  private async requireAutomation(id: string) {
    const automation = await this.automations.get(id);
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

  private trackMutation(promise: Promise<void>) {
    this.backgroundMutations.add(promise);
    void promise.finally(() => this.backgroundMutations.delete(promise));
    return promise;
  }

  private async publishRun(run: StoredStoryAutomationRun) {
    const publicRun = await this.automations.run(run.id);
    const automation = await this.automations.get(run.automationId);
    if (publicRun && automation) this.publish?.(StoryAutomationChangedEventType, { storyId: automation.storyId, automationId: automation.id, change: "run", run: publicRun }, { nodeId: this.state.node.id, instanceId: run.targetInstanceId });
  }

  private async publishStatus(id: string, change: "created" | "updated" | "status") {
    const status = await this.status(id);
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
