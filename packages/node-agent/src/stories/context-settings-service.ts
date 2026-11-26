import {
  StoryContextSettingsSchema,
  StoryContextSettingsUpdateInputSchema,
  type StoryContextSettings,
  type StoryContextSettingsUpdateInput,
} from "@task-handoff/protocol/story-context";
import type { NodeLocalFolder } from "@task-handoff/protocol/control-plane";
import type { NodeAgentRepository } from "../persistence/repository.ts";

export type StoryContextFolderSource = {
  listLocalFolders(): NodeLocalFolder[];
  resolveLocalFolder(id: string): NodeLocalFolder | undefined;
};

export type StoryContextSettingsChange = (storyId: string) => void | Promise<void>;
export type StoryContextSettingsChangeError = (storyId: string, error: unknown) => void;

function contextError(code: string, message: string, statusCode: number, details?: Record<string, unknown>) {
  return Object.assign(new Error(message), { code, statusCode, ...(details ? { details } : {}) });
}

export class StoryContextSettingsService {
  private readonly repository: NodeAgentRepository;
  private readonly ownerNodeId: string;
  private readonly folders: StoryContextFolderSource;
  private readonly onChange?: StoryContextSettingsChange;
  private readonly onChangeError?: StoryContextSettingsChangeError;

  constructor(
    repository: NodeAgentRepository,
    ownerNodeId: string,
    folders: StoryContextFolderSource,
    onChange?: StoryContextSettingsChange,
    onChangeError?: StoryContextSettingsChangeError,
  ) {
    this.repository = repository;
    this.ownerNodeId = ownerNodeId;
    this.folders = folders;
    this.onChange = onChange;
    this.onChangeError = onChangeError;
  }

  async get(storyId: string): Promise<StoryContextSettings> {
    const settings = await this.repository.storyContext.get(storyId);
    if (!settings) throw contextError("STORY_NOT_FOUND", "Story was not found.", 404);
    return StoryContextSettingsSchema.parse(settings);
  }

  async update(storyId: string, rawInput: StoryContextSettingsUpdateInput): Promise<StoryContextSettings> {
    const input = StoryContextSettingsUpdateInputSchema.parse(rawInput);
    const current = await this.get(storyId);
    const currentIds = new Set(current.projectFolderIds);
    const seen = new Set<string>();
    for (const folderId of input.projectFolderIds) {
      if (seen.has(folderId)) {
        throw contextError("STORY_CONTEXT_DUPLICATE_PROJECT", "A Story project can only be attached once.", 400, { folderId });
      }
      seen.add(folderId);
      const folder = this.folders.resolveLocalFolder(folderId);
      if (folder?.nodeId === this.ownerNodeId) continue;
      if (currentIds.has(folderId)) continue;
      throw contextError("STORY_CONTEXT_PROJECT_UNAVAILABLE", "The Story project is not available on this Node.", 400, { folderId });
    }

    const updatedAt = new Date().toISOString();
    const settings = await this.repository.transaction(async (transaction) => {
      const story = await transaction.stories.get(storyId);
      if (!story) throw contextError("STORY_NOT_FOUND", "Story was not found.", 404);
      if (await transaction.deletionIntents.get(storyId)) {
        throw contextError("STORY_DELETING", "Story is being deleted.", 409);
      }
      const saved = await transaction.storyContext.replace({
        storyId,
        expectedRevision: input.expectedRevision,
        projectFolderIds: input.projectFolderIds,
        appendedPrompt: input.appendedPrompt,
        updatedAt,
      });
      await transaction.stories.update(storyId, { updatedAt });
      return saved;
    });
    const projected = StoryContextSettingsSchema.parse(settings);
    try {
      await this.onChange?.(storyId);
    } catch (error) {
      this.onChangeError?.(storyId, error);
    }
    return projected;
  }
}
