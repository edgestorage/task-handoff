import path from "node:path";
import { z } from "zod";
import {
  StoryAutomationInputSchema,
  StoryAutomationRunSchema,
  StoryAutomationSchema,
  StoryAutomationUpdateInputSchema,
  StorySessionPresetSchema,
  type StoryAutomation,
  type StoryAutomationInput,
  type StoryAutomationRun,
} from "@task-handoff/protocol/stories";
import { JsonFile, createId } from "../../shared/persistence/store.ts";
import type { NodeAgentStorePaths } from "../persistence/paths.ts";

const MAX_TERMINAL_RUNS = 100;
const terminalStatuses = new Set<StoryAutomationRun["status"]>(["completed", "failed", "skipped"]);

const StoryAutomationExecutionInputSchema = z.object({
  storyId: StoryAutomationSchema.shape.storyId,
  actionId: StoryAutomationSchema.shape.actionId,
  targetInstanceId: z.string().trim().min(1).max(120),
  prompt: z.string().trim().min(1).max(32_000),
  sessionPreset: StorySessionPresetSchema.optional(),
  cwd: z.string().trim().min(1).max(4096),
}).strict();

const StoredStoryAutomationSchema = StoryAutomationSchema.extend({
  scheduleAnchorAt: z.string().datetime(),
}).strict();

const StoredStoryAutomationRunSchema = StoryAutomationRunSchema.extend({
  executionKey: z.string().trim().min(1).max(160),
  requestFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  executionInput: StoryAutomationExecutionInputSchema,
}).strict();

const StoryAutomationIndexSchema = z.object({
  schemaVersion: z.literal(1),
  automations: z.array(StoredStoryAutomationSchema),
  runs: z.array(StoredStoryAutomationRunSchema),
}).strict();

type StoredStoryAutomation = z.infer<typeof StoredStoryAutomationSchema>;
export type StoredStoryAutomationRun = z.infer<typeof StoredStoryAutomationRunSchema>;
export type StoryAutomationExecutionInput = z.infer<typeof StoryAutomationExecutionInputSchema>;

const allowedTransitions: Record<StoryAutomationRun["status"], StoryAutomationRun["status"][]> = {
  queued: ["dispatching", "skipped"],
  dispatching: ["running", "failed"],
  running: ["completed", "failed"],
  completed: [],
  failed: [],
  skipped: [],
};

export class StoryAutomationStore {
  private readonly file: JsonFile<z.infer<typeof StoryAutomationIndexSchema>>;
  private readonly now: () => Date;

  constructor(paths: NodeAgentStorePaths, now: () => Date = () => new Date()) {
    this.now = now;
    this.file = new JsonFile(path.join(paths.storyAutomationsDir, "index.json"), () => ({ schemaVersion: 1, automations: [], runs: [] }), {
      schema: StoryAutomationIndexSchema,
      rejectInvalid: true,
    });
  }

  init() {
    this.file.init();
    this.file.get();
  }

  list(storyId?: string): StoryAutomation[] {
    return this.file.get().automations
      .filter((automation) => !storyId || automation.storyId === storyId)
      .map(publicAutomation);
  }

  stored(id: string) {
    return this.file.get().automations.find((automation) => automation.id === id);
  }

  get(id: string) {
    const automation = this.stored(id);
    return automation ? publicAutomation(automation) : undefined;
  }

