import {
  directInstancePrivateModelCatalog,
  instancePrivateModelCatalogBaseUrl,
  relayInstancePrivateModelCatalog,
  type InstancePrivateModelCatalog,
} from "@task-handoff/core/core/instance-private-model-catalog";
import type { AiSessionModelSelection, AiSessionReasoningEffort } from "@task-handoff/protocol/ai-sessions";

type TitleProtocol = "openai-responses" | "openai-chat-completions";

export type ControlledSessionStructuredMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

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

export type ControlledSessionStructuredModelRequest = Omit<ControlledSessionTitleModelRequest, "prompt"> & {
  prompt?: string;
  messages?: readonly ControlledSessionStructuredMessage[];
  schemaName?: string;
  signal?: AbortSignal;
  errorCodePrefix?: string;
};

/**
 * Builds the title request in the instance that owns the private model
 * catalog. Responses is preferred because its canonical reasoning effort enum
 * does not depend on a provider's Chat Completions aliases.
 */
export async function requestControlledAiSessionTitle(input: ControlledSessionTitleModelRequest) {
  return requestControlledAiSessionStructuredModel({
    ...input,
    messages: [{ role: "user", content: input.prompt }],
    schemaName: "ai_session_title",
    errorCodePrefix: "AI_SESSION_TITLE",
  });
}

export async function requestControlledAiSessionStructuredModel(input: ControlledSessionStructuredModelRequest) {
  const { catalog, modelSelection } = input;
  const entity = catalog?.entities.find((candidate) => candidate.id === modelSelection.modelEntityId);
  const errorCode = (suffix: string) => `${input.errorCodePrefix || "AI_SESSION_STRUCTURED_MODEL"}_${suffix}`;
  if (!catalog || !entity) throw titleModelError(errorCode("MODEL_UNAVAILABLE"), "The selected model is unavailable in this instance.");

  const protocol = (["openai-responses", "openai-chat-completions"] as const).find((candidate) => (
    entity.protocols.includes(candidate)
    && Boolean(instancePrivateModelCatalogBaseUrl(catalog, entity.id, candidate))
  ));
  if (!protocol) throw titleModelError(errorCode("PROTOCOL_UNAVAILABLE"), "The selected model has no OpenAI-compatible route.");

  const baseUrl = instancePrivateModelCatalogBaseUrl(catalog, entity.id, protocol);
  const credential = relayInstancePrivateModelCatalog(catalog)
    ? (input.env || process.env).TASK_HANDOFF_REGISTRATION_TOKEN?.trim()
    : directInstancePrivateModelCatalog(catalog)?.entities.find((candidate) => candidate.id === entity.id)?.key;
  if (!baseUrl || !credential) throw titleModelError(errorCode("CREDENTIAL_UNAVAILABLE"), "The selected model has no usable route credential.");

  const messages = input.messages?.length
    ? input.messages
    : [{ role: "user" as const, content: input.prompt || "" }];
  if (!messages.length || messages.some((message) => !message.content.trim())) {
    throw titleModelError(errorCode("MESSAGE_INVALID"), "Structured model messages must contain non-empty text.");
  }

  const model = modelSelection.modelUpstreamName || modelSelection.modelName;
  const body = structuredRequestBody(protocol, model, messages, input.outputSchema, input.reasoningEffort, input.schemaName || "ai_session_structured_output");
  const timeout = AbortSignal.timeout(input.timeoutMs ?? 30_000);
  const signal = input.signal ? AbortSignal.any([timeout, input.signal]) : timeout;
  const response = await (input.fetchImpl || fetch)(routeUrl(baseUrl, protocol), {
    method: "POST",
    headers: {
      authorization: `Bearer ${credential}`,
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify(body),
    signal,
  });
  const raw = await response.text();
  if (!response.ok) {
    throw titleModelError(errorCode("MODEL_REQUEST_FAILED"), `Structured model returned HTTP ${response.status}: ${raw.slice(0, 4000)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw titleModelError(errorCode("MODEL_RESPONSE_INVALID"), "Structured model returned invalid JSON.");
  }
  const text = titleResponseText(protocol, parsed);
  if (!text) throw titleModelError(errorCode("MODEL_RESPONSE_INVALID"), "Structured model returned no text output.");
  return text;
}

function structuredRequestBody(
  protocol: TitleProtocol,
  model: string,
  messages: readonly ControlledSessionStructuredMessage[],
  outputSchema: Record<string, unknown>,
  reasoningEffort?: AiSessionReasoningEffort,
  schemaName = "ai_session_title",
) {
  if (protocol === "openai-responses") {
    const instructions = messages
      .filter((message) => message.role === "system")
      .map((message) => message.content)
      .join("\n\n");
    return {
      model,
      ...(instructions ? { instructions } : {}),
      input: messages
        .filter((message) => message.role !== "system")
        .map((message) => ({
          role: message.role,
          content: [{ type: message.role === "assistant" ? "output_text" : "input_text", text: message.content }],
        })),
      ...(reasoningEffort ? { reasoning: { effort: reasoningEffort } } : {}),
      text: {
        format: {
          type: "json_schema",
          name: schemaName,
          strict: true,
          schema: outputSchema,
        },
      },
    };
  }
  return {
    model,
    messages: messages.map((message) => ({ role: message.role, content: message.content })),
    ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
    response_format: {
      type: "json_schema",
      json_schema: {
        name: schemaName,
        strict: true,
        schema: outputSchema,
      },
    },
  };
}

function titleResponseText(protocol: TitleProtocol, value: unknown) {
  const response = asRecord(value);
  if (protocol === "openai-responses") {
    const outputText = nonEmptyText(response.output_text);
    if (outputText) return outputText;
    for (const item of arrayValue(response.output)) {
      const output = asRecord(item);
      if (output.type === "message") {
        const text = messageContentText(output.content);
        if (text) return text;
        continue;
      }
      if (output.type === "function_call" || output.type === "custom_tool_call") {
        const text = toolArgumentsText(output.arguments ?? output.input);
        if (text) return text;
      }
    }
    return undefined;
  }
  const choice = asRecord(arrayValue(response.choices)[0]);
  const message = asRecord(choice.message);
  const content = messageContentText(message.content);
  if (content) return content;
  for (const toolCall of arrayValue(message.tool_calls)) {
    const args = toolArgumentsText(asRecord(asRecord(toolCall).function).arguments);
    if (args) return args;
  }
  const functionCall = asRecord(message.function_call);
  const functionArguments = toolArgumentsText(functionCall.arguments);
  if (functionArguments) return functionArguments;
  return nonEmptyText(choice.text);
}

function messageContentText(value: unknown) {
  const text = nonEmptyText(value);
  if (text) return text;
  for (const content of arrayValue(value)) {
    const part = asRecord(content);
    if (part.type !== "text" && part.type !== "output_text") continue;
    const partText = nonEmptyText(part.text);
    if (partText) return partText;
  }
  return undefined;
}

function toolArgumentsText(value: unknown) {
  const text = nonEmptyText(value);
  if (text) return text;
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const json = JSON.stringify(value);
  return json === "{}" ? undefined : json;
}

function nonEmptyText(value: unknown) {
  return typeof value === "string" && value.trim() ? value : undefined;
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
