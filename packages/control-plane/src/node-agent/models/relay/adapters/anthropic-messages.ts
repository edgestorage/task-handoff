import type { NodeModelConfig } from "@task-handoff/protocol/control-plane";
import { MODEL_RELAY_ERROR_CODES } from "../errors.ts";
import type { ModelRelayAdapter } from "../types.ts";
import { createProtocolAdapter, externalModelNames, syntheticPlan, unknownOperation, upstreamPlan, upstreamUrl } from "./shared.ts";

function anthropicModelsListBody(model: Pick<NodeModelConfig, "modelNames" | "model">) {
  const names = externalModelNames(model);
  return JSON.stringify({
    data: names.map((name) => ({
      id: name,
      type: "model",
      display_name: name,
      created_at: "2026-01-01T00:00:00Z",
    })),
    has_more: false,
    first_id: names[0] ?? null,
    last_id: names[names.length - 1] ?? null,
  });
}

/**
 * Anthropic Messages relay adapter (Claude Code). Claude Code probes its
 * gateway with `HEAD /api/hello` before the first model call; the relay
 * answers that probe locally with a structured 404 so it never reaches the
 * upstream endpoint.
 */
export function createAnthropicMessagesAdapter(): ModelRelayAdapter {
  return {
    ...createProtocolAdapter({
      protocol: "anthropic-messages",
      responsePaths: [["model"], ["message", "model"]],
    }),
    planOperation: ({ method, operationPath, search, model }) => {
      if (method === "GET" && operationPath === "/models") {
        return syntheticPlan("models.list", anthropicModelsListBody(model));
      }
      if (method === "POST" && operationPath === "/messages") {
        return upstreamPlan("messages.create", "POST", upstreamUrl(model.endpoint, "/v1/messages", search), "json");
      }
      if (method === "POST" && operationPath === "/messages/count_tokens") {
        return upstreamPlan("messages.count_tokens", "POST", upstreamUrl(model.endpoint, "/v1/messages/count_tokens", search), "json");
      }
      if (method === "HEAD" && operationPath === "/api/hello") {
        return {
          kind: "reject",
          name: "gateway.probe",
          status: 404,
          code: MODEL_RELAY_ERROR_CODES.operationNotAllowed,
          message: "The node model relay does not proxy gateway probes.",
        };
      }
      return unknownOperation("anthropic-messages");
    },
  };
}
