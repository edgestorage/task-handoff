import fs from "node:fs";
import {
  InstancePrivateModelCatalogSchema,
  parseInstancePrivateModelCatalog,
  type InstancePrivateModelCatalog,
} from "@task-handoff/core/core/instance-private-model-catalog";
import type { AiSessionModelSelection } from "@task-handoff/protocol/ai-sessions";

export const ControlledPrivateModelCatalogSchema = InstancePrivateModelCatalogSchema;
export type ControlledPrivateModelCatalog = InstancePrivateModelCatalog;

export function readControlledPrivateModelCatalog(env: NodeJS.ProcessEnv = process.env) {
  const serializedCatalog = env.TASK_HANDOFF_PRIVATE_MODEL_CATALOG_JSON;
  if (serializedCatalog !== undefined) {
    return parseControlledPrivateModelCatalog(JSON.parse(serializedCatalog), env);
  }
  // The Docker entrypoint reads the root-only config before dropping privileges.
  // An absent environment value therefore authoritatively means no catalog.
  if (env.TASK_HANDOFF_PRIVATE_CONFIG_LOADED === "1") return undefined;

  const filePath = env.TASK_HANDOFF_INSTANCE_PRIVATE_CONFIG_PATH?.trim()
    || (env.TASK_HANDOFF_RUNTIME_KIND === "docker" ? "/run/task-handoff/instance-private-config.json" : "");
  if (!filePath || !fs.existsSync(filePath)) return undefined;
  const root = JSON.parse(fs.readFileSync(filePath, "utf8")) as Record<string, unknown>;
  if (root.modelCatalog === undefined) return undefined;
  return parseControlledPrivateModelCatalog(root.modelCatalog, env);
}

export function resolveControlledPrivateModelSelection(
  catalog: InstancePrivateModelCatalog | undefined,
  agent: string,
  requested?: AiSessionModelSelection,
) {
  const protocol = agent === "codex" ? "openai-responses"
    : agent === "claude" ? "anthropic-messages"
      : agent === "opencode" ? "openai-chat-completions" : undefined;
  if (!protocol) return undefined;
  if (!catalog) {
    if (requested) throw Object.assign(new Error("This instance does not have a private model catalog."), {
      code: "AI_SESSION_MODEL_CATALOG_UNAVAILABLE",
      statusCode: 409,
    });
    return undefined;
  }
  const entities = catalog.entities.filter((entity) => entity.protocols.includes(protocol));
  const entity = requested
    ? entities.find((candidate) => candidate.id === requested.modelEntityId)
    : entities[0];
  if (!entity) {
    if (!requested) return undefined;
    throw Object.assign(new Error(`Model entity ${requested.modelEntityId} is not assigned for ${agent}.`), {
      code: "AI_SESSION_MODEL_ENTITY_UNAVAILABLE",
      statusCode: 409,
    });
  }
  const names = entity.modelNames.slice().sort((left, right) => left.order - right.order || left.name.localeCompare(right.name));
  const modelName = requested?.modelName || names[0]?.name;
  if (!modelName || !names.some((entry) => entry.name === modelName)) {
    throw Object.assign(new Error(`Model ${modelName || ""} is not available from entity ${entity.id}.`), {
      code: "AI_SESSION_MODEL_NAME_UNAVAILABLE",
      statusCode: 409,
    });
  }
  return { modelEntityId: entity.id, modelName };
}

function parseControlledPrivateModelCatalog(value: unknown, env: NodeJS.ProcessEnv) {
  const catalog = parseInstancePrivateModelCatalog(value);
  const instanceId = env.TASK_HANDOFF_INSTANCE_ID?.trim();
  if (instanceId && catalog.instanceId !== instanceId) {
    throw Object.assign(new Error("Private model catalog instance identity does not match this runtime."), {
      code: "PRIVATE_MODEL_CATALOG_IDENTITY_MISMATCH",
    });
  }
  return catalog;
}
