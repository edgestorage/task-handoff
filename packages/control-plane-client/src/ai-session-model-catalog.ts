import type { AiSessionModelSelection } from "@task-handoff/protocol/ai-sessions";
import type { AiSessionModelSelectionCapabilities } from "@task-handoff/protocol/ai-session-provider-capabilities";

export type AiSessionCatalogAgent = "codex" | "claude" | "opencode" | string;

export type AiSessionCatalogModelEntity = {
  id: string;
  name: string;
  model: string;
  enabled: boolean;
  order: number;
  app?: string;
  protocols?: string[];
  modelNames?: Array<{ name: string; order: number }>;
  locations?: Array<{ type: "control-plane" | "node"; nodeId?: string; enabled: boolean }>;
};

export type AiSessionCatalogAssignment = {
  modelEntityIds?: string[];
  codexModelHash?: string | null;
  claudeModelHash?: string | null;
  opencodeModelHash?: string | null;
};

export type AiSessionModelOption = AiSessionModelSelection & {
  providerName: string;
};

export type AiSessionModelGroup = {
  modelEntityId: string;
  providerName: string;
  models: AiSessionModelOption[];
};

const agentProtocol: Record<string, string> = {
  codex: "openai-responses",
  claude: "anthropic-messages",
  opencode: "openai-chat-completions",
};

export function assignedModelEntityIds(assignment: AiSessionCatalogAssignment): string[] {
  const current = assignment.modelEntityIds?.length
    ? assignment.modelEntityIds
    : [assignment.codexModelHash, assignment.claudeModelHash, assignment.opencodeModelHash];
  return [...new Set(current.filter((id): id is string => typeof id === "string" && id.length > 0))];
}

export function deriveAiSessionModelGroups(input: {
  entities: AiSessionCatalogModelEntity[];
  assignment: AiSessionCatalogAssignment;
  agent: AiSessionCatalogAgent;
  nodeId: string;
  mode: "create" | "existing";
  currentSelection?: AiSessionModelSelection;
  capability?: Partial<AiSessionModelSelectionCapabilities>;
}): AiSessionModelGroup[] {
  const ids = assignedModelEntityIds(input.assignment);
  const entityById = new Map(input.entities.map((entity) => [entity.id, entity]));
  const capability = input.capability || {};
  const providerSelectionAllowed = input.mode === "create"
    ? capability.selectProviderAtCreate === true
    : capability.switchProviderDuringSession === true;
  const modelSelectionAllowed = input.mode === "create"
    ? capability.selectModelAtCreate === true
    : capability.switchModelWithinProvider === true;
  if (!modelSelectionAllowed) return [];

  return ids.flatMap((id) => {
    if (!providerSelectionAllowed && input.currentSelection?.modelEntityId !== id) return [];
    const entity = entityById.get(id);
    if (!entity || !entityAvailable(entity, input.nodeId) || !entitySupportsAgent(entity, input.agent)) return [];
    const names = [...(entity.modelNames?.length ? entity.modelNames : [{ name: entity.model, order: 0 }])]
      .filter((entry) => entry.name.trim().length > 0)
      .sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));
    if (!names.length) return [];
    return [{
      modelEntityId: entity.id,
      providerName: entity.name,
      models: names.map((entry) => ({ modelEntityId: entity.id, modelName: entry.name, providerName: entity.name })),
    }];
  });
}

export function defaultAiSessionModelSelection(groups: AiSessionModelGroup[]): AiSessionModelSelection | undefined {
  const first = groups[0]?.models[0];
  return first ? { modelEntityId: first.modelEntityId, modelName: first.modelName } : undefined;
}

function entityAvailable(entity: AiSessionCatalogModelEntity, nodeId: string) {
  return entity.enabled && entity.locations?.some((location) => location.enabled
    && (location.type === "control-plane" || location.nodeId === nodeId)) === true;
}

function entitySupportsAgent(entity: AiSessionCatalogModelEntity, agent: string) {
  const protocol = agentProtocol[agent];
  if (!protocol) return false;
  if (entity.protocols?.length) return entity.protocols.includes(protocol);
  // Compatibility for v0.0.23 model records: app was the only compatibility marker.
  return entity.app === agent;
}
