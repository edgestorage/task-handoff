import fs from "node:fs";
import path from "node:path";
import { StoryAutomationWithActionInputSchema, StoryCreateInputSchema, StoryIdSchema, StoryUpdateInputSchema, type Story, type StoryAutomationStatus, type StoryAutomationWithActionInput, type StoryCreateInput, type StoryUpdateInput } from "@task-handoff/protocol/stories";
import type { NodeAgentState } from "../state.ts";
import type { StoryAutomationStore } from "./automation-store.ts";
import type { NodeAgentRepository } from "../persistence/repository.ts";
import type { StoryScheduler } from "./scheduler.ts";
import type { NodeStoryStore } from "./store.ts";
import type { StoryAiSessionCloser } from "./ai-session-close-service.ts";

export class StoryCommandService {
  private readonly state: NodeAgentState;
  private readonly stories: NodeStoryStore;
  private readonly automations: StoryAutomationStore;
  private readonly scheduler: StoryScheduler;
  private readonly repository: NodeAgentRepository;
  private readonly aiSessionCloser?: StoryAiSessionCloser;

  constructor(
    state: NodeAgentState,
    stories: NodeStoryStore,
    automations: StoryAutomationStore,
    scheduler: StoryScheduler,
    repository: NodeAgentRepository,
    aiSessionCloser?: StoryAiSessionCloser,
  ) {
    this.state = state;
    this.stories = stories;
    this.automations = automations;
    this.scheduler = scheduler;
    this.repository = repository;
    this.aiSessionCloser = aiSessionCloser;
  }

  async init() {
    fs.mkdirSync(this.state.paths.storyTrashDir, { recursive: true, mode: 0o700 });
    for (const intent of await this.repository.deletionIntents.list()) {
      const active = await this.repository.stories.get(intent.storyId);
      const root = this.storyRoot(intent.storyId);
      const trash = intent.trashName ? path.join(this.state.paths.storyTrashDir, intent.trashName) : undefined;
      if (active) {
        if (trash && fs.existsSync(trash) && !fs.existsSync(root)) fs.renameSync(trash, root);
      } else if (trash) {
        fs.rmSync(trash, { recursive: true, force: true });
      }
      await this.repository.deletionIntents.delete(intent.storyId);
    }
  }

  async update(storyId: string, input: StoryUpdateInput) {
    const parsed = StoryUpdateInputSchema.parse(input);
    if (parsed.actions) this.assertActionTargets(parsed.actions);
    const story = await this.stories.update(storyId, parsed);
    await this.scheduler.refresh();
    return story;
  }

  async create(input: StoryCreateInput) {
    const parsed = StoryCreateInputSchema.parse(input);
    this.assertActionTargets(parsed.actions || []);
    return this.stories.create(parsed);
  }

  async createAutomationWithAction(storyId: string, input: StoryAutomationWithActionInput): Promise<StoryAutomationStatus> {
    const parsed = StoryAutomationWithActionInputSchema.parse(input);
    this.assertActionTargets([parsed.action]);
    const current = await this.stories.automationContext(storyId);
    if (!current) throw commandError("STORY_NOT_FOUND", "Story was not found.", 404);
    if (current.archivedAt) throw commandError("STORY_ARCHIVED", "Archived Story cannot create an Automation.", 409);
    if (current.actions.some((action) => action.id === parsed.action.id)) throw commandError("STORY_ACTION_ID_CONFLICT", "Story Action id already exists.", 409);
    const automationInput = { storyId, actionId: parsed.action.id, ...parsed.automation };
    await this.scheduler.validateCreate(automationInput, { ...current, actions: [...current.actions, parsed.action] });
    let automationId = "";
    await this.repository.transaction(async (repository) => {
      await repository.actions.replace(storyId, [...current.actions, parsed.action].map((action, displayOrder) => ({
        storyId,
        id: action.id,
        title: action.title,
        promptTemplate: action.promptTemplate,
        targetInstanceId: action.targetInstanceId,
        sessionPreset: action.sessionPreset,
        displayOrder,
      })));
      await repository.stories.update(storyId, { updatedAt: new Date().toISOString() });
      automationId = (await this.automations.create(automationInput)).id;
    });
    const updated = await this.stories.get(storyId);
    if (updated) this.stories.notifyUpdated(updated);
    return this.scheduler.activateCreated(automationId);
  }

  async archive(storyId: string) {
    const story = await this.stories.archive(storyId);
    await this.scheduler.refresh();
    return story;
  }

  async restore(storyId: string) {
    const story = await this.stories.restore(storyId);
    await this.scheduler.refresh();
    return story;
  }

