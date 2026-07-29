import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { atomicWriteJsonSync } from "@task-handoff/core/storage/atomic-write";

type ConfigObject = Record<string, unknown>;

export type ManagedClaudeModelConfigResult = {
  applied: boolean;
  settingsPath?: string;
  backupPath?: string;
};

function claudeHome(env: NodeJS.ProcessEnv) {
  const configured = env.CLAUDE_HOME?.trim();
  return path.resolve(configured || path.join(env.HOME || os.homedir(), ".claude"));
}

function isConfigObject(value: unknown): value is ConfigObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readSettings(settingsPath: string) {
  try {
    const contents = fs.readFileSync(settingsPath, "utf8");
    const parsed: unknown = contents.trim() ? JSON.parse(contents) : {};
    if (!isConfigObject(parsed)) throw new Error("the root value must be a JSON object");
    if (parsed.env !== undefined && !isConfigObject(parsed.env)) throw new Error("env must be a JSON object");
    return { contents, settings: parsed };
  } catch (error: unknown) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return { contents: "", settings: {} as ConfigObject };
    }
    throw Object.assign(
      new Error(`Claude settings could not be read or parsed at ${settingsPath}: ${error instanceof Error ? error.message : String(error)}`),
      { code: "CLAUDE_MODEL_CONFIG_INVALID" },
    );
  }
}

/**
 * Applies the instance-selected Claude model to Claude Code's durable settings.
 * The node-agent environment is only the private delivery envelope; launched
 * Claude processes consume ~/.claude/settings.json instead of inherited model
 * environment variables or a generated --model argument.
 */
export function applyManagedClaudeModelConfig(env: NodeJS.ProcessEnv = process.env): ManagedClaudeModelConfigResult {
  if (env.TASK_HANDOFF_CONTROL_MODE !== "controlled") return { applied: false };

  const model = (env.TASK_HANDOFF_CLAUDE_MODEL || "").trim();
  const baseUrl = (env.ANTHROPIC_BASE_URL || "").trim();
  const apiKey = (env.ANTHROPIC_API_KEY || "").trim();
  if (!model || !baseUrl || !apiKey) return { applied: false };

  const settingsPath = path.join(claudeHome(env), "settings.json");
  const current = readSettings(settingsPath);
  const currentEnv = isConfigObject(current.settings.env) ? current.settings.env : {};
  if (
    currentEnv.ANTHROPIC_API_KEY === apiKey
    && currentEnv.ANTHROPIC_BASE_URL === baseUrl
    && currentEnv.ANTHROPIC_MODEL === model
    && currentEnv.ANTHROPIC_AUTH_TOKEN === undefined
  ) {
    return { applied: false, settingsPath };
  }

  const nextEnv: ConfigObject = {
    ...currentEnv,
    ANTHROPIC_API_KEY: apiKey,
    ANTHROPIC_BASE_URL: baseUrl,
    ANTHROPIC_MODEL: model,
  };
  // Avoid an older bearer token silently taking precedence over the selected
  // API-key credential. The original settings remain available in the backup.
  delete nextEnv.ANTHROPIC_AUTH_TOKEN;

  let backupPath: string | undefined;
  if (current.contents) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    backupPath = `${settingsPath}.bak.${stamp}`;
    fs.copyFileSync(settingsPath, backupPath);
    fs.chmodSync(backupPath, 0o600);
  }
  atomicWriteJsonSync(settingsPath, { ...current.settings, env: nextEnv });
  return { applied: true, settingsPath, backupPath };
}
