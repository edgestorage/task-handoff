import type { AiSessionModelSelection, AiSessionPermissionMode, AiSessionReasoningEffort } from "@task-handoff/protocol/ai-sessions";

export type AcpAgentId = "gemini" | "commandcode" | "dsh";

export const ACP_AGENT_PROTOCOLS = {
  gemini: ["google-generative-ai"],
  commandcode: ["openai-chat-completions", "openai-responses", "anthropic-messages"],
  dsh: ["openai-chat-completions", "openai-responses", "anthropic-messages", "google-generative-ai"],
} as const satisfies Record<AcpAgentId, readonly string[]>;

export type AcpModelProtocol = (typeof ACP_AGENT_PROTOCOLS)[AcpAgentId][number];

export function isAcpAgentId(agent: string): agent is AcpAgentId {
  return Object.prototype.hasOwnProperty.call(ACP_AGENT_PROTOCOLS, agent);
}

export function acpAgentProtocols(agent: string): readonly AcpModelProtocol[] {
  return isAcpAgentId(agent) ? ACP_AGENT_PROTOCOLS[agent] : [];
}

export function acpProtocolForEntity(agent: string, protocols: readonly string[]): AcpModelProtocol | undefined {
  return acpAgentProtocols(agent).find((protocol) => protocols.includes(protocol));
}

/** Agent-visible provider key. ACP providers address configured TaskHandoff models through this stable namespace. */
export function acpManagedProviderKey(modelEntityId: string) {
  const normalized = modelEntityId.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  return `task-handoff-${normalized || "model"}`;
}

export function acpModelValue(agent: string, selection: AiSessionModelSelection) {
  const model = selection.modelUpstreamName || selection.modelName;
  if (agent === "commandcode") return `${acpManagedProviderKey(selection.modelEntityId)}/${model}`;
  if (agent === "dsh") return JSON.stringify([acpManagedProviderKey(selection.modelEntityId), model]);
  return model;
}

export type AcpSelectOption = { value: string; name: string; description?: string };
export type AcpSelectConfiguration = {
  id: string;
  name: string;
  category?: string;
  currentValue: string;
  options: AcpSelectOption[];
};

export type AcpSessionConfiguration = {
  options: AcpSelectConfiguration[];
  legacyModels?: { currentModelId: string; availableModels: AcpSelectOption[] };
};

export type AcpSessionMode = { id: string; name: string; description?: string };
export type AcpSessionModes = { currentModeId: string; availableModes: AcpSessionMode[] };

/**
 * TaskHandoff permission modes are semantic. Each pinned Agent exposes its own
 * IDs, so the mapping must stay at the adapter boundary and never leak to the
 * public capability model.
 */
const ACP_PERMISSION_MODE_IDS: Partial<Record<AcpAgentId, Record<AiSessionPermissionMode, string>>> = {
  gemini: { ask: "default", "auto-review": "autoEdit", "full-access": "yolo" },
  commandcode: { ask: "default", "auto-review": "auto-accept", "full-access": "bypass" },
};

export function acpPermissionModes(agent: string): AiSessionPermissionMode[] {
  if (!isAcpAgentId(agent) || !ACP_PERMISSION_MODE_IDS[agent]) return [];
  return ["ask", "auto-review", "full-access"];
}

export function acpPermissionModeId(agent: string, mode: AiSessionPermissionMode) {
  return isAcpAgentId(agent) ? ACP_PERMISSION_MODE_IDS[agent]?.[mode] : undefined;
}

export function acpPermissionModeForId(agent: string, id: string) {
  if (!isAcpAgentId(agent)) return undefined;
  return (Object.entries(ACP_PERMISSION_MODE_IDS[agent] ?? {}) as [AiSessionPermissionMode, string][])
    .find(([, candidate]) => candidate === id)?.[0];
}

export function normalizeAcpSessionModes(value: unknown): AcpSessionModes | undefined {
  const source = record(value);
  if (!source || !Array.isArray(source.availableModes)) return undefined;
  const availableModes = source.availableModes.flatMap((entry): AcpSessionMode[] => {
    const item = record(entry);
    const id = text(item?.id);
    const name = text(item?.name);
    return id && name
      ? [{ id, name, ...(text(item?.description) ? { description: text(item?.description) } : {}) }]
      : [];
  });
  if (!availableModes.length) return undefined;
  return {
    currentModeId: text(source.currentModeId) ?? availableModes[0].id,
    availableModes,
  };
}

