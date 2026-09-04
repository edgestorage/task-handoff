import { z } from "zod";
import {
  StoryCreateInputSchema,
  StoryContentPreviewSchema,
  StoryDocumentOrderInputSchema,
  StoryDocumentUpdateInputSchema,
  StoryListSchema,
  StorySchema,
  StoryUpdateInputSchema,
  StorySessionRetentionSettingsSchema,
  type StoryCreateInput,
  type StoryUpdateInput,
} from "@task-handoff/protocol/stories";
import type { ControlPlaneClientTransport } from "./transport.ts";

const DataSchema = <T extends z.ZodType>(schema: T) => z.object({ data: schema }).passthrough();
export function createControlPlaneStoriesApi(transport: ControlPlaneClientTransport) {
  const requestData = async <T>(path: string, schema: z.ZodType<T>, init?: RequestInit) => (await transport.request(path, DataSchema(schema), init)).data;
  const json = (method: string, body?: unknown): RequestInit => ({ method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return {
    list(nodeId?: string, signal?: AbortSignal) {
      return requestData("/api/stories" + (nodeId ? `?nodeId=${encodeURIComponent(nodeId)}` : ""), z.object({ stories: StoryListSchema.shape.stories, unavailableNodeIds: z.array(z.string()).default([]) }).strict(), { signal });
    },
    get(storyId: string, nodeId: string) { return requestData(`/api/stories/${encodeURIComponent(storyId)}?nodeId=${encodeURIComponent(nodeId)}`, StorySchema); },
    preview(storyId: string, nodeId: string, storyPath: string, signal?: AbortSignal) { return requestData(`/api/stories/${encodeURIComponent(storyId)}/content/preview?nodeId=${encodeURIComponent(nodeId)}&storyPath=${encodeURIComponent(storyPath)}`, StoryContentPreviewSchema, { signal }); },
    create(nodeId: string, input: StoryCreateInput) { return requestData("/api/stories", StorySchema, json("POST", { nodeId, input: StoryCreateInputSchema.parse(input) })); },
    update(storyId: string, nodeId: string, input: StoryUpdateInput) { return requestData(`/api/stories/${encodeURIComponent(storyId)}`, StorySchema, json("PATCH", { nodeId, input: StoryUpdateInputSchema.parse(input) })); },
    retentionSettings(storyId: string, nodeId: string) { return requestData(`/api/stories/${encodeURIComponent(storyId)}/settings?nodeId=${encodeURIComponent(nodeId)}`, StorySessionRetentionSettingsSchema); },
    archive(storyId: string, nodeId: string) { return requestData(`/api/stories/${encodeURIComponent(storyId)}/archive`, StorySchema, json("POST", { nodeId })); },
    restore(storyId: string, nodeId: string) { return requestData(`/api/stories/${encodeURIComponent(storyId)}/restore`, StorySchema, json("POST", { nodeId })); },
    remove(storyId: string, nodeId: string) { return requestData(`/api/stories/${encodeURIComponent(storyId)}?nodeId=${encodeURIComponent(nodeId)}`, z.object({ deleted: z.boolean() }).strict(), json("DELETE")); },
    updateDocument(storyId: string, nodeId: string, storyPath: string, input: z.infer<typeof StoryDocumentUpdateInputSchema>) { return requestData(`/api/stories/${encodeURIComponent(storyId)}/documents/${encodeURIComponent(storyPath)}`, StorySchema, json("PATCH", { nodeId, input: StoryDocumentUpdateInputSchema.parse(input) })); },
    removeDocument(storyId: string, nodeId: string, storyPath: string) { return requestData(`/api/stories/${encodeURIComponent(storyId)}/documents/${encodeURIComponent(storyPath)}`, z.object({ deleted: z.boolean() }).strict(), json("DELETE", { nodeId })); },
    reorderDocuments(storyId: string, nodeId: string, input: z.infer<typeof StoryDocumentOrderInputSchema>) { return requestData(`/api/stories/${encodeURIComponent(storyId)}/documents/order`, StorySchema, json("POST", { nodeId, input: StoryDocumentOrderInputSchema.parse(input) })); },
    setSessionStory(instanceId: string, sessionId: string, storyId: string | null) { return requestData(`/api/controlled-instances/${encodeURIComponent(instanceId)}/ai-sessions/${encodeURIComponent(sessionId)}/story`, z.unknown(), json("PUT", { storyId })); },
  };
}

export type ControlPlaneStoriesApi = ReturnType<typeof createControlPlaneStoriesApi>;