  create(input: StoryAutomationInput) {
    const parsed = StoryAutomationInputSchema.parse(input);
    const timestamp = this.now().toISOString();
    const automation = StoredStoryAutomationSchema.parse({
      ...parsed,
      id: createId("story_automation"),
      scheduleAnchorAt: timestamp,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    const index = this.file.get();
    this.file.put({ ...index, automations: [...index.automations, automation] });
    return publicAutomation(automation);
  }

  update(id: string, input: unknown) {
    const patch = StoryAutomationUpdateInputSchema.parse(input);
    const index = this.file.get();
    const current = index.automations.find((automation) => automation.id === id);
    if (!current) return undefined;
    const timestamp = this.now().toISOString();
    const resetAnchor = patch.schedule !== undefined || (patch.enabled === true && !current.enabled);
    const updated = StoredStoryAutomationSchema.parse({
      ...current,
      ...patch,
      ...(resetAnchor ? { scheduleAnchorAt: timestamp } : {}),
      updatedAt: timestamp,
    });
    this.file.put({ ...index, automations: index.automations.map((automation) => automation.id === id ? updated : automation) });
    return publicAutomation(updated);
  }

  referencingActions(storyId: string, actionIds: Iterable<string>) {
    const ids = new Set(actionIds);
    return this.file.get().automations.filter((automation) => automation.storyId === storyId && ids.has(automation.actionId));
  }

  hasActiveRuns(automationId: string) {
    return this.file.get().runs.some((run) => run.automationId === automationId && !terminalStatuses.has(run.status));
  }

  activeRunsForStory(storyId: string) {
    const automationIds = new Set(this.file.get().automations.filter((automation) => automation.storyId === storyId).map((automation) => automation.id));
    return this.file.get().runs.filter((run) => automationIds.has(run.automationId) && !terminalStatuses.has(run.status));
  }

  delete(id: string) {
    const index = this.file.get();
    if (!index.automations.some((automation) => automation.id === id)) return false;
    if (index.runs.some((run) => run.automationId === id && !terminalStatuses.has(run.status))) {
      throw automationError("STORY_AUTOMATION_RUN_ACTIVE", "Automation has a non-terminal run.", 409);
    }
    this.file.put({
      ...index,
      automations: index.automations.filter((automation) => automation.id !== id),
      runs: index.runs.filter((run) => run.automationId !== id),
    });
    return true;
  }

  deleteForStory(storyId: string) {
    const index = this.file.get();
    const ids = new Set(index.automations.filter((automation) => automation.storyId === storyId).map((automation) => automation.id));
    const active = index.runs.filter((run) => ids.has(run.automationId) && !terminalStatuses.has(run.status));
    if (active.length) throw automationError("STORY_AUTOMATION_RUN_ACTIVE", "Story has a non-terminal Automation run.", 409);
    this.file.put({
      ...index,
      automations: index.automations.filter((automation) => automation.storyId !== storyId),
      runs: index.runs.filter((run) => !ids.has(run.automationId)),
    });
  }

  createRun(input: {
    automationId: string;
    eventType: StoryAutomationRun["eventType"];
    scheduledFor: string;
    executionKey: string;
    requestFingerprint: string;
    executionInput: StoryAutomationExecutionInput;
  }) {
    const index = this.file.get();
    const existing = index.runs.find((run) => run.executionKey === input.executionKey);
    if (existing) return existing;
    const queuedAt = this.now().toISOString();
    const run = StoredStoryAutomationRunSchema.parse({
      ...input,
      id: createId("story_automation_run"),
      status: "queued",
      targetInstanceId: input.executionInput.targetInstanceId,
      queuedAt,
    });
    this.save({ ...index, runs: [run, ...index.runs] });
    return run;
  }

  transition(id: string, status: StoryAutomationRun["status"], patch: Partial<Pick<StoredStoryAutomationRun, "aiSessionId" | "error">> = {}) {
    const index = this.file.get();
    const current = index.runs.find((run) => run.id === id);
    if (!current) throw automationError("STORY_AUTOMATION_RUN_NOT_FOUND", "Automation run was not found.", 404);
    if (current.status === status) return current;
    if (!allowedTransitions[current.status].includes(status)) {
      throw automationError("STORY_AUTOMATION_RUN_TRANSITION_INVALID", `Cannot transition run from ${current.status} to ${status}.`, 409);
    }
    const timestamp = this.now().toISOString();
    const updated = StoredStoryAutomationRunSchema.parse({
      ...current,
      ...patch,
      status,
      ...(status === "dispatching" ? { startedAt: timestamp } : {}),
      ...(terminalStatuses.has(status) ? { completedAt: timestamp } : {}),
    });
    this.save({ ...index, runs: index.runs.map((run) => run.id === id ? updated : run) });
    return updated;
  }

  runsFor(automationId: string): StoryAutomationRun[] {
    return this.file.get().runs
      .filter((run) => run.automationId === automationId)
      .sort((a, b) => b.queuedAt.localeCompare(a.queuedAt))
      .map(publicRun);
  }

  run(id: string) {
    const run = this.file.get().runs.find((candidate) => candidate.id === id);
    return run ? publicRun(run) : undefined;
  }

  runByExecutionKey(executionKey: string) {
    return this.file.get().runs.find((run) => run.executionKey === executionKey);
  }

  pendingRuns() {
    return this.file.get().runs.filter((run) => !terminalStatuses.has(run.status));
  }

  private save(index: z.infer<typeof StoryAutomationIndexSchema>) {
    const terminalByAutomation = new Map<string, number>();
    const runs = index.runs
      .sort((a, b) => b.queuedAt.localeCompare(a.queuedAt))
      .filter((run) => {
        if (!terminalStatuses.has(run.status)) return true;
        const count = terminalByAutomation.get(run.automationId) ?? 0;
        terminalByAutomation.set(run.automationId, count + 1);
        return count < MAX_TERMINAL_RUNS;
      });
    this.file.put(StoryAutomationIndexSchema.parse({ ...index, runs }));
  }
}

function publicAutomation({ scheduleAnchorAt: _scheduleAnchorAt, ...automation }: StoredStoryAutomation): StoryAutomation {
  return StoryAutomationSchema.parse(automation);
}

function publicRun({ executionKey: _executionKey, requestFingerprint: _requestFingerprint, executionInput: _executionInput, ...run }: StoredStoryAutomationRun): StoryAutomationRun {
  return StoryAutomationRunSchema.parse(run);
}

function automationError(code: string, message: string, statusCode: number) {
  return Object.assign(new Error(message), { code, statusCode });
}
