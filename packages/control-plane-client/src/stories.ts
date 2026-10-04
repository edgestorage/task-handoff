import { z } from "zod";
import {
  StoryActionRunResultSchema,
  StoryCreateInputSchema,
  StoryAutomationInputSchema,
  StoryAutomationListSchema,
  StoryAutomationManualRunInputSchema,
  StoryAutomationRunSchema,
  StoryAutomationRunsSchema,
  StoryAutomationStatusSchema,
  StoryAutomationUpdateInputSchema,
  StoryAutomationWithActionInputSchema,
  StoryContentPreviewSchema,
  StoryDocumentOrderInputSchema,
  StoryDocumentUpdateInputSchema,
  StoryDecisionCancelInputSchema,
  StoryDecisionDecideInputSchema,
  StoryDecisionListSchema,
  StoryDecisionSchema,
  StoryListSchema,
  StorySchema,
  StoryUpdateInputSchema,
  StorySessionRetentionSettingsSchema,
  type StoryCreateInput,
  type StoryAutomationInput,
  type StoryAutomationManualRunInput,
  type StoryAutomationUpdateInput,
  type StoryAutomationWithActionInput,
  type StoryUpdateInput,
  type StoryDecisionCancelInput,
  type StoryDecisionDecideInput,
} from "@task-handoff/protocol/stories";
import type { ControlPlaneClientTransport } from "./transport.ts";
import {
  StoryAgentToolPolicySettingsSchema,
  StoryAgentToolPolicyUpdateInputSchema,
  sanitizeStoryAgentToolPolicySettings,
  type StoryAgentToolPolicy,
  StoryAgentActionRunInputSchema,
} from "@task-handoff/protocol/story-agent-tools";
import { jsonRequest } from "./json-request.ts";

