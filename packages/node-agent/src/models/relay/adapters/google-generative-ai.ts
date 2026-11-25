import type { ModelRelayAdapter } from "../types.ts";
import { externalModelNames, syntheticPlan, unknownOperation, upstreamPlan } from "./shared.ts";

function googleModelsListBody(model: { modelNames: unknown; model: string }) {
  const names = externalModelNames(model as never);
  return JSON.stringify({
    models: names.map((name) => ({
      name: `models/${name}`,
      displayName: name,
      supportedGenerationMethods: ["generateContent", "streamGenerateContent", "countTokens"],
    })),
  });
}

function googleUpstreamUrl(endpoint: string, operationPath: string, search: string) {
  const root = endpoint.replace(/\/+$/, "");
  const versioned = /\/v1beta$/.test(root);
  return `${root}${versioned ? operationPath.slice("/v1beta".length) : operationPath}${search}`;
}

/**
 * Google Generative Language API relay adapter (Gemini CLI). The model travels
 * in the URL, so this adapter never rewrites request or response bodies.
 */
export function createGoogleGenerativeAiAdapter(): ModelRelayAdapter {
  return {
    protocol: "google-generative-ai",
    planOperation: ({ method, operationPath, search, model }) => {
      if (method === "GET" && operationPath === "/v1beta/models") {
        return syntheticPlan("models.list", googleModelsListBody(model));
      }
      const single = /^\/v1beta\/models\/([^/:]+)$/.exec(operationPath);
      if (method === "GET" && single) {
        const name = decodeURIComponent(single[1]);
        return syntheticPlan("models.get", JSON.stringify({
          name: `models/${name}`, displayName: name,
          supportedGenerationMethods: ["generateContent", "streamGenerateContent", "countTokens"],
        }));
      }
      const operation = /^\/v1beta\/models\/(.+):(generateContent|streamGenerateContent|countTokens)$/.exec(operationPath);
      if (method === "POST" && operation) {
        const name = operation[1];
        const action = operation[2];
        if (action === "generateContent") {
          return upstreamPlan("generateContent", "POST", googleUpstreamUrl(model.endpoint, operationPath, search), "json");
        }
        if (action === "streamGenerateContent") {
          return upstreamPlan("streamGenerateContent", "POST", googleUpstreamUrl(model.endpoint, operationPath, search), "sse");
        }
        if (action === "countTokens") {
          return upstreamPlan("countTokens", "POST", googleUpstreamUrl(model.endpoint, operationPath, search), "json");
        }
        void name;
      }
      return unknownOperation("google-generative-ai");
    },
    prepareRequest: async ({ body }) => ({ body }),
    prepareResponse: ({ body }) => body,
  };
}
