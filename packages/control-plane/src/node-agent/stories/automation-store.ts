import { JsonCollection, createId } from "../../shared/persistence/store.ts";
import { StoryAutomationSchema, StoryAutomationInputSchema, type StoryAutomation, type StoryAutomationInput } from "@task-handoff/protocol/stories";
import type { NodeAgentStorePaths } from "../persistence/paths.ts";

const MAX_RUNS = 100;
export type StoryAutomationRun = { id: string; automationId: string; eventType: "manual" | "schedule"; status: "started" | "completed" | "failed" | "skipped"; executionKey: string; error?: string; startedAt: string; completedAt?: string };

export class StoryAutomationStore {
  private readonly records: JsonCollection<StoryAutomation>;
  private readonly runs: JsonCollection<StoryAutomationRun>;
  constructor(paths: NodeAgentStorePaths) {
    this.records = new JsonCollection(paths.storyAutomationsDir, { schema: StoryAutomationSchema });
    this.runs = new JsonCollection(`${paths.storyAutomationsDir}-runs`, { schema: (awaitableSchema as never) });
  }
  init() { this.records.init(); this.runs.init(); }
  list() { return this.records.list(); }
  get(id: string) { return this.records.get(id); }
  runsFor(id: string) { return this.runs.list().filter((run) => run.automationId === id).sort((a,b) => b.startedAt.localeCompare(a.startedAt)).slice(0, MAX_RUNS); }
  create(input: StoryAutomationInput) { const parsed = StoryAutomationInputSchema.parse(input); const now = new Date().toISOString(); return this.records.put(StoryAutomationSchema.parse({ ...parsed, id: createId("story_automation"), createdAt: now, updatedAt: now })); }
  update(id: string, input: unknown) { const current = this.records.get(id); if (!current) return undefined; const parsed = StoryAutomationInputSchema.partial().parse(input); return this.records.put(StoryAutomationSchema.parse({ ...current, ...parsed, updatedAt: new Date().toISOString() })); }
  delete(id: string) { const deleted = this.records.delete(id); if (deleted) for (const run of this.runsFor(id)) this.runs.delete(run.id); return deleted; }
  putRun(run: StoryAutomationRun) { return this.runs.put(run); }
}

const awaitableSchema = { parse(value: unknown) { return value as StoryAutomationRun; } };
