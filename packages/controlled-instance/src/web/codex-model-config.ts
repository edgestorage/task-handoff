import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import TOML from "@iarna/toml";
import { atomicWriteFileSync } from "@task-handoff/core/storage/atomic-write";
import type { ControlledPrivateModelCatalog } from "./private-model-catalog";
import type { CodexInstanceSettings } from "@task-handoff/protocol/control-plane";

type ConfigObject = Record<string, unknown>;
type TomlMap = ReturnType<typeof TOML.parse>;

export type ManagedCodexModelConfigResult = {
  applied: boolean;
  configPath?: string;
  authPath?: string;
  backupPath?: string;
  model?: string;
  modelProvider?: string;
  providerEnvironment?: Record<string, string>;
};

const MANAGED_PROVIDER_PREFIX = "task-handoff-";

export function codexProviderId(modelEntityId: string) {
  return `${MANAGED_PROVIDER_PREFIX}${modelEntityId.toLowerCase().replace(/[^a-z0-9_-]+/g, "-")}`;
}

export function codexProviderEnvironment(catalog: ControlledPrivateModelCatalog | undefined) {
  return Object.fromEntries((catalog?.entities || [])
    .filter((entity) => entity.protocols.includes("openai-responses"))
    .map((entity) => [`TASK_HANDOFF_CODEX_PROVIDER_${codexProviderId(entity.id).toUpperCase().replace(/[^A-Z0-9_]/g, "_")}_API_KEY`, entity.key]));
}

function codexHome(env: NodeJS.ProcessEnv) {
  const configured = env.CODEX_HOME?.trim();
  return path.resolve(configured || path.join(env.HOME || os.homedir(), ".codex"));
}

function asConfigObject(value: unknown): ConfigObject {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as ConfigObject) : {};
}

function readConfig(configPath: string) {
  try {
    const contents = fs.readFileSync(configPath, "utf8");
    return {
      contents,
      config: asConfigObject(contents.trim() ? TOML.parse(contents) : {}),
    };
  } catch (error: unknown) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return { contents: "", config: {} as ConfigObject };
    }
    throw Object.assign(
      new Error(`Codex config could not be read or parsed at ${configPath}: ${error instanceof Error ? error.message : String(error)}`),
      { code: "CODEX_MODEL_CONFIG_INVALID" },
    );
  }
}

function atomicWrite(filePath: string, contents: string) {
  atomicWriteFileSync(filePath, contents);
}

/**
 * Applies the instance-selected Codex model to the user's durable Codex config.
 * This intentionally updates config.toml rather than relying on non-standard
 * model/base-url environment variables, so manually launched Codex sessions use
 * the same instance-level selection.
 */
