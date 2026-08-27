import type { ModelApp, ModelConfig } from "../../../api/types";

function modelOrder(a: ModelConfig, b: ModelConfig) {
  return a.order - b.order || a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
}

export function selectableInstanceModels(models: ModelConfig[], app: ModelApp, nodeId: string) {
  return models
    .filter((model) => modelSupportsApp(model, app) && model.locations?.some((location) => location.enabled && (location.type === "control-plane" || location.nodeId === nodeId)))
    .sort(modelOrder);
}

export function modelSupportsApp(model: ModelConfig, app: ModelApp) {
  const protocol = app === "claude" ? "anthropic-messages" : app === "opencode" ? "openai-chat-completions" : "openai-responses";
  return model.protocols?.includes(protocol) || (!model.protocols?.length && model.app === app);
}

export function invalidInstanceModelSelection(models: ModelConfig[], app: ModelApp, nodeId: string, modelId?: string | null) {
  if (!modelId) return false;
  return !selectableInstanceModels(models, app, nodeId).some((model) => model.id === modelId);
}

export function effectiveInstanceModel(models: ModelConfig[], app: ModelApp, nodeId: string, modelId?: string | null) {
  if (modelId === null) return undefined;
  const selectable = selectableInstanceModels(models, app, nodeId);
  if (modelId) return selectable.find((model) => model.id === modelId);
  return selectable.find((model) => model.locations?.some((location) => location.type === "control-plane" && location.enabled));
}
