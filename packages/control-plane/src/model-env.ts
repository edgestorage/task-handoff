import {
  type ControlledInstance,
  type ModelConfig,
} from "@task-handoff/protocol/control-plane";

export function modelEnvForInstance(instance: ControlledInstance, models: ModelConfig[]) {
  return modelEnvForSelection(instance.modelSelection, models);
}

export function modelEnvForSelection(selection: ControlledInstance["modelSelection"], models: ModelConfig[]) {
  const env: Record<string, string> = {};
  const codex = selectedModelForApp(models, "codex", selection.codexModelId);
  if (codex) {
    env.OPENAI_API_KEY = codex.key;
    env.OPENAI_BASE_URL = codex.endpoint;
    env.CODEX_MODEL = codex.model;
    env.TASK_HANDOFF_CODEX_BASE_URL = codex.endpoint;
    env.TASK_HANDOFF_CODEX_MODEL = codex.model;
    env.TASK_HANDOFF_CODEX_MODEL_ID = codex.id;
  }
  const claude = selectedModelForApp(models, "claude", selection.claudeModelId);
  if (claude) {
    env.ANTHROPIC_API_KEY = claude.key;
    env.ANTHROPIC_BASE_URL = claude.endpoint;
    env.CLAUDE_MODEL = claude.model;
    env.TASK_HANDOFF_CLAUDE_MODEL = claude.model;
    env.TASK_HANDOFF_CLAUDE_MODEL_ID = claude.id;
  }
  return env;
}

function selectedModelForApp(models: ModelConfig[], app: ModelConfig["app"], selectedId?: string) {
  if (selectedId) {
    const selected = models.find((model) => model.id === selectedId);
    if (!selected || selected.app !== app || !selected.enabled) {
      const error = new Error(`Selected ${app} model ${selectedId} is missing, disabled, or belongs to another app.`);
      Object.assign(error, { statusCode: 409, code: "MODEL_SELECTION_INVALID", modelId: selectedId, app });
      throw error;
    }
    return selected;
  }
  return models.find((model) => model.enabled && model.app === app);
}
