export const controlPlaneQueryKeys = {
  status: ["control-plane-status"] as const,
  settings: ["control-plane-settings"] as const,
  mobileSessions: ["control-plane-mobile-sessions"] as const,
  currentAccess: ["control-plane-current-access"] as const,
  users: ["control-plane-users"] as const,
  roles: ["control-plane-roles"] as const,
  permissions: ["control-plane-permissions"] as const,
  identityProviders: ["control-plane-identity-providers"] as const,
  externalIdentityApprovals: ["control-plane-external-identity-approvals"] as const,
  cloudConnectivity: ["cloud-connectivity"] as const,
  projects: ["control-plane-projects"] as const,
  models: ["control-plane-models"] as const,
  gitCredentials: ["control-plane-git-credentials"] as const,
  instanceGitCredentialAssignments: (instanceId: string) => ["control-plane-instance-git-credential-assignments", instanceId] as const,
  images: ["control-plane-images"] as const,
  imageOptions: ["control-plane-image-options"] as const,
  marketCatalog: ["control-plane-market-catalog"] as const,
  nodes: ["control-plane-nodes"] as const,
  controlPlaneProxyInvites: ["control-plane-proxy-invites"] as const,
  controlPlaneProxyBindings: ["control-plane-proxy-bindings"] as const,
  controlPlaneProxyDiagnostics: ["control-plane-proxy-diagnostics"] as const,
  controlPlaneProxyPendingClaims: ["control-plane-proxy-pending-claims"] as const,
  nodeRuntimes: ["control-plane-node-runtimes-payload"] as const,
  nodeLocalFolders: (nodeId?: string) => nodeId
    ? ["control-plane-node-local-folders", nodeId] as const
    : ["control-plane-node-local-folders"] as const,
  nodeImageCatalog: (nodeId?: string) => nodeId
    ? ["node-image-catalog", nodeId] as const
    : ["node-image-catalog"] as const,
  environmentTemplates: (nodeId?: string) => nodeId
    ? ["node-environment-templates", nodeId] as const
    : ["node-environment-templates"] as const,
  instanceBoard: ["instance-board-payload"] as const,
  scopedInstanceBoard: (instanceId?: string) => instanceId
    ? ["instance-board-payload", instanceId] as const
    : ["instance-board-payload"] as const,
  instanceDirectory: ["instance-directory"] as const,
  aiSessions: (instanceId?: string) => ["control-plane-ai-sessions", instanceId || "*"] as const,
  aiSessionWorkspace: (instanceId: string, cwdFolderId?: string) => [
    "control-plane-ai-session-workspace",
    instanceId,
    cwdFolderId || null,
  ] as const,
  appSessions: (instanceId?: string) => ["control-plane-app-sessions", instanceId || "*"] as const,
  chatBridges: ["chat-gateway-bridges"] as const,
  chatStatus: ["chat-gateway-status"] as const,
};
