import {
  StoryAutomationInputSchema,
  StoryAutomationRunSchema,
  StoryAutomationSchema,
  StoryAutomationUpdateInputSchema,
  type StoryAutomation,
  type StoryAutomationInput,
  type StoryAutomationRun,
} from "@task-handoff/protocol/stories";
import { createId } from "../../shared/persistence/store.ts";
import {
  StoredStoryAutomationErrorSchema,
  StoredStoryAutomationPolicySchema,
  StoredStoryAutomationRunSchema,
  StoredStoryAutomationScheduleSchema,
  StoryAutomationExecutionInputSchema,
  type StoredStoryAutomationRun,
  type StoryAutomationExecutionInput,
} from "./database/records.ts";
import type { NodeAgentRepository, StoryAutomationRecord, StoryAutomationRunRecord } from "./database/repository.ts";

export type { StoredStoryAutomationRun, StoryAutomationExecutionInput } from "./database/records.ts";

const MAX_TERMINAL_RUNS = 100;
const terminalStatuses = new Set<StoryAutomationRun["status"]>(["completed", "failed", "skipped"]);
const allowedTransitions: Record<StoryAutomationRun["status"], StoryAutomationRun["status"][]> = {
  queued: ["dispatching", "skipped"],
  dispatching: ["running", "failed"],
  running: ["completed", "failed"],
  completed: [], failed: [], skipped: [],
};

export class StoryAutomationStore {
  private readonly repository: NodeAgentRepository;
  private readonly now: () => Date;

  constructor(repository: NodeAgentRepository, now: () => Date = () => new Date()) {
    this.repository = repository;
    this.now = now;
  }

  async init() {}

  async list(storyId?: string): Promise<StoryAutomation[]> {
    return (await this.repository.automations.list(storyId)).map(publicAutomation);
  }

  async stored(id: string) {
    const record = await this.repository.automations.get(id);
    return record ? storedAutomation(record) : undefined;
  }

  async get(id: string) {
    const automation = await this.repository.automations.get(id);
    return automation ? publicAutomation(automation) : undefined;
  }

