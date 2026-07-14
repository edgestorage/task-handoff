import os from "node:os";
import path from "node:path";
import { CONFIG_PATH } from "../core/persistence";

function envPath(name: string, fallback: string) {
  const value = process.env[name];
  return value && value.trim() ? path.resolve(value.trim()) : fallback;
}

export type TaskHandoffStoragePaths = {
  configPath: string;
  dataDir: string;
  appCatalogDir: string;
  appSessionsDir: string;
  triggersDir: string;
  runtimeDir: string;
  eventsDir: string;
  artifactDir: string;
  logDir: string;
  webTokenPath: string;
};

export function resolveStoragePaths(): TaskHandoffStoragePaths {
  const defaultDataDir = path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share"), "task-handoff");
  const configPath = envPath("TASK_HANDOFF_CONFIG", CONFIG_PATH);
  const dataDir = envPath("TASK_HANDOFF_DATA_DIR", path.dirname(configPath) || defaultDataDir);
  return {
    configPath,
    dataDir,
    appCatalogDir: envPath("TASK_HANDOFF_APP_CATALOG_DIR", path.join(dataDir, "app-catalog")),
    appSessionsDir: envPath("TASK_HANDOFF_APP_SESSION_DIR", path.join(dataDir, "app-sessions")),
    triggersDir: envPath("TASK_HANDOFF_TRIGGERS_DIR", path.join(dataDir, "triggers")),
    runtimeDir: envPath("TASK_HANDOFF_RUNTIME_DIR", path.join(dataDir, "runtime")),
    eventsDir: envPath("TASK_HANDOFF_EVENTS_DIR", path.join(dataDir, "events")),
    artifactDir: envPath("TASK_HANDOFF_ARTIFACT_DIR", path.join(dataDir, "artifacts")),
    logDir: envPath("TASK_HANDOFF_LOG_DIR", path.join(dataDir, "logs")),
    webTokenPath: envPath("TASK_HANDOFF_WEB_TOKEN_FILE", path.join(dataDir, "web-token")),
  };
}
