import type { ControlledInstance } from "@task-handoff/protocol/control-plane";
import { StoryAutomationInstanceCreateInputSchema, StoryAutomationInstanceCreateResultSchema } from "@task-handoff/protocol/story-automation-instance";
import type { z } from "zod";
import { StoryActionRunResultSchema } from "@task-handoff/protocol/stories";
import type { NodeAgentState } from "../state.ts";
import { resolveInstanceFolder } from "../instances/instance-folder.ts";
import type { StoryAutomationExecutionInput } from "./automation-store.ts";
import type { NodeStoryStore, StoryAutomationContext } from "./store.ts";

export class StoryActionExecutionService {
  private readonly state: NodeAgentState;
  private readonly stories: NodeStoryStore;
  private readonly fetchImpl: typeof fetch;
  private readonly resolveInstanceWeb: (instance: ControlledInstance) => Promise<string>;

  constructor(
    state: NodeAgentState,
    stories: NodeStoryStore,
    fetchImpl: typeof fetch,
    resolveInstanceWeb: (instance: ControlledInstance) => Promise<string>,
  ) {
    this.state = state;
    this.stories = stories;
    this.fetchImpl = fetchImpl;
    this.resolveInstanceWeb = resolveInstanceWeb;
  }

  async resolve(storyId: string, actionId: string, storyOverride?: StoryAutomationContext): Promise<StoryAutomationExecutionInput> {
    const story = storyOverride?.id === storyId ? storyOverride : await this.stories.automationContext(storyId);
    if (!story) throw actionError("STORY_NOT_FOUND", "Story was not found.", 404);
    if (story.archivedAt) throw actionError("STORY_ARCHIVED", "Archived Story Action cannot run.", 409);
    const action = story.actions.find((candidate) => candidate.id === actionId);
    if (!action) throw actionError("STORY_ACTION_NOT_FOUND", "Story Action was not found.", 404);
    // Compatibility for v0.0.32: historical Actions remain readable but cannot
    // execute or back an Automation until the user saves an explicit target.
    if (!action.targetInstanceId) throw actionError("STORY_ACTION_TARGET_REQUIRED", "Story Action requires a target instance.", 409);
    const instance = this.state.requireInstance(action.targetInstanceId);
    if (instance.nodeId !== this.state.node.id) throw actionError("STORY_NODE_MISMATCH", "Story Action target belongs to another node.", 409);
    return {
      storyId: story.id,
      actionId: action.id,
      targetInstanceId: instance.id,
      prompt: action.promptTemplate,
      sessionPreset: action.sessionPreset,
      cwd: this.runtimeCwd(instance, action.sessionPreset?.cwdFolderId),
    };
  }

  request(input: StoryAutomationExecutionInput, clientRequestId: string) {
    const preset = input.sessionPreset;
    return StoryAutomationInstanceCreateInputSchema.parse({
      agent: preset?.agent || "codex",
      cwd: { type: "runtime-path", path: input.cwd },
      cwdFolderId: preset?.cwdFolderId,
      gitSelection: preset?.gitSelection,
      workspaceSelection: preset?.workspaceSelection,
      message: input.prompt,
      permissionMode: preset?.permissionMode || "ask",
      clientRequestId,
      modelSelection: preset?.modelSelection,
      reasoningEffort: preset?.reasoningEffort,
      storyId: input.storyId,
    });
  }

  async dispatch(input: StoryAutomationExecutionInput, clientRequestId: string) {
    const instance = this.state.requireInstance(input.targetInstanceId);
    if (!instance.registrationToken) throw actionError("STORY_ACTION_INSTANCE_CREDENTIAL_MISSING", "Target instance has no registration credential.", 503);
    let response: Response;
    try {
      response = await this.fetchImpl(`${await this.resolveInstanceWeb(instance)}/api/internal/node-agent/story-automation/ai-sessions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${instance.registrationToken}` },
        body: JSON.stringify(this.request(input, clientRequestId)),
      });
    } catch (cause) {
      throw actionError("STORY_ACTION_DISPATCH_UNAVAILABLE", "Target instance is temporarily unavailable.", 503, cause, true);
    }
    const payload = await response.json().catch(() => ({})) as { data?: unknown; error?: { code?: string; message?: string } };
    if (!response.ok) throw actionError(payload.error?.code || "STORY_ACTION_DISPATCH_FAILED", payload.error?.message || `Target instance returned HTTP ${response.status}.`, response.status);
    return StoryAutomationInstanceCreateResultSchema.parse(payload.data);
  }

  async run(storyId: string, actionId: string, clientRequestId: string): Promise<z.infer<typeof StoryActionRunResultSchema>> {
    const input = await this.resolve(storyId, actionId);
    const result = await this.dispatch(input, clientRequestId);
    return { targetInstanceId: input.targetInstanceId, aiSessionId: result.aiSessionId };
  }

  private runtimeCwd(instance: ControlledInstance, cwdFolderId?: string) {
    if (!cwdFolderId) return instance.runtime.workspacePath || instance.workspace.path || "/workspace";
    const resolution = resolveInstanceFolder(this.state, instance, cwdFolderId);
    if (resolution.status === "unknown-folder") throw actionError("NODE_LOCAL_FOLDER_NOT_FOUND", "Story Action working folder was not found.", 404);
    if (resolution.status === "unsupported-source") throw actionError("AI_SESSION_CWD_UNAVAILABLE", "Working folder is unavailable for this instance source.", 409);
    if (resolution.status === "outside-workspace") throw actionError("AI_SESSION_CWD_OUTSIDE_WORKSPACE", "Working folder is outside the instance workspace.", 409);
    return resolution.runtimePath;
  }
}

function actionError(code: string, message: string, statusCode: number, cause?: unknown, retryable = false) {
  return Object.assign(new Error(message), { code, statusCode, retryable, ...(cause === undefined ? {} : { cause }) });
}
