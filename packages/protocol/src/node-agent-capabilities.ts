import { z } from "zod";

export const NodeAgentManagedGitCapabilitiesSchema = z.object({
  registry: z.boolean().default(false),
  runtimeBroker: z.boolean().default(false),
  workspaceProvisioning: z.object({
    docker: z.boolean().default(false),
    kubernetes: z.boolean().default(false),
    local: z.boolean().default(false),
  }).strip().default({ docker: false, kubernetes: false, local: false }),
}).strip();

export const NodeAgentManagedModelCapabilitiesSchema = z.object({
  multiEntityAssignment: z.boolean().default(false),
  privateModelCatalog: z.boolean().default(false),
}).strip();

export const NodeAgentStoryAgentToolCapabilitiesSchema = z.object({
  policy: z.boolean().default(false),
  actions: z.boolean().default(false),
  automations: z.boolean().default(false),
  aiSessionRead: z.boolean().default(false),
}).strip();

export const NodeAgentStoryCapabilitiesSchema = z.object({
  enabled: z.boolean().default(false),
  // Compatibility for v0.0.32: this only advertises the original Content tools.
  agentTools: z.boolean().default(false),
  agentToolCapabilities: NodeAgentStoryAgentToolCapabilitiesSchema.optional(),
  sessionRetention: z.boolean().default(false),
  maxFileBytes: z.number().int().positive().default(32 * 1024 * 1024),
  maxBatchPaths: z.number().int().min(1).max(100).default(20),
}).strip();

export const NodeAgentCapabilitiesSchema = z.object({
  modelEndpointProbe: z.boolean().optional(),
  aiSessionHistoryLimit: z.boolean().optional(),
  aiSessionAttachmentRetention: z.boolean().optional(),
  aiSessionFileAttachmentLimit: z.boolean().optional(),
  folderPlaces: z.boolean().optional(),
  localFolderNameUpdate: z.boolean().optional(),
  // Additive capability: absent on v0.0.21 node-agents.
  managedGitCredentials: NodeAgentManagedGitCapabilitiesSchema.optional(),
  // Compatibility for v0.0.23: absence keeps the legacy single-model projection.
  managedModels: NodeAgentManagedModelCapabilitiesSchema.optional(),
  stories: NodeAgentStoryCapabilitiesSchema.optional(),
  // Compatibility for v0.0.28: absent node-agents reject codexSettings in instance patches.
  codexManagedSettings: z.boolean().optional(),
}).strip();

export type NodeAgentCapabilities = z.infer<typeof NodeAgentCapabilitiesSchema>;

export function normalizeNodeAgentCapabilities(capabilities: unknown): NodeAgentCapabilities & {
  managedGitCredentials: z.infer<typeof NodeAgentManagedGitCapabilitiesSchema>;
  managedModels: z.infer<typeof NodeAgentManagedModelCapabilitiesSchema>;
  stories: z.infer<typeof NodeAgentStoryCapabilitiesSchema> & {
    agentToolCapabilities: z.infer<typeof NodeAgentStoryAgentToolCapabilitiesSchema>;
  };
} {
  const parsed = NodeAgentCapabilitiesSchema.safeParse(capabilities);
  const current = parsed.success ? parsed.data : {};
  return {
    ...current,
    managedGitCredentials: NodeAgentManagedGitCapabilitiesSchema.parse(current.managedGitCredentials || {}),
    managedModels: NodeAgentManagedModelCapabilitiesSchema.parse(current.managedModels || {}),
    stories: {
      ...NodeAgentStoryCapabilitiesSchema.parse(current.stories || {}),
      agentToolCapabilities: NodeAgentStoryAgentToolCapabilitiesSchema.parse(current.stories?.agentToolCapabilities || {}),
    },
  };
}

export function supportsNodeMultiEntityModelAssignment(capabilities: unknown) {
  return normalizeNodeAgentCapabilities(capabilities).managedModels.multiEntityAssignment;
}

export function supportsNodePrivateModelCatalog(capabilities: unknown) {
  return normalizeNodeAgentCapabilities(capabilities).managedModels.privateModelCatalog;
}

export function supportsNodeCodexManagedSettings(capabilities: unknown) {
  return normalizeNodeAgentCapabilities(capabilities).codexManagedSettings === true;
}

export function supportsNodeStories(capabilities: unknown) {
  return normalizeNodeAgentCapabilities(capabilities).stories.enabled;
}

export function nodeStoryAgentToolCapabilities(capabilities: unknown) {
  return normalizeNodeAgentCapabilities(capabilities).stories.agentToolCapabilities;
}

export function nodeAgentCapabilitiesFromPublicNode(capabilities: unknown) {
  if (!capabilities || typeof capabilities !== "object" || Array.isArray(capabilities)) return undefined;
  const agent = (capabilities as Record<string, unknown>).agent;
  if (!agent || typeof agent !== "object" || Array.isArray(agent)) return undefined;
  return (agent as Record<string, unknown>).capabilities;
}

export function supportsNodeManagedGitCredentialRegistry(capabilities: unknown) {
  return normalizeNodeAgentCapabilities(capabilities).managedGitCredentials.registry;
}

export function supportsNodeGitCredentialRuntimeBroker(capabilities: unknown) {
  return normalizeNodeAgentCapabilities(capabilities).managedGitCredentials.runtimeBroker;
}

export function supportsNodeGitWorkspaceProvisioning(capabilities: unknown, runtime: "docker" | "kubernetes" | "local") {
  return normalizeNodeAgentCapabilities(capabilities).managedGitCredentials.workspaceProvisioning[runtime];
}

export function supportsNodeFolderPlaces(capabilities: unknown) {
  return NodeAgentCapabilitiesSchema.safeParse(capabilities).data?.folderPlaces === true;
}

export function supportsNodeLocalFolderNameUpdate(capabilities: unknown) {
  return NodeAgentCapabilitiesSchema.safeParse(capabilities).data?.localFolderNameUpdate === true;
}

export function supportsNodeAiSessionFileAttachmentLimit(capabilities: unknown) {
  return NodeAgentCapabilitiesSchema.safeParse(capabilities).data?.aiSessionFileAttachmentLimit === true;
}
