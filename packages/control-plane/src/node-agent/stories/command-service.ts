import path from "node:path";
import { z } from "zod";
import { StoryAutomationWithActionInputSchema, StoryUpdateInputSchema, type Story, type StoryAutomationStatus, type StoryAutomationWithActionInput, type StoryUpdateInput } from "@task-handoff/protocol/stories";
import { JsonFile } from "../../shared/persistence/store.ts";
import type { NodeAgentState } from "../state.ts";
import type { StoryAutomationStore } from "./automation-store.ts";
import type { StoryScheduler } from "./scheduler.ts";
import type { NodeStoryStore } from "./store.ts";

const StoryDeletionIntentSchema = z.object({
  storyId: z.string().trim().min(1).max(120),
  createdAt: z.string().datetime(),
}).strict();

const StoryDeletionIntentIndexSchema = z.object({
  schemaVersion: z.literal(1),
  intents: z.array(StoryDeletionIntentSchema),
}).strict();

export class StoryCommandService {
  private readonly deletions: JsonFile<z.infer<typeof StoryDeletionIntentIndexSchema>>;
  private readonly state: NodeAgentState;
  private readonly stories: NodeStoryStore;
  private readonly automations: StoryAutomationStore;
  private readonly scheduler: StoryScheduler;

  constructor(
    state: NodeAgentState,
    stories: NodeStoryStore,
    automations: StoryAutomationStore,
    scheduler: StoryScheduler,
  ) {
    this.state = state;
    this.stories = stories;
    this.automations = automations;
    this.scheduler = scheduler;
    this.deletions = new JsonFile(path.join(state.paths.storyAutomationsDir, "deletion-intents.json"), () => ({ schemaVersion: 1, intents: [] }), {
      schema: StoryDeletionIntentIndexSchema,
      rejectInvalid: true,
    });
  }

  init() {
    this.deletions.init();
    for (const intent of this.deletions.get().intents) this.finishDelete(intent.storyId);
  }

  update(storyId: string, input: StoryUpdateInput) {
    const parsed = StoryUpdateInputSchema.parse(input);
    if (parsed.actions !== undefined) this.assertActionsUnreferenced(storyId, parsed.actions.map((action) => action.id).filter(Boolean) as string[]);
    const story = this.stories.update(storyId, parsed);
    this.scheduler.refresh();
    return story;
  }

  createAutomationWithAction(storyId: string, input: StoryAutomationWithActionInput): StoryAutomationStatus {
    const parsed = StoryAutomationWithActionInputSchema.parse(input);
    const current = this.stories.get(storyId);
    if (!current) throw commandError("STORY_NOT_FOUND", "Story was not found.", 404);
    if (current.archivedAt) throw commandError("STORY_ARCHIVED", "Archived Story cannot create an Automation.", 409);
    if (current.actions.some((action) => action.id === parsed.action.id)) {
      throw commandError("STORY_ACTION_ID_CONFLICT", "Story Action id already exists.", 409);
    }
    this.stories.update(storyId, { actions: [...current.actions, parsed.action] });
    try {
      return this.scheduler.create({ storyId, actionId: parsed.action.id, ...parsed.automation });
    } catch (cause) {
      this.stories.update(storyId, { actions: current.actions });
      throw cause;
    }
  }

  archive(storyId: string) {
    const story = this.stories.archive(storyId);
    this.scheduler.refresh();
    return story;
  }

  restore(storyId: string) {
    const story = this.stories.restore(storyId);
    this.scheduler.refresh();
    return story;
  }

  delete(storyId: string) {
    const story = this.stories.get(storyId);
    if (!story) return false;
    const sessions = this.state.listInstances().flatMap((instance) => instance.aiSessions.sessions
      .filter((session) => session.storyId === storyId)
      .map((session) => ({ instanceId: instance.id, aiSessionId: session.id })));
    if (sessions.length) throw commandError("STORY_IN_USE", "Story is still referenced by an AI Session.", 409, { sessions });
    const activeRuns = this.automations.activeRunsForStory(storyId);
    if (activeRuns.length) throw commandError("STORY_AUTOMATION_RUN_ACTIVE", "Story has a non-terminal Automation run.", 409, { runIds: activeRuns.map((run) => run.id) });
    const index = this.deletions.get();
    if (!index.intents.some((intent) => intent.storyId === storyId)) {
      this.deletions.put({ ...index, intents: [...index.intents, { storyId, createdAt: new Date().toISOString() }] });
    }
    return this.finishDelete(storyId);
  }

  private assertActionsUnreferenced(storyId: string, retainedActionIds: string[]) {
    const current = this.stories.get(storyId);
    if (!current) throw commandError("STORY_NOT_FOUND", "Story was not found.", 404);
    const retained = new Set(retainedActionIds);
    const removedIds = current.actions.map((action) => action.id).filter((id) => !retained.has(id));
    const references = this.automations.referencingActions(storyId, removedIds);
    if (references.length) {
      throw commandError("STORY_ACTION_AUTOMATION_IN_USE", "Story Action is referenced by an Automation.", 409, {
        automationIds: references.map((automation) => automation.id),
      });
    }
  }

  private finishDelete(storyId: string) {
    this.scheduler.clearStory(storyId);
    this.automations.deleteForStory(storyId);
    if (this.stories.get(storyId)) this.stories.delete(storyId);
    const index = this.deletions.get();
    this.deletions.put({ ...index, intents: index.intents.filter((intent) => intent.storyId !== storyId) });
    return true;
  }
}

function commandError(code: string, message: string, statusCode: number, details?: unknown) {
  return Object.assign(new Error(message), { code, statusCode, details });
}
