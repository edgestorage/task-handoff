import type { ModelRelayAdapter } from "../types.ts";
import { createProtocolAdapter, openAiModelsListBody, syntheticPlan, unknownOperation, upstreamPlan, upstreamUrl } from "./shared.ts";

/**
 * OpenAI Responses relay adapter (Codex). Captured Codex artifacts only send
 * `POST /v1/responses`; the model catalog is synthesized locally instead of
 * proxying the upstream directory.
 */
export function createOpenAiResponsesAdapter(): ModelRelayAdapter {
  return {
    ...createProtocolAdapter({
      protocol: "openai-responses",
      responsePaths: [["model"], ["response", "model"]],
    }),
    planOperation: ({ method, operationPath, search, model }) => {
      if (method === "GET" && operationPath === "/models") {
        return syntheticPlan("models.list", openAiModelsListBody(model));
      }
      if (method === "POST" && operationPath === "/responses") {
        return upstreamPlan("responses.create", "POST", upstreamUrl(model.endpoint, "/responses", search), "json");
      }
      return unknownOperation("openai-responses");
    },
  };
}