export function applyManagedCodexModelConfig(
  env: NodeJS.ProcessEnv = process.env,
  catalog?: ControlledPrivateModelCatalog,
  settings?: CodexInstanceSettings,
): ManagedCodexModelConfigResult {
  if (env.TASK_HANDOFF_CONTROL_MODE !== "controlled") {
    return { applied: false };
  }
  const codexEntities = (catalog?.entities || []).filter((entity) => entity.protocols.includes("openai-responses"));
  const defaultEntity = codexEntities[0];
  const defaultName = defaultEntity?.modelNames.slice().sort((a, b) => a.order - b.order || a.name.localeCompare(b.name))[0]?.name;
  const model = defaultName || (env.TASK_HANDOFF_CODEX_MODEL || "").trim();
  const baseUrl = (env.TASK_HANDOFF_CODEX_BASE_URL || "").trim();
  const apiKey = (env.OPENAI_API_KEY || "").trim();
  const hasManagedModel = catalog ? Boolean(defaultEntity && model) : Boolean(model && baseUrl && apiKey);
  if (!hasManagedModel && !settings) {
    return { applied: false };
  }
  const home = codexHome(env);
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  const configPath = path.join(home, "config.toml");
  const authPath = path.join(home, "auth.json");
  let applied = false;
  if (hasManagedModel && !catalog && apiKey) {
    let currentKey = "";
    try {
      const currentAuth = JSON.parse(fs.readFileSync(authPath, "utf8")) as Record<string, unknown>;
      currentKey = currentAuth.auth_mode === "apikey" && typeof currentAuth.OPENAI_API_KEY === "string"
        ? currentAuth.OPENAI_API_KEY
        : "";
    } catch {
      currentKey = "";
    }
    if (currentKey !== apiKey) {
      atomicWrite(authPath, `${JSON.stringify({ auth_mode: "apikey", OPENAI_API_KEY: apiKey }, null, 2)}\n`);
      applied = true;
    }
  }

  const current = readConfig(configPath);
  const providerEnvironment = codexProviderEnvironment(catalog);
  const modelProvider = defaultEntity ? codexProviderId(defaultEntity.id) : "openai";
  const existingProviders = asConfigObject(current.config.model_providers);
  const retainedProviders = Object.fromEntries(Object.entries(existingProviders).filter(([id]) => !id.startsWith(MANAGED_PROVIDER_PREFIX)));
  const managedProviders = Object.fromEntries(codexEntities.map((entity) => {
    const providerId = codexProviderId(entity.id);
    const envKey = Object.keys(codexProviderEnvironment({ ...catalog!, entities: [entity] }))[0];
    return [providerId, {
      name: `TaskHandoff ${entity.id}`,
      base_url: entity.endpoint,
      env_key: envKey,
      wire_api: "responses",
    }];
  }));
  const next: ConfigObject = {
    ...current.config,
    ...(hasManagedModel ? {
      model,
      model_provider: modelProvider,
    } : {}),
    ...(hasManagedModel && !catalog ? { openai_base_url: baseUrl } : hasManagedModel ? {
      model_providers: { ...retainedProviders, ...managedProviders },
    } : {}),
  };
  if (settings) applyManagedSettings(next, settings, catalog);
  if (isDeepStrictEqual(current.config, next)) {
    return { applied, configPath, authPath, model: model || undefined, modelProvider: hasManagedModel ? modelProvider : undefined, providerEnvironment };
  }
  let backupPath: string | undefined;
  if (current.contents) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    backupPath = `${configPath}.bak.${stamp}`;
    fs.copyFileSync(configPath, backupPath);
    fs.chmodSync(backupPath, 0o600);
  }
  atomicWrite(configPath, TOML.stringify(next as TomlMap));
  return { applied: true, configPath, authPath, backupPath, model, modelProvider, providerEnvironment };
}

function applyManagedSettings(config: ConfigObject, settings: CodexInstanceSettings, catalog?: ControlledPrivateModelCatalog) {
  delete config.model_verbosity;
  delete config.personality;
  if (settings.modelVerbosity) config.model_verbosity = settings.modelVerbosity;
  if (settings.personality) config.personality = settings.personality;

  const agents = { ...asConfigObject(config.agents) };
  for (const key of ["enabled", "max_concurrent_threads_per_session", "default_subagent_model", "default_subagent_reasoning_effort"]) {
    delete agents[key];
  }
  agents.enabled = settings.multiAgent.enabled;
  if (settings.multiAgent.maxConcurrentThreads !== undefined) {
    agents.max_concurrent_threads_per_session = settings.multiAgent.maxConcurrentThreads;
  }
  if (settings.multiAgent.defaultModel) {
    const entity = catalog?.entities.find((candidate) => candidate.id === settings.multiAgent.defaultModel?.modelEntityId
      && candidate.protocols.includes("openai-responses"));
    if (!entity?.modelNames.some((entry) => entry.name === settings.multiAgent.defaultModel?.modelName)) {
      throw Object.assign(new Error("The configured Codex subagent model is not assigned to this instance."), {
        code: "CODEX_SUBAGENT_MODEL_UNAVAILABLE",
      });
    }
    agents.default_subagent_model = settings.multiAgent.defaultModel.modelName;
  }
  if (settings.multiAgent.defaultReasoningEffort) {
    agents.default_subagent_reasoning_effort = settings.multiAgent.defaultReasoningEffort;
  }
  config.agents = agents;
}
