import os from "node:os";
import path from "node:path";

export type NodeAgentStorePaths = {
  dataDir: string;
  identityPath: string;
  settingsPath: string;
  localFoldersDir: string;
  nodeRuntimesDir: string;
  controlledInstancesDir: string;
  nodeModelsDir: string;
  modelAssignmentsDir: string;
  modelEnvironmentsDir: string;
  updatesDir: string;
  logsDir: string;
};

export function defaultNodeAgentDataDir() {
  return process.env.TASK_HANDOFF_NODE_AGENT_DATA_DIR || path.join(os.homedir(), ".config", "task-handoff", "node-agent");
}

export function nodeAgentStorePaths(dataDir = defaultNodeAgentDataDir()): NodeAgentStorePaths {
  const root = path.resolve(dataDir);
  return {
    dataDir: root,
    identityPath: path.join(root, "identity.json"),
    settingsPath: path.join(root, "runtime-settings.json"),
    localFoldersDir: path.join(root, "local-folders"),
    nodeRuntimesDir: path.join(root, "node-runtimes"),
    controlledInstancesDir: path.join(root, "controlled-instances"),
    nodeModelsDir: path.join(root, "models"),
    modelAssignmentsDir: path.join(root, "model-assignments"),
    modelEnvironmentsDir: path.join(root, "model-environments"),
    updatesDir: path.join(root, "updates"),
    logsDir: path.join(root, "logs"),
  };
}
