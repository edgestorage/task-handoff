import { normalizeModelNameEntries, type NodeModelConfig } from "@task-handoff/protocol/control-plane";
import { MODEL_RELAY_ERROR_CODES } from "../errors.ts";
import { createModelRelayRequestBody, rewriteJsonModelResponseBody, type JsonModelPath, type JsonModelRewriteMapping } from "../json-model-rewrite.ts";
import { rewriteSseModelResponseBody } from "../sse-model-rewrite.ts";
import type { ModelRelayAdapter, ModelRelayDiagnostic, ModelRelayOperationPlan, ModelRelayUpstreamPlan } from "../types.ts";

export function externalModelNames(model: Pick<NodeModelConfig, "modelNames" | "model">) {
  return normalizeModelNameEntries(model.modelNames, model.model)
    .slice()
    .sort((left, right) => left.order - right.order || left.name.localeCompare(right.name))
    .map((entry) => entry.name);
}

export function upstreamUrl(endpoint: string, operationPath: string, search: string) {
  return `${endpoint.replace(/\/+$/, "")}${operationPath}${search}`;
}

export function unknownOperation(protocol: string): ModelRelayOperationPlan {
  return {
    kind: "reject",
    name: "unknown",
    status: 404,
    code: MODEL_RELAY_ERROR_CODES.operationNotAllowed,
    message: `The node model relay does not allow this ${protocol} operation.`,
  };
}

/** OpenAI-style synthetic model catalog built from the route's external names. */
export function openAiModelsListBody(model: Pick<NodeModelConfig, "modelNames" | "model">) {
  return JSON.stringify({
    object: "list",
    data: externalModelNames(model).map((name) => ({ id: name, object: "model", created: 0, owned_by: "task-handoff" })),
  });
}

export function upstreamPlan(name: string, method: string, url: string, responseMode: ModelRelayUpstreamPlan["responseMode"]): ModelRelayUpstreamPlan {
  return { kind: "upstream", name, method, url, responseMode };
}

export function syntheticPlan(name: string, body: string): ModelRelayOperationPlan {
  return { kind: "synthetic", name, status: 200, headers: { "content-type": "application/json" }, body };
}

/**
 * Shared adapter behavior: resolve the top-level request model before any
 * upstream contact and map protocol-standard response model fields back.
 */
export function createProtocolAdapter(input: {
  protocol: ModelRelayAdapter["protocol"];
  responsePaths: readonly JsonModelPath[];
}): ModelRelayAdapter {
  return {
    protocol: input.protocol,
    planOperation: () => unknownOperation(input.protocol),
    prepareRequest: async ({ body, plan, resolveUpstreamModelName, maxPrologueBytes }) => {
      if (!body || plan.method === "GET" || plan.method === "HEAD") return {};
      const prepared = await createModelRelayRequestBody({ body, resolveUpstreamModelName, maxPrologueBytes });
      return {
        body: prepared.body,
        externalModelName: prepared.externalModelName,
        upstreamModelName: prepared.upstreamModelName,
      };
    },
    prepareResponse: ({ body, plan, externalModelName, upstreamModelName, maxResponseEventBytes, onDiagnostic }) => {
      if (plan.responseMode === "raw") return body;
      const mapping: JsonModelRewriteMapping = {
        paths: input.responsePaths,
        externalName: externalModelName,
        expectedUpstreamName: upstreamModelName,
        onMismatch: () => onDiagnostic?.({ code: "MODEL_RELAY_UPSTREAM_MODEL_MISMATCH" }),
      };
      if (plan.responseMode === "sse") {
        return rewriteSseModelResponseBody(body, mapping, { maxEventBytes: maxResponseEventBytes });
      }
      return rewriteJsonModelResponseBody(body, mapping);
    },
  };
}

export type { ModelRelayDiagnostic };
