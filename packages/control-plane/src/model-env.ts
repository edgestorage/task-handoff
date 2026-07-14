import {
  ProjectSchema,
  type ControlledInstance,
  type ModelConfig,
  type Project,
} from "@task-handoff/protocol/control-plane";
import { createId } from "./store.ts";
import { workspacePolicyForSource } from "./public-records.ts";

export function modelEnvForInstance(instance: ControlledInstance, models: ModelConfig[]) {
  const sourceModelSelection = modelSelectionFromSnapshot(instance.sourceSnapshot);
  const pseudoProject = ProjectSchema.parse({
    id: instance.projectId || `project_${instance.id}`,
    name: typeof instance.sourceSnapshot.name === "string" ? instance.sourceSnapshot.name : instance.name,
    source: instance.source,
    defaultImageId: instance.imageId,
    defaultNodeId: instance.nodeId,
    defaultRuntimeId: instance.runtimeId,
    modelSelection: sourceModelSelection,
    workspacePolicy: workspacePolicyForSource(instance.source),
    labels: {},
    createdAt: instance.createdAt,
    updatedAt: instance.updatedAt,
  });
  return modelEnvForProject(pseudoProject, models);
}

export function modelEnvForSourceSnapshot(source: Project["source"], snapshot: Record<string, unknown>, models: ModelConfig[]) {
  const sourceModelSelection = modelSelectionFromSnapshot(snapshot);
  const timestamp = new Date().toISOString();
  const pseudoProject = ProjectSchema.parse({
    id: typeof snapshot.id === "string" ? snapshot.id : `source_${createId("tmp")}`,
    name: typeof snapshot.name === "string" ? snapshot.name : "Source",
    source,
    defaultImageId: typeof snapshot.defaultImageId === "string" ? snapshot.defaultImageId : undefined,
    modelSelection: sourceModelSelection,
    workspacePolicy: workspacePolicyForSource(source),
    labels: {},
    createdAt: timestamp,
    updatedAt: timestamp,
  });
  return modelEnvForProject(pseudoProject, models);
}

export function modelEnvForProject(project: Project, models: ModelConfig[]) {
  const candidates = models.filter((model) => model.enabled);
  const env: Record<string, string> = {};
  const codex = selectedModelForApp(candidates, "codex", project.modelSelection.codexModelId);
  if (codex) {
    env.OPENAI_API_KEY = codex.key;
    env.OPENAI_BASE_URL = codex.endpoint;
    env.CODEX_MODEL = codex.model;
    env.TASK_HANDOFF_CODEX_MODEL = codex.model;
    env.TASK_HANDOFF_CODEX_MODEL_ID = codex.id;
  }
  const claude = selectedModelForApp(candidates, "claude", project.modelSelection.claudeModelId);
  if (claude) {
    env.ANTHROPIC_API_KEY = claude.key;
    env.ANTHROPIC_BASE_URL = claude.endpoint;
    env.CLAUDE_MODEL = claude.model;
    env.TASK_HANDOFF_CLAUDE_MODEL = claude.model;
    env.TASK_HANDOFF_CLAUDE_MODEL_ID = claude.id;
  }
  return env;
}

function modelSelectionFromSnapshot(snapshot: Record<string, unknown>) {
  const raw = snapshot.modelSelection;
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const record = raw as Record<string, unknown>;
    return {
      ...(typeof record.codexModelId === "string" ? { codexModelId: record.codexModelId } : {}),
      ...(typeof record.claudeModelId === "string" ? { claudeModelId: record.claudeModelId } : {}),
    };
  }

  return {};
}

function selectedModelForApp(models: ModelConfig[], app: ModelConfig["app"], selectedId?: string) {
  const appModels = models.filter((model) => model.app === app);
  return appModels.find((model) => selectedId && model.id === selectedId) || appModels[0];
}
