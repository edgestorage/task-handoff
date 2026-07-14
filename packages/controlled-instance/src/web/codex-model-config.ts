import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import TOML from "@iarna/toml";

type ConfigObject = Record<string, unknown>;
type TomlMap = ReturnType<typeof TOML.parse>;

export type ManagedCodexModelConfigResult = {
  applied: boolean;
  configPath?: string;
  backupPath?: string;
};

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
  const directory = path.dirname(filePath);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporaryPath = path.join(directory, `.${path.basename(filePath)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temporaryPath, contents, { encoding: "utf8", mode: 0o600 });
    fs.renameSync(temporaryPath, filePath);
    fs.chmodSync(filePath, 0o600);
  } finally {
    fs.rmSync(temporaryPath, { force: true });
  }
}

/**
 * Applies the instance-selected Codex model to the user's durable Codex config.
 * This intentionally updates config.toml rather than relying on non-standard
 * model/base-url environment variables, so manually launched Codex sessions use
 * the same instance-level selection.
 */
export function applyManagedCodexModelConfig(env: NodeJS.ProcessEnv = process.env): ManagedCodexModelConfigResult {
  if (env.TASK_HANDOFF_CONTROL_MODE !== "controlled") {
    return { applied: false };
  }
  const model = (env.TASK_HANDOFF_CODEX_MODEL || env.CODEX_MODEL || "").trim();
  const baseUrl = (env.TASK_HANDOFF_CODEX_BASE_URL || env.OPENAI_BASE_URL || "").trim();
  if (!model || !baseUrl) {
    return { applied: false };
  }

  const configPath = path.join(codexHome(env), "config.toml");
  const current = readConfig(configPath);
  if (
    current.config.model === model
    && current.config.model_provider === "openai"
    && current.config.openai_base_url === baseUrl
  ) {
    return { applied: false, configPath };
  }

  const next: ConfigObject = {
    ...current.config,
    model,
    model_provider: "openai",
    openai_base_url: baseUrl,
  };
  let backupPath: string | undefined;
  if (current.contents) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    backupPath = `${configPath}.bak.${stamp}`;
    fs.copyFileSync(configPath, backupPath);
    fs.chmodSync(backupPath, 0o600);
  }
  atomicWrite(configPath, TOML.stringify(next as TomlMap));
  return { applied: true, configPath, backupPath };
}