const DataSchema = <T extends z.ZodType>(schema: T) => z.object({ data: schema }).passthrough();
export function createControlPlaneStoriesApi(transport: ControlPlaneClientTransport) {
  const requestData = async <T>(path: string, schema: z.ZodType<T>, init?: RequestInit) => (await transport.request(path, DataSchema(schema), init)).data;
  return {
    list(nodeId?: string, signal?: AbortSignal) {
      return requestData("/api/stories" + (nodeId ? `?nodeId=${encodeURIComponent(nodeId)}` : ""), z.object({ stories: StoryListSchema.shape.stories, unavailableNodeIds: z.array(z.string()).default([]) }).strict(), { signal });
    },
    get(storyId: string, nodeId: string) { return requestData(`/api/stories/${encodeURIComponent(storyId)}?nodeId=${encodeURIComponent(nodeId)}`, StorySchema); },
    preview(storyId: string, nodeId: string, storyPath: string, signal?: AbortSignal) { return requestData(`/api/stories/${encodeURIComponent(storyId)}/content/preview?nodeId=${encodeURIComponent(nodeId)}&storyPath=${encodeURIComponent(storyPath)}`, StoryContentPreviewSchema, { signal }); },
    create(nodeId: string, input: StoryCreateInput) { return requestData("/api/stories", StorySchema, jsonRequest("POST", { nodeId, input: StoryCreateInputSchema.parse(input) })); },
    update(storyId: string, nodeId: string, input: StoryUpdateInput) { return requestData(`/api/stories/${encodeURIComponent(storyId)}`, StorySchema, jsonRequest("PATCH", { nodeId, input: StoryUpdateInputSchema.parse(input) })); },
    retentionSettings(storyId: string, nodeId: string) { return requestData(`/api/stories/${encodeURIComponent(storyId)}/settings?nodeId=${encodeURIComponent(nodeId)}`, StorySessionRetentionSettingsSchema); },
    async agentToolSettings(storyId: string, nodeId: string) {
      const data = await requestData(`/api/stories/${encodeURIComponent(storyId)}/settings/agent-tools?nodeId=${encodeURIComponent(nodeId)}`, z.unknown());
      return StoryAgentToolPolicySettingsSchema.parse(sanitizeStoryAgentToolPolicySettings(data));
    },
    async updateAgentToolSettings(storyId: string, nodeId: string, policy: StoryAgentToolPolicy) {
      const input = StoryAgentToolPolicyUpdateInputSchema.parse({ policy });
      const data = await requestData(`/api/stories/${encodeURIComponent(storyId)}/settings/agent-tools`, z.unknown(), jsonRequest("PUT", { nodeId, input }));
      return StoryAgentToolPolicySettingsSchema.parse(sanitizeStoryAgentToolPolicySettings(data));
    },
    listDecisions(storyId: string, nodeId: string, signal?: AbortSignal) {
      return requestData(`/api/stories/${encodeURIComponent(storyId)}/decisions?nodeId=${encodeURIComponent(nodeId)}`, StoryDecisionListSchema, { signal });
    },
    getDecision(storyId: string, decisionId: string, nodeId: string, signal?: AbortSignal) {
      return requestData(`/api/stories/${encodeURIComponent(storyId)}/decisions/${encodeURIComponent(decisionId)}?nodeId=${encodeURIComponent(nodeId)}`, StoryDecisionSchema, { signal });
    },
    decideStory(storyId: string, decisionId: string, nodeId: string, input: StoryDecisionDecideInput) {
      return requestData(
        `/api/stories/${encodeURIComponent(storyId)}/decisions/${encodeURIComponent(decisionId)}/decide`,
        StoryDecisionSchema,
        jsonRequest("POST", { nodeId, input: StoryDecisionDecideInputSchema.parse(input) }),
      );
    },
    cancelDecision(storyId: string, decisionId: string, nodeId: string, input: StoryDecisionCancelInput) {
      return requestData(
        `/api/stories/${encodeURIComponent(storyId)}/decisions/${encodeURIComponent(decisionId)}/cancel`,
        StoryDecisionSchema,
        jsonRequest("POST", { nodeId, input: StoryDecisionCancelInputSchema.parse(input) }),
      );
    },
    runAction(storyId: string, actionId: string, nodeId: string, clientRequestId: string) {
      const input = StoryAgentActionRunInputSchema.omit({ actionId: true }).parse({ clientRequestId });
      return requestData(`/api/stories/${encodeURIComponent(storyId)}/actions/${encodeURIComponent(actionId)}/run`, StoryActionRunResultSchema, jsonRequest("POST", { nodeId, input }));
    },
    archive(storyId: string, nodeId: string) { return requestData(`/api/stories/${encodeURIComponent(storyId)}/archive`, StorySchema, jsonRequest("POST", { nodeId })); },
    restore(storyId: string, nodeId: string) { return requestData(`/api/stories/${encodeURIComponent(storyId)}/restore`, StorySchema, jsonRequest("POST", { nodeId })); },
    remove(storyId: string, nodeId: string) { return requestData(`/api/stories/${encodeURIComponent(storyId)}?nodeId=${encodeURIComponent(nodeId)}`, z.object({ deleted: z.boolean() }).strict(), jsonRequest("DELETE")); },
    listAutomations(storyId: string, nodeId: string) { return requestData(`/api/stories/${encodeURIComponent(storyId)}/automations?nodeId=${encodeURIComponent(nodeId)}`, StoryAutomationListSchema); },
    getAutomation(storyId: string, automationId: string, nodeId: string) { return requestData(`/api/stories/${encodeURIComponent(storyId)}/automations/${encodeURIComponent(automationId)}?nodeId=${encodeURIComponent(nodeId)}`, StoryAutomationStatusSchema); },
    createAutomation(storyId: string, nodeId: string, input: StoryAutomationInput) { return requestData(`/api/stories/${encodeURIComponent(storyId)}/automations`, StoryAutomationStatusSchema, jsonRequest("POST", { nodeId, input: StoryAutomationInputSchema.parse(input) })); },
    createAutomationWithAction(storyId: string, nodeId: string, input: StoryAutomationWithActionInput) { return requestData(`/api/stories/${encodeURIComponent(storyId)}/automations/with-action`, StoryAutomationStatusSchema, jsonRequest("POST", { nodeId, input: StoryAutomationWithActionInputSchema.parse(input) })); },
    updateAutomation(storyId: string, automationId: string, nodeId: string, input: StoryAutomationUpdateInput) { return requestData(`/api/stories/${encodeURIComponent(storyId)}/automations/${encodeURIComponent(automationId)}`, StoryAutomationStatusSchema, jsonRequest("PATCH", { nodeId, input: StoryAutomationUpdateInputSchema.parse(input) })); },
    removeAutomation(storyId: string, automationId: string, nodeId: string) { return requestData(`/api/stories/${encodeURIComponent(storyId)}/automations/${encodeURIComponent(automationId)}?nodeId=${encodeURIComponent(nodeId)}`, z.object({ deleted: z.boolean() }).strict(), jsonRequest("DELETE")); },
    setAutomationEnabled(storyId: string, automationId: string, nodeId: string, enabled: boolean) { return requestData(`/api/stories/${encodeURIComponent(storyId)}/automations/${encodeURIComponent(automationId)}/${enabled ? "enable" : "disable"}`, StoryAutomationStatusSchema, jsonRequest("POST", { nodeId })); },
    runAutomation(storyId: string, automationId: string, nodeId: string, input: StoryAutomationManualRunInput) { return requestData(`/api/stories/${encodeURIComponent(storyId)}/automations/${encodeURIComponent(automationId)}/run`, StoryAutomationRunSchema, jsonRequest("POST", { nodeId, input: StoryAutomationManualRunInputSchema.parse(input) })); },
    automationRuns(storyId: string, automationId: string, nodeId: string) { return requestData(`/api/stories/${encodeURIComponent(storyId)}/automations/${encodeURIComponent(automationId)}/runs?nodeId=${encodeURIComponent(nodeId)}`, StoryAutomationRunsSchema); },
    updateDocument(storyId: string, nodeId: string, storyPath: string, input: z.infer<typeof StoryDocumentUpdateInputSchema>) { return requestData(`/api/stories/${encodeURIComponent(storyId)}/documents/${encodeURIComponent(storyPath)}`, StorySchema, jsonRequest("PATCH", { nodeId, input: StoryDocumentUpdateInputSchema.parse(input) })); },
    removeDocument(storyId: string, nodeId: string, storyPath: string) { return requestData(`/api/stories/${encodeURIComponent(storyId)}/documents/${encodeURIComponent(storyPath)}`, z.object({ deleted: z.boolean() }).strict(), jsonRequest("DELETE", { nodeId })); },
    reorderDocuments(storyId: string, nodeId: string, input: z.infer<typeof StoryDocumentOrderInputSchema>) { return requestData(`/api/stories/${encodeURIComponent(storyId)}/documents/order`, StorySchema, jsonRequest("POST", { nodeId, input: StoryDocumentOrderInputSchema.parse(input) })); },
    setSessionStory(instanceId: string, sessionId: string, storyId: string | null) { return requestData(`/api/controlled-instances/${encodeURIComponent(instanceId)}/ai-sessions/${encodeURIComponent(sessionId)}/story`, z.unknown(), jsonRequest("PUT", { storyId })); },
  };
}

export type ControlPlaneStoriesApi = ReturnType<typeof createControlPlaneStoriesApi>;