type RecordLike = Record<string, unknown>;

function record(value: unknown): RecordLike | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as RecordLike : undefined;
}

function text(value: unknown) {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function flattenSelectOptions(value: unknown): AcpSelectOption[] {
  if (!Array.isArray(value)) return [];
  const options: AcpSelectOption[] = [];
  for (const entry of value) {
    const item = record(entry);
    if (!item) continue;
    const nested = item.options;
    if (Array.isArray(nested)) {
      options.push(...flattenSelectOptions(nested));
      continue;
    }
    const optionValue = text(item.value) ?? text(item.modelId);
    const name = text(item.name);
    if (!optionValue || !name) continue;
    options.push({
      value: optionValue,
      name,
      ...(text(item.description) ? { description: text(item.description) } : {}),
    });
  }
  return options;
}

/**
 * Project the two ACP model surfaces into one shape. Current ACP agents use
 * `configOptions`; Gemini CLI 0.71.1 still returns the older `models` object.
 * Unknown entries are ignored, while malformed recognized entries are omitted
 * instead of failing the whole session.
 */
export function normalizeAcpSessionConfiguration(value: unknown): AcpSessionConfiguration {
  const source = record(value) ?? {};
  const options = Array.isArray(source.configOptions)
    ? source.configOptions.flatMap((entry) => {
        const item = record(entry);
        if (!item || item.type === "boolean") return [];
        const id = text(item.id);
        const name = text(item.name);
        // ACP select values are opaque strings. dsh uses the empty string to
        // represent its provider-default reasoning level after a model switch.
        const currentValue = typeof item.currentValue === "string" ? item.currentValue : undefined;
        const selectOptions = flattenSelectOptions(item.options);
        if (!id || !name || currentValue === undefined || !selectOptions.length) return [];
        return [{
          id,
          name,
          ...(text(item.category) ? { category: text(item.category) } : {}),
          currentValue,
          options: selectOptions,
        }];
      })
    : [];
  const legacy = record(source.models);
  const availableModels = legacy ? flattenSelectOptions(legacy.availableModels) : [];
  const currentModelId = legacy ? text(legacy.currentModelId) : undefined;
  return {
    options,
    ...(legacy && currentModelId && availableModels.length
      ? { legacyModels: { currentModelId, availableModels } }
      : {}),
  };
}

export function acpModelOption(configuration: AcpSessionConfiguration) {
  return configuration.options.find((option) => option.category === "model" || option.id === "model");
}

export function acpReasoningOption(configuration: AcpSessionConfiguration) {
  return configuration.options.find((option) => option.category === "thought_level"
    || option.id === "reasoning_effort" || option.id === "effort");
}

export function acpAvailableModelValues(configuration: AcpSessionConfiguration) {
  return acpModelOption(configuration)?.options.map((option) => option.value)
    ?? configuration.legacyModels?.availableModels.map((option) => option.value)
    ?? [];
}

/**
 * Gemini CLI accepts configured model IDs through `session/set_model` but does
 * not include them in the legacy `availableModels` list. Stable config options
 * remain authoritative for Agents that can enumerate every selectable value.
 */
export function acpModelValueSelectable(configuration: AcpSessionConfiguration, value: string) {
  if (configuration.legacyModels) return true;
  const available = acpAvailableModelValues(configuration);
  return !available.length || available.includes(value);
}

export function acpSelectedModelValue(configuration: AcpSessionConfiguration) {
  return acpModelOption(configuration)?.currentValue ?? configuration.legacyModels?.currentModelId;
}

function reasoningAliases(effort: AiSessionReasoningEffort) {
  const common: string[] = [effort];
  if (effort === "none") common.push("off", "disabled");
  if (effort === "minimal") common.push("low");
  if (effort === "xhigh" || effort === "max" || effort === "ultra") common.push("xhigh", "max", "ultra");
  return [...new Set(common)];
}

export function acpReasoningEffortValue(configuration: AcpSessionConfiguration, effort: AiSessionReasoningEffort) {
  const option = acpReasoningOption(configuration);
  if (!option) return undefined;
  const aliases = reasoningAliases(effort);
  const matches = option.options.filter((candidate) => aliases.includes(candidate.value.toLowerCase())
    || aliases.includes(candidate.name.toLowerCase()));
  return matches.find((candidate) => aliases.includes(candidate.value.toLowerCase()))?.value
    ?? matches[0]?.value;
}
