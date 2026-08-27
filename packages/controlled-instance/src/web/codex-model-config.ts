import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import TOML from "@iarna/toml";
import { atomicWriteFileSync } from "@task-handoff/core/storage/atomic-write";
import type { ControlledPrivateModelCatalog } from "./private-model-catalog";

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
  if (catalog ? (!defaultEntity || !model) : (!model || !baseUrl || !apiKey)) {
    return { applied: false };
  }
  const home = codexHome(env);
  const configPath = path.join(home, "config.toml");
  const authPath = path.join(home, "auth.json");
  let applied = false;
  if (!catalog && apiKey) {
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
  if (
    current.config.model === model
    && current.config.model_provider === modelProvider
    && (!catalog ? current.config.openai_base_url === baseUrl : JSON.stringify(existingProviders) === JSON.stringify({ ...retainedProviders, ...managedProviders }))
  ) {
    return { applied, configPath, authPath, model, modelProvider, providerEnvironment };
  }

  const next: ConfigObject = {
    ...current.config,
    model,
    model_provider: modelProvider,
    ...(!catalog ? { openai_base_url: baseUrl } : {
      model_providers: { ...retainedProviders, ...managedProviders },
    }),
  };
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