  async create(input: StoryAutomationInput) {
    const parsed = StoryAutomationInputSchema.parse(input);
    const timestamp = this.now().toISOString();
    const record = await this.repository.automations.insert({
      id: createId("story_automation"),
      storyId: parsed.storyId,
      actionId: parsed.actionId,
      schedule: StoredStoryAutomationScheduleSchema.parse(parsed.schedule),
      enabled: parsed.enabled,
      policy: StoredStoryAutomationPolicySchema.parse(parsed.policy),
      scheduleAnchorAt: timestamp,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    return publicAutomation(record);
  }

  async update(id: string, input: unknown) {
    const patch = StoryAutomationUpdateInputSchema.parse(input);
    const current = await this.repository.automations.get(id);
    if (!current) return undefined;
    const timestamp = this.now().toISOString();
    const resetAnchor = patch.schedule !== undefined || (patch.enabled === true && !current.enabled);
    const updated = await this.repository.automations.update(id, {
      ...patch,
      ...(resetAnchor ? { scheduleAnchorAt: timestamp } : {}),
      updatedAt: timestamp,
    });
    return updated ? publicAutomation(updated) : undefined;
  }

  referencingActions(storyId: string, actionIds: Iterable<string>) {
    return this.repository.automations.referencingActions(storyId, [...actionIds]);
  }

  async hasActiveRuns(automationId: string) {
    return (await this.repository.runs.list(automationId)).some((run) => !terminalStatuses.has(run.status));
  }

  activeRunsForStory(storyId: string) {
    return this.repository.runs.activeForStory(storyId).then((runs) => runs.map(storedRun));
  }

  async delete(id: string) {
    if (!await this.repository.automations.get(id)) return false;
    if (await this.hasActiveRuns(id)) throw automationError("STORY_AUTOMATION_RUN_ACTIVE", "Automation has a non-terminal run.", 409);
    return this.repository.automations.delete(id);
  }

  async deleteForStory(storyId: string) {
    if ((await this.activeRunsForStory(storyId)).length) throw automationError("STORY_AUTOMATION_RUN_ACTIVE", "Story has a non-terminal Automation run.", 409);
    await this.repository.automations.deleteForStory(storyId);
  }

  async createRun(input: {
    automationId: string;
    eventType: StoryAutomationRun["eventType"];
    scheduledFor: string;
    executionKey: string;
    requestFingerprint: string;
    executionInput: StoryAutomationExecutionInput;
  }) {
    const parsedInput = StoryAutomationExecutionInputSchema.parse(input.executionInput);
    return this.repository.transaction(async (repository) => {
      const existing = await repository.runs.byExecutionKey(input.executionKey);
      if (existing) return storedRun(existing);
      const run = await repository.runs.insert({
        ...input,
        executionInput: parsedInput,
        id: createId("story_automation_run"),
        status: "queued",
        targetInstanceId: parsedInput.targetInstanceId,
        queuedAt: this.now().toISOString(),
      });
      await repository.runs.trimTerminal(input.automationId, MAX_TERMINAL_RUNS);
      return storedRun(run);
    });
  }

  async transition(id: string, status: StoryAutomationRun["status"], patch: Partial<Pick<StoredStoryAutomationRun, "aiSessionId" | "error">> = {}) {
    return this.repository.transaction(async (repository) => {
      const currentRecord = await repository.runs.get(id);
      if (!currentRecord) throw automationError("STORY_AUTOMATION_RUN_NOT_FOUND", "Automation run was not found.", 404);
      const current = storedRun(currentRecord);
      if (current.status === status) return current;
      if (!allowedTransitions[current.status].includes(status)) throw automationError("STORY_AUTOMATION_RUN_TRANSITION_INVALID", `Cannot transition run from ${current.status} to ${status}.`, 409);
      const timestamp = this.now().toISOString();
      const updated = await repository.runs.update(id, {
        ...patch,
        status,
        ...(status === "dispatching" ? { startedAt: timestamp } : {}),
        ...(terminalStatuses.has(status) ? { completedAt: timestamp } : {}),
      });
      await repository.runs.trimTerminal(current.automationId, MAX_TERMINAL_RUNS);
      return storedRun(updated!);
    });
  }

  async runsFor(automationId: string): Promise<StoryAutomationRun[]> {
    return (await this.repository.runs.list(automationId)).map(publicRun);
  }

  async run(id: string) {
    const run = await this.repository.runs.get(id);
    return run ? publicRun(run) : undefined;
  }

  async runByExecutionKey(executionKey: string) {
    const run = await this.repository.runs.byExecutionKey(executionKey);
    return run ? storedRun(run) : undefined;
  }

  async pendingRuns() { return (await this.repository.runs.pending()).map(storedRun); }
}

function storedAutomation(record: StoryAutomationRecord) {
  return {
    ...publicAutomation(record),
    scheduleAnchorAt: record.scheduleAnchorAt,
  };
}

function publicAutomation(record: StoryAutomationRecord): StoryAutomation {
  return StoryAutomationSchema.parse({
    id: record.id, storyId: record.storyId, actionId: record.actionId,
    schedule: StoredStoryAutomationScheduleSchema.parse(record.schedule),
    enabled: record.enabled,
    policy: StoredStoryAutomationPolicySchema.parse(record.policy),
    createdAt: record.createdAt, updatedAt: record.updatedAt,
  });
}

function storedRun(record: StoryAutomationRunRecord): StoredStoryAutomationRun {
  return StoredStoryAutomationRunSchema.parse({
    ...record,
    aiSessionId: record.aiSessionId || undefined,
    startedAt: record.startedAt || undefined,
    completedAt: record.completedAt || undefined,
    error: record.error ? StoredStoryAutomationErrorSchema.parse(record.error) : undefined,
    executionInput: StoryAutomationExecutionInputSchema.parse(record.executionInput),
  });
}

function publicRun(record: StoryAutomationRunRecord): StoryAutomationRun {
  const { executionKey: _executionKey, requestFingerprint: _requestFingerprint, executionInput: _executionInput, ...run } = storedRun(record);
  return StoryAutomationRunSchema.parse(run);
}

function automationError(code: string, message: string, statusCode: number) {
  return Object.assign(new Error(message), { code, statusCode });
}
