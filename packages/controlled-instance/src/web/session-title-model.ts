import {
  directInstancePrivateModelCatalog,
  instancePrivateModelCatalogBaseUrl,
  relayInstancePrivateModelCatalog,
  type InstancePrivateModelCatalog,
} from "@task-handoff/core/core/instance-private-model-catalog";
import type { AiSessionModelSelection, AiSessionReasoningEffort } from "@task-handoff/protocol/ai-sessions";

type TitleProtocol = "openai-responses" | "openai-chat-completions";

export type ControlledSessionTitleModelRequest = {
  catalog: InstancePrivateModelCatalog | undefined;
  modelSelection: AiSessionModelSelection;
  reasoningEffort?: AiSessionReasoningEffort;
  prompt: string;
  outputSchema: Record<string, unknown>;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
};

/**
 * Builds the title request in the instance that owns the private model
 * catalog. Responses is preferred because its canonical reasoning effort enum
 * does not depend on a provider's Chat Completions aliases.
 */
export async function requestControlledAiSessionTitle(input: ControlledSessionTitleModelRequest) {
  const { catalog, modelSelection } = input;
  const entity = catalog?.entities.find((candidate) => candidate.id === modelSelection.modelEntityId);
  if (!catalog || !entity) throw titleModelError("AI_SESSION_TITLE_MODEL_UNAVAILABLE", "The selected title model is unavailable in this instance.");

  const protocol = (["openai-responses", "openai-chat-completions"] as const).find((candidate) => (
    entity.protocols.includes(candidate)
    && Boolean(instancePrivateModelCatalogBaseUrl(catalog, entity.id, candidate))
  ));
  if (!protocol) throw titleModelError("AI_SESSION_TITLE_PROTOCOL_UNAVAILABLE", "The selected title model has no OpenAI-compatible route.");

  const baseUrl = instancePrivateModelCatalogBaseUrl(catalog, entity.id, protocol);
  const credential = relayInstancePrivateModelCatalog(catalog)
    ? (input.env || process.env).TASK_HANDOFF_REGISTRATION_TOKEN?.trim()
    : directInstancePrivateModelCatalog(catalog)?.entities.find((candidate) => candidate.id === entity.id)?.key;
  if (!baseUrl || !credential) throw titleModelError("AI_SESSION_TITLE_CREDENTIAL_UNAVAILABLE", "The selected title model has no usable route credential.");

  const model = modelSelection.modelUpstreamName || modelSelection.modelName;
  const body = titleRequestBody(protocol, model, input.prompt, input.outputSchema, input.reasoningEffort);
  const response = await (input.fetchImpl || fetch)(routeUrl(baseUrl, protocol), {
    method: "POST",
    headers: {
      authorization: `Bearer ${credential}`,
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(input.timeoutMs ?? 30_000),
  });
  const raw = await response.text();
  if (!response.ok) {
    throw titleModelError("AI_SESSION_TITLE_MODEL_REQUEST_FAILED", `Title model returned HTTP ${response.status}: ${raw.slice(0, 4000)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw titleModelError("AI_SESSION_TITLE_MODEL_RESPONSE_INVALID", "Title model returned invalid JSON.");
  }
  const text = titleResponseText(protocol, parsed);
  if (!text) throw titleModelError("AI_SESSION_TITLE_MODEL_RESPONSE_INVALID", "Title model returned no text output.");
  return text;
}

function titleRequestBody(
  protocol: TitleProtocol,
  model: string,
  prompt: string,
  outputSchema: Record<string, unknown>,
  reasoningEffort?: AiSessionReasoningEffort,
) {
  if (protocol === "openai-responses") {
    return {
      model,
      input: [{ role: "user", content: [{ type: "input_text", text: prompt }] }],
      ...(reasoningEffort ? { reasoning: { effort: reasoningEffort } } : {}),
      text: {
        format: {
          type: "json_schema",
          name: "ai_session_title",
          strict: true,
          schema: outputSchema,
        },
      },
    };
  }
  return {
    model,
    messages: [{ role: "user", content: prompt }],
    ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "ai_session_title",
        strict: true,
        schema: outputSchema,
      },
    },
  };
}

function titleResponseText(protocol: TitleProtocol, value: unknown) {
  const response = asRecord(value);
  if (protocol === "openai-responses") {
    if (typeof response.output_text === "string" && response.output_text.trim()) return response.output_text;
    for (const item of arrayValue(response.output)) {
      const output = asRecord(item);
      if (output.type !== "message") continue;
      for (const content of arrayValue(output.content)) {
        const part = asRecord(content);
        if (part.type === "output_text" && typeof part.text === "string" && part.text.trim()) return part.text;
      }
    }
    return undefined;
  }
  const choice = asRecord(arrayValue(response.choices)[0]);
  const message = asRecord(choice.message);
  if (typeof message.content === "string" && message.content.trim()) return message.content;
  for (const content of arrayValue(message.content)) {
    const part = asRecord(content);
    if ((part.type === "text" || part.type === "output_text") && typeof part.text === "string" && part.text.trim()) return part.text;
  }
  return typeof choice.text === "string" && choice.text.trim() ? choice.text : undefined;
}

function routeUrl(baseUrl: string, protocol: TitleProtocol) {
  return `${baseUrl.replace(/\/+$/, "")}${protocol === "openai-responses" ? "/responses" : "/chat/completions"}`;
}

function titleModelError(code: string, message: string) {
  return Object.assign(new Error(message), { code });
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
