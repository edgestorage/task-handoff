import os from "node:os";
import path from "node:path";

export type NodeAgentStorePaths = {
  dataDir: string;
  identityPath: string;
  settingsPath: string;
  localFoldersDir: string;
  nodeRuntimesDir: string;
  controlledInstancesDir: string;
  environmentTemplatesDir: string;
  instancePrivateConfigsDir: string;
  nodeModelsDir: string;
  modelAssignmentsDir: string;
  modelEnvironmentsDir: string;
  gitCredentialPayloadsDir: string;
  gitCredentialAssignmentsDir: string;
  gitCredentialAuthorizationSetsDir: string;
  gitWorkspaceProvisioningIntentsDir: string;
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
    environmentTemplatesDir: path.join(root, "environment-templates"),
    instancePrivateConfigsDir: path.join(root, "instance-private-configs"),
    nodeModelsDir: path.join(root, "models"),
    modelAssignmentsDir: path.join(root, "model-assignments"),
    modelEnvironmentsDir: path.join(root, "model-environments"),
    gitCredentialPayloadsDir: path.join(root, "git-credentials", "payloads"),
    gitCredentialAssignmentsDir: path.join(root, "git-credentials", "assignments"),
    gitCredentialAuthorizationSetsDir: path.join(root, "git-credentials", "authorization-sets"),
    gitWorkspaceProvisioningIntentsDir: path.join(root, "git-credentials", "workspace-provisioning-intents"),
    updatesDir: path.join(root, "updates"),
    logsDir: path.join(root, "logs"),
  };
}
