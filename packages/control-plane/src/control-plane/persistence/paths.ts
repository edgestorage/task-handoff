import os from "node:os";
import path from "node:path";

export type ControlPlaneStorePaths = {
  dataDir: string;
  settingsPath: string;
  projectsDir: string;
  modelsDir: string;
  imagesDir: string;
  marketDir: string;
  marketCachePath: string;
  marketStatePath: string;
  marketMigrationBackupPath: string;
  nodesDir: string;
  pendingPairingRevokesDir: string;
  chatSessionsDir: string;
  chatBridgesDir: string;
  triggersDir: string;
  proxyAuthorityPath: string;
  identitySigningPath: string;
  cloudConnectivityPath: string;
  authUsersDir: string;
  authSessionsDir: string;
  authMembershipsDir: string;
  userDatabasePath: string;
  identityProviderEncryptionKeyPath: string;
  gitCredentialsDir: string;
  gitCredentialAssignmentsDir: string;
  gitCredentialAuditDir: string;
  gitCredentialEncryptionKeyPath: string;
  aiSessionUnreadDir: string;
  logsDir: string;
};

export function defaultControlPlaneDataDir() {
  return process.env.TASK_HANDOFF_CONTROL_PLANE_DATA_DIR || path.join(os.homedir(), ".config", "task-handoff", "control-plane");
}

export function controlPlaneStorePaths(dataDir = defaultControlPlaneDataDir()): ControlPlaneStorePaths {
  const root = path.resolve(dataDir);
  return {
    dataDir: root,
    settingsPath: path.join(root, "control-plane-settings.json"),
    projectsDir: path.join(root, "projects"),
    modelsDir: path.join(root, "models"),
    imagesDir: path.join(root, "images"),
    marketDir: path.join(root, "market"),
    marketCachePath: path.join(root, "market", "catalog-cache.json"),
    marketStatePath: path.join(root, "market", "catalog-state.json"),
    marketMigrationBackupPath: path.join(root, "market", "legacy-image-migration-backup.json"),
    nodesDir: path.join(root, "nodes"),
    pendingPairingRevokesDir: path.join(root, "pending-pairing-revokes"),
    chatSessionsDir: path.join(root, "chat-sessions"),
    chatBridgesDir: path.join(root, "chat-bridges"),
    triggersDir: path.join(root, "triggers"),
    proxyAuthorityPath: path.join(root, "control-plane-proxy", "authority.json"),
    identitySigningPath: path.join(root, "control-plane-identity-signing.json"),
    cloudConnectivityPath: path.join(root, "cloud-connectivity.json"),
    authUsersDir: path.join(root, "auth-users"),
    authSessionsDir: path.join(root, "auth-sessions"),
    authMembershipsDir: path.join(root, "auth-memberships"),
    userDatabasePath: path.join(root, "user-access", "control-plane.sqlite"),
    identityProviderEncryptionKeyPath: path.join(root, "user-access", "identity-provider-encryption-key.json"),
    gitCredentialsDir: path.join(root, "git-credentials", "credentials"),
    gitCredentialAssignmentsDir: path.join(root, "git-credentials", "assignments"),
    gitCredentialAuditDir: path.join(root, "git-credentials", "audit"),
    gitCredentialEncryptionKeyPath: path.join(root, "git-credentials", "encryption-key.json"),
    aiSessionUnreadDir: path.join(root, "ai-session-unread"),
    logsDir: path.join(root, "logs"),
  };
}
