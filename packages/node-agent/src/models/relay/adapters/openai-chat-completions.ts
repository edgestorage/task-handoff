import type { ModelRelayAdapter } from "../types.ts";
import { createProtocolAdapter, openAiModelsListBody, syntheticPlan, unknownOperation, upstreamPlan, upstreamUrl } from "./shared.ts";

/**
 * OpenAI Chat Completions relay adapter (OpenCode). The wire model, usage,
 * tool call and finish reason semantics stay untouched; only the standard
 * model field is rewritten.
 */
export function createOpenAiChatCompletionsAdapter(): ModelRelayAdapter {
  return {
    ...createProtocolAdapter({
      protocol: "openai-chat-completions",
      responsePaths: [["model"]],
    }),
    planOperation: ({ method, operationPath, search, model }) => {
      if (method === "GET" && operationPath === "/models") {
        return syntheticPlan("models.list", openAiModelsListBody(model));
      }
      if (method === "POST" && operationPath === "/chat/completions") {
        return upstreamPlan("chat.completions.create", "POST", upstreamUrl(model.endpoint, "/chat/completions", search), "json");
      }
      return unknownOperation("openai-chat-completions");
    },
  };
}
