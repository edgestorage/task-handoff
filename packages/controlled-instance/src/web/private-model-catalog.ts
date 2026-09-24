import fs from "node:fs";
import {
  InstancePrivateModelCatalogSchema,
  parseInstancePrivateModelCatalog,
  type InstancePrivateModelCatalog,
} from "@task-handoff/core/core/instance-private-model-catalog";
import type { AiSessionModelSelection } from "@task-handoff/protocol/ai-sessions";
import { parseCodexInstanceSettings } from "@task-handoff/protocol/control-plane";

export const ControlledPrivateModelCatalogSchema = InstancePrivateModelCatalogSchema;
export type ControlledPrivateModelCatalog = InstancePrivateModelCatalog;

export type ControlledPrivateModelCatalogSource = "environment" | "private-config-file" | "none";

function privateConfigFilePath(env: NodeJS.ProcessEnv) {
  return env.TASK_HANDOFF_INSTANCE_PRIVATE_CONFIG_PATH?.trim()
    || (env.TASK_HANDOFF_RUNTIME_KIND === "docker" ? "/run/task-handoff/instance-private-config.json" : "");
}

export function readControlledPrivateModelCatalog(env: NodeJS.ProcessEnv = process.env) {
  return readControlledPrivateModelCatalogSource(env).catalog;
}

export function readControlledPrivateModelCatalogSource(env: NodeJS.ProcessEnv = process.env): {
  catalog: ControlledPrivateModelCatalog | undefined;
  source: ControlledPrivateModelCatalogSource;
} {
  const serializedCatalog = env.TASK_HANDOFF_PRIVATE_MODEL_CATALOG_JSON;
  if (serializedCatalog !== undefined) {
    return { catalog: parseControlledPrivateModelCatalog(JSON.parse(serializedCatalog), env), source: "environment" };
  }
  // The Docker entrypoint reads the root-only config before dropping privileges.
  // An absent environment value therefore authoritatively means no catalog.
  if (env.TASK_HANDOFF_PRIVATE_CONFIG_LOADED === "1") return { catalog: undefined, source: "none" };

  const filePath = privateConfigFilePath(env);
  if (!filePath || !fs.existsSync(filePath)) return { catalog: undefined, source: "none" };
  const root = JSON.parse(fs.readFileSync(filePath, "utf8")) as Record<string, unknown>;
  if (root.modelCatalog === undefined) return { catalog: undefined, source: "none" };
  return { catalog: parseControlledPrivateModelCatalog(root.modelCatalog, env), source: "private-config-file" };
}

export function readControlledPrivateCodexSettings(env: NodeJS.ProcessEnv = process.env) {
  const serializedSettings = env.TASK_HANDOFF_PRIVATE_CODEX_SETTINGS_JSON;
  if (serializedSettings !== undefined) return parseCodexInstanceSettings(JSON.parse(serializedSettings));
  if (env.TASK_HANDOFF_PRIVATE_CONFIG_LOADED === "1") return undefined;
  const filePath = privateConfigFilePath(env);
  if (!filePath || !fs.existsSync(filePath)) return undefined;
  const root = JSON.parse(fs.readFileSync(filePath, "utf8")) as Record<string, unknown>;
  return root.codexSettings === undefined ? undefined : parseCodexInstanceSettings(root.codexSettings);
}

/**
 * Session selections are stored model identities that may have been removed
 * since the session last ran. A switch target is a fresh caller choice. The two
 * must not share one error meaning: only the resume/send path may claim that
 * "the model previously selected for this session" disappeared.
 */
export type ControlledPrivateModelSelectionIntent = "session" | "target";

function previouslySelectedModelUnavailable(code: "AI_SESSION_MODEL_ENTITY_UNAVAILABLE" | "AI_SESSION_MODEL_NAME_UNAVAILABLE") {
  return Object.assign(new Error("The model previously selected for this session is no longer available. Select another model to continue."), {
    code,
    statusCode: 409,
  });
}

function modelTargetUnavailable() {
  return Object.assign(new Error("The selected model has not taken effect in this running instance. Try again in a moment, or restart the instance to apply the latest model configuration."), {
    code: "AI_SESSION_MODEL_TARGET_UNAVAILABLE",
    statusCode: 409,
  });
}

export function resolveControlledPrivateModelSelection(
  catalog: InstancePrivateModelCatalog | undefined,
  agent: string,
  requested?: AiSessionModelSelection,
  options: { intent?: ControlledPrivateModelSelectionIntent } = {},
) {
  const protocol = agent === "codex" ? "openai-responses"
    : agent === "claude" ? "anthropic-messages"
      : agent === "opencode" ? "openai-chat-completions" : undefined;
  if (!protocol) return undefined;
  if (!catalog) {
    if (requested) throw Object.assign(new Error("The model configuration is not loaded by this instance. Restart the instance to apply the latest model configuration."), {
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
    throw options.intent === "target"
      ? modelTargetUnavailable()
      : previouslySelectedModelUnavailable("AI_SESSION_MODEL_ENTITY_UNAVAILABLE");
  }
  const names = entity.modelNames.slice().sort((left, right) => left.order - right.order || left.name.localeCompare(right.name));
  const modelName = requested?.modelName || names[0]?.name;
  if (!modelName || !names.some((entry) => entry.name === modelName)) {
    throw options.intent === "target"
      ? modelTargetUnavailable()
      : previouslySelectedModelUnavailable("AI_SESSION_MODEL_NAME_UNAVAILABLE");
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