  async delete(storyId: string) {
    return this.stories.coordinator.run(storyId, async () => {
      const story = await this.stories.get(storyId);
      if (!story) return false;
      await this.prepareStoryDeletion(storyId);
      return this.deleteCoordinated(story);
    });
  }

  private async prepareStoryDeletion(storyId: string) {
    const activeRuns = await this.automations.activeRunsForStory(storyId);
    if (activeRuns.length) throw commandError("STORY_AUTOMATION_RUN_ACTIVE", "Story has a non-terminal Automation run.", 409, { runIds: activeRuns.map((run) => run.id) });
    const sessions = this.state.listInstances().flatMap((instance) => instance.aiSessions.sessions
      .filter((session) => session.storyId === storyId)
      .map((session) => ({ instance, sessionId: session.id, storyId })));
    if (!sessions.length) return;
    if (!this.aiSessionCloser) throw commandError("STORY_AI_SESSION_CLOSE_UNAVAILABLE", "AI Sessions cannot be closed for Story deletion.", 503);
    const results = await Promise.allSettled(sessions.map((target) => this.aiSessionCloser!.close(target)));
    const failures = results.flatMap((result, index) => result.status === "rejected" ? [{
      instanceId: sessions[index]!.instance.id,
      aiSessionId: sessions[index]!.sessionId,
      message: result.reason instanceof Error ? result.reason.message : String(result.reason),
    }] : []);
    if (failures.length) {
      throw commandError("STORY_AI_SESSION_CLOSE_FAILED", "One or more AI Sessions could not be closed.", 409, { sessions: failures });
    }
  }

  private async deleteCoordinated(story: Story) {
    const storyId = story.id;
    await this.scheduler.clearStory(storyId);
    const root = this.storyRoot(storyId);
    const trashName = `${storyId}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const trash = path.join(this.state.paths.storyTrashDir, trashName);
    const timestamp = new Date().toISOString();
    await this.repository.deletionIntents.put({ storyId, phase: "prepared", trashName: null, createdAt: timestamp, updatedAt: timestamp });
    try {
      let staged = false;
      if (fs.existsSync(root)) {
        fs.renameSync(root, trash);
        this.fsyncDirectory(path.dirname(root));
        this.fsyncDirectory(path.dirname(trash));
        staged = true;
      }
      await this.repository.deletionIntents.put({ storyId, phase: "files-staged", trashName: staged ? trashName : null, createdAt: timestamp, updatedAt: new Date().toISOString() });
      await this.repository.transaction(async (repository) => {
        const activeRuns = await repository.runs.activeForStory(storyId);
        if (activeRuns.length) {
          throw commandError("STORY_AUTOMATION_RUN_ACTIVE", "Story has a non-terminal Automation run.", 409, { runIds: activeRuns.map((run) => run.id) });
        }
        await repository.automations.deleteForStory(storyId);
        await repository.stories.delete(storyId);
        await repository.deletionIntents.put({ storyId, phase: "database-committed", trashName: staged ? trashName : null, createdAt: timestamp, updatedAt: new Date().toISOString() });
      });
      if (staged) fs.rmSync(trash, { recursive: true, force: true });
      await this.repository.deletionIntents.put({ storyId, phase: "cleanup", trashName: staged ? trashName : null, createdAt: timestamp, updatedAt: new Date().toISOString() });
      await this.repository.deletionIntents.delete(storyId);
      this.stories.notifyDeleted(story);
      return true;
    } catch (error) {
      const active = await this.repository.stories.get(storyId);
      if (active) {
        if (fs.existsSync(trash) && !fs.existsSync(root)) fs.renameSync(trash, root);
        await this.repository.deletionIntents.delete(storyId);
      }
      throw error;
    }
  }

  private storyRoot(storyId: string) { return path.join(this.state.paths.storyContentDir, StoryIdSchema.parse(storyId)); }
  private assertActionTargets(actions: Array<{ targetInstanceId: string }>) {
    for (const action of actions) {
      const instance = this.state.requireInstance(action.targetInstanceId);
      if (instance.nodeId !== this.state.node.id) {
        throw commandError("STORY_NODE_MISMATCH", "Story Action target belongs to another node.", 409);
      }
    }
  }
  private fsyncDirectory(directory: string) { if (process.platform === "win32") return; const fd = fs.openSync(directory, "r"); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } }
}

function commandError(code: string, message: string, statusCode: number, details?: unknown) {
  return Object.assign(new Error(message), { code, statusCode, details });
}
