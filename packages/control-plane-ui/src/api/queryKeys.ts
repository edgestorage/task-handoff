export const controlPlaneQueryKeys = {
  status: ["control-plane-status"] as const,
  settings: ["control-plane-settings"] as const,
  projects: ["control-plane-projects"] as const,
  models: ["control-plane-models"] as const,
  images: ["control-plane-images"] as const,
  imageOptions: ["control-plane-image-options"] as const,
  marketCatalog: ["control-plane-market-catalog"] as const,
  nodes: ["control-plane-nodes"] as const,
  nodeRuntimes: ["control-plane-node-runtimes-payload"] as const,
  nodeLocalFolders: (nodeId?: string) => nodeId
    ? ["control-plane-node-local-folders", nodeId] as const
    : ["control-plane-node-local-folders"] as const,
  nodeImageCatalog: (nodeId?: string) => nodeId
    ? ["node-image-catalog", nodeId] as const
    : ["node-image-catalog"] as const,
  instanceBoard: ["instance-board-payload"] as const,
  chatBridges: ["chat-gateway-bridges"] as const,
  chatStatus: ["chat-gateway-status"] as const,
};
