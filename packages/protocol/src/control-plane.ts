import crypto from "node:crypto";
import { z } from "zod";
import {
  AI_SESSION_HISTORY_DEFAULT_LIMIT,
  AI_SESSION_HISTORY_MAX_LIMIT,
  AI_SESSION_ATTACHMENT_RETENTION_DEFAULT_DAYS,
  AI_SESSION_ATTACHMENT_RETENTION_MAX_DAYS,
  AI_SESSION_DEFAULT_MAX_FILE_ATTACHMENT_BYTES,
  AI_SESSION_MAX_CONFIGURABLE_FILE_ATTACHMENT_BYTES,
  AI_SESSION_MAX_MESSAGE_ATTACHMENT_BYTES,
  AI_SESSION_MAX_MESSAGE_ATTACHMENTS,
  AiSessionMessageAttachmentSchema,
  AiSessionPermissionModeSchema,
  AiSessionReasoningEffortSchema,
  AiSessionSummarySchema,
  AiSessionsSnapshotSchema,
} from "./ai-sessions.ts";
import { TriggerConfigSchema, TriggerDeploymentSchema, TriggerRunSchema, TriggerRuntimeStateSchema } from "./triggers.ts";
import { ControlPlaneProxyErrorSchema, ProxyTargetStateSchema } from "./control-plane-proxy.ts";
import { GitCredentialRetentionSchema } from "./managed-git-credentials.ts";
import { NodeAgentCapabilitiesSchema } from "./node-agent-capabilities.ts";
export * from "./node-agent-capabilities.ts";
import { ModelProtocolSchema, type ModelProtocol } from "./model-protocol.ts";
export * from "./model-protocol.ts";
import {
  AiSessionProviderCapabilitiesSchema,
  type AiSessionProviderCapability,
} from "./ai-session-provider-capabilities.ts";
export {
  AiSessionProviderCapabilitiesSchema,
  AiSessionProviderCapabilitySchema,
  type AiSessionProviderCapability,
} from "./ai-session-provider-capabilities.ts";

export const CONTROL_PLANE_PROTOCOL_VERSION = "2026-10-02";
export const AI_SESSION_RENAME_PROTOCOL_VERSION = "2026-09-17";
// Browser profile capability on the controlled-instance app inventory boundary.
export const APP_PROFILES_PROTOCOL_VERSION = "2026-10-02";
export const NODE_AGENT_PROTOCOL_VERSION_HEADER = "x-task-handoff-node-agent-protocol-version";
export const NODE_TUNNEL_PROTOCOL_VERSION = "2026-08-01";
export const MARKET_CATALOG_PROTOCOL_VERSION = "2026-07-29";
// Compatibility for v0.0.21: this released protocol already requires appInventory
// and remains inside the N-1 support window as later additive features advance the boundary.
const APP_INVENTORY_REQUIRED_PROTOCOL_VERSIONS = new Set(["2026-08-01", "2026-08-16", "2026-08-17", "2026-08-20", "2026-09-24", "2026-09-29", CONTROL_PLANE_PROTOCOL_VERSION]);
export const ProtocolVersionSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Protocol version must use YYYY-MM-DD format.");

const AiSessionCapabilityAgentSchema = z.string().trim().min(1).max(120);

export const CodexModelVerbositySchema = z.enum(["low", "medium", "high"]);
export const CodexPersonalitySchema = z.enum(["none", "friendly", "pragmatic"]);
export const CodexSubagentModelSchema = z.object({
  modelEntityId: z.string().trim().min(1).max(120),
  modelName: z.string().trim().min(1).max(240),
  // Stable model identity; see AiSessionModelSelectionSchema. Optional so
  // settings written before the identity split still parse.
  modelUpstreamName: z.string().trim().min(1).max(240).optional(),
}).strict();
export const CodexInstanceSettingsSchema = z.object({
  modelVerbosity: CodexModelVerbositySchema.optional(),
  personality: CodexPersonalitySchema.optional(),
  multiAgent: z.object({
    enabled: z.boolean().default(true),
    maxConcurrentThreads: z.number().int().min(1).max(64).optional(),
    defaultModel: CodexSubagentModelSchema.optional(),
    defaultReasoningEffort: AiSessionReasoningEffortSchema.optional(),
  }).strict().default({ enabled: true }),
}).strict();

export function sanitizeCodexInstanceSettings(input: unknown) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return input;
  const source = input as Record<string, unknown>;
  const multiAgent = source.multiAgent;
  const sanitizedMultiAgent = !multiAgent || typeof multiAgent !== "object" || Array.isArray(multiAgent)
    ? multiAgent
    : (() => {
        const value = multiAgent as Record<string, unknown>;
        const defaultModel = value.defaultModel;
        return {
          ...(value.enabled === undefined ? {} : { enabled: value.enabled }),
          ...(value.maxConcurrentThreads === undefined ? {} : { maxConcurrentThreads: value.maxConcurrentThreads }),
          ...(defaultModel === undefined ? {} : {
            defaultModel: !defaultModel || typeof defaultModel !== "object" || Array.isArray(defaultModel)
              ? defaultModel
              : {
                  modelEntityId: (defaultModel as Record<string, unknown>).modelEntityId,
                  modelName: (defaultModel as Record<string, unknown>).modelName,
                  ...(typeof (defaultModel as Record<string, unknown>).modelUpstreamName === "string"
                    ? { modelUpstreamName: (defaultModel as Record<string, unknown>).modelUpstreamName }
                    : {}),
                },
          }),
          ...(value.defaultReasoningEffort === undefined ? {} : { defaultReasoningEffort: value.defaultReasoningEffort }),
        };
      })();
  return {
    ...(source.modelVerbosity === undefined ? {} : { modelVerbosity: source.modelVerbosity }),
    ...(source.personality === undefined ? {} : { personality: source.personality }),
    ...(multiAgent === undefined ? {} : {
      multiAgent: sanitizedMultiAgent,
    }),
  };
}

export function parseCodexInstanceSettings(input: unknown) {
  return CodexInstanceSettingsSchema.parse(sanitizeCodexInstanceSettings(input));
}

function emptyAiSessionTimelineCapabilities() {
  return {
    sessionReadAgents: [] as string[],
    turnReadAgents: [] as string[],
    liveItemAgents: [] as string[],
  };
}

function emptyAiSessionConversationAttachmentCapabilities() {
  return {
    metadataAgents: [] as string[],
    contentAgents: [] as string[],
    uploadAgents: [] as string[],
    retentionSettings: false,
    fileSizeLimitSettings: false,
  };
}

function emptyAiSessionProviderCapabilities() {
  return [] as AiSessionProviderCapability[];
}

function emptyModelRelayCapabilities() {
  return { protocols: [] as ModelProtocol[], streaming: false };
}

function emptyManagedModelEnvironmentCapabilities() {
  return { openCodeConfig: false };
}

function defaultControlledInstanceFeatures() {
  return {
    appRuntime: false,
    tty: false,
    gui: false,
    browser: false,
    browserTunnel: false,
    screenshots: false,
    logs: false,
    aiSessionWorkspaceSelection: false,
    aiSessionWorkspaceCheckout: false,
    aiSessionPersistenceSettings: false,
    privateModelCatalog: false,
    codexManagedSettings: false,
    nodeAgentConnectionUpdate: false,
    gitCliCredentialBroker: false,
    gitCredentialProxy: false,
    repositoryPathSearch: false,
    repositoryWorktreeMoveToMain: false,
    modelRelay: emptyModelRelayCapabilities(),
    managedModelEnvironment: emptyManagedModelEnvironmentCapabilities(),
    aiSessionSendIdempotency: false,
    aiSessionQueuePause: false,
    aiSessionTimeline: emptyAiSessionTimelineCapabilities(),
    aiSessionConversationAttachments: emptyAiSessionConversationAttachmentCapabilities(),
    aiSessionProviders: emptyAiSessionProviderCapabilities(),
  };
}

function defaultControlledInstanceCapabilities() {
  return { features: defaultControlledInstanceFeatures() };
}

/**
 * Provider-scoped Timeline capabilities on the controlled-instance/control-plane boundary.
 * The three capabilities are independent: snapshot reads never imply live item delivery.
 */
export const AiSessionTimelineCapabilitiesSchema = z.object({
  sessionReadAgents: z.array(AiSessionCapabilityAgentSchema).max(100).default([]),
  turnReadAgents: z.array(AiSessionCapabilityAgentSchema).max(100).default([]),
  liveItemAgents: z.array(AiSessionCapabilityAgentSchema).max(100).default([]),
}).passthrough();

export const AiSessionConversationAttachmentCapabilitiesSchema = z.object({
  metadataAgents: z.array(AiSessionCapabilityAgentSchema).max(100).default([]),
  contentAgents: z.array(AiSessionCapabilityAgentSchema).max(100).default([]),
  uploadAgents: z.array(AiSessionCapabilityAgentSchema).max(100).default([]),
  retentionSettings: z.boolean().default(false),
  // Compatibility for v0.0.21: older controlled instances do not accept the
  // additive maxFileAttachmentBytes internal settings field.
  fileSizeLimitSettings: z.boolean().default(false),
}).passthrough();

/**
 * Additive consumer capability: the controlled instance can consume the v2
 * relay private catalog and address model traffic through node-agent routes.
 * Absence on v0.0.34 instances only disables the relay feature domain.
 */
export const ControlledInstanceModelRelayCapabilitiesSchema = z.object({
  protocols: z.array(ModelProtocolSchema).max(3).default([]),
  streaming: z.boolean().default(false),
}).strip();

/**
 * Additive consumer capability: the controlled instance accepts structured
 * managed model environment keys beyond the flat legacy set (today the OpenCode
 * provider config content) on the live model-environment route. Compatibility
 * for v0.0.35: absence keeps the node agent on the flat key set so a strict
 * older route cannot fail the whole environment and catalog sync.
 */
export const ControlledInstanceManagedModelEnvironmentCapabilitiesSchema = z.object({
  openCodeConfig: z.boolean().default(false),
}).strip();

export const ControlledInstanceFeatureCapabilitiesSchema = z.object({
  appRuntime: z.boolean().default(false),
  tty: z.boolean().default(false),
  gui: z.boolean().default(false),
  browser: z.boolean().default(false),
  // Compatibility for v0.0.23: Browser Tunnel is additive and absent on older instances.
  browserTunnel: z.boolean().optional(),
  screenshots: z.boolean().default(false),
  logs: z.boolean().default(false),
  aiSessionWorkspaceSelection: z.boolean().default(false),
  // Compatibility for v0.0.31: absence disables pre-session current-folder checkout.
  aiSessionWorkspaceCheckout: z.boolean().optional(),
  aiSessionPersistenceSettings: z.boolean().default(false),
  // Compatibility for v0.0.23: only current controlled instances accept the
  // private model catalog live-sync route.
  privateModelCatalog: z.boolean().optional(),
  // Compatibility for v0.0.28: absent means the instance cannot apply managed Codex settings.
  codexManagedSettings: z.boolean().optional(),
  // Additive capability: older controlled instances keep using their bootstrap environment URL.
  nodeAgentConnectionUpdate: z.boolean().optional(),
  // Additive capability: absent on v0.0.21 controlled instances.
  gitCliCredentialBroker: z.boolean().optional(),
  // Additive capability for the node-agent-owned runtime broker architecture.
  gitCredentialProxy: z.boolean().optional(),
  // Compatibility for v0.0.32: absence disables repository-wide path search.
  repositoryPathSearch: z.boolean().optional(),
  // Compatibility for v0.0.33: absence disables moving a worktree into the main worktree.
  repositoryWorktreeMoveToMain: z.boolean().optional(),
  // Compatibility for v0.0.33: absence means the internal AI Session send route
  // does not accept `clientRequestId`, so node-agent degrades to its private
  // `resuming` ledger instead of a blind resend.
  aiSessionSendIdempotency: z.boolean().optional(),
  // Compatibility for v0.0.35: absence means the AI Session queue route does
  // not expose the pause/resume control.
  aiSessionQueuePause: z.boolean().optional(),
  aiSessionTimeline: AiSessionTimelineCapabilitiesSchema.default(emptyAiSessionTimelineCapabilities),
  // Compatibility for v0.0.21: the additive wire field must remain optional.
  aiSessionConversationAttachments: AiSessionConversationAttachmentCapabilitiesSchema.optional(),
  // Compatibility for v0.0.21: provider capabilities are additive and absent on older instances.
  aiSessionProviders: AiSessionProviderCapabilitiesSchema.optional(),
  // Additive capability: absent on v0.0.34 controlled instances.
  modelRelay: ControlledInstanceModelRelayCapabilitiesSchema.optional(),
  // Additive capability: absent on v0.0.35 controlled instances.
  managedModelEnvironment: ControlledInstanceManagedModelEnvironmentCapabilitiesSchema.optional(),
}).passthrough();

/** The single capability document for the controlled-instance/control-plane boundary. */
export const ControlledInstanceCapabilitiesSchema = z.object({
  features: ControlledInstanceFeatureCapabilitiesSchema.default(defaultControlledInstanceFeatures),
}).passthrough();

export const UpdateControlledInstanceNodeAgentConnectionSchema = z.object({
  nodeAgentUrl: z.string().trim().url().max(2_048).refine((value) => {
    const parsed = new URL(value);
    return /^https?:$/.test(parsed.protocol)
      && !parsed.username
      && !parsed.password
      && parsed.pathname === "/"
      && !parsed.search
      && !parsed.hash;
  }, "Node agent URL must be an HTTP(S) origin."),
}).strict();

export type AiSessionTimelineCapabilities = z.infer<typeof AiSessionTimelineCapabilitiesSchema>;
export type AiSessionTimelineCapability = "session-read" | "turn-read" | "live-items";
export type AiSessionConversationAttachmentCapabilities = z.infer<typeof AiSessionConversationAttachmentCapabilitiesSchema>;
export type AiSessionConversationAttachmentCapability = "metadata" | "content" | "upload";
export type ControlledInstanceModelRelayCapabilities = z.infer<typeof ControlledInstanceModelRelayCapabilitiesSchema>;
export type ControlledInstanceManagedModelEnvironmentCapabilities = z.infer<typeof ControlledInstanceManagedModelEnvironmentCapabilitiesSchema>;
export type ControlledInstanceCapabilities = z.infer<typeof ControlledInstanceCapabilitiesSchema>;
type NormalizedControlledInstanceCapabilities = ControlledInstanceCapabilities & {
  features: ControlledInstanceCapabilities["features"] & {
    aiSessionConversationAttachments: AiSessionConversationAttachmentCapabilities;
    aiSessionProviders: AiSessionProviderCapability[];
    aiSessionWorkspaceCheckout: boolean;
    gitCliCredentialBroker: boolean;
    gitCredentialProxy: boolean;
    repositoryPathSearch: boolean;
    repositoryWorktreeMoveToMain: boolean;
    aiSessionSendIdempotency: boolean;
    privateModelCatalog: boolean;
    browserTunnel: boolean;
    nodeAgentConnectionUpdate: boolean;
    modelRelay: ControlledInstanceModelRelayCapabilities;
    managedModelEnvironment: ControlledInstanceManagedModelEnvironmentCapabilities;
  };
};

/** Normalize the only capability document on this boundary before querying any feature. */
export function normalizeControlledInstanceCapabilities(capabilities: unknown): NormalizedControlledInstanceCapabilities {
  const defaults = defaultControlledInstanceCapabilities();
  if (!capabilities || typeof capabilities !== "object" || Array.isArray(capabilities)) return defaults;
  const document = capabilities as Record<string, unknown>;
  const rawFeatures = document.features;
  if (!rawFeatures || typeof rawFeatures !== "object" || Array.isArray(rawFeatures)) return defaults;
  const features = rawFeatures as Record<string, unknown>;
  const normalizedFeatures = defaultControlledInstanceFeatures();
  for (const feature of [
    "appRuntime",
    "tty",
    "gui",
    "browser",
    "browserTunnel",
    "screenshots",
    "logs",
    "aiSessionWorkspaceSelection",
    "aiSessionWorkspaceCheckout",
    "aiSessionPersistenceSettings",
    "privateModelCatalog",
    "codexManagedSettings",
    "nodeAgentConnectionUpdate",
    "gitCliCredentialBroker",
    "gitCredentialProxy",
    "repositoryPathSearch",
    "repositoryWorktreeMoveToMain",
    "aiSessionSendIdempotency",
    "aiSessionQueuePause",
  ] as const) {
    const parsed = z.boolean().safeParse(features[feature]);
    if (parsed.success) normalizedFeatures[feature] = parsed.data;
  }
  const timeline = AiSessionTimelineCapabilitiesSchema.safeParse(features.aiSessionTimeline);
  if (timeline.success) normalizedFeatures.aiSessionTimeline = timeline.data;
  const conversationAttachments = AiSessionConversationAttachmentCapabilitiesSchema.safeParse(features.aiSessionConversationAttachments);
  if (conversationAttachments.success) normalizedFeatures.aiSessionConversationAttachments = conversationAttachments.data;
  const providers = AiSessionProviderCapabilitiesSchema.safeParse(features.aiSessionProviders);
  if (providers.success) normalizedFeatures.aiSessionProviders = providers.data;
  const modelRelay = ControlledInstanceModelRelayCapabilitiesSchema.safeParse(features.modelRelay);
  if (modelRelay.success) normalizedFeatures.modelRelay = modelRelay.data;
  const managedModelEnvironment = ControlledInstanceManagedModelEnvironmentCapabilitiesSchema.safeParse(features.managedModelEnvironment);
  if (managedModelEnvironment.success) normalizedFeatures.managedModelEnvironment = managedModelEnvironment.data;
  return ControlledInstanceCapabilitiesSchema.parse({
    ...document,
    features: { ...features, ...normalizedFeatures },
  }) as NormalizedControlledInstanceCapabilities;
}

export function supportsAiSessionWorkspaceSelection(capabilities: unknown) {
  return normalizeControlledInstanceCapabilities(capabilities).features.aiSessionWorkspaceSelection;
}

export function supportsAiSessionWorkspaceCheckout(capabilities: unknown) {
  return normalizeControlledInstanceCapabilities(capabilities).features.aiSessionWorkspaceCheckout;
}

export function supportsAiSessionPersistenceSettings(capabilities: unknown) {
  return normalizeControlledInstanceCapabilities(capabilities).features.aiSessionPersistenceSettings;
}

export function supportsControlledInstancePrivateModelCatalog(capabilities: unknown) {
  return normalizeControlledInstanceCapabilities(capabilities).features.privateModelCatalog;
}

/** Single query for the relay consumer capability declared by this boundary. */
export function controlledInstanceModelRelayCapabilities(capabilities: unknown) {
  return normalizeControlledInstanceCapabilities(capabilities).features.modelRelay;
}

export function supportsControlledInstanceModelRelay(capabilities: unknown) {
  return controlledInstanceModelRelayCapabilities(capabilities).protocols.length > 0;
}

export function supportsControlledInstanceModelRelayProtocol(capabilities: unknown, protocol: ModelProtocol) {
  return controlledInstanceModelRelayCapabilities(capabilities).protocols.includes(protocol);
}

export function supportsControlledInstanceModelRelayStreaming(capabilities: unknown) {
  return controlledInstanceModelRelayCapabilities(capabilities).streaming;
}

/** Single query for the structured managed-environment capability declared by this boundary. */
export function controlledInstanceManagedModelEnvironmentCapabilities(capabilities: unknown) {
  return normalizeControlledInstanceCapabilities(capabilities).features.managedModelEnvironment;
}

export function supportsControlledInstanceOpenCodeEnvironment(capabilities: unknown) {
  return controlledInstanceManagedModelEnvironmentCapabilities(capabilities).openCodeConfig;
}

export function supportsControlledInstanceCodexManagedSettings(capabilities: unknown) {
  return normalizeControlledInstanceCapabilities(capabilities).features.codexManagedSettings;
}

export function supportsControlledInstanceNodeAgentConnectionUpdate(capabilities: unknown) {
  return normalizeControlledInstanceCapabilities(capabilities).features.nodeAgentConnectionUpdate;
}

export function supportsBrowserTunnel(capabilities: unknown) {
  return normalizeControlledInstanceCapabilities(capabilities).features.browserTunnel;
}

export function supportsGitCliCredentialBroker(capabilities: unknown) {
  const features = normalizeControlledInstanceCapabilities(capabilities).features;
  return features.gitCredentialProxy || features.gitCliCredentialBroker;
}

export function supportsGitCredentialProxy(capabilities: unknown) {
  return normalizeControlledInstanceCapabilities(capabilities).features.gitCredentialProxy;
}

export function supportsRepositoryPathSearch(capabilities: unknown) {
  return normalizeControlledInstanceCapabilities(capabilities).features.repositoryPathSearch;
}

export function supportsRepositoryWorktreeMoveToMain(capabilities: unknown) {
  return normalizeControlledInstanceCapabilities(capabilities).features.repositoryWorktreeMoveToMain;
}

/**
 * Compatibility for v0.0.33: older controlled instances do not declare this
 * capability, so their internal AI Session send route may reject
 * `clientRequestId`. The node-agent then uses its private `resuming` ledger for
 * a decision reply instead of a blind resend.
 */
export function supportsAiSessionSendIdempotency(capabilities: unknown) {
  return normalizeControlledInstanceCapabilities(capabilities).features.aiSessionSendIdempotency;
}

export function supportsAiSessionQueuePause(capabilities: unknown) {
  return normalizeControlledInstanceCapabilities(capabilities).features.aiSessionQueuePause === true;
}

export function aiSessionConversationAttachmentCapabilities(capabilities: unknown): AiSessionConversationAttachmentCapabilities {
  return normalizeControlledInstanceCapabilities(capabilities).features.aiSessionConversationAttachments;
}

export function aiSessionProviderCapabilities(capabilities: unknown) {
  return normalizeControlledInstanceCapabilities(capabilities).features.aiSessionProviders;
}

export function aiSessionProviderCapability(capabilities: unknown, agent: string) {
  return aiSessionProviderCapabilities(capabilities).find((provider) => provider.agent === agent);
}

/**
 * Older controlled instances parse `modelSelection` with a strict schema that
 * predates the additive `modelUpstreamName` field, so sending it there fails
 * the whole request. Drop the field unless the instance advertises
 * stable-identity support; those instances resolve identity from their own
 * model catalog anyway.
 */
export function modelSelectionForInstance<T extends { modelUpstreamName?: string }>(
  capabilities: unknown,
  agent: string,
  selection: T,
): T {
  if (selection.modelUpstreamName === undefined) return selection;
  if (aiSessionProviderCapability(capabilities, agent)?.modelSelection?.stableIdentity) return selection;
  const { modelUpstreamName: _omitted, ...legacy } = selection;
  return legacy as T;
}

export function aiSessionConversationAttachmentCapabilityAgents(
  capabilities: unknown,
  capability: AiSessionConversationAttachmentCapability,
) {
  const normalized = aiSessionConversationAttachmentCapabilities(capabilities);
  if (capability === "metadata") return normalized.metadataAgents;
  if (capability === "content") return normalized.contentAgents;
  return normalized.uploadAgents;
}

export function supportsAiSessionConversationAttachmentCapability(
  capabilities: unknown,
  agent: string,
  capability: AiSessionConversationAttachmentCapability,
) {
  return aiSessionConversationAttachmentCapabilityAgents(capabilities, capability).includes(agent);
}

export function supportsAiSessionAttachmentRetentionSettings(capabilities: unknown) {
  return aiSessionConversationAttachmentCapabilities(capabilities).retentionSettings;
}

export function supportsAiSessionFileSizeLimitSettings(capabilities: unknown) {
  return aiSessionConversationAttachmentCapabilities(capabilities).fileSizeLimitSettings === true;
}

/** Query the structured Timeline feature from the normalized capability document. */
export function aiSessionTimelineCapabilities(capabilities: unknown): AiSessionTimelineCapabilities {
  return normalizeControlledInstanceCapabilities(capabilities).features.aiSessionTimeline;
}

export function aiSessionTimelineCapabilityAgents(
  capabilities: unknown,
  capability: AiSessionTimelineCapability,
) {
  const normalized = aiSessionTimelineCapabilities(capabilities);
  if (capability === "session-read") return normalized.sessionReadAgents;
  if (capability === "turn-read") return normalized.turnReadAgents;
  return normalized.liveItemAgents;
}

export function supportsAiSessionTimelineCapability(
  capabilities: unknown,
  agent: string,
  capability: AiSessionTimelineCapability,
) {
  return aiSessionTimelineCapabilityAgents(capabilities, capability).includes(agent);
}

const IdSchema = z.string().trim().min(1).max(120).regex(/^[a-zA-Z0-9][a-zA-Z0-9_.:-]*$/);
const TimestampSchema = z.string().datetime();
const LabelsSchema = z.record(z.string(), z.string()).default({});
const StringRecordSchema = z.record(z.string(), z.string()).default({});

export const NodeTunnelRequestBodySchema = z.object({
  encoding: z.enum(["utf8", "base64"]),
  data: z.string(),
}).strict().superRefine((body, context) => {
  if (body.encoding === "base64" && Buffer.from(body.data, "base64").toString("base64") !== body.data) {
    context.addIssue({ code: "custom", path: ["data"], message: "Node tunnel binary body must use canonical base64 encoding." });
  }
});

export type NodeTunnelRequestBody = z.infer<typeof NodeTunnelRequestBodySchema>;

export function encodeNodeTunnelRequestBody(value: unknown): NodeTunnelRequestBody | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") return { encoding: "utf8", data: value };
  if (Buffer.isBuffer(value)) return { encoding: "base64", data: value.toString("base64") };
  if (value instanceof ArrayBuffer) return { encoding: "base64", data: Buffer.from(value).toString("base64") };
  if (ArrayBuffer.isView(value)) {
    return { encoding: "base64", data: Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString("base64") };
  }
  throw new TypeError("Node tunnel request body must be a string or binary buffer.");
}

export function decodeNodeTunnelRequestBody(value: unknown): string | Buffer | undefined {
  if (value === undefined || value === null) return undefined;
  const parsed = NodeTunnelRequestBodySchema.parse(value);
  return parsed.encoding === "utf8" ? parsed.data : Buffer.from(parsed.data, "base64");
}

const DockerTagPattern = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;
const DockerDigestPattern = /^sha256:([a-fA-F0-9]{64})$/;
const DockerRegistryPattern = /^(?:localhost|[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?)(?::[1-9][0-9]{0,4})?$/;
const DockerRepositoryComponentPattern = /^[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*$/;

export function normalizeDockerImageReference(input: string) {
  const value = input.trim();
  if (!value || value.length > 512 || value.includes("://") || /\s/.test(value)) {
    throw new Error("Docker image reference must not contain a URL scheme or whitespace.");
  }
  const at = value.indexOf("@");
  if (at !== -1 && at !== value.lastIndexOf("@")) throw new Error("Docker image reference contains more than one digest separator.");
  const digestInput = at === -1 ? undefined : value.slice(at + 1);
  const base = at === -1 ? value : value.slice(0, at);
  const digestMatch = digestInput ? DockerDigestPattern.exec(digestInput) : undefined;
  if (digestInput && !digestMatch) throw new Error("Docker image digest must use sha256 followed by 64 hexadecimal characters.");

  const lastSlash = base.lastIndexOf("/");
  const lastColon = base.lastIndexOf(":");
  const hasTag = lastColon > lastSlash;
  const tag = hasTag ? base.slice(lastColon + 1) : undefined;
  const name = hasTag ? base.slice(0, lastColon) : base;
  if (tag && !DockerTagPattern.test(tag)) throw new Error("Docker image tag is invalid.");
  if (!tag && !digestMatch) throw new Error("Docker image reference must include an explicit tag or sha256 digest.");

  const parts = name.split("/");
  if (!parts.length || parts.some((part) => !part)) throw new Error("Docker image repository path is invalid.");
  const hasRegistry = parts.length > 1 && (parts[0].includes(".") || parts[0].includes(":") || parts[0] === "localhost");
  const repositoryParts = hasRegistry ? parts.slice(1) : parts;
  if (hasRegistry && !DockerRegistryPattern.test(parts[0].toLowerCase())) throw new Error("Docker image registry host or port is invalid.");
  if (!repositoryParts.length || repositoryParts.some((part) => !DockerRepositoryComponentPattern.test(part))) {
    throw new Error("Docker image repository names must be lowercase and use valid separators.");
  }

  const normalizedName = parts.map((part, index) => hasRegistry && index === 0 ? part.toLowerCase() : part).join("/");
  const normalizedDigest = digestMatch ? `sha256:${digestMatch[1].toLowerCase()}` : undefined;
  return `${normalizedName}${tag ? `:${tag}` : ""}${normalizedDigest ? `@${normalizedDigest}` : ""}`;
}

export function parseDockerImageReference(input: string) {
  const reference = normalizeDockerImageReference(input);
  const at = reference.indexOf("@");
  const digest = at === -1 ? undefined : reference.slice(at + 1);
  const base = at === -1 ? reference : reference.slice(0, at);
  const lastSlash = base.lastIndexOf("/");
  const lastColon = base.lastIndexOf(":");
  const hasTag = lastColon > lastSlash;
  return {
    reference,
    repository: hasTag ? base.slice(0, lastColon) : base,
    tag: hasTag ? base.slice(lastColon + 1) : undefined,
    digest,
  };
}

export const DockerImageReferenceSchema = z.string().trim().min(1).max(512).transform((value, context) => {
  try {
    return normalizeDockerImageReference(value);
  } catch (error) {
    context.addIssue({ code: "custom", message: error instanceof Error ? error.message : String(error) });
    return z.NEVER;
  }
});

export const DockerImageDigestSchema = z.string().trim().transform((value, context) => {
  const match = DockerDigestPattern.exec(value);
  if (!match) {
    context.addIssue({ code: "custom", message: "Docker image digest must use sha256 followed by 64 hexadecimal characters." });
    return z.NEVER;
  }
  return `sha256:${match[1].toLowerCase()}`;
});

// Omitted uses the enabled global default, null disables managed model binding,
// and a hash pins the instance to that model.
export const ModelSelectionSchema = z
  .object({
    modelEntityIds: z.array(IdSchema).max(64).transform((ids) => [...new Set(ids)]).optional(),
    // Compatibility for v0.0.23: these hashes remain the single-model projection
    // consumed by N-1 node agents. Current owners derive them from modelEntityIds.
    codexModelHash: IdSchema.nullable().optional(),
    claudeModelHash: IdSchema.nullable().optional(),
    opencodeModelHash: IdSchema.nullable().optional(),
  })
  .strict()
  .default({});

export const ImageSelectionSchema = z.object({
  imageId: IdSchema,
  tag: z.string().trim().min(1).max(128).regex(DockerTagPattern).optional(),
}).strict();

export const EnvironmentSourceSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("image"),
    imageSelection: ImageSelectionSchema,
  }).strict(),
  z.object({
    type: z.literal("template"),
    environmentTemplateId: IdSchema,
  }).strict(),
]);

export const EnvironmentTemplateStatusSchema = z.enum(["creating", "ready", "failed", "deleting"]);
export const FinalComputerPlatformSchema = z.enum(["linux", "darwin", "win32", "freebsd", "openbsd", "aix", "sunos", "unknown"]);
export const FinalComputerArchSchema = z.enum(["x64", "arm64", "arm", "ia32", "ppc64", "s390x", "riscv64", "unknown"]);

export const EnvironmentTemplateErrorSchema = z.object({
  code: z.string().trim().min(1).max(120),
  message: z.string().trim().min(1).max(2048),
  phase: z.enum(["validate", "commit", "inspect", "security-check", "persist", "delete", "recovery"]).optional(),
}).strict();

export const EnvironmentTemplateOriginSchema = z.object({
  templateId: IdSchema,
  nodeId: IdSchema,
  imageId: DockerImageDigestSchema,
  name: z.string().trim().min(1).max(160),
  platform: FinalComputerPlatformSchema,
  architecture: FinalComputerArchSchema,
}).strict();

export const InstanceVolumeRoleSchema = z.enum(["data", "agent-home", "workspace"]);

export const InstanceDeleteInputSchema = z.object({
  deleteVolumes: z.boolean(),
}).strict();

export const InstanceVolumeDispositionSchema = z.object({
  role: InstanceVolumeRoleSchema,
  name: z.string().trim().min(1).max(255),
  mountPath: z.string().trim().startsWith("/").max(4096),
  status: z.enum(["deleted", "retained", "missing", "failed"]),
  error: z.object({
    code: z.string().trim().min(1).max(120),
    message: z.string().trim().min(1).max(2048),
  }).strict().optional(),
}).strict();

export const InstanceDeleteResultSchema = z.object({
  instanceId: IdSchema,
  containerDeleted: z.boolean(),
  completed: z.boolean(),
  deletedVolumes: z.array(InstanceVolumeDispositionSchema),
  retainedVolumes: z.array(InstanceVolumeDispositionSchema),
  volumeResults: z.array(InstanceVolumeDispositionSchema),
}).strict();

export const LEGACY_MARKET_IMAGE_IDS: Record<string, string> = {
  img_default: "market_taskhandoff_browser",
  img_codex: "market_taskhandoff_codex",
  img_ai: "market_taskhandoff_ai",
};

export function migrateLegacyImageSelection(input: unknown, legacyImageId?: unknown) {
  if (input && typeof input === "object" && !Array.isArray(input)) {
    const source = input as Record<string, unknown>;
    const imageId = typeof source.imageId === "string" ? (LEGACY_MARKET_IMAGE_IDS[source.imageId] || source.imageId) : source.imageId;
    return { imageId, ...(typeof source.tag === "string" ? { tag: source.tag } : {}) };
  }
  if (typeof legacyImageId === "string") return { imageId: LEGACY_MARKET_IMAGE_IDS[legacyImageId] || legacyImageId };
  return undefined;
}

export function sanitizeStoredProject(input: unknown) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return input;
  const source = input as Record<string, unknown>;
  // Compatibility for v0.0.21: projects persisted by older control planes may
  // carry a runtime preference. Runtime selection is instance-owned now.
  const { defaultImageId, defaultRuntimeId: _defaultRuntimeId, ...record } = source;
  return {
    ...record,
    source: sanitizeStoredProjectSource(source.source),
    defaultImageSelection: migrateLegacyImageSelection(source.defaultImageSelection, defaultImageId),
  };
}

export function sanitizeStoredNodeLocalFolder(input: unknown) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return input;
  const source = input as Record<string, unknown>;
  const { defaultImageId, ...record } = source;
  return {
    ...record,
    defaultImageSelection: migrateLegacyImageSelection(source.defaultImageSelection, defaultImageId),
  };
}

export const InstanceAppInventoryItemSchema = z
  .object({
    id: IdSchema,
    name: z.string().trim().min(1).max(120),
    kind: z.enum(["tty", "gui", "web"]),
    source: z.enum(["builtin", "custom"]),
    availability: z.enum(["available", "missing-dependency"]),
    capabilities: z
      .object({
        automation: z.enum(["cdp"]).optional(),
        supportsCwdSelection: z.boolean().default(false),
        supportsProfiles: z.boolean().default(false),
      })
      .strict()
      .default({ supportsCwdSelection: false, supportsProfiles: false }),
    diagnosticCode: z.enum(["APP_EXECUTABLE_NOT_FOUND"]).optional(),
  })
  .strict();

export const InstanceAppInventoryIssueSchema = z
  .object({
    code: z.enum(["APP_CATALOG_INVALID"]),
    message: z.string().trim().min(1).max(500),
  })
  .strict();

export const InstanceAppInventorySchema = z
  .object({
    items: z.array(InstanceAppInventoryItemSchema).max(256),
    observedAt: TimestampSchema,
    issues: z.array(InstanceAppInventoryIssueSchema).max(32).default([]),
  })
  .strict();

export const EnvironmentTemplateSchema = z.object({
  id: IdSchema,
  name: z.string().trim().min(1).max(160),
  sourceInstanceId: IdSchema,
  nodeId: IdSchema,
  imageId: DockerImageDigestSchema.optional(),
  internalTag: z.string().trim().min(1).max(512).optional(),
  platform: FinalComputerPlatformSchema.optional(),
  architecture: FinalComputerArchSchema.optional(),
  sizeBytes: z.number().int().nonnegative().optional(),
  status: EnvironmentTemplateStatusSchema,
  error: EnvironmentTemplateErrorSchema.optional(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
}).strict().superRefine((template, context) => {
  if (template.status === "ready") {
    for (const field of ["imageId", "internalTag", "platform", "architecture", "sizeBytes"] as const) {
      if (template[field] === undefined) {
        context.addIssue({ code: "custom", path: [field], message: `Ready environment template requires ${field}.` });
      }
    }
  }
  if (template.status === "failed" && !template.error) {
    context.addIssue({ code: "custom", path: ["error"], message: "Failed environment template requires an error diagnostic." });
  }
});

export function sanitizeStoredEnvironmentTemplate(
  input: unknown,
  onWarning?: (warning: { templateId?: string; field: string }) => void,
) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return input;
  const source = input as Record<string, unknown>;
  const knownKeys = new Set([
    "id", "name", "sourceInstanceId", "nodeId", "imageId", "internalTag", "platform",
    "architecture", "sizeBytes", "status", "error", "createdAt", "updatedAt",
  ]);
  const templateId = typeof source.id === "string" ? source.id : undefined;
  for (const key of Object.keys(source)) {
    if (!knownKeys.has(key)) onWarning?.({ templateId, field: key });
  }
  const next = pickObjectFields(source, [...knownKeys]) as Record<string, unknown>;
  if (source.error && typeof source.error === "object" && !Array.isArray(source.error)) {
    const error = source.error as Record<string, unknown>;
    for (const key of Object.keys(error)) {
      if (!["code", "message", "phase"].includes(key)) onWarning?.({ templateId, field: `error.${key}` });
    }
    next.error = pickObjectFields(error, ["code", "message", "phase"]);
  }
  return next;
}
export const AppInstallerSchema = z.enum(["apt", "dnf", "brew", "npm"]);
export const AppInstallPrivilegeSchema = z.enum(["user", "passwordless-sudo", "root"]);
export const FinalComputerCapabilitiesSchema = z.object({
  platform: FinalComputerPlatformSchema,
  arch: FinalComputerArchSchema,
  installers: z.array(AppInstallerSchema).max(8),
  privilege: AppInstallPrivilegeSchema,
  installerAccess: z.object({
    npmGlobalWritable: z.boolean().optional(),
  }).strict().optional(),
}).strict();

export const ManagedAppStateSchema = z.enum(["installed", "not-installed", "broken", "unsupported"]);
export const ManagedAppManagementSourceSchema = z.enum(["recipe", "bundled", "external", "none"]);
export const ManagedAppActionReasonSchema = z.object({
  code: z.enum(["BUNDLED", "EXTERNALLY_MANAGED", "ALREADY_INSTALLED", "NOT_INSTALLED", "UNSUPPORTED_PLATFORM", "INSTALLER_UNAVAILABLE", "INSTALLER_NOT_WRITABLE", "INSUFFICIENT_PRIVILEGE", "OPERATION_IN_PROGRESS"]),
  message: z.string().trim().min(1).max(500),
}).strict();
export const ManagedAppUpdateStatusSchema = z.enum(["update-available", "up-to-date", "unknown", "unsupported"]);
// Read-only result of the most recent manual update check. Omitted until the
// user checks and by instances that predate the update-check capability.
export const ManagedAppUpdateStateSchema = z.object({
  status: ManagedAppUpdateStatusSchema,
  installedVersion: z.string().trim().max(120).optional(),
  latestVersion: z.string().trim().max(120).optional(),
  checkedAt: TimestampSchema,
  reason: z.string().trim().max(500).optional(),
}).strict();
export const ManagedAppUpdateCheckSchema = ManagedAppUpdateStateSchema.extend({ appId: IdSchema }).strict();
export const ManagedAppProjectionSchema = z.object({
  id: IdSchema,
  name: z.string().trim().min(1).max(120),
  kind: z.enum(["tty", "gui", "web"]),
  description: z.string().trim().max(500).optional(),
  state: ManagedAppStateSchema,
  managementSource: ManagedAppManagementSourceSchema,
  version: z.string().trim().max(120).optional(),
  canInstall: z.boolean(),
  canUninstall: z.boolean(),
  // Optional for N-1 compatibility: instances that predate app updates omit these
  // fields and consumers must treat a missing value as "not updatable".
  canUpdate: z.boolean().optional(),
  installReason: ManagedAppActionReasonSchema.optional(),
  uninstallReason: ManagedAppActionReasonSchema.optional(),
  updateReason: ManagedAppActionReasonSchema.optional(),
  updateCheck: ManagedAppUpdateStateSchema.optional(),
  activeJobId: IdSchema.optional(),
}).strict();

export const AppManagementOperationSchema = z.enum(["install", "uninstall", "update"]);
export const AppManagementJobStateSchema = z.enum(["queued", "running", "succeeded", "failed", "cancelled", "interrupted"]);
export const AppManagementProgressSchema = z.object({
  current: z.number().finite().nonnegative().optional(),
  total: z.number().finite().positive().optional(),
  unit: z.string().trim().min(1).max(40).optional(),
}).strict().refine((value) => value.total === undefined || value.current === undefined || value.current <= value.total, {
  message: "Progress current must not exceed total.",
  path: ["current"],
});
export const AppManagementCommandSchema = z.object({
  executable: z.string().trim().min(1).max(4096),
  args: z.array(z.string().max(4096)).max(128),
}).strict();
export const AppManagementErrorSchema = z.object({
  code: z.string().trim().min(1).max(120).regex(/^[a-z0-9][a-z0-9._-]*$/),
  message: z.string().trim().min(1).max(4096),
  retryable: z.boolean(),
  sessionIds: z.array(IdSchema).max(64).optional(),
}).strict();
export const AppManagementJobSchema = z.object({
  id: IdSchema,
  requestId: IdSchema.optional(),
  appId: IdSchema,
  operation: AppManagementOperationSchema,
  state: AppManagementJobStateSchema,
  phase: z.string().trim().min(1).max(120).optional(),
  progress: AppManagementProgressSchema.optional(),
  command: AppManagementCommandSchema.optional(),
  logTail: z.string().max(32768).optional(),
  logTruncated: z.boolean().optional(),
  error: AppManagementErrorSchema.optional(),
  requestedAt: TimestampSchema,
  startedAt: TimestampSchema.optional(),
  finishedAt: TimestampSchema.optional(),
  updatedAt: TimestampSchema,
}).strict();
export const AppManagementSnapshotSchema = z.object({
  streamId: IdSchema,
  sequence: z.number().int().nonnegative(),
  capabilities: FinalComputerCapabilitiesSchema,
  apps: z.array(ManagedAppProjectionSchema).max(256),
  activeJobs: z.array(AppManagementJobSchema).max(256),
  recentJobs: z.array(AppManagementJobSchema).max(256),
  observedAt: TimestampSchema,
}).strict();
export const AppManagementOperationRequestSchema = z.object({
  requestId: IdSchema.optional(),
}).strict();
export const AppManagementJobResponseSchema = z.object({
  job: AppManagementJobSchema,
}).strict();
export const AppManagementUpdateCheckResponseSchema = z.object({
  check: ManagedAppUpdateCheckSchema,
}).strict();
export const AppManagementEventSchema = z.object({
  type: z.literal("app-management"),
  streamId: IdSchema,
  sequence: z.number().int().nonnegative(),
  observedAt: TimestampSchema,
  job: AppManagementJobSchema.optional(),
  snapshot: AppManagementSnapshotSchema.optional(),
}).strict().refine((value) => value.job !== undefined || value.snapshot !== undefined, {
  message: "An app management event requires a job or snapshot.",
});

export const BuildInfoSchema = z
  .object({
    component: z.enum(["control-plane", "node-agent", "controlled-instance"]),
    packageName: z.string().trim().max(160).optional(),
    packageVersion: z.string().trim().max(80).optional(),
    protocolVersion: ProtocolVersionSchema.optional(),
    buildId: z.string().trim().max(160).optional(),
    builtAt: z.string().trim().max(120).optional(),
    gitCommit: z.string().trim().max(120).optional(),
    imageRef: z.string().trim().max(512).optional(),
    imageDigest: z.string().trim().max(240).optional(),
  })
  .strict();

export const ControlPlaneHealthResponseSchema = z.object({
  data: z.object({
    ok: z.literal(true),
    role: z.literal("control-plane"),
    protocolVersion: ProtocolVersionSchema,
    build: BuildInfoSchema.extend({
      component: z.literal("control-plane"),
      packageVersion: z.string().trim().min(1).max(80),
    }).loose(),
    serverTime: TimestampSchema,
  }).loose(),
}).loose();

export const UpdateChannelSchema = z.enum(["stable", "beta", "alpha"]);
export const RuntimeArtifactIdentitySchema = z.object({
  packageName: z.literal("@task-handoff/controlled-instance"),
  version: z.string().trim().min(1).max(80),
  platform: z.string().trim().min(1).max(40),
  arch: z.string().trim().min(1).max(40),
  formatVersion: z.number().int().positive(),
  launcherAbi: z.number().int().positive(),
  entrypoint: z.string().trim().min(1).max(512),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export const RuntimeConvergenceErrorSchema = z.object({
  code: z.enum([
    "INSTANCE_RUNTIME_VERSION_MISMATCH",
    "INSTANCE_RUNTIME_ARTIFACT_UNAVAILABLE",
    "INSTANCE_RUNTIME_ARTIFACT_INVALID",
    "INSTANCE_RUNTIME_INSTALL_FAILED",
    "INSTANCE_RUNTIME_RESTART_FAILED",
    "INSTANCE_RUNTIME_VERIFICATION_FAILED",
    "INSTANCE_BASE_RUNTIME_INCOMPATIBLE",
    "NODE_UPDATE_PREFLIGHT_FAILED",
    "NODE_UPDATE_FAILED",
    "LEGACY_INSTANCE_UPDATE_RETIRED",
  ]),
  message: z.string().trim().min(1).max(4096),
  expectedVersion: z.string().trim().min(1).max(80).optional(),
  actualVersion: z.string().trim().min(1).max(80).optional(),
  retryable: z.boolean().default(false),
}).strict();
export const RuntimeVersionStateSchema = z.object({
  desiredVersion: z.string().trim().min(1).max(80),
  actualVersion: z.string().trim().min(1).max(80).optional(),
  phase: z.enum(["pending", "draining", "installing", "restarting", "verifying", "matched", "failed"]),
  attempt: z.number().int().nonnegative().default(0),
  lastAttemptAt: TimestampSchema.optional(),
  matchedAt: TimestampSchema.optional(),
  error: RuntimeConvergenceErrorSchema.optional(),
}).strict();
export const NodeUpdateImpactSchema = z.object({
  runningInstanceCount: z.number().int().nonnegative(),
  stoppedInstanceCount: z.number().int().nonnegative(),
  activeInstanceCount: z.number().int().nonnegative(),
  restartInstanceCount: z.number().int().nonnegative(),
  runningInstanceIds: z.array(IdSchema).max(1024).default([]),
  stoppedInstanceIds: z.array(IdSchema).max(1024).default([]),
  activeInstanceIds: z.array(IdSchema).max(1024).default([]),
}).strict();
export const NodeRolloutSummarySchema = z.object({
  // Compatibility for v0.0.32: instance rollout phases and counters remain
  // readable, but current server update jobs do not own instance convergence.
  phase: z.enum(["queued", "updating-node", "restarting-node", "converging-instances", "succeeded", "degraded", "failed"]),
  desiredVersion: z.string().trim().min(1).max(80),
  nodeVersion: z.string().trim().min(1).max(80).optional(),
  expectedInstanceIds: z.array(IdSchema).max(1024).default([]),
  expectedInstanceCount: z.number().int().nonnegative(),
  matchedInstanceCount: z.number().int().nonnegative(),
  pendingInstanceCount: z.number().int().nonnegative(),
  failedInstanceCount: z.number().int().nonnegative(),
  deferredInstanceCount: z.number().int().nonnegative().default(0),
}).strict();
export const UpdateCheckRequestSchema = z.object({
  channel: UpdateChannelSchema.default("stable"),
}).strict();
export const UpdateCheckResultSchema = z.object({
  source: z.literal("npm"),
  channel: UpdateChannelSchema,
  currentVersion: z.string().trim().max(240).optional(),
  availableVersion: z.string().trim().min(1).max(240),
  artifactRef: z.string().trim().min(1).max(512).optional(),
  runtimeArtifacts: z.array(RuntimeArtifactIdentitySchema).default([]),
  impact: NodeUpdateImpactSchema,
  updateAvailable: z.boolean(),
  supported: z.boolean().default(true),
  reason: z.string().trim().max(2048).optional(),
  checkedAt: TimestampSchema,
  preflightToken: z.string().trim().min(16).max(240).optional(),
}).strict();
export const UpdateJobSchema = z.object({
  id: IdSchema,
  nodeId: IdSchema,
  source: z.literal("npm"),
  channel: UpdateChannelSchema,
  fromVersion: z.string().trim().max(240).optional(),
  toVersion: z.string().trim().min(1).max(240),
  artifactRef: z.string().trim().min(1).max(512).optional(),
  runtimeArtifacts: z.array(RuntimeArtifactIdentitySchema).default([]),
  impact: NodeUpdateImpactSchema,
  rollout: NodeRolloutSummarySchema,
  status: z.enum(["queued", "updating-node", "restarting-node", "converging-instances", "succeeded", "degraded", "failed"]),
  error: RuntimeConvergenceErrorSchema.optional(),
  startedAt: TimestampSchema.optional(),
  completedAt: TimestampSchema.optional(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
}).strict();
export const ApplyUpdateRequestSchema = z.object({
  channel: UpdateChannelSchema,
  targetVersion: z.string().trim().min(1).max(240),
  preflightToken: z.string().trim().min(16).max(240),
}).strict();

const GitNamedRefSchema = z.object({
  type: z.enum(["branch", "tag"]),
  name: z.string().trim().min(1).max(240),
}).strict();

const GitCommitRefSchema = z.object({
  type: z.literal("commit"),
  commit: z.string().trim().regex(/^[0-9a-fA-F]{4,64}$/, "commit must be a hexadecimal Git object id"),
}).strict();

export const GitRefSchema = z.discriminatedUnion("type", [GitNamedRefSchema, GitCommitRefSchema]);

export const GitAuthSchema = z
  .object({
    type: z.enum(["none", "ssh-key", "https-token"]).default("none"),
    // Compatibility for v0.0.21: preserve the existing field on read. Current
    // Repository producers use it as a managed credential reference; it never
    // carries secret material or directly grants an instance assignment.
    secretId: z.string().trim().min(1).max(120).optional(),
  })
  .strict();

export const GitCloneOptionsSchema = z
  .object({
    depth: z.number().int().positive().max(100000).optional(),
    submodules: z.boolean().default(false),
    lfs: z.boolean().default(false),
    subdirectory: z.string().trim().max(240).refine(
      (value) => !value.startsWith("/") && !value.split("/").some((segment) => segment === ".."),
      "subdirectory must be a relative path within the repository",
    ).transform((value) => value.split("/").filter((segment) => segment && segment !== ".").join("/")).default(""),
  })
  .strict();

export const GitRepositorySchema = z
  .object({
    id: IdSchema,
    name: z.string().trim().min(1).max(160),
    url: z.string().trim().min(1).max(2048),
    provider: z.string().trim().max(80).optional(),
    ref: GitRefSchema.default({ type: "branch", name: "main" }),
    auth: GitAuthSchema.default({ type: "none" }),
    clone: GitCloneOptionsSchema.default({ submodules: false, lfs: false, subdirectory: "" }),
    defaultImageSelection: ImageSelectionSchema.optional(),
    labels: LabelsSchema,
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
  })
  .strict();

export const NodeLocalFolderSchema = z
  .object({
    id: IdSchema,
    nodeId: IdSchema,
    name: z.string().trim().min(1).max(160),
    path: z.string().trim().min(1).max(4096),
    // Compatibility for v0.0.21: accepted from older node-agents, but local folders no longer select images.
    defaultImageSelection: ImageSelectionSchema.optional(),
    labels: LabelsSchema,
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
  })
  .strict();

export const ProjectSourceSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("git-repository"),
      repositoryId: IdSchema.optional(),
      url: z.string().trim().min(1).max(2048),
      provider: z.string().trim().max(80).optional(),
      ref: GitRefSchema.default({ type: "branch", name: "main" }),
      auth: GitAuthSchema.default({ type: "none" }),
      clone: GitCloneOptionsSchema.default({ submodules: false, lfs: false, subdirectory: "" }),
    })
    .strict(),
  z
    .object({
      type: z.literal("git-template"),
      url: z.string().trim().min(1).max(2048),
      templateId: z.string().trim().min(1).max(120).optional(),
      ref: GitRefSchema.default({ type: "branch", name: "main" }),
      auth: GitAuthSchema.default({ type: "none" }),
      clone: GitCloneOptionsSchema.default({ submodules: false, lfs: false, subdirectory: "" }),
    })
    .strict(),
  z
    .object({
      type: z.literal("local-folder"),
      localFolderId: IdSchema.optional(),
      path: z.string().trim().min(1).max(4096),
      ownerNodeId: IdSchema.optional(),
    })
    .strict(),
]);

export type ProjectSource = z.infer<typeof ProjectSourceSchema>;

/** Project auth belongs to the Repository configuration, not the instance/node wire projection. */
export function projectSourceWithoutGitCredential(input: unknown): ProjectSource {
  const source = ProjectSourceSchema.parse(input);
  if (source.type === "local-folder") return source;
  return ProjectSourceSchema.parse({
    ...source,
    auth: { type: "none" },
  });
}

/** Compatibility alias for code compiled against the initial managed-credential implementation. */
export const projectSourceWithoutLegacyGitSecretId = projectSourceWithoutGitCredential;

export const WorkspacePolicySchema = z
  .object({
    mode: z.enum(["local-bind", "git-clone", "empty-volume", "persistent-volume"]),
    path: z.string().trim().min(1).max(4096).default("/workspace"),
    volumeName: z.string().trim().max(240).optional(),
    readOnly: z.boolean().default(false),
  })
  .strict();

export const ModelAppSchema = z.enum(["codex", "claude", "opencode"]);
export type ModelApp = z.infer<typeof ModelAppSchema>;

/** Protocol defaults derived from the deprecated app discriminator. */
export function defaultModelProtocols(app: ModelApp): ModelProtocol[] {
  return app === "claude" ? ["anthropic-messages"] : app === "opencode" ? ["openai-chat-completions"] : ["openai-responses"];
}

export const ModelNameEntrySchema = z.object({
  name: z.string().trim().min(1).max(240),
  // Current writers include the upstream model name only when it differs from
  // the external name; readers normalize a missing value to `name`. The field
  // is additive, so v0.0.34 records stay readable without migration.
  upstreamName: z.string().trim().min(1).max(240).optional(),
  order: z.number().int().min(0).max(1_000_000).default(0),
}).strict();
export type ModelNameEntry = z.infer<typeof ModelNameEntrySchema>;

/**
 * Name entries within one model entity must expose unique external names.
 * Ambiguity is rejected on write; read paths sanitize historical records
 * before parsing so a single bad entry cannot make the whole registry
 * unreadable.
 */
export const ModelNameEntriesSchema = z.array(ModelNameEntrySchema).max(256).default([]).superRefine((entries, context) => {
  const seen = new Set<string>();
  for (const [index, entry] of entries.entries()) {
    if (seen.has(entry.name)) {
      context.addIssue({ code: "custom", path: [index, "name"], message: `Duplicate model name ${entry.name}.` });
    }
    seen.add(entry.name);
  }
});

/**
 * Relay-only request name mapping: an operator-authored rewrite from a model
 * name a client asks for (for example a product's hidden background model) to
 * the name this entity's upstream endpoint expects. Mappings are deliberately
 * independent from {@link ModelNameEntrySchema}: they never join the entity's
 * exposed model names, so they cannot change identity, catalogs, assignments,
 * defaults or session selection. Resolution order is modelNames first, so
 * adding a mapping never changes how an already-resolvable name resolves.
 */
export const ModelRequestMappingSchema = z.object({
  name: z.string().trim().min(1).max(240),
  upstreamName: z.string().trim().min(1).max(240),
  order: z.number().int().min(0).max(1_000_000).default(0),
}).strict();
export type ModelRequestMapping = z.infer<typeof ModelRequestMappingSchema>;

/**
 * Request names within one entity must be unique: the relay fails closed on
 * ambiguous input, and duplicate rows would make the same request resolve
 * differently depending on row order.
 */
export const ModelRequestMappingListSchema = z.array(ModelRequestMappingSchema).max(64).superRefine((entries, context) => {
  const seen = new Set<string>();
  for (const [index, entry] of entries.entries()) {
    if (seen.has(entry.name)) {
      context.addIssue({ code: "custom", path: [index, "name"], message: `Duplicate request mapping ${entry.name}.` });
    }
    seen.add(entry.name);
  }
});

/**
 * Record shape: every stored entity carries a list (possibly empty).
 * Patch inputs use {@link ModelRequestMappingListSchema}.optional() instead so
 * "field absent" stays distinguishable from an explicit empty list.
 */
export const ModelRequestMappingsSchema = ModelRequestMappingListSchema.default([]);

/**
 * Built-in mapping presets for request names the upstream products emit for
 * background work. Presets are read-only metadata: applying one only inserts
 * rows, the upstream target defaults to the entity's first upstream name and
 * every row stays editable. Labels and descriptions live in the UI locales.
 */
export const MODEL_REQUEST_MAPPING_PRESETS = [
  { id: "codex-auto-approval", names: ["codex-auto-review", "gpt-5.6-luna"] },
  { id: "codex-background-tasks", names: ["gpt-5.6-luna", "gpt-5.6-terra"] },
] as const;
export type ModelRequestMappingPreset = (typeof MODEL_REQUEST_MAPPING_PRESETS)[number];

export const ProjectSchema = z
  .object({
    id: IdSchema,
    name: z.string().trim().min(1).max(160),
    source: ProjectSourceSchema,
    defaultImageSelection: ImageSelectionSchema.optional(),
    defaultNodeId: IdSchema.optional(),
    workspacePolicy: WorkspacePolicySchema,
    labels: LabelsSchema,
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
  })
  .strict();

export const ModelConfigSchema = z
  .object({
    id: IdSchema,
    name: z.string().trim().min(1).max(160),
    endpoint: z.string().trim().min(1).max(2048),
    key: z.string().trim().min(1).max(4096),
    model: z.string().trim().min(1).max(240),
    // Ordered names served by this endpoint; legacy records are normalized from `model`.
    modelNames: ModelNameEntriesSchema,
    // Relay-only request name rewrites; never projected into the exposed model
    // name list and inert outside the node model relay.
    mappings: ModelRequestMappingsSchema,
    // Empty is accepted for N-1 records; owners normalize it from the legacy app field.
    protocols: z.array(ModelProtocolSchema).max(3).default([]),
    /** @deprecated Compatibility discriminator for pre-protocol model records. */
    app: ModelAppSchema,
    enabled: z.boolean().default(true),
    order: z.number().int().min(0).max(1_000_000).default(0),
    labels: LabelsSchema,
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
  })
  .strict();

export const NodeModelConfigSchema = ModelConfigSchema;

export const PublicModelConfigSchema = ModelConfigSchema.omit({ key: true }).extend({
  keyPreview: z.string().trim().min(1).max(160),
  keySet: z.boolean(),
  // Content revision of the stored record. Optional so that N-1 node-agents
  // and historical public snapshots stay readable; consumers treat a missing
  // revision as "unknown" instead of assuming the entity is in sync.
  revision: z.string().trim().min(1).max(160).optional(),
}).strict();

export const NodeModelPublicRecordSchema = PublicModelConfigSchema.extend({
  referenceCount: z.number().int().min(0),
}).strict();

export const NodeModelAssignmentSchema = z.object({
  instanceId: IdSchema,
  modelEntityIds: z.array(IdSchema).max(64).transform((ids) => [...new Set(ids)]).optional(),
  codexModelHash: IdSchema.optional(),
  claudeModelHash: IdSchema.optional(),
  opencodeModelHash: IdSchema.optional(),
  updatedAt: TimestampSchema,
}).strict().transform((assignment) => ({
  ...assignment,
  // Compatibility for v0.0.23: migrate the per-agent hashes into the ordered
  // entity collection when reading legacy node-agent persistence or responses.
  modelEntityIds: assignment.modelEntityIds !== undefined
    ? assignment.modelEntityIds
    : [...new Set([assignment.codexModelHash, assignment.claudeModelHash, assignment.opencodeModelHash]
      .filter((id): id is string => Boolean(id)))],
}));

export const ModelLocationSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("control-plane"),
    name: ModelConfigSchema.shape.name,
    enabled: ModelConfigSchema.shape.enabled,
    order: ModelConfigSchema.shape.order,
    revision: z.string().trim().min(1).max(160).optional(),
  }).strict(),
  z.object({
    type: z.literal("node"),
    nodeId: IdSchema,
    name: ModelConfigSchema.shape.name,
    enabled: ModelConfigSchema.shape.enabled,
    order: ModelConfigSchema.shape.order,
    referenceCount: z.number().int().min(0),
    revision: z.string().trim().min(1).max(160).optional(),
  }).strict(),
]);

export const FederatedModelGroupSchema = z.object({
  id: IdSchema,
  model: PublicModelConfigSchema,
  locations: z.array(ModelLocationSchema).min(1),
  referenceCount: z.number().int().min(0).default(0),
}).strict();

export const ModelRegistryNodeDiagnosticSchema = z.object({
  nodeId: IdSchema,
  code: z.string().trim().min(1).max(120),
  message: z.string().trim().min(1).max(2000),
}).strict();

export const FederatedModelRegistrySchema = z.object({
  models: z.array(FederatedModelGroupSchema),
  nodeDiagnostics: z.array(ModelRegistryNodeDiagnosticSchema).default([]),
  updatedAt: TimestampSchema,
}).strict();

export const CreateNodeModelSchema = ModelConfigSchema.omit({
  id: true,
  createdAt: true,
  updatedAt: true,
}).extend({
  // No default here: an absent field means "unchanged" on PATCH, while an
  // explicit empty list means "clear every mapping".
  mappings: ModelRequestMappingListSchema.optional(),
}).strict();

export const UpdateNodeModelSchema = CreateNodeModelSchema.partial().strict();

export const DeployNodeModelSchema = ModelConfigSchema;

// Result of propagating one model edit to a single replica location.
export const ModelLocationSyncStateSchema = z.enum(["synced", "pending", "unsupported", "error"]);
export const ModelLocationSyncResultSchema = z.object({
  nodeId: IdSchema,
  state: ModelLocationSyncStateSchema,
  code: z.string().trim().min(1).max(120).optional(),
  message: z.string().trim().min(1).max(2000).optional(),
}).strict();

export const ModelMutationResultSchema = z.object({
  model: PublicModelConfigSchema,
  locations: z.array(ModelLocationSyncResultSchema).default([]),
}).strict();

export const NodeModelMergeSchema = z.object({ targetModelId: IdSchema }).strict();

export const NodeModelMergeResultSchema = z.object({
  merged: z.literal(true),
  reassignedInstances: z.array(IdSchema).default([]),
}).strict();

export const ModelMergeLocationResultSchema = z.object({
  nodeId: IdSchema,
  merged: z.boolean(),
  reassignedInstances: z.array(IdSchema).default([]),
  code: z.string().trim().min(1).max(120).optional(),
  message: z.string().trim().min(1).max(2000).optional(),
}).strict();

export const ModelMergeResultSchema = z.object({
  modelId: IdSchema,
  targetModelId: IdSchema,
  merged: z.boolean(),
  locations: z.array(ModelMergeLocationResultSchema).default([]),
}).strict();

export const UpdateNodeModelAssignmentSchema = z.object({
  modelSelection: ModelSelectionSchema,
  modelEntityIds: z.array(IdSchema).max(64).transform((ids) => [...new Set(ids)]).optional(),
  codexModelHash: IdSchema.optional(),
  claudeModelHash: IdSchema.optional(),
  opencodeModelHash: IdSchema.optional(),
}).strict().transform((assignment) => ({
  ...assignment,
  modelEntityIds: assignment.modelEntityIds
    || assignment.modelSelection.modelEntityIds
    || [...new Set([assignment.codexModelHash, assignment.claudeModelHash, assignment.opencodeModelHash]
      .filter((id): id is string => Boolean(id)))],
}));

/**
 * Read-side sanitize for stored or remote name entries: unknown keys are
 * dropped (optionally reported), trimmed values are kept and duplicate
 * external names are reduced to the first entry. Values that still have the
 * wrong type pass through so the schema parse reports a structured error.
 */
function sanitizeNameEntryList(input: unknown, label: "modelNames" | "mappings", onWarning?: (warning: { field: string }) => void) {
  if (!Array.isArray(input)) return input;
  const names = new Set<string>();
  return input.flatMap((raw, index) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [raw];
    const source = raw as Record<string, unknown>;
    for (const key of Object.keys(source)) {
      if (key !== "name" && key !== "upstreamName" && key !== "order") {
        onWarning?.({ field: `${label}[${index}].${key}` });
      }
    }
    const name = typeof source.name === "string" ? source.name.trim() : undefined;
    const upstreamName = typeof source.upstreamName === "string" ? source.upstreamName.trim() : undefined;
    if (name) {
      if (names.has(name)) {
        onWarning?.({ field: `${label}[${index}].name` });
        return [];
      }
      names.add(name);
    }
    return [{
      ...(name ? { name } : { name: source.name }),
      ...(upstreamName ? { upstreamName } : {}),
      order: source.order,
    }];
  });
}

export function sanitizeModelNameEntries(input: unknown, onWarning?: (warning: { field: string }) => void) {
  return sanitizeNameEntryList(input, "modelNames", onWarning);
}

/**
 * Read-side sanitize for stored or remote request mappings. Same rules as the
 * model name list: unknown keys are dropped (optionally reported), values are
 * trimmed and duplicate request names keep the first row. `upstreamName` stays
 * required, so a row that loses it still fails the schema parse instead of
 * silently becoming a same-name no-op.
 */
export function sanitizeModelRequestMappings(input: unknown, onWarning?: (warning: { field: string }) => void) {
  return sanitizeNameEntryList(input, "mappings", onWarning);
}

/**
 * Normalization for name entries: fill a missing upstreamName from the
 * external name and sort by order then external name. Write paths renumber
 * orders onto the persisted 100-step grid; read paths pass `renumber: false`
 * so historical order values (for example v0.0.28 migrated `order: 0`
 * records) survive a round trip instead of being rewritten on load.
 * Duplicates are preserved so the {@link ModelNameEntriesSchema} refine
 * rejects ambiguous mappings instead of silently dropping one of them.
 */
export function normalizeModelNameEntries(
  entries: ModelNameEntry[] | undefined,
  legacyModel?: string,
  options: { renumber?: boolean } = {},
): ModelNameEntry[] {
  const source = entries?.length
    ? entries
    : legacyModel?.trim() ? [{ name: legacyModel.trim(), order: 100 }] : [];
  const normalized = source
    .map((entry) => ({
      name: entry.name.trim(),
      upstreamName: entry.upstreamName?.trim() || entry.name.trim(),
      order: entry.order,
    }))
    .sort((left, right) => left.order - right.order || left.name.localeCompare(right.name));
  return options.renumber === false
    ? normalized
    : normalized.map((entry, index) => ({ ...entry, order: (index + 1) * 100 }));
}

/**
 * Wire projection of name entries: `upstreamName` is omitted while it equals
 * the external name, which keeps v0.0.34 readers working and avoids
 * persisting a derivable value. Mapped entries keep the explicit name.
 */
export function projectModelNameEntries(entries: ModelNameEntry[]): ModelNameEntry[] {
  return entries.map((entry) => ({
    name: entry.name,
    ...(entry.upstreamName && entry.upstreamName !== entry.name ? { upstreamName: entry.upstreamName } : {}),
    order: entry.order,
  }));
}

/**
 * Normalization for request mappings: trim both names and sort by order then
 * request name. Write paths renumber onto the persisted 100-step grid; read
 * paths pass `renumber: false` so stored order values survive a round trip.
 * Duplicates are preserved so the {@link ModelRequestMappingsSchema} refine
 * rejects ambiguous rows instead of silently dropping one of them.
 */
export function normalizeModelRequestMappings(
  entries: ModelRequestMapping[] | undefined,
  options: { renumber?: boolean } = {},
): ModelRequestMapping[] {
  const normalized = (entries ?? [])
    .map((entry) => ({
      name: entry.name.trim(),
      upstreamName: entry.upstreamName.trim(),
      order: entry.order,
    }))
    .sort((left, right) => left.order - right.order || left.name.localeCompare(right.name));
  return options.renumber === false
    ? normalized
    : normalized.map((entry, index) => ({ ...entry, order: (index + 1) * 100 }));
}

/**
 * Canonical content revision for current writers. Mapping, endpoint, key or
 * model-name edits advance this revision while the entity id stays stable.
 * Display-level metadata (entity name, labels, enabled, order, timestamps)
 * stays out of the revision; it is a content fingerprint, not an entity id.
 */
export function modelContentRevision(
  input: Pick<z.infer<typeof ModelConfigSchema>, "app" | "endpoint" | "key" | "model"> & {
    modelNames?: ModelNameEntry[];
    mappings?: ModelRequestMapping[];
    protocols?: ModelProtocol[];
  },
) {
  const app = ModelAppSchema.parse(input.app);
  const modelNames = normalizeModelNameEntries(input.modelNames, input.model);
  const mappings = normalizeModelRequestMappings(input.mappings);
  const protocols = input.protocols?.length ? input.protocols : defaultModelProtocols(app);
  const canonical = {
    algorithm: "model-content-revision-v1",
    app,
    endpoint: ModelConfigSchema.shape.endpoint.parse(input.endpoint),
    key: ModelConfigSchema.shape.key.parse(input.key),
    model: ModelConfigSchema.shape.model.parse(input.model),
    modelNames: modelNames.map((entry) => ({ name: entry.name, upstreamName: entry.upstreamName, order: entry.order })),
    protocols: [...new Set(protocols)].sort(),
    // Entities without request mappings keep the exact v0.0.34 canonical
    // payload (and therefore their existing revision) byte for byte.
    ...(mappings.length
      ? { mappings: mappings.map((entry) => ({ name: entry.name, upstreamName: entry.upstreamName, order: entry.order })) }
      : {}),
  };
  return `mdlr_${crypto.createHash("sha256").update(JSON.stringify(canonical)).digest("hex")}`;
}

export function isModelContentRevision(value: string) {
  return /^mdlr_[0-9a-f]{64}$/.test(value);
}

// Entity ids are opaque identities. Records mint a short time-ordered id
// (41 bits of milliseconds since the epoch plus 23 random bits: one complete
// 64-bit snowflake) and modelContentRevision is the current content revision. The
// payload encodes the whole 64-bit value as 13 lower-case Crockford base32
// symbols, ULID-style: Crockford never emits "=" padding, and the fixed width
// keeps ids lexicographically ordered by their millisecond prefix. The
// alphabet never mixes case because ids double as file names, Docker tags, and
// provider env var segments: folding an id to lower case or a DNS-safe
// character set must stay lossless. The random low bits replace the snowflake
// worker/sequence pair because control-plane and node-agent hosts share no
// worker registry; same-process bursts are deduplicated, and a cross-host
// collision needs two writers to draw the same 23 random bits in the same
// millisecond.
const ENTITY_ID_EPOCH_MS = Date.UTC(2026, 0, 1);
const ENTITY_ID_TIMESTAMP_BITS = 41n;
const ENTITY_ID_RANDOM_BITS = 23n;
// 5 bits per symbol: a full 64-bit value needs ceil(64 / 5) = 13 symbols.
const ENTITY_ID_PAYLOAD_LENGTH = 13;
// Crockford base32 without the ambiguous i/l/o/u, lower case only.
const ENTITY_ID_ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";
const MODEL_ENTITY_ID_PATTERN = new RegExp(`^mdl_[${ENTITY_ID_ALPHABET}]{${ENTITY_ID_PAYLOAD_LENGTH}}$`);

function encodeEntityIdPayload(value: bigint, length: number) {
  const digits: string[] = [];
  let current = value;
  while (current > 0n) {
    digits.unshift(ENTITY_ID_ALPHABET[Number(current % 32n)]);
    current /= 32n;
  }
  return `${"0".repeat(Math.max(0, length - digits.length))}${digits.join("")}`;
}

let mintedEntityIds: { timestamp: bigint; random: Set<bigint> } | undefined;

function drawEntityIdRandom(timestamp: bigint) {
  if (mintedEntityIds?.timestamp !== timestamp) mintedEntityIds = { timestamp, random: new Set() };
  for (;;) {
    const random = BigInt(crypto.randomBytes(3).readUIntBE(0, 3)) >> 1n;
    if (!mintedEntityIds.random.has(random)) {
      mintedEntityIds.random.add(random);
      return random;
    }
  }
}

/**
 * Mint the id for a new entity record, following the project-wide short id
 * scheme: `<prefix>_` plus a fixed-length lower-case base32 payload that
 * encodes one complete 64-bit snowflake whose high bits are the millisecond
 * timestamp, so ids sort by creation time and never depend on character case.
 */
export function createEntityId(prefix: string, now = Date.now()) {
  const timestamp = BigInt(Math.max(0, now - ENTITY_ID_EPOCH_MS)) & ((1n << ENTITY_ID_TIMESTAMP_BITS) - 1n);
  const random = drawEntityIdRandom(timestamp);
  return `${prefix}_${encodeEntityIdPayload((timestamp << ENTITY_ID_RANDOM_BITS) | random, ENTITY_ID_PAYLOAD_LENGTH)}`;
}

export function createModelEntityId(now = Date.now()) {
  return createEntityId("mdl", now);
}

/** True when an id is a minted model entity identity rather than a migrated legacy id. */
export function isModelEntityId(value: string) {
  return MODEL_ENTITY_ID_PATTERN.test(value);
}

/**
 * One-time rename target for a persisted id that predates entity identities
 * (a v0.0.34 content-hash id). The mapping is deterministic so the control
 * plane and every node holding a replica of the same legacy id converge on the
 * same entity id without coordinating, and stale references stay derivable
 * during the migration. This is not a mint point: new records always use
 * {@link createModelEntityId}, and nothing may derive fresh identities here.
 */
export function migratedModelEntityId(legacyId: string) {
  const digest = crypto.createHash("sha256").update(`task-handoff:model-entity-migration:v1:${legacyId}`).digest();
  return `mdl_${encodeEntityIdPayload(digest.readBigUInt64BE(0), ENTITY_ID_PAYLOAD_LENGTH)}`;
}

export const ImageOriginSchema = z.enum(["market", "custom"]);
export const MarketLifecycleStatusSchema = z.enum(["active", "deprecated", "yanked"]);

export const ImageCoverSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("builtin"),
    key: z.string().trim().min(1).max(120),
  }).strict(),
  z.object({
    kind: z.literal("remote"),
    url: z.string().trim().url().max(2048),
    mediaType: z.enum(["image/png", "image/jpeg", "image/webp"]).optional(),
    digest: DockerImageDigestSchema.optional(),
  }).strict(),
]);

export const DEFAULT_IMAGE_COVER = { kind: "builtin", key: "default-image-cover" } as const;

const ImageCapabilitiesSchema = z.array(z.string().trim().min(1).max(80)).default([]);
const ImageOptionalAppsSchema = z.array(z.string().trim().min(1).max(120)).default([]);
const LocalizedImageDescriptionsSchema = z.record(
  z.string().trim().min(2).max(35),
  z.string().trim().min(1).max(4096),
);

export const MarketImagePlatformArtifactSchema = z.object({
  os: z.string().trim().min(1).max(40),
  architecture: z.string().trim().min(1).max(40),
  digest: DockerImageDigestSchema.optional(),
  downloadSizeBytes: z.number().int().positive().optional(),
  unpackedSizeBytes: z.number().int().positive().optional(),
}).strict();

export const MarketImageTagSchema = z.object({
  name: z.string().trim().min(1).max(128).regex(DockerTagPattern),
  version: z.string().trim().min(1).max(160).optional(),
  reference: DockerImageReferenceSchema,
  manifestDigest: DockerImageDigestSchema.optional(),
  publishedAt: TimestampSchema.optional(),
  platforms: z.array(MarketImagePlatformArtifactSchema).default([]),
  status: MarketLifecycleStatusSchema.default("active"),
}).strict();

export const MarketImageSchema = z.object({
  id: IdSchema,
  publisher: z.string().trim().min(1).max(160),
  slug: z.string().trim().min(1).max(160),
  name: z.string().trim().min(1).max(160),
  description: z.string().trim().min(1).max(4096),
  localizedDescriptions: LocalizedImageDescriptionsSchema.optional(),
  cover: ImageCoverSchema.optional(),
  repository: z.string().trim().min(1).max(512),
  defaultTag: z.string().trim().min(1).max(128).regex(DockerTagPattern),
  tags: z.array(MarketImageTagSchema).min(1),
  capabilities: ImageCapabilitiesSchema,
  optionalApps: ImageOptionalAppsSchema,
  defaultEnv: StringRecordSchema,
  labels: LabelsSchema,
  status: MarketLifecycleStatusSchema.default("active"),
}).strict().superRefine((image, context) => {
  if (!image.tags.some((tag) => tag.name === image.defaultTag)) {
    context.addIssue({ code: "custom", path: ["defaultTag"], message: "Market defaultTag must identify one of the image tags." });
  }
});

export const MarketCatalogSnapshotSchema = z.object({
  protocolVersion: ProtocolVersionSchema,
  catalogId: IdSchema,
  revision: z.string().trim().min(1).max(240),
  source: z.enum(["embedded", "remote", "cache"]),
  generatedAt: TimestampSchema,
  expiresAt: TimestampSchema.optional(),
  items: z.array(MarketImageSchema),
}).strict();

export const MarketCatalogStatusSchema = z.object({
  source: z.enum(["embedded", "remote", "cache"]),
  state: z.enum(["ready", "refreshing", "stale", "failed"]),
  revision: z.string().trim().min(1).max(240),
  updatedAt: TimestampSchema,
  error: z.string().trim().max(4096).optional(),
}).strict();

export function sanitizeStoredMarketCatalogSnapshot(
  input: unknown,
  onWarning?: (warning: { itemId?: string; field: string }) => void,
) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return input;
  const source = input as Record<string, unknown>;
  const topLevelKeys = ["protocolVersion", "catalogId", "revision", "source", "generatedAt", "expiresAt", "items"];
  for (const key of Object.keys(source)) if (!topLevelKeys.includes(key)) onWarning?.({ field: key });
  const items = Array.isArray(source.items) ? source.items.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      onWarning?.({ field: "items" });
      return [];
    }
    const record = item as Record<string, unknown>;
    const itemKeys = ["id", "publisher", "slug", "name", "description", "localizedDescriptions", "cover", "repository", "defaultTag", "tags", "capabilities", "optionalApps", "defaultEnv", "labels", "status"];
    for (const key of Object.keys(record)) if (!itemKeys.includes(key)) onWarning?.({ itemId: typeof record.id === "string" ? record.id : undefined, field: key });
    const parsed = MarketImageSchema.safeParse(pickObjectFields(record, itemKeys));
    if (!parsed.success) {
      onWarning?.({ itemId: typeof record.id === "string" ? record.id : undefined, field: "invalid-record" });
      return [];
    }
    return [parsed.data];
  }) : source.items;
  return { ...(pickObjectFields(source, topLevelKeys) as Record<string, unknown>), items };
}

export const CustomImageProfileSchema = z.object({
  id: IdSchema,
  origin: z.literal("custom"),
  name: z.string().trim().min(1).max(160),
  description: z.string().trim().max(4096).optional(),
  localizedDescriptions: LocalizedImageDescriptionsSchema.optional(),
  cover: ImageCoverSchema.optional(),
  reference: DockerImageReferenceSchema,
  repository: z.string().trim().min(1).max(512),
  tag: z.string().trim().min(1).max(128).regex(DockerTagPattern).optional(),
  pullPolicy: z.literal("if-not-present").default("if-not-present"),
  capabilities: ImageCapabilitiesSchema,
  optionalApps: ImageOptionalAppsSchema,
  defaultEnv: StringRecordSchema,
  labels: LabelsSchema,
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
}).strict();

// Kept as a source-level alias while consumers move to the explicit Custom type.
export const ImageProfileSchema = CustomImageProfileSchema;

export const SelectableImageTagSchema = z.object({
  name: z.string().trim().min(1).max(128).regex(DockerTagPattern),
  version: z.string().trim().min(1).max(160).optional(),
  reference: DockerImageReferenceSchema,
  manifestDigest: DockerImageDigestSchema.optional(),
  status: MarketLifecycleStatusSchema,
}).strict();

export const SelectableImageSchema = z.object({
  id: IdSchema,
  origin: ImageOriginSchema,
  name: z.string().trim().min(1).max(160),
  description: z.string().trim().max(4096).optional(),
  localizedDescriptions: LocalizedImageDescriptionsSchema.optional(),
  cover: ImageCoverSchema,
  repository: z.string().trim().min(1).max(512),
  tag: z.string().trim().min(1).max(128).regex(DockerTagPattern).optional(),
  availableTags: z.array(SelectableImageTagSchema),
  reference: DockerImageReferenceSchema,
  digest: DockerImageDigestSchema.optional(),
  downloadSizeBytes: z.number().int().positive().optional(),
  unpackedSizeBytes: z.number().int().positive().optional(),
  capabilities: ImageCapabilitiesSchema,
  optionalApps: ImageOptionalAppsSchema,
  defaultEnv: StringRecordSchema,
  labels: LabelsSchema,
  readOnly: z.boolean(),
  lifecycleStatus: MarketLifecycleStatusSchema.optional(),
  market: z.object({
    catalogId: IdSchema,
    catalogRevision: z.string().trim().min(1).max(240),
    publisher: z.string().trim().min(1).max(160),
    version: z.string().trim().min(1).max(160).optional(),
  }).strict().optional(),
}).strict();

export const InstanceImageSnapshotSchema = z.object({
  id: IdSchema,
  origin: ImageOriginSchema,
  name: z.string().trim().min(1).max(160),
  description: z.string().trim().max(4096).optional(),
  localizedDescriptions: LocalizedImageDescriptionsSchema.optional(),
  cover: ImageCoverSchema.optional(),
  repository: z.string().trim().min(1).max(512),
  tag: z.string().trim().min(1).max(128).regex(DockerTagPattern).optional(),
  requestedReference: DockerImageReferenceSchema,
  resolvedDigest: DockerImageDigestSchema.optional(),
  resolvedReference: DockerImageReferenceSchema.optional(),
  downloadSizeBytes: z.number().int().positive().optional(),
  pullPolicy: z.literal("if-not-present").default("if-not-present"),
  capabilities: ImageCapabilitiesSchema,
  optionalApps: ImageOptionalAppsSchema,
  defaultEnv: StringRecordSchema,
  labels: LabelsSchema,
  market: z.object({
    catalogId: IdSchema,
    catalogRevision: z.string().trim().min(1).max(240),
    publisher: z.string().trim().min(1).max(160),
    version: z.string().trim().min(1).max(160).optional(),
  }).strict().optional(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
}).strict();

export const ImageProvisioningSchema = z.object({
  phase: z.enum(["checking-image", "pulling-image", "resolving-image", "ready", "failed"]),
  requestedReference: DockerImageReferenceSchema,
  generation: z.number().int().nonnegative().default(0),
  error: z.string().trim().max(4096).optional(),
  startedAt: TimestampSchema,
  updatedAt: TimestampSchema,
}).strict();

export const ImagePullTerminalEventType = {
  Output: "image.pull.terminal.output",
  Finished: "image.pull.terminal.finished",
  Progress: "image.pull.progress",
  Snapshot: "image.pull.snapshot",
} as const;

const ImagePullEventIdentitySchema = z.object({
  instanceId: IdSchema,
  generation: z.number().int().nonnegative(),
  requestedReference: DockerImageReferenceSchema,
  sequence: z.number().int().nonnegative(),
  observedAt: TimestampSchema,
}).strict();

export const ImagePullTerminalOutputSchema = ImagePullEventIdentitySchema.extend({
  data: z.string().min(1).max(65536),
  replay: z.boolean().optional(),
}).strict();

export const ImagePullTerminalFinishedSchema = ImagePullEventIdentitySchema.extend({
  outcome: z.enum(["succeeded", "failed"]),
}).strict();

export const ImagePullProgressSchema = ImagePullEventIdentitySchema.extend({
  status: z.enum(["connecting", "pulling", "extracting", "complete", "failed"]),
  layers: z.object({
    total: z.number().int().nonnegative(),
    completed: z.number().int().nonnegative(),
    downloaded: z.number().int().nonnegative(),
    downloading: z.number().int().nonnegative(),
    extracting: z.number().int().nonnegative(),
  }).strict(),
  bytes: z.object({
    current: z.number().finite().nonnegative(),
    total: z.number().finite().positive(),
  }).strict().optional(),
  percent: z.number().finite().min(0).max(100).optional(),
  message: z.string().trim().min(1).max(500),
  terminalTail: z.string().max(262144).optional(),
  terminalTruncated: z.boolean().optional(),
}).strict();

// Git workspace materialization is a workspace concern, so its authoritative
// state lives on the instance workspace record. The phases describe the
// provisioning script stages; the live terminal/progress flow is carried by the
// git.provisioning.* events below instead of being persisted.
export const GitWorkspaceProvisioningPhaseSchema = z.enum([
  "pending",
  "cloning",
  "checking-out",
  "submodules",
  "lfs",
  "finalizing",
  "ready",
  "failed",
]);

export const GitWorkspaceProvisioningStatusSchema = z.object({
  phase: GitWorkspaceProvisioningPhaseSchema,
  remoteUrl: z.string().trim().min(1).max(2048),
  generation: z.number().int().nonnegative().default(0),
  error: z.string().trim().max(4096).optional(),
  startedAt: TimestampSchema,
  updatedAt: TimestampSchema,
}).strict();

export const GitProvisioningTerminalEventType = {
  Output: "git.provisioning.terminal.output",
  Finished: "git.provisioning.terminal.finished",
  Progress: "git.provisioning.progress",
  Snapshot: "git.provisioning.snapshot",
} as const;

const GitProvisioningEventIdentitySchema = z.object({
  instanceId: IdSchema,
  generation: z.number().int().nonnegative(),
  remoteUrl: z.string().trim().min(1).max(2048),
  sequence: z.number().int().nonnegative(),
  observedAt: TimestampSchema,
}).strict();

export const GitProvisioningTerminalOutputSchema = GitProvisioningEventIdentitySchema.extend({
  data: z.string().min(1).max(65536),
  replay: z.boolean().optional(),
}).strict();

export const GitProvisioningTerminalFinishedSchema = GitProvisioningEventIdentitySchema.extend({
  outcome: z.enum(["succeeded", "failed"]),
}).strict();

export const GitProvisioningProgressSchema = GitProvisioningEventIdentitySchema.extend({
  status: z.enum(["connecting", "cloning", "checking-out", "submodules", "lfs", "finalizing", "complete", "failed"]),
  objects: z.object({
    received: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
  }).strict().optional(),
  bytes: z.object({
    current: z.number().finite().nonnegative(),
    total: z.number().finite().positive(),
  }).strict().optional(),
  percent: z.number().finite().min(0).max(100).optional(),
  message: z.string().trim().min(1).max(500),
  terminalTail: z.string().max(262144).optional(),
  terminalTruncated: z.boolean().optional(),
}).strict();

export function sanitizeStoredImageProfile(
  input: unknown,
  onWarning?: (warning: { imageId?: string; field: string }) => void,
) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return input;
  const source = input as Record<string, unknown>;
  const knownKeys = new Set(["id", "origin", "name", "description", "localizedDescriptions", "cover", "reference", "repository", "tag", "image", "registry", "pullPolicy", "capabilities", "optionalApps", "defaultEnv", "labels", "createdAt", "updatedAt"]);
  for (const key of Object.keys(source)) if (!knownKeys.has(key)) onWarning?.({ imageId: typeof source.id === "string" ? source.id : undefined, field: key });
  const imageId = typeof source.id === "string" ? source.id : undefined;
  const legacyReference = typeof source.image === "string" ? source.image : undefined;
  if (legacyReference !== undefined) onWarning?.({ imageId, field: "image" });
  if (Object.prototype.hasOwnProperty.call(source, "registry")) onWarning?.({ imageId, field: "registry" });
  let reference = typeof source.reference === "string" ? source.reference : legacyReference;
  if (reference) {
    try {
      reference = normalizeDockerImageReference(reference);
    } catch {
      if (!reference.includes("@") && reference.lastIndexOf(":") <= reference.lastIndexOf("/")) {
        try {
          reference = normalizeDockerImageReference(`${reference}:latest`);
          onWarning?.({ imageId, field: "reference:implicit-latest" });
        } catch {
          // Leave invalid historical values for record-level schema isolation.
        }
      }
    }
  }
  let parsedReference: ReturnType<typeof parseDockerImageReference> | undefined;
  try {
    parsedReference = reference ? parseDockerImageReference(reference) : undefined;
  } catch {
    // Leave invalid historical values for record-level schema isolation.
  }
  return {
    id: source.id,
    origin: "custom",
    name: source.name,
    description: source.description,
    localizedDescriptions: source.localizedDescriptions,
    cover: pickObjectFields(source.cover, ["kind", "key", "url", "mediaType", "digest"]),
    reference: parsedReference?.reference ?? reference,
    repository: parsedReference?.repository ?? source.repository,
    tag: parsedReference?.tag ?? source.tag,
    pullPolicy: source.pullPolicy ?? "if-not-present",
    capabilities: source.capabilities,
    optionalApps: source.optionalApps,
    defaultEnv: source.defaultEnv,
    labels: source.labels,
    createdAt: source.createdAt,
    updatedAt: source.updatedAt,
  };
}

function sanitizeStoredInstanceImageSnapshot(
  input: unknown,
  imageId: unknown,
  onWarning?: (warning: { instanceId?: string; field: string }) => void,
  instanceId?: string,
) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return input;
  const source = input as Record<string, unknown>;
  const sanitizedProfile = sanitizeStoredImageProfile(source) as Record<string, unknown>;
  const { reference: profileReference, ...profile } = sanitizedProfile;
  const requestedReference = source.requestedReference ?? profileReference;
  let parsedReference: ReturnType<typeof parseDockerImageReference> | undefined;
  try {
    parsedReference = typeof requestedReference === "string" ? parseDockerImageReference(requestedReference) : undefined;
  } catch {
    // Leave invalid historical values for record-level schema isolation.
  }
  const legacyMarketIds: Record<string, string> = {
    img_default: "market_taskhandoff_browser",
    img_codex: "market_taskhandoff_codex",
    img_ai: "market_taskhandoff_ai",
  };
  const rawId = typeof source.id === "string" ? source.id : typeof imageId === "string" ? imageId : undefined;
  const origin = source.origin === "market" || (rawId && legacyMarketIds[rawId]) ? "market" : "custom";
  if (source.image !== undefined || source.reference !== undefined) onWarning?.({ instanceId, field: "imageSnapshot.reference" });
  return {
    ...profile,
    id: rawId && legacyMarketIds[rawId] ? legacyMarketIds[rawId] : rawId,
    origin,
    repository: parsedReference?.repository ?? source.repository,
    tag: parsedReference?.tag ?? source.tag,
    requestedReference: parsedReference?.reference ?? requestedReference,
    resolvedDigest: source.resolvedDigest,
    resolvedReference: source.resolvedReference,
    downloadSizeBytes: source.downloadSizeBytes,
    market: origin === "market"
      ? pickObjectFields(source.market, ["catalogId", "catalogRevision", "publisher", "version"]) ?? {
          catalogId: "task_handoff_embedded",
          catalogRevision: "legacy",
          publisher: "task-handoff",
        }
      : undefined,
  };
}

export const NodeConnectionPathSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("direct") }).strict(),
  z.object({
    kind: z.literal("control-plane-proxy"),
    proxyId: IdSchema,
    proxyBindingId: IdSchema,
    targetNodeId: IdSchema,
  }).strict(),
]);

/** Ephemeral public diagnostics for the control-plane/node-agent connection. */
export const NodeConnectionDiagnosticsSchema = z.object({
  // Compatibility for v0.0.21: older Control Plane responses omit this
  // additive runtime projection, so every consumer must accept its absence.
  pingRttMs: z.number().nonnegative().optional(),
  pingRttP95Ms: z.number().nonnegative().optional(),
  consecutiveReconnects: z.number().int().nonnegative(),
  nextRetryAt: TimestampSchema.optional(),
}).strict();

export type NodeConnectionDiagnostics = z.infer<typeof NodeConnectionDiagnosticsSchema>;

export const NodeJoinedEventSchema = z.object({
  nodeId: IdSchema,
  // Compatibility for v0.0.21: events emitted by older control planes omit
  // inviteId. Consumers still refresh topology but cannot complete a wizard.
  inviteId: IdSchema.optional(),
}).strict();

export const NodeJoinInviteStatusSchema = z.discriminatedUnion("status", [
  z.object({
    id: IdSchema,
    status: z.literal("pending"),
  }).strict(),
  z.object({
    id: IdSchema,
    status: z.literal("completed"),
    nodeId: IdSchema,
  }).strict(),
]);

export const NodeControlPlaneProxyStateSchema = z.object({
  reachability: z.enum(["unknown", "reachable", "unreachable"]),
  bindingStatus: z.enum(["unknown", "active", "revoked"]),
  bindingRevision: z.number().int().positive().optional(),
  streamId: z.string().trim().min(1).max(160).optional(),
  revision: z.number().int().nonnegative().optional(),
  observedAt: TimestampSchema.optional(),
  target: ProxyTargetStateSchema.optional(),
  lastError: ControlPlaneProxyErrorSchema.optional(),
  updatedAt: TimestampSchema,
}).strict();

export const NodeSchema = z
  .object({
    id: IdSchema,
    name: z.string().trim().min(1).max(160),
    connectionMode: z.enum(["local-ipc", "local-loopback", "direct-http", "reverse-wss", "control-plane-proxy"]).default("direct-http"),
    connectionPath: NodeConnectionPathSchema.default({ kind: "direct" }),
    connectionEnabled: z.boolean().default(true),
    auth: z
      .object({
        mode: z.enum(["local-static-key", "paired-hmac", "proxy-binding"]).default("local-static-key"),
        keyId: IdSchema.optional(),
        secret: z.string().trim().max(4096).optional(),
        pairedAt: TimestampSchema.optional(),
        pairing: z
          .object({
            status: z.enum(["pending", "paired", "expired"]).default("pending"),
            joinToken: z.string().trim().max(4096).optional(),
            expiresAt: TimestampSchema.optional(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .default({ mode: "local-static-key" }),
    endpoint: z.string().trim().max(2048).optional(),
    controlEndpoint: z.string().trim().max(2048).optional(),
    containerEndpoint: z.string().trim().max(2048).optional(),
    publicWebBase: z.string().trim().max(2048).optional(),
    status: z.enum(["unknown", "online", "offline", "degraded"]).default("unknown"),
    health: z.enum(["unknown", "ok", "degraded", "failed"]).default("unknown"),
    capabilities: z.record(z.string(), z.unknown()).default({}),
    proxyState: NodeControlPlaneProxyStateSchema.optional(),
    appInventory: InstanceAppInventorySchema.optional(),
    labels: LabelsSchema,
    lastSeenAt: TimestampSchema.optional(),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
  })
  .strict()
  .superRefine((node, context) => {
    if (node.connectionPath.kind === "control-plane-proxy" && node.connectionMode !== "control-plane-proxy") {
      context.addIssue({
        code: "custom",
        path: ["connectionPath"],
        message: "Control-plane proxy paths require control-plane-proxy connection mode.",
      });
    }
    if (node.connectionMode === "control-plane-proxy" && node.connectionPath.kind !== "control-plane-proxy") {
      context.addIssue({
        code: "custom",
        path: ["connectionPath"],
        message: "Control-plane proxy nodes require a control-plane-proxy connection path.",
      });
    }
  });

/** Minimal public projection for converging one node's ephemeral connection state. */
export const NodeStateProjectionEventSchema = z.object({
  nodeId: IdSchema,
  status: z.enum(["unknown", "online", "offline", "degraded"]),
  health: z.enum(["unknown", "ok", "degraded", "failed"]),
  lastSeenAt: TimestampSchema.nullable(),
  connectionPhase: z.enum(["connecting", "handshaking", "healthy", "reconnecting", "suspect", "offline"]).nullable(),
  connectionDiagnostics: NodeConnectionDiagnosticsSchema.nullable(),
  proxyState: NodeControlPlaneProxyStateSchema.nullable(),
}).strict();

export function sanitizeStoredNode(input: unknown, onWarning?: (warning: { field: string }) => void) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return input;
  const source = input as Record<string, unknown>;
  const known = new Set([
    "id", "name", "connectionMode", "connectionPath", "connectionEnabled", "auth", "endpoint", "controlEndpoint",
    "containerEndpoint", "publicWebBase", "status", "health", "capabilities", "proxyState", "appInventory",
    "labels", "lastSeenAt", "createdAt", "updatedAt",
  ]);
  for (const field of Object.keys(source)) if (!known.has(field)) onWarning?.({ field });

  const auth = source.auth && typeof source.auth === "object" && !Array.isArray(source.auth)
    ? pickObjectFields(source.auth, ["mode", "keyId", "secret", "pairedAt", "pairing"])
    : source.auth;
  if (auth && typeof auth === "object" && "pairing" in auth) {
    auth.pairing = pickObjectFields(auth.pairing, ["status", "joinToken", "expiresAt"]);
  }
  const connectionPath = source.connectionPath && typeof source.connectionPath === "object" && !Array.isArray(source.connectionPath)
    ? (source.connectionPath as Record<string, unknown>).kind === "control-plane-proxy"
      ? pickObjectFields(source.connectionPath, ["kind", "proxyId", "proxyBindingId", "targetNodeId"])
      : pickObjectFields(source.connectionPath, ["kind"])
    : { kind: "direct" };
  const proxyState = source.proxyState && typeof source.proxyState === "object" && !Array.isArray(source.proxyState)
    ? pickObjectFields(source.proxyState, [
        "reachability", "bindingStatus", "bindingRevision", "streamId", "revision", "observedAt", "target", "lastError", "updatedAt",
      ])
    : source.proxyState;
  if (proxyState && typeof proxyState === "object") {
    const state = proxyState as Record<string, unknown>;
    state.target = pickObjectFields(state.target, ["id", "name", "status", "health", "lastSeenAt", "capabilities"]);
    state.lastError = pickObjectFields(state.lastError, ["code", "message", "retryable", "details"]);
  }
  return {
    ...Object.fromEntries(Object.entries(source).filter(([field]) => known.has(field))),
    auth,
    connectionPath,
    proxyState,
  };
}

export const NodeRuntimeSchema = z
  .object({
    id: IdSchema,
    nodeId: IdSchema,
    name: z.string().trim().min(1).max(160),
    type: z.enum(["docker", "kubernetes", "local"]),
    status: z.enum(["unknown", "online", "offline", "degraded"]).default("unknown"),
    accessStrategy: z.enum(["node-proxy", "direct-port", "kubernetes-ingress", "kubernetes-port-forward"]).default("node-proxy"),
    capabilities: z.record(z.string(), z.unknown()).default({}),
    labels: LabelsSchema,
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
  })
  .strict();

export const InstanceResourceMetricsSchema = z.object({
  instanceId: IdSchema,
  runtimeKind: z.literal("docker"),
  state: z.enum(["pending", "available", "stopped", "unavailable"]),
  sampledAt: TimestampSchema,
  cpu: z.object({ usagePercent: z.number().nonnegative() }).strict().optional(),
  memory: z.object({
    usageBytes: z.number().nonnegative(),
    limitBytes: z.number().nonnegative().optional(),
    usagePercent: z.number().nonnegative().optional(),
  }).strict().optional(),
  network: z.object({
    rxBytes: z.number().nonnegative(),
    txBytes: z.number().nonnegative(),
  }).strict().optional(),
  blockIo: z.object({
    readBytes: z.number().nonnegative(),
    writeBytes: z.number().nonnegative(),
  }).strict().optional(),
  pids: z.number().int().nonnegative().optional(),
  error: z.string().trim().max(2048).optional(),
}).strict();

export const InstanceResourceMetricsEventType = {
  Snapshot: "instance.metrics.snapshot",
} as const;

export const NodeAgentEventTransportHealthSchema = z.object({
  status: z.enum(["healthy", "congested", "recovering"]),
  activeOutputs: z.number().int().nonnegative(),
  bufferedBytes: z.number().int().nonnegative(),
  peakBufferedBytes: z.number().int().nonnegative(),
  coalescedEvents: z.number().int().nonnegative(),
  // Compatibility for v0.0.23: older node agents do not report payload limits.
  oversizedEvents: z.number().int().nonnegative().optional(),
  peakEventBytes: z.number().int().nonnegative().optional(),
  congestedSince: TimestampSchema.optional(),
  lastCongestedAt: TimestampSchema.optional(),
}).strip();
export type NodeAgentEventTransportHealth = z.infer<typeof NodeAgentEventTransportHealthSchema>;

export const NodeAgentHealthSchema = z
  .object({
    ok: z.boolean().optional(),
    role: z.string().optional(),
    nodeId: IdSchema.optional(),
    // Additive health field: absent on node-agents before v0.0.38. The control
    // plane uses it only as the node's default display name when no name was
    // entered; a stored name (typed or renamed) always wins over it.
    hostname: z.string().trim().min(1).max(255).optional(),
    platform: FinalComputerPlatformSchema.optional(),
    arch: FinalComputerArchSchema.optional(),
    protocolVersion: ProtocolVersionSchema.optional(),
    capabilities: NodeAgentCapabilitiesSchema.optional(),
    build: BuildInfoSchema.strip().optional(),
    process: z.object({
      pid: z.number().int().positive(),
      startIdentity: z.string().trim().min(1).optional(),
    }).strip().optional(),
    listener: z.object({
      host: z.string().trim().min(1),
      port: z.number().int().min(1).max(65535),
    }).strip().optional(),
    instanceProxy: z.object({
      requests: z.number().int().nonnegative(),
      active: z.number().int().nonnegative(),
      completed: z.number().int().nonnegative(),
      aborted: z.number().int().nonnegative(),
      limitRejected: z.number().int().nonnegative(),
      responseBytes: z.number().nonnegative(),
      totalDurationMs: z.number().nonnegative(),
      maxResponseBytes: z.number().int().nonnegative(),
    }).partial().strip().optional(),
    // Additive health diagnostic: absent on node-agents before v0.0.25.
    eventTransport: NodeAgentEventTransportHealthSchema.optional(),
    serverTime: TimestampSchema.optional(),
  })
  .strip();

export const NodeAgentExternalListenerConfigSchema = z
  .object({
    bindScope: z.enum(["loopback", "all-ipv4"]),
    port: z.number().int().min(1).max(65535),
  })
  .strict();

export const NodeAgentExternalListenerSchema = NodeAgentExternalListenerConfigSchema.extend({
  host: z.enum(["127.0.0.1", "0.0.0.0"]),
  status: z.enum(["listening", "error"]),
  source: z.enum(["bootstrap", "persisted"]),
  error: z.string().trim().max(2048).optional(),
}).strict();

export const UpdateNodeAgentExternalListenerSchema = NodeAgentExternalListenerConfigSchema;

/**
 * Node-level model relay switch persisted in runtime settings. Missing or
 * malformed stored values normalize to disabled; only an explicit boolean
 * enables the relay data plane. The additive `unknownModelPolicy` defaults to
 * forwarding unmatched names verbatim when absent or malformed.
 */
export const NodeAgentModelRelayUnknownModelPolicySchema = z.enum(["passthrough", "reject"]);

export const NodeAgentModelRelayConfigSchema = z.object({
  enabled: z.boolean(),
  // Additive: a request model that matches neither declared names nor request
  // mappings is forwarded verbatim when "passthrough" (the default) and fails
  // closed with MODEL_RELAY_UNKNOWN_MODEL_NAME when "reject".
  unknownModelPolicy: NodeAgentModelRelayUnknownModelPolicySchema.optional(),
}).strict();

/** Effective node-agent response consumed by the control panel. */
export const NodeAgentModelRelaySchema = z.object({
  enabled: z.boolean(),
  // Optional on the wire so a node-agent that predates this setting still
  // parses; writers must gate the field on the relay capability.
  unknownModelPolicy: NodeAgentModelRelayUnknownModelPolicySchema.optional(),
  // "default" means the switch was never persisted and relay stays off.
  source: z.enum(["default", "persisted"]),
}).strip();

/** Strict write model for the settings PATCH route. */
export const UpdateNodeAgentModelRelaySchema = NodeAgentModelRelayConfigSchema;

export function normalizeNodeAgentModelRelaySettings(input: unknown): z.infer<typeof NodeAgentModelRelaySchema> {
  const source = input && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : {};
  return {
    enabled: source.enabled === true,
    unknownModelPolicy: source.unknownModelPolicy === "reject" ? "reject" : "passthrough",
    source: source.source === "persisted" ? "persisted" : "default",
  };
}

export function parseNodeAgentModelRelaySettings(input: unknown) {
  return NodeAgentModelRelaySchema.parse(normalizeNodeAgentModelRelaySettings(input));
}

export const NodeAgentPairingInviteResponseSchema = z
  .object({
    nodeId: IdSchema,
    joinToken: z.string().trim().min(1),
    expiresAt: TimestampSchema,
  })
  .passthrough();

export const NodeAgentPairingCompleteResultSchema = z.object({
  nodeId: IdSchema,
  keyId: IdSchema,
  secret: z.string().regex(/^[A-Za-z0-9_-]{32,128}$/),
  pairedAt: TimestampSchema,
}).strict();

export const NodeAgentControlPlanePairingSchema = z
  .object({
    id: IdSchema,
    keyId: IdSchema,
    name: z.string().trim().min(1).max(160).optional(),
    pairedAt: TimestampSchema,
    updatedAt: TimestampSchema,
    current: z.boolean(),
  })
  .passthrough();

export const NodeAgentPairingSelfRevokeResultSchema = z.object({
  keyId: IdSchema,
  revoked: z.literal(true),
  revokedAt: TimestampSchema,
}).strict();

export const NodeAgentControlPlaneConnectionSchema = z
  .object({
    id: IdSchema,
    pairingKeyId: IdSchema,
    url: z.string().trim().min(1).max(2048),
    name: z.string().trim().min(1).max(160).optional(),
    enabled: z.boolean(),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
    status: z.enum(["disabled", "connecting", "connected", "reconnecting", "failed"]),
    // Compatibility for v0.0.21: connection diagnostics are additive because
    // older node agents omit them and older control planes ignore them.
    pingRttMs: z.number().nonnegative().optional(),
    pingRttP95Ms: z.number().nonnegative().optional(),
    consecutiveReconnects: z.number().int().nonnegative().optional(),
    nextRetryAt: TimestampSchema.optional(),
    lastConnectedAt: TimestampSchema.optional(),
    lastDisconnectedAt: TimestampSchema.optional(),
    error: z.string().optional(),
  })
  .passthrough();

export const NodeAgentControlPlaneConnectionCreateResultSchema = z
  .object({
    pairing: NodeAgentControlPlanePairingSchema,
    connection: z
      .object({
        id: IdSchema,
        pairingKeyId: IdSchema,
        url: z.string().trim().min(1).max(2048),
        name: z.string().trim().min(1).max(160).optional(),
        enabled: z.boolean(),
        createdAt: TimestampSchema,
        updatedAt: TimestampSchema,
      })
      .passthrough(),
    tunnel: z
      .object({
        status: z.enum(["disabled", "saved", "connecting", "connected", "failed"]),
        error: z.string().trim().max(2048).optional(),
      })
      .passthrough(),
  })
  .passthrough();

export const NodeAgentDeleteResponseSchema = z
  .object({
    deleted: z.boolean().optional(),
  })
  .passthrough();

export const LocalDockerImageSchema = z
  .object({
    repository: z.string().trim().optional(),
    tag: z.string().trim().optional(),
    id: z.string().trim(),
    createdSince: z.string().trim().optional(),
    size: z.string().trim().optional(),
    sizeBytes: z.number().int().nonnegative().optional(),
    reference: z.string().trim().min(1),
    repoDigests: z.array(z.string().trim().min(1).max(512)).default([]),
  })
  .passthrough();

export const NodeImageAvailabilitySchema = z.object({
  image: SelectableImageSchema,
  status: z.enum(["available", "pull-required", "unknown"]),
  localImage: LocalDockerImageSchema.optional(),
  localSizeBytes: z.number().int().nonnegative().optional(),
  downloadSizeBytes: z.number().int().positive().optional(),
  unpackedSizeBytes: z.number().int().positive().optional(),
  error: z.string().trim().max(2048).optional(),
}).strict();

export type NodeFolderTreeEntry = {
  name: string;
  path: string;
  children: NodeFolderTreeEntry[];
};

export const NodeFolderTreeEntrySchema: z.ZodType<NodeFolderTreeEntry> = z.lazy(() => z
  .object({
    name: z.string().trim().min(1),
    path: z.string().trim().min(1).max(4096),
    children: z.array(NodeFolderTreeEntrySchema),
  })
  .passthrough());

export const NodeFolderPlaceSchema = z.object({
  kind: z.enum(["home", "root"]),
  name: z.string().trim().min(1),
  path: z.string().trim().min(1).max(4096),
}).passthrough();

export type NodeFolderPlace = z.infer<typeof NodeFolderPlaceSchema>;

export const NodeAgentInstanceProxyRawResponseSchema = z
  .object({
    status: z.number().int().min(100).max(599).optional(),
    headers: z.record(z.string(), z.string()).optional(),
    bodyBase64: z.string().optional(),
  })
  .passthrough();

export const InstanceTargetSchema = z
  .object({
    strategy: z.enum(["node-proxy", "direct-port", "kubernetes-ingress", "kubernetes-port-forward"]).default("node-proxy"),
    web: z.string().trim().max(2048).optional(),
    api: z.string().trim().max(2048).optional(),
    vnc: z.string().trim().max(2048).optional(),
    tty: z.string().trim().max(2048).optional(),
    logs: z.string().trim().max(2048).optional(),
    status: z.enum(["unknown", "reachable", "endpoint-unreachable"]).default("unknown"),
  })
  .strict();

// Compatibility for v0.0.21: controlled instances used to report the node-owned
// runtime target. Keep accepting that wire shape during the N-1 window; the
// node-agent report state transition deliberately discards every field. Runtime
// adapters are the sole authority for instance endpoints.
const LegacyControlledInstanceReportedTargetSchema = z
  .object({ ...InstanceTargetSchema.shape })
  .strict();

export const InstanceAccessSchema = z
  .object({
    strategy: z.enum(["control-plane-proxy", "direct-port", "node-proxy", "kubernetes-ingress", "kubernetes-port-forward"]).default("control-plane-proxy"),
    web: z.string().trim().max(2048).optional(),
    api: z.string().trim().max(2048).optional(),
    ws: z.string().trim().max(2048).optional(),
    status: z.enum(["unknown", "reachable", "endpoint-unreachable"]).default("unknown"),
  })
  .strict()
  .default({ strategy: "control-plane-proxy", status: "unknown" });

export const WorkspaceStatusSchema = z
  .object({
    mode: z.enum(["local-bind", "git-clone", "empty-volume", "persistent-volume"]).optional(),
    status: z.enum(["unknown", "pending", "ready", "failed"]).default("unknown"),
    path: z.string().trim().max(4096).optional(),
    resolvedCommit: z.string().trim().max(120).optional(),
    error: z.string().trim().max(2048).optional(),
    // Additive workspace materialization state. Older readers keep accepting the
    // workspace record and simply ignore unknown keys, so node agents can report
    // Git provisioning progress without a protocol-version gate.
    gitProvisioning: GitWorkspaceProvisioningStatusSchema.optional(),
  })
  .passthrough();

export const ControlledInstanceSchema = z
  .object({
    id: IdSchema,
    name: z.string().trim().min(1).max(160),
    projectId: IdSchema.optional(),
    source: ProjectSourceSchema,
    sourceSnapshot: z.record(z.string(), z.unknown()).default({}),
    modelSelection: ModelSelectionSchema,
    nodeId: IdSchema,
    runtimeId: IdSchema,
    imageSelection: ImageSelectionSchema.optional(),
    environmentSource: EnvironmentSourceSchema.optional(),
    environmentTemplateOrigin: EnvironmentTemplateOriginSchema.optional(),
    imageSnapshot: InstanceImageSnapshotSchema.optional(),
    imageProvisioning: ImageProvisioningSchema.optional(),
    stateRevision: z.number().int().min(0).default(0),
    processIncarnationId: z.string().trim().min(1).max(120).optional(),
    status: z.enum(["created", "provisioning", "starting", "registering", "registered", "running", "stopping", "stopped", "deleting", "failed", "unhealthy"]).default("created"),
    health: z.enum(["unknown", "ok", "degraded", "failed"]).default("unknown"),
    connectionStatus: z.enum(["unknown", "online", "offline", "endpoint-unreachable"]).default("unknown"),
    agentStatus: z.enum(["unknown", "online", "offline"]).default("unknown"),
    targetStatus: z.enum(["unknown", "reachable", "endpoint-unreachable"]).default("unknown"),
    uiAccessStatus: z.enum(["unknown", "reachable", "endpoint-unreachable"]).default("unknown"),
    controlMode: z.enum(["standalone", "controlled"]).default("controlled"),
    protocolVersion: ProtocolVersionSchema.optional(),
    instanceVersion: z.string().trim().max(80).optional(),
    build: BuildInfoSchema.optional(),
    runtimeVersion: RuntimeVersionStateSchema.optional(),
    ready: z.boolean().default(false),
    capabilities: ControlledInstanceCapabilitiesSchema.default(defaultControlledInstanceCapabilities),
    appInventory: InstanceAppInventorySchema.optional(),
    config: z
      .object({
        autoImportAgentConfigs: z.boolean().default(true),
        codexConfigEnabled: z.boolean().default(true),
        codexHomeMode: z.enum(["default", "taskhandoff"]).default("taskhandoff"),
        defaultCodexPermissionMode: AiSessionPermissionModeSchema.default("ask"),
        // Compatibility for v0.0.28: absent settings preserve Codex defaults.
        codexSettings: CodexInstanceSettingsSchema.optional(),
        aiSessionHistoryLimit: z.number().int().min(1).max(AI_SESSION_HISTORY_MAX_LIMIT).default(AI_SESSION_HISTORY_DEFAULT_LIMIT),
        aiSessionAttachmentRetentionDays: z.number().int().min(0).max(AI_SESSION_ATTACHMENT_RETENTION_MAX_DAYS).default(AI_SESSION_ATTACHMENT_RETENTION_DEFAULT_DAYS),
        aiSessionMaxFileAttachmentBytes: z.number().int().positive().max(AI_SESSION_MAX_CONFIGURABLE_FILE_ATTACHMENT_BYTES).default(AI_SESSION_DEFAULT_MAX_FILE_ATTACHMENT_BYTES),
      })
      .strict()
      .default({ autoImportAgentConfigs: true, codexConfigEnabled: true, codexHomeMode: "taskhandoff", defaultCodexPermissionMode: "ask", aiSessionHistoryLimit: AI_SESSION_HISTORY_DEFAULT_LIMIT, aiSessionAttachmentRetentionDays: AI_SESSION_ATTACHMENT_RETENTION_DEFAULT_DAYS, aiSessionMaxFileAttachmentBytes: AI_SESSION_DEFAULT_MAX_FILE_ATTACHMENT_BYTES }),
    workspace: WorkspaceStatusSchema.default({ status: "unknown" }),
    target: InstanceTargetSchema.default({ strategy: "direct-port", status: "unknown" }),
    access: InstanceAccessSchema,
    apps: z
      .object({
        runningCount: z.number().int().min(0).default(0),
        problemCount: z.number().int().min(0).default(0),
        updatedAt: TimestampSchema.optional(),
        revision: z.number().int().min(0).optional(),
      })
      .strict()
      .default({ runningCount: 0, problemCount: 0 }),
    aiSessions: AiSessionsSnapshotSchema.default(() => ({
      runningCount: 0,
      waitingCount: 0,
      staleCount: 0,
      sessions: [],
      updatedAt: new Date().toISOString(),
    })),
    triggers: z
      .object({
        enabledCount: z.number().int().min(0).default(0),
        runningCount: z.number().int().min(0).default(0),
        errorCount: z.number().int().min(0).default(0),
        configs: z.array(z.object({
          configHash: z.string().trim().min(1),
          config: TriggerConfigSchema,
          deployments: z.array(TriggerDeploymentSchema).default([]),
          runtime: z.array(TriggerRuntimeStateSchema).default([]),
        }).strict()).default([]),
        recentRuns: z.array(TriggerRunSchema).default([]),
      })
      .strict()
      .optional(),
    runtime: z
      .object({
        kind: z.string().trim().max(80).optional(),
        containerName: z.string().trim().max(240).optional(),
        containerId: z.string().trim().max(240).optional(),
        workspacePath: z.string().trim().max(4096).optional(),
        pid: z.number().int().positive().optional(),
        port: z.number().int().positive().max(65535).optional(),
        labels: z.record(z.string(), z.string()).default({}),
      })
      .strict()
      .default({ labels: {} }),
    registrationToken: z.string().trim().min(1).max(240).optional(),
    lastHeartbeatAt: TimestampSchema.optional(),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
  })
  .strict();

// 公开 API：POST /api/controlled-instances 请求体（control plane 边界）。
export const InstanceConfigInputSchema = z.object({
  autoImportAgentConfigs: z.boolean().optional(),
  codexConfigEnabled: z.boolean().optional(),
  codexHomeMode: z.enum(["default", "taskhandoff"]).optional(),
  defaultCodexPermissionMode: AiSessionPermissionModeSchema.optional(),
  codexSettings: CodexInstanceSettingsSchema.optional(),
  aiSessionHistoryLimit: z.number().int().min(1).max(AI_SESSION_HISTORY_MAX_LIMIT).optional(),
  aiSessionAttachmentRetentionDays: z.number().int().min(0).max(AI_SESSION_ATTACHMENT_RETENTION_MAX_DAYS).optional(),
  aiSessionMaxFileAttachmentBytes: z.number().int().positive().max(AI_SESSION_MAX_CONFIGURABLE_FILE_ATTACHMENT_BYTES).optional(),
}).strict();

// 公开 API：PATCH /api/controlled-instances/:id 请求体（control plane 边界）。
export const UpdateInstanceInputSchema = z.object({
  name: ControlledInstanceSchema.shape.name.optional(),
  config: InstanceConfigInputSchema.optional(),
  modelSelection: ControlledInstanceSchema.shape.modelSelection.unwrap().optional(),
}).strict();

export const InstanceCreateInputSchema = z.object({
  id: ControlledInstanceSchema.shape.id.optional(),
  name: ControlledInstanceSchema.shape.name.optional(),
  projectId: ControlledInstanceSchema.shape.projectId,
  source: ProjectSourceSchema.optional(),
  sourceSnapshot: z.record(z.string(), z.unknown()).optional(),
  nodeId: ControlledInstanceSchema.shape.nodeId.optional(),
  runtimeId: ControlledInstanceSchema.shape.runtimeId.optional(),
  environmentSource: EnvironmentSourceSchema.optional(),
  imageSelection: ControlledInstanceSchema.shape.imageSelection,
  config: InstanceConfigInputSchema.optional(),
  modelSelection: ControlledInstanceSchema.shape.modelSelection.optional(),
  gitCredentialRetention: GitCredentialRetentionSchema.optional(),
  start: z.boolean().default(false),
}).strict().superRefine((input, context) => {
  if (input.environmentSource && input.imageSelection) {
    context.addIssue({ code: "custom", path: ["environmentSource"], message: "environmentSource and imageSelection are mutually exclusive." });
  }
  if (input.gitCredentialRetention && input.source?.type === "local-folder") {
    context.addIssue({ code: "custom", path: ["gitCredentialRetention"], message: "Git credential retention requires a Git source." });
  }
});

export const InstanceCreateStartOutcomeSchema = z.object({
  status: z.enum(["not-requested", "started", "failed"]),
  error: z.object({
    code: z.string().trim().min(1).max(120),
    message: z.string().trim().min(1).max(2048),
  }).strict().optional(),
}).strict();

// registrationToken 是实例向 node-agent 注册的凭证，只走服务端协作链路，不进公开客户端输出模型。
export const InstanceCreateResultSchema = z.object({
  ...ControlledInstanceSchema.omit({ registrationToken: true }).shape,
  startOutcome: InstanceCreateStartOutcomeSchema,
}).strict();

const NodeAgentInstanceLifecycleResultWireSchema = z.union([
  ControlledInstanceSchema.transform((instance) => ({ instance, gitWorkspaceProvisioningOperationId: undefined })),
  z.object({
    instance: ControlledInstanceSchema,
    gitWorkspaceProvisioningOperationId: IdSchema.optional(),
  }).strict(),
]);

export const NodeAgentInstanceLifecycleResultSchema = z.preprocess((input) => {
  if (!input || typeof input !== "object" || Array.isArray(input)) return input;
  const source = input as Record<string, unknown>;
  // Compatibility for v0.0.21 bare instance responses, while allowing independently
  // upgraded node agents to add fields to the lifecycle response and instance snapshot.
  if (source.instance && typeof source.instance === "object" && !Array.isArray(source.instance)) {
    return {
      instance: sanitizeStoredControlledInstance(source.instance),
      ...(typeof source.gitWorkspaceProvisioningOperationId === "string"
        ? { gitWorkspaceProvisioningOperationId: source.gitWorkspaceProvisioningOperationId }
        : {}),
    };
  }
  return sanitizeStoredControlledInstance(source);
}, NodeAgentInstanceLifecycleResultWireSchema);

export const InstanceLifecycleEventType = {
  Snapshot: "instance.lifecycle.snapshot",
} as const;

export const InstanceLifecycleSnapshotSchema = z.object({
  instanceId: ControlledInstanceSchema.shape.id,
  revision: z.number().int().min(0),
  updatedAt: TimestampSchema,
  status: ControlledInstanceSchema.shape.status.unwrap(),
  health: ControlledInstanceSchema.shape.health.unwrap(),
  connectionStatus: ControlledInstanceSchema.shape.connectionStatus.unwrap(),
  accessStatus: z.enum(["reachable", "endpoint-unreachable"]),
  imageProvisioning: ImageProvisioningSchema.optional(),
  workspace: WorkspaceStatusSchema,
  runtime: ControlledInstanceSchema.shape.runtime.unwrap(),
  runtimeVersion: RuntimeVersionStateSchema.optional(),
  ready: z.boolean(),
  lastHeartbeatAt: TimestampSchema.optional(),
}).strict();

export type InstanceLifecycleSnapshot = z.infer<typeof InstanceLifecycleSnapshotSchema>;

export function parseStoredControlledInstance(input: unknown, onWarning?: (warning: { instanceId?: string; field: string }) => void) {
  return ControlledInstanceSchema.parse(sanitizeStoredControlledInstance(input, onWarning));
}

export function safeParseStoredControlledInstance(input: unknown, onWarning?: (warning: { instanceId?: string; field: string }) => void) {
  return ControlledInstanceSchema.safeParse(sanitizeStoredControlledInstance(input, onWarning));
}

export function sanitizeStoredControlledInstance(
  input: unknown,
  onWarning?: (warning: { instanceId?: string; field: string }) => void,
) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return input;
  }
  const source = input as Record<string, unknown>;
  const knownTopLevelKeys = new Set(Object.keys(ControlledInstanceSchema.shape));
  const next: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(source)) {
    if (knownTopLevelKeys.has(key)) {
      next[key] = value;
    } else {
      onWarning?.({
        instanceId: typeof source.id === "string" ? source.id : undefined,
        field: key,
      });
    }
  }
  if (source.capabilities && typeof source.capabilities === "object" && !Array.isArray(source.capabilities)) {
    const capabilities = { ...(source.capabilities as Record<string, unknown>) };
    if (Object.prototype.hasOwnProperty.call(capabilities, "apps")) {
      onWarning?.({
        instanceId: typeof source.id === "string" ? source.id : undefined,
        field: "capabilities.apps",
      });
      delete capabilities.apps;
    }
    next.capabilities = normalizeControlledInstanceCapabilities(capabilities);
  } else {
    next.capabilities = normalizeControlledInstanceCapabilities(undefined);
  }
  next.appInventory = sanitizeStoredAppInventory(source.appInventory, onWarning, typeof source.id === "string" ? source.id : undefined);
  next.source = sanitizeStoredProjectSource(source.source, onWarning, typeof source.id === "string" ? source.id : undefined);
  next.sourceSnapshot = source.sourceSnapshot && typeof source.sourceSnapshot === "object" && !Array.isArray(source.sourceSnapshot) ? source.sourceSnapshot : {};
  next.build = sanitizeStoredStrictObject(BuildInfoSchema, source.build, "build", onWarning, typeof source.id === "string" ? source.id : undefined);
  next.aiSessions = sanitizeStoredAiSessions(source.aiSessions, onWarning, typeof source.id === "string" ? source.id : undefined);
  next.triggers = sanitizeStoredTriggers(source.triggers, onWarning, typeof source.id === "string" ? source.id : undefined);
  next.apps = sanitizeStoredStrictObject(ControlledInstanceSchema.shape.apps.unwrap(), pickObjectFields(source.apps, ["runningCount", "problemCount", "updatedAt", "revision"]), "apps", onWarning, typeof source.id === "string" ? source.id : undefined) || { runningCount: 0, problemCount: 0 };
  next.config = sanitizeStoredStrictObject(ControlledInstanceSchema.shape.config.unwrap(), pickObjectFields(source.config, ["autoImportAgentConfigs", "codexConfigEnabled", "codexHomeMode", "defaultCodexPermissionMode", "codexSettings", "aiSessionHistoryLimit", "aiSessionAttachmentRetentionDays", "aiSessionMaxFileAttachmentBytes"]), "config", onWarning, typeof source.id === "string" ? source.id : undefined) || { autoImportAgentConfigs: true, codexConfigEnabled: true, codexHomeMode: "taskhandoff", defaultCodexPermissionMode: "ask", aiSessionHistoryLimit: AI_SESSION_HISTORY_DEFAULT_LIMIT, aiSessionAttachmentRetentionDays: AI_SESSION_ATTACHMENT_RETENTION_DEFAULT_DAYS, aiSessionMaxFileAttachmentBytes: AI_SESSION_DEFAULT_MAX_FILE_ATTACHMENT_BYTES };
  next.modelSelection = sanitizeStoredStrictObject(ModelSelectionSchema.unwrap(), pickObjectFields(source.modelSelection, ["modelEntityIds", "codexModelHash", "claudeModelHash", "opencodeModelHash"]), "modelSelection", onWarning, typeof source.id === "string" ? source.id : undefined) || {};
  next.imageSnapshot = sanitizeStoredInstanceImageSnapshot(
    source.imageSnapshot,
    source.imageId,
    onWarning,
    typeof source.id === "string" ? source.id : undefined,
  );
  const legacyImageIds: Record<string, string> = {
    img_default: "market_taskhandoff_browser",
    img_codex: "market_taskhandoff_codex",
    img_ai: "market_taskhandoff_ai",
  };
  const requestedImageId = typeof source.imageId === "string" ? (legacyImageIds[source.imageId] || source.imageId) : undefined;
  const existingSelection = pickObjectFields(source.imageSelection, ["imageId", "tag"]);
  next.imageSelection = existingSelection || (requestedImageId
    ? { imageId: requestedImageId, tag: (next.imageSnapshot as Record<string, unknown> | undefined)?.tag }
    : undefined);
  next.imageProvisioning = sanitizeStoredStrictObject(ImageProvisioningSchema, pickObjectFields(source.imageProvisioning, ["phase", "requestedReference", "generation", "error", "startedAt", "updatedAt"]), "imageProvisioning", onWarning, typeof source.id === "string" ? source.id : undefined);
  next.runtimeVersion = sanitizeStoredRuntimeVersion(source.runtimeVersion, onWarning, typeof source.id === "string" ? source.id : undefined);
  next.workspace = sanitizeStoredStrictObject(WorkspaceStatusSchema, source.workspace, "workspace", onWarning, typeof source.id === "string" ? source.id : undefined) || { status: "unknown" };
  next.environmentSource = sanitizeStoredStrictObject(EnvironmentSourceSchema, source.environmentSource, "environmentSource", onWarning, typeof source.id === "string" ? source.id : undefined);
  next.environmentTemplateOrigin = sanitizeStoredStrictObject(EnvironmentTemplateOriginSchema, source.environmentTemplateOrigin, "environmentTemplateOrigin", onWarning, typeof source.id === "string" ? source.id : undefined);
  next.runtime = sanitizeStoredStrictObject(ControlledInstanceSchema.shape.runtime.unwrap(), source.runtime, "runtime", onWarning, typeof source.id === "string" ? source.id : undefined) || { labels: {} };
  next.target = sanitizeStoredStrictObject(InstanceTargetSchema, pickObjectFields(source.target ?? source.endpoints, ["strategy", "web", "api", "vnc", "tty", "logs", "status"]), "target", onWarning, typeof source.id === "string" ? source.id : undefined) || { strategy: "direct-port", status: "unknown" };
  next.access = sanitizeStoredStrictObject(InstanceAccessSchema, pickObjectFields(source.access, ["strategy", "web", "api", "ws", "status"]), "access", onWarning, typeof source.id === "string" ? source.id : undefined) || { strategy: "control-plane-proxy", status: "unknown" };
  for (const [key, schema] of Object.entries(ControlledInstanceSchema.shape)) {
    if (!Object.prototype.hasOwnProperty.call(next, key)) continue;
    if (schema.safeParse(next[key]).success || !schema.safeParse(undefined).success) continue;
    delete next[key];
    onWarning?.({ instanceId: typeof source.id === "string" ? source.id : undefined, field: key });
  }
  return next;
}

function sanitizeStoredStrictObject<T>(
  schema: z.ZodType<T>,
  input: unknown,
  field: string,
  onWarning?: (warning: { instanceId?: string; field: string }) => void,
  instanceId?: string,
): T | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
  let candidate = structuredClone(input);
  let changed = false;
  for (let pass = 0; pass < 20; pass += 1) {
    const parsed = schema.safeParse(candidate);
    if (parsed.success) {
      if (changed) onWarning?.({ instanceId, field });
      return parsed.data;
    }
    let removedUnknown = false;
    for (const issue of parsed.error.issues) {
      if (issue.code !== "unrecognized_keys") continue;
      const parent = valueAtPath(candidate, issue.path);
      if (!parent || typeof parent !== "object" || Array.isArray(parent)) continue;
      for (const key of issue.keys) {
        if (Object.prototype.hasOwnProperty.call(parent, key)) {
          delete (parent as Record<string, unknown>)[key];
          removedUnknown = true;
          changed = true;
        }
      }
    }
    if (!removedUnknown) {
      const withoutBadOptionalFields = structuredClone(candidate);
      let removedInvalid = false;
      for (const issue of parsed.error.issues) {
        if (!issue.path.length || typeof issue.path.at(-1) !== "string") continue;
        const parent = valueAtPath(withoutBadOptionalFields, issue.path.slice(0, -1));
        const key = issue.path.at(-1) as string;
        if (parent && typeof parent === "object" && !Array.isArray(parent) && Object.prototype.hasOwnProperty.call(parent, key)) {
          delete (parent as Record<string, unknown>)[key];
          removedInvalid = true;
        }
      }
      if (removedInvalid) {
        const recovered = schema.safeParse(withoutBadOptionalFields);
        if (recovered.success) {
          onWarning?.({ instanceId, field });
          return recovered.data;
        }
      }
      break;
    }
  }
  onWarning?.({ instanceId, field });
  return undefined;
}

function valueAtPath(root: unknown, path: PropertyKey[]) {
  let value = root;
  for (const key of path) {
    if (!value || typeof value !== "object") return undefined;
    value = (value as Record<PropertyKey, unknown>)[key];
  }
  return value;
}

function sanitizeStoredProjectSource(input: unknown, onWarning?: (warning: { instanceId?: string; field: string }) => void, instanceId?: string) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return input;
  const source = input as Record<string, unknown>;
  const type = source.type;
  const option = ProjectSourceSchema.options.find((candidate) => candidate.shape.type.value === type);
  if (!option) return input;
  const allowed = type === "local-folder"
    ? ["type", "localFolderId", "path", "ownerNodeId"]
    : type === "git-template"
      ? ["type", "url", "templateId", "ref", "auth", "clone"]
      : ["type", "repositoryId", "url", "provider", "ref", "auth", "clone"];
  const candidate = pickObjectFields(source, allowed) as Record<string, unknown>;
  if (type !== "local-folder") {
    const ref = sanitizeStoredGitRef(source.ref, onWarning, instanceId);
    const auth = sanitizeStoredStrictObject(GitAuthSchema, pickObjectFields(source.auth, ["type", "secretId"]), "source.auth", onWarning, instanceId);
    const clone = sanitizeStoredStrictObject(GitCloneOptionsSchema, pickObjectFields(source.clone, ["depth", "submodules", "lfs", "subdirectory"]), "source.clone", onWarning, instanceId);
    if (ref) candidate.ref = ref; else delete candidate.ref;
    if (auth) candidate.auth = auth; else delete candidate.auth;
    if (clone) candidate.clone = clone; else delete candidate.clone;
  }
  const parsed = sanitizeStoredStrictObject(option as z.ZodType<unknown>, candidate, "source", onWarning, instanceId);
  if (parsed) {
    if (Object.keys(source).some((key) => !allowed.includes(key))) onWarning?.({ instanceId, field: "source" });
    return parsed;
  }
  return candidate;
}

function sanitizeStoredGitRef(input: unknown, onWarning?: (warning: { instanceId?: string; field: string }) => void, instanceId?: string) {
  const source = input && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : undefined;
  const direct = GitRefSchema.safeParse(pickObjectFields(source, ["type", "name", "commit"]));
  if (direct.success) return direct.data;
  // Compatibility for v0.0.21: malformed ref shapes were accepted. Preserve the
  // executor's old precedence (commit before name), then fall back to the former default.
  const commit = typeof source?.commit === "string" ? source.commit.trim() : "";
  const name = typeof source?.name === "string" ? source.name.trim() : "";
  const migrated = commit
    ? GitRefSchema.safeParse({ type: "commit", commit })
    : name
      ? GitRefSchema.safeParse({ type: source?.type === "tag" ? "tag" : "branch", name })
      : GitRefSchema.safeParse({ type: "branch", name: "main" });
  if (!migrated.success) return undefined;
  onWarning?.({ instanceId, field: "source.ref" });
  return migrated.data;
}

function sanitizeStoredAiSessions(input: unknown, onWarning?: (warning: { instanceId?: string; field: string }) => void, instanceId?: string) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
  const source = input as Record<string, unknown>;
  const sessions = Array.isArray(source.sessions)
    ? source.sessions.flatMap((session, index) => {
      const parsed = sanitizeStoredStrictObject(AiSessionSummarySchema, session, `aiSessions.sessions.${index}`, onWarning, instanceId);
      return parsed ? [parsed] : [];
    })
    : [];
  const candidate = {
    runningCount: typeof source.runningCount === "number" && Number.isInteger(source.runningCount) && source.runningCount >= 0 ? source.runningCount : 0,
    waitingCount: typeof source.waitingCount === "number" && Number.isInteger(source.waitingCount) && source.waitingCount >= 0 ? source.waitingCount : 0,
    staleCount: typeof source.staleCount === "number" && Number.isInteger(source.staleCount) && source.staleCount >= 0 ? source.staleCount : 0,
    sessions,
    updatedAt: TimestampSchema.safeParse(source.updatedAt).success ? source.updatedAt : new Date().toISOString(),
  };
  if (Object.keys(source).some((key) => !["runningCount", "waitingCount", "staleCount", "sessions", "updatedAt"].includes(key))) onWarning?.({ instanceId, field: "aiSessions" });
  return AiSessionsSnapshotSchema.parse(candidate);
}

function sanitizeStoredTriggers(input: unknown, onWarning?: (warning: { instanceId?: string; field: string }) => void, instanceId?: string) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
  const source = input as Record<string, unknown>;
  if (Object.keys(source).some((key) => !["enabledCount", "runningCount", "errorCount", "configs", "recentRuns"].includes(key))) onWarning?.({ instanceId, field: "triggers" });
  const sanitizeArray = <T>(value: unknown, schema: z.ZodType<T>, field: string) => Array.isArray(value)
    ? value.flatMap((entry, index) => {
      const parsed = sanitizeStoredStrictObject(schema, entry, `${field}.${index}`, onWarning, instanceId);
      return parsed ? [parsed] : [];
    })
    : [];
  const configs = Array.isArray(source.configs) ? source.configs.flatMap((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
    const record = entry as Record<string, unknown>;
    if (Object.keys(record).some((key) => !["configHash", "config", "deployments", "runtime"].includes(key))) onWarning?.({ instanceId, field: `triggers.configs.${index}` });
    const config = sanitizeStoredTriggerConfig(record.config, `triggers.configs.${index}.config`, onWarning, instanceId);
    if (typeof record.configHash !== "string" || !config) return [];
    return [{
      configHash: record.configHash,
      config,
      deployments: sanitizeArray(record.deployments, TriggerDeploymentSchema, `triggers.configs.${index}.deployments`),
      runtime: sanitizeArray(record.runtime, TriggerRuntimeStateSchema, `triggers.configs.${index}.runtime`),
    }];
  }) : [];
  return {
    enabledCount: typeof source.enabledCount === "number" && Number.isInteger(source.enabledCount) && source.enabledCount >= 0 ? source.enabledCount : 0,
    runningCount: typeof source.runningCount === "number" && Number.isInteger(source.runningCount) && source.runningCount >= 0 ? source.runningCount : 0,
    errorCount: typeof source.errorCount === "number" && Number.isInteger(source.errorCount) && source.errorCount >= 0 ? source.errorCount : 0,
    configs,
    recentRuns: sanitizeArray(source.recentRuns, TriggerRunSchema, "triggers.recentRuns"),
  };
}

function sanitizeStoredTriggerConfig(
  input: unknown,
  field: string,
  onWarning?: (warning: { instanceId?: string; field: string }) => void,
  instanceId?: string,
) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
  const source = input as Record<string, unknown>;
  const candidate = pickObjectFields(source, ["configHash", "name", "description", "createdAt", "updatedAt"]) as Record<string, unknown>;
  if (source.source && typeof source.source === "object" && !Array.isArray(source.source)) {
    const triggerSource = source.source as Record<string, unknown>;
    const sourceKeys = triggerSource.type === "schedule"
      ? triggerSource.scheduleKind === "interval"
        ? ["type", "scheduleKind", "intervalMs"]
        : triggerSource.scheduleKind === "daily"
          ? ["type", "scheduleKind", "timeOfDay", "timezone"]
          : ["type", "scheduleKind", "weekdays", "timeOfDay", "timezone"]
      : triggerSource.type === "file-change"
        ? ["type", "roots", "globs", "ignore", "debounceMs"]
        : ["type", "agent", "statuses", "phases"];
    candidate.source = pickObjectFields(triggerSource, sourceKeys);
  }
  candidate.action = pickObjectFields(source.action, ["promptTemplate"]);
  candidate.policy = pickObjectFields(source.policy, ["cooldownMs", "maxConcurrentRuns", "whenBusy"]);
  return sanitizeStoredStrictObject(TriggerConfigSchema, candidate, field, onWarning, instanceId);
}

function sanitizeStoredRuntimeVersion(
  input: unknown,
  onWarning?: (warning: { instanceId?: string; field: string }) => void,
  instanceId?: string,
) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
  const source = input as Record<string, unknown>;
  const storedVersion = (value: unknown) => {
    if (typeof value !== "string") return undefined;
    const trimmed = value.trim();
    return trimmed && trimmed.length <= 80 ? trimmed : undefined;
  };
  const desiredVersion = storedVersion(source.desiredVersion);
  if (!desiredVersion) {
    onWarning?.({ instanceId, field: "runtimeVersion.desiredVersion" });
    return undefined;
  }
  const phaseAliases: Record<string, RuntimeVersionState["phase"]> = {
    idle: "pending",
    queued: "pending",
    checking: "pending",
    downloading: "installing",
    updating: "installing",
    completed: "matched",
    succeeded: "matched",
    ready: "matched",
    error: "failed",
  };
  const validPhases = new Set(RuntimeVersionStateSchema.shape.phase.options);
  const rawPhase = typeof source.phase === "string" ? source.phase : "pending";
  const phase = validPhases.has(rawPhase as RuntimeVersionState["phase"])
    ? rawPhase as RuntimeVersionState["phase"]
    : phaseAliases[rawPhase] || "pending";
  if (phase !== rawPhase) onWarning?.({ instanceId, field: "runtimeVersion.phase" });
  let error: RuntimeConvergenceError | undefined;
  if (source.error && typeof source.error === "object" && !Array.isArray(source.error)) {
    const storedError = source.error as Record<string, unknown>;
    const message = typeof storedError.message === "string" ? storedError.message.trim().slice(0, 4096) : "";
    if (message) {
      const validCodes = new Set(RuntimeConvergenceErrorSchema.shape.code.options);
      const code = typeof storedError.code === "string" && validCodes.has(storedError.code as RuntimeConvergenceError["code"])
        ? storedError.code as RuntimeConvergenceError["code"]
        : "INSTANCE_RUNTIME_INSTALL_FAILED";
      if (code !== storedError.code) onWarning?.({ instanceId, field: "runtimeVersion.error.code" });
      const expectedVersion = storedVersion(storedError.expectedVersion);
      const errorActualVersion = storedVersion(storedError.actualVersion);
      error = {
        code,
        message,
        ...(expectedVersion ? { expectedVersion } : {}),
        ...(errorActualVersion ? { actualVersion: errorActualVersion } : {}),
        retryable: storedError.retryable === true,
      };
    } else {
      onWarning?.({ instanceId, field: "runtimeVersion.error" });
    }
  }
  if (typeof source.error === "string" && source.error.trim()) {
    error = {
      code: "INSTANCE_RUNTIME_INSTALL_FAILED",
      message: source.error.trim().slice(0, 4096),
      expectedVersion: desiredVersion,
      ...(storedVersion(source.actualVersion) ? { actualVersion: storedVersion(source.actualVersion) } : {}),
      retryable: false,
    };
  }
  const actualVersion = storedVersion(source.actualVersion);
  const lastAttemptAt = TimestampSchema.safeParse(source.lastAttemptAt);
  const matchedAt = TimestampSchema.safeParse(source.matchedAt);
  if (source.lastAttemptAt !== undefined && !lastAttemptAt.success) onWarning?.({ instanceId, field: "runtimeVersion.lastAttemptAt" });
  if (source.matchedAt !== undefined && !matchedAt.success) onWarning?.({ instanceId, field: "runtimeVersion.matchedAt" });
  return {
    desiredVersion,
    ...(actualVersion ? { actualVersion } : {}),
    phase,
    attempt: typeof source.attempt === "number" && Number.isInteger(source.attempt) && source.attempt >= 0 ? source.attempt : 0,
    ...(lastAttemptAt.success ? { lastAttemptAt: lastAttemptAt.data } : {}),
    ...(matchedAt.success ? { matchedAt: matchedAt.data } : {}),
    ...(error ? { error } : {}),
  };
}

function sanitizeStoredAppInventory(input: unknown, onWarning?: (warning: { instanceId?: string; field: string }) => void, instanceId?: string) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
  const source = input as Record<string, unknown>;
  if (Object.keys(source).some((key) => !["observedAt", "items", "issues"].includes(key))) onWarning?.({ instanceId, field: "appInventory" });
  const candidate = {
    observedAt: source.observedAt,
    items: Array.isArray(source.items)
      ? source.items.map((item) => {
          if (item && typeof item === "object" && !Array.isArray(item) && Object.keys(item).some((key) => !["id", "name", "kind", "source", "availability", "capabilities", "diagnosticCode"].includes(key))) onWarning?.({ instanceId, field: "appInventory.items" });
          const picked = pickObjectFields(item, ["id", "name", "kind", "source", "availability", "diagnosticCode"]);
          if (!picked || typeof picked !== "object" || Array.isArray(picked)) return picked;
          return {
            ...picked,
            capabilities: pickObjectFields((item as Record<string, unknown>).capabilities, ["automation", "supportsCwdSelection", "supportsProfiles"]),
          };
        })
      : source.items,
    issues: Array.isArray(source.issues)
      ? source.issues.map((issue) => pickObjectFields(issue, ["code", "message"]))
      : source.issues,
  };
  const parsed = InstanceAppInventorySchema.safeParse(candidate);
  return parsed.success ? parsed.data : undefined;
}

function pickObjectFields(input: unknown, keys: string[]) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return input;
  const source = input as Record<string, unknown>;
  return Object.fromEntries(keys.filter((key) => Object.prototype.hasOwnProperty.call(source, key)).map((key) => [key, source[key]]));
}

export const ControlledInstanceRegisterSchema = z
  .object({
    instanceId: IdSchema.optional(),
    projectId: IdSchema.optional(),
    source: ProjectSourceSchema.optional(),
    nodeId: IdSchema.optional(),
    runtimeId: IdSchema.optional(),
    imageSelection: ImageSelectionSchema.optional(),
    instanceVersion: z.string().trim().max(80).optional(),
    protocolVersion: ProtocolVersionSchema,
    build: BuildInfoSchema.optional(),
    controlMode: z.enum(["standalone", "controlled"]).default("controlled"),
    capabilities: ControlledInstanceCapabilitiesSchema.default(defaultControlledInstanceCapabilities),
    appInventory: InstanceAppInventorySchema.optional(),
    target: LegacyControlledInstanceReportedTargetSchema.optional(),
    workspace: WorkspaceStatusSchema.default({ status: "unknown" }),
    registrationToken: z.string().trim().max(240).optional(),
    processIncarnationId: z.string().trim().min(1).max(120).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (APP_INVENTORY_REQUIRED_PROTOCOL_VERSIONS.has(value.protocolVersion) && !value.appInventory) {
      context.addIssue({ code: "custom", path: ["appInventory"], message: "Current protocol register payload requires appInventory." });
    }
  });

export const ControlledInstanceHeartbeatSchema = z
  .object({
    status: ControlledInstanceSchema.shape.status.optional(),
    health: ControlledInstanceSchema.shape.health.optional(),
    protocolVersion: ProtocolVersionSchema,
    build: BuildInfoSchema.optional(),
    capabilities: ControlledInstanceSchema.shape.capabilities.optional(),
    appInventory: InstanceAppInventorySchema.optional(),
    apps: ControlledInstanceSchema.shape.apps.optional(),
    aiSessions: ControlledInstanceSchema.shape.aiSessions.optional(),
    triggers: ControlledInstanceSchema.shape.triggers.optional(),
    workspace: WorkspaceStatusSchema.optional(),
    target: LegacyControlledInstanceReportedTargetSchema.optional(),
    processIncarnationId: z.string().trim().min(1).max(120).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (APP_INVENTORY_REQUIRED_PROTOCOL_VERSIONS.has(value.protocolVersion) && !value.appInventory) {
      context.addIssue({ code: "custom", path: ["appInventory"], message: "Current protocol heartbeat payload requires appInventory." });
    }
  });

export type CrossVersionInstanceReportWarning = {
  field: string;
  action: "ignored" | "migrated";
};

export function sanitizeCrossVersionControlledInstanceRegister(
  input: unknown,
  onWarning?: (warning: CrossVersionInstanceReportWarning) => void,
) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return input;
  const source = input as Record<string, unknown>;
  const knownKeys = [
    "instanceId", "projectId", "source", "nodeId", "runtimeId", "imageSelection",
    "instanceVersion", "protocolVersion", "build", "controlMode", "capabilities", "appInventory",
    "target", "workspace", "registrationToken", "processIncarnationId",
  ];
  const acceptedKeys = new Set([...knownKeys, "imageId"]);
  for (const key of Object.keys(source)) {
    if (!acceptedKeys.has(key)) onWarning?.({ field: key, action: "ignored" });
  }
  if (Object.prototype.hasOwnProperty.call(source, "imageId")) {
    onWarning?.({ field: "imageId", action: "migrated" });
  }
  return {
    ...(pickObjectFields(source, knownKeys) as Record<string, unknown>),
    imageSelection: migrateLegacyImageSelection(source.imageSelection, source.imageId),
  };
}

export function sanitizeCrossVersionControlledInstanceHeartbeat(
  input: unknown,
  onWarning?: (warning: CrossVersionInstanceReportWarning) => void,
) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return input;
  const knownKeys = [
    "status", "health", "protocolVersion", "build", "capabilities", "appInventory", "apps",
    "aiSessions", "triggers", "workspace", "target", "processIncarnationId",
  ];
  const acceptedKeys = new Set(knownKeys);
  for (const key of Object.keys(input)) {
    if (!acceptedKeys.has(key)) onWarning?.({ field: key, action: "ignored" });
  }
  return pickObjectFields(input, knownKeys);
}

function projectAppInventoryForNodeAgentProtocol(
  input: Record<string, unknown>,
  nodeAgentProtocolVersion?: string,
) {
  if (nodeAgentProtocolVersion && nodeAgentProtocolVersion >= APP_PROFILES_PROTOCOL_VERSION) return input;
  const appInventory = input.appInventory;
  if (!appInventory || typeof appInventory !== "object" || Array.isArray(appInventory)) return input;
  const items = (appInventory as Record<string, unknown>).items;
  if (!Array.isArray(items)) return input;
  let changed = false;
  const compatibleItems = items.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return item;
    const capabilities = (item as Record<string, unknown>).capabilities;
    if (!capabilities || typeof capabilities !== "object" || Array.isArray(capabilities) || !("supportsProfiles" in capabilities)) return item;
    const { supportsProfiles: _supportsProfiles, ...compatibleCapabilities } = capabilities as Record<string, unknown>;
    changed = true;
    return { ...item, capabilities: compatibleCapabilities };
  });
  if (!changed) return input;
  // Compatibility for v0.0.34 and earlier: their strict app inventory
  // capability schema rejects the additive profiles capability, so newer
  // controlled instances project the pre-profile wire model instead of
  // blocking registration and heartbeats.
  return { ...input, appInventory: { ...appInventory, items: compatibleItems } };
}

export function projectControlledInstanceRegisterForNodeAgentProtocol(
  input: Record<string, unknown>,
  nodeAgentProtocolVersion?: string,
) {
  return projectAppInventoryForNodeAgentProtocol(input, nodeAgentProtocolVersion);
}

export function projectControlledInstanceHeartbeatForNodeAgentProtocol(
  input: Record<string, unknown>,
  nodeAgentProtocolVersion?: string,
) {
  const projected = projectAppInventoryForNodeAgentProtocol(input, nodeAgentProtocolVersion);
  if (nodeAgentProtocolVersion && nodeAgentProtocolVersion >= AI_SESSION_RENAME_PROTOCOL_VERSION) return projected;
  const aiSessions = projected.aiSessions;
  if (!aiSessions || typeof aiSessions !== "object" || Array.isArray(aiSessions)) return projected;
  const sessions = (aiSessions as Record<string, unknown>).sessions;
  if (!Array.isArray(sessions)) return projected;
  let changed = false;
  const compatibleSessions = sessions.map((session) => {
    if (!session || typeof session !== "object" || Array.isArray(session)) return session;
    const actions = (session as Record<string, unknown>).actions;
    if (!actions || typeof actions !== "object" || Array.isArray(actions) || !("rename" in actions)) return session;
    const { rename: _rename, ...compatibleActions } = actions as Record<string, unknown>;
    changed = true;
    return { ...session, actions: compatibleActions };
  });
  if (!changed) return projected;
  // Compatibility for v0.0.31: its strict action schema rejects the additive
  // rename capability, so newer controlled instances project the N-1 wire model.
  return {
    ...projected,
    aiSessions: {
      ...aiSessions,
      sessions: compatibleSessions,
    },
  };
}

export const ChatChannelSchema = z.enum(["web", "telegram", "wechat", "dingding", "lark"]);

export const ChatBridgeConfigSchema = z
  .object({
    id: IdSchema,
    channel: ChatChannelSchema,
    name: z.string().trim().min(1).max(160),
    enabled: z.boolean().default(false),
    token: z.string().trim().max(4096).optional(),
    defaultChatId: z.string().trim().max(240).optional(),
    allowedUserIds: z.array(z.string().trim().min(1).max(240)).default([]),
    pollIntervalMs: z.number().int().positive().max(60000).default(3000),
    settings: z.record(z.string(), z.unknown()).default({}),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
  })
  .strict();

export const ChatSessionBindingSchema = z
  .object({
    id: IdSchema,
    channel: ChatChannelSchema,
    bridgeId: IdSchema.optional(),
    chatSessionId: z.string().trim().min(1).max(240),
    userId: z.string().trim().max(240).optional(),
    activeProjectId: IdSchema.optional(),
    activeInstanceId: IdSchema.optional(),
    activeAiSessionId: z.string().trim().min(1).max(120).optional(),
    lastUsedAt: TimestampSchema,
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
  })
  .strict();

export const ChatGatewayMessageSchema = z
  .object({
    source: z
      .object({
        type: z.literal("chat-gateway").default("chat-gateway"),
        channel: ChatChannelSchema,
        bridgeId: IdSchema.optional(),
        chatSessionId: z.string().trim().min(1).max(240),
        userId: z.string().trim().max(240).optional(),
      })
      .strict(),
    message: z
      .object({
        text: z.string().trim().max(20000).default(""),
        attachments: z.array(AiSessionMessageAttachmentSchema).max(AI_SESSION_MAX_MESSAGE_ATTACHMENTS).default([]),
      })
      .strict()
      .superRefine((message, context) => {
        const totalBytes = message.attachments.reduce((sum, attachment) => sum + (attachment.source.type === "inline" ? attachment.size : 0), 0);
        if (totalBytes > AI_SESSION_MAX_MESSAGE_ATTACHMENT_BYTES) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["attachments"],
            message: `Inline attachments must be ${AI_SESSION_MAX_MESSAGE_ATTACHMENT_BYTES} bytes or less in total.`,
          });
        }
      }),
    target: z
      .object({
        instanceId: IdSchema,
        aiSessionId: z.string().trim().min(1).max(120),
      })
      .strict()
      .optional(),
  })
  .strict();

export const PendingRouteSchema = z
  .object({
    id: IdSchema,
    instanceId: IdSchema,
    projectId: IdSchema.optional(),
    aiSessionId: z.string().trim().min(1).max(120),
    providerSessionId: z.string().trim().max(240).optional(),
    result: z.string().default(""),
    timeoutMs: z.number().positive().optional(),
    source: z.string().trim().max(120).optional(),
    kind: z.enum(["task", "approval"]).default("task"),
    status: z.enum(["pending", "unreachable"]).default("pending"),
    error: z.string().trim().max(2048).optional(),
    lastSeenAt: TimestampSchema,
  })
  .strict();

export type GitRepository = z.infer<typeof GitRepositorySchema>;
export type NodeLocalFolder = z.infer<typeof NodeLocalFolderSchema>;
export type Project = z.infer<typeof ProjectSchema>;
export type ModelConfig = z.infer<typeof ModelConfigSchema>;
export type NodeModelConfig = z.infer<typeof NodeModelConfigSchema>;
export type PublicModelConfig = z.infer<typeof PublicModelConfigSchema>;
export type NodeModelPublicRecord = z.infer<typeof NodeModelPublicRecordSchema>;
export type NodeModelAssignment = z.infer<typeof NodeModelAssignmentSchema>;
export type ModelLocation = z.infer<typeof ModelLocationSchema>;
export type FederatedModelGroup = z.infer<typeof FederatedModelGroupSchema>;
export type FederatedModelRegistry = z.infer<typeof FederatedModelRegistrySchema>;
export type ModelLocationSyncState = z.infer<typeof ModelLocationSyncStateSchema>;
export type ModelLocationSyncResult = z.infer<typeof ModelLocationSyncResultSchema>;
export type ModelMutationResult = z.infer<typeof ModelMutationResultSchema>;
export type NodeModelMergeInput = z.infer<typeof NodeModelMergeSchema>;
export type NodeModelMergeResult = z.infer<typeof NodeModelMergeResultSchema>;
export type ModelMergeLocationResult = z.infer<typeof ModelMergeLocationResultSchema>;
export type ModelMergeResult = z.infer<typeof ModelMergeResultSchema>;
export type ImageSelection = z.infer<typeof ImageSelectionSchema>;
export type EnvironmentSource = z.infer<typeof EnvironmentSourceSchema>;
export type EnvironmentTemplateStatus = z.infer<typeof EnvironmentTemplateStatusSchema>;
export type EnvironmentTemplateError = z.infer<typeof EnvironmentTemplateErrorSchema>;
export type EnvironmentTemplate = z.infer<typeof EnvironmentTemplateSchema>;
export type EnvironmentTemplateOrigin = z.infer<typeof EnvironmentTemplateOriginSchema>;
export type InstanceVolumeRole = z.infer<typeof InstanceVolumeRoleSchema>;
export type InstanceVolumeDisposition = z.infer<typeof InstanceVolumeDispositionSchema>;
export type InstanceDeleteInput = z.infer<typeof InstanceDeleteInputSchema>;
export type InstanceDeleteResult = z.infer<typeof InstanceDeleteResultSchema>;
export type InstanceCreateInput = z.infer<typeof InstanceCreateInputSchema>;
export type UpdateInstanceInput = z.infer<typeof UpdateInstanceInputSchema>;
export type InstanceCreateStartOutcome = z.infer<typeof InstanceCreateStartOutcomeSchema>;
export type InstanceCreateResult = z.infer<typeof InstanceCreateResultSchema>;
export type ImageCover = z.infer<typeof ImageCoverSchema>;
export type MarketImagePlatformArtifact = z.infer<typeof MarketImagePlatformArtifactSchema>;
export type MarketImageTag = z.infer<typeof MarketImageTagSchema>;
export type MarketImage = z.infer<typeof MarketImageSchema>;
export type MarketCatalogSnapshot = z.infer<typeof MarketCatalogSnapshotSchema>;
export type MarketCatalogStatus = z.infer<typeof MarketCatalogStatusSchema>;
export type CustomImageProfile = z.infer<typeof CustomImageProfileSchema>;
export type ImageProfile = CustomImageProfile;
export type SelectableImage = z.infer<typeof SelectableImageSchema>;
export type InstanceImageSnapshot = z.infer<typeof InstanceImageSnapshotSchema>;
export type ImageProvisioning = z.infer<typeof ImageProvisioningSchema>;
export type ImagePullTerminalOutput = z.infer<typeof ImagePullTerminalOutputSchema>;
export type ImagePullTerminalFinished = z.infer<typeof ImagePullTerminalFinishedSchema>;
export type ImagePullProgress = z.infer<typeof ImagePullProgressSchema>;
export type GitWorkspaceProvisioningStatus = z.infer<typeof GitWorkspaceProvisioningStatusSchema>;
export type GitProvisioningTerminalOutput = z.infer<typeof GitProvisioningTerminalOutputSchema>;
export type GitProvisioningTerminalFinished = z.infer<typeof GitProvisioningTerminalFinishedSchema>;
export type GitProvisioningProgress = z.infer<typeof GitProvisioningProgressSchema>;
export type NodeImageAvailability = z.infer<typeof NodeImageAvailabilitySchema>;
export type Node = z.infer<typeof NodeSchema>;
export type NodeStateProjectionEvent = z.infer<typeof NodeStateProjectionEventSchema>;
export type NodeJoinedEvent = z.infer<typeof NodeJoinedEventSchema>;
export type NodeJoinInviteStatus = z.infer<typeof NodeJoinInviteStatusSchema>;
export type NodeRuntime = z.infer<typeof NodeRuntimeSchema>;
export type InstanceResourceMetrics = z.infer<typeof InstanceResourceMetricsSchema>;
export type NodeAgentHealth = z.infer<typeof NodeAgentHealthSchema>;
export type NodeAgentExternalListenerConfig = z.infer<typeof NodeAgentExternalListenerConfigSchema>;
export type NodeAgentExternalListener = z.infer<typeof NodeAgentExternalListenerSchema>;
export type UpdateNodeAgentExternalListener = z.infer<typeof UpdateNodeAgentExternalListenerSchema>;
export type NodeAgentModelRelayConfig = z.infer<typeof NodeAgentModelRelayConfigSchema>;
export type NodeAgentModelRelayUnknownModelPolicy = z.infer<typeof NodeAgentModelRelayUnknownModelPolicySchema>;
export type NodeAgentModelRelay = z.infer<typeof NodeAgentModelRelaySchema>;
export type UpdateNodeAgentModelRelay = z.infer<typeof UpdateNodeAgentModelRelaySchema>;
export type NodeAgentPairingInviteResponse = z.infer<typeof NodeAgentPairingInviteResponseSchema>;
export type NodeAgentPairingCompleteResult = z.infer<typeof NodeAgentPairingCompleteResultSchema>;
export type NodeAgentControlPlanePairing = z.infer<typeof NodeAgentControlPlanePairingSchema>;
export type NodeAgentPairingSelfRevokeResult = z.infer<typeof NodeAgentPairingSelfRevokeResultSchema>;
export type NodeAgentControlPlaneConnection = z.infer<typeof NodeAgentControlPlaneConnectionSchema>;
export type NodeAgentControlPlaneConnectionCreateResult = z.infer<typeof NodeAgentControlPlaneConnectionCreateResultSchema>;
export type NodeAgentDeleteResponse = z.infer<typeof NodeAgentDeleteResponseSchema>;
export type LocalDockerImage = z.infer<typeof LocalDockerImageSchema>;
export type NodeAgentInstanceProxyRawResponse = z.infer<typeof NodeAgentInstanceProxyRawResponseSchema>;
export type BuildInfo = z.infer<typeof BuildInfoSchema>;
export type ControlPlaneHealthResponse = z.infer<typeof ControlPlaneHealthResponseSchema>;
export type UpdateChannel = z.infer<typeof UpdateChannelSchema>;
export type RuntimeArtifactIdentity = z.infer<typeof RuntimeArtifactIdentitySchema>;
export type RuntimeConvergenceError = z.infer<typeof RuntimeConvergenceErrorSchema>;
export type RuntimeVersionState = z.infer<typeof RuntimeVersionStateSchema>;
export type NodeUpdateImpact = z.infer<typeof NodeUpdateImpactSchema>;
export type NodeRolloutSummary = z.infer<typeof NodeRolloutSummarySchema>;
export type UpdateCheckRequest = z.infer<typeof UpdateCheckRequestSchema>;
export type ApplyUpdateRequest = z.infer<typeof ApplyUpdateRequestSchema>;
export type UpdateCheckResult = z.infer<typeof UpdateCheckResultSchema>;
export type UpdateJob = z.infer<typeof UpdateJobSchema>;
export type ControlledInstance = z.infer<typeof ControlledInstanceSchema>;
export type CodexInstanceSettings = z.infer<typeof CodexInstanceSettingsSchema>;
export function controlledInstanceAcceptsTraffic(instance: Pick<ControlledInstance, "ready" | "runtimeVersion">) {
  return instance.ready !== false
    && (!instance.runtimeVersion || ["matched", "failed"].includes(instance.runtimeVersion.phase));
}
export type InstanceAppInventory = z.infer<typeof InstanceAppInventorySchema>;
export type InstanceAppInventoryItem = z.infer<typeof InstanceAppInventoryItemSchema>;
export type FinalComputerPlatform = z.infer<typeof FinalComputerPlatformSchema>;
export type FinalComputerArch = z.infer<typeof FinalComputerArchSchema>;
export type AppInstaller = z.infer<typeof AppInstallerSchema>;
export type AppInstallPrivilege = z.infer<typeof AppInstallPrivilegeSchema>;
export type FinalComputerCapabilities = z.infer<typeof FinalComputerCapabilitiesSchema>;
export type ManagedAppState = z.infer<typeof ManagedAppStateSchema>;
export type ManagedAppManagementSource = z.infer<typeof ManagedAppManagementSourceSchema>;
export type ManagedAppActionReason = z.infer<typeof ManagedAppActionReasonSchema>;
export type ManagedAppUpdateStatus = z.infer<typeof ManagedAppUpdateStatusSchema>;
export type ManagedAppUpdateState = z.infer<typeof ManagedAppUpdateStateSchema>;
export type ManagedAppUpdateCheck = z.infer<typeof ManagedAppUpdateCheckSchema>;
export type ManagedAppProjection = z.infer<typeof ManagedAppProjectionSchema>;
export type AppManagementOperation = z.infer<typeof AppManagementOperationSchema>;
export type AppManagementJobState = z.infer<typeof AppManagementJobStateSchema>;
export type AppManagementProgress = z.infer<typeof AppManagementProgressSchema>;
export type AppManagementError = z.infer<typeof AppManagementErrorSchema>;
export type AppManagementJob = z.infer<typeof AppManagementJobSchema>;
export type AppManagementSnapshot = z.infer<typeof AppManagementSnapshotSchema>;
export type AppManagementOperationRequest = z.infer<typeof AppManagementOperationRequestSchema>;
export type AppManagementJobResponse = z.infer<typeof AppManagementJobResponseSchema>;
export type AppManagementUpdateCheckResponse = z.infer<typeof AppManagementUpdateCheckResponseSchema>;
export type AppManagementEvent = z.infer<typeof AppManagementEventSchema>;
export type ControlledInstanceRegister = z.infer<typeof ControlledInstanceRegisterSchema>;
export type ControlledInstanceHeartbeat = z.infer<typeof ControlledInstanceHeartbeatSchema>;
export type ChatSessionBinding = z.infer<typeof ChatSessionBindingSchema>;
export type ChatBridgeConfig = z.infer<typeof ChatBridgeConfigSchema>;
export type ChatGatewayMessage = z.infer<typeof ChatGatewayMessageSchema>;
export type PendingRoute = z.infer<typeof PendingRouteSchema>;

// ---------------------------------------------------------------------------
// Control Plane management write inputs.
//
// These schemas are the single authoritative wire contract for requests the
// panel and `thctl` both send. They live in the protocol boundary so an
// independently upgraded CLI never has to depend on `packages/control-plane`
// internals. Server persistence records and derived state stay in the server.
// ---------------------------------------------------------------------------

export const DEFAULT_MENTION_TRIGGER = "@";
export const DEFAULT_COMMAND_TRIGGER = "/";

export function isValidMentionTrigger(value: string) {
  return Array.from(value).length === 1
    && !/[\p{L}\p{N}\s]/u.test(value)
    && value !== "/"
    && value !== "\\";
}

export const MentionTriggerSchema = z.string().refine(isValidMentionTrigger, "Mention trigger must be one printable non-alphanumeric character other than / or \\.");

export function isValidCommandTrigger(value: string) {
  return Array.from(value).length === 1
    && !/[\p{L}\p{N}\s]/u.test(value)
    && value !== "\\";
}

export const CommandTriggerSchema = z.string().refine(isValidCommandTrigger, "Command trigger must be one printable non-alphanumeric character other than \\.");

export const ControlPlaneSettingsSchema = z.object({
  publicBaseUrl: z.string().trim().max(2048).optional(),
  updateChannel: UpdateChannelSchema.default("stable"),
  mentionTrigger: MentionTriggerSchema.default(DEFAULT_MENTION_TRIGGER),
  commandTrigger: CommandTriggerSchema.default(DEFAULT_COMMAND_TRIGGER),
  diagnosticLogs: z.boolean().default(false),
}).strict().refine((settings) => settings.mentionTrigger !== settings.commandTrigger, {
  path: ["commandTrigger"], message: "Command and mention triggers must be different.",
});

export const UpdateControlPlaneSettingsSchema = z.object({
  publicBaseUrl: z.string().trim().max(2048).optional(),
  updateChannel: UpdateChannelSchema.optional(),
  mentionTrigger: MentionTriggerSchema.optional(),
  commandTrigger: CommandTriggerSchema.optional(),
  diagnosticLogs: z.boolean().optional(),
}).strict();

export function sanitizeStoredControlPlaneSettings(value: unknown, defaults: { diagnosticLogs?: boolean } = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const record = { ...(value as Record<string, unknown>) };
  if (typeof record.mentionTrigger !== "string" || !isValidMentionTrigger(record.mentionTrigger)) {
    record.mentionTrigger = DEFAULT_MENTION_TRIGGER;
  }
  if (typeof record.commandTrigger !== "string" || !isValidCommandTrigger(record.commandTrigger) || record.commandTrigger === record.mentionTrigger) {
    record.commandTrigger = DEFAULT_COMMAND_TRIGGER;
  }
  if (typeof record.diagnosticLogs !== "boolean") {
    record.diagnosticLogs = defaults.diagnosticLogs ?? false;
  }
  return record;
}

const CreateProjectInputBaseSchema = z.object({
  id: ProjectSchema.shape.id.optional(), name: ProjectSchema.shape.name, source: ProjectSourceSchema,
  defaultImageSelection: ProjectSchema.shape.defaultImageSelection, defaultNodeId: ProjectSchema.shape.defaultNodeId,
  workspacePolicy: WorkspacePolicySchema.optional(),
  labels: ProjectSchema.shape.labels.optional(),
});

// Compatibility for v0.0.21: accept the removed project runtime preference
// from N-1 clients, but do not expose or persist it in the current model.
const LegacyProjectRuntimeInputShape = { defaultRuntimeId: NodeRuntimeSchema.shape.id.optional() };
export const CreateProjectInputSchema = CreateProjectInputBaseSchema
  .extend(LegacyProjectRuntimeInputShape)
  .strict()
  .transform(({ defaultRuntimeId: _defaultRuntimeId, ...input }) => ({
    ...input,
    source: ProjectSourceSchema.parse(input.source),
  }));
export const UpdateProjectInputSchema = CreateProjectInputBaseSchema
  .omit({ id: true })
  .partial()
  .extend(LegacyProjectRuntimeInputShape)
  .strict()
  .transform(({ defaultRuntimeId: _defaultRuntimeId, ...input }) => ({
    ...input,
    ...(input.source ? { source: ProjectSourceSchema.parse(input.source) } : {}),
  }));
export type CreateProjectInput = z.infer<typeof CreateProjectInputSchema>;

export const CreateImageInputSchema = z.object({
  id: CustomImageProfileSchema.shape.id.optional(), name: CustomImageProfileSchema.shape.name,
  description: CustomImageProfileSchema.shape.description, cover: CustomImageProfileSchema.shape.cover,
  reference: CustomImageProfileSchema.shape.reference,
  pullPolicy: CustomImageProfileSchema.shape.pullPolicy.optional(), capabilities: z.array(z.string().trim().min(1).max(80)).optional(),
  optionalApps: z.array(z.string().trim().min(1).max(120)).optional(), defaultEnv: CustomImageProfileSchema.shape.defaultEnv.optional(),
  labels: CustomImageProfileSchema.shape.labels.optional(),
}).strict();
export const UpdateImageInputSchema = CreateImageInputSchema.omit({ id: true }).partial().strict();

export const CreateModelInputSchema = z.object({
  name: ModelConfigSchema.shape.name,
  endpoint: ModelConfigSchema.shape.endpoint,
  key: ModelConfigSchema.shape.key,
  model: ModelConfigSchema.shape.model,
  modelNames: ModelConfigSchema.shape.modelNames.optional(),
  mappings: ModelRequestMappingListSchema.optional(),
  protocols: ModelConfigSchema.shape.protocols.optional(),
  app: ModelConfigSchema.shape.app,
  enabled: ModelConfigSchema.shape.enabled.optional(),
  order: ModelConfigSchema.shape.order.optional(),
  labels: ModelConfigSchema.shape.labels.optional(),
}).strict();

export const CopyModelInputSchema = CreateModelInputSchema.omit({ key: true }).extend({
  key: ModelConfigSchema.shape.key.optional(),
}).strict();

export const UpdateModelInputSchema = CreateModelInputSchema.partial().strict();

export const ModelDiscoveryInputSchema = z.object({
  endpoint: ModelConfigSchema.shape.endpoint,
  key: ModelConfigSchema.shape.key.optional(),
  existingModelId: ModelConfigSchema.shape.id.optional(),
}).strict();

export const ModelTestInputSchema = ModelDiscoveryInputSchema.extend({
  model: ModelConfigSchema.shape.model,
  app: ModelConfigSchema.shape.app.optional(),
  protocol: z.enum(["openai-responses", "openai-chat-completions", "anthropic-messages"]).optional(),
}).strict().refine((input) => Boolean(input.protocol || input.app), { message: "A model protocol is required.", path: ["protocol"] });

export const NodeAuthInputSchema = z.object({
  mode: z.enum(["local-static-key", "paired-hmac", "proxy-binding"]).default("local-static-key"),
  keyId: NodeSchema.shape.id.optional(),
  secret: z.string().trim().max(4096).optional(),
  pairedAt: NodeSchema.shape.createdAt.optional(),
  pairing: z.object({
    status: z.enum(["pending", "paired", "expired"]).default("pending"),
    joinToken: z.string().trim().max(4096).optional(),
    expiresAt: NodeSchema.shape.createdAt.optional(),
  }).strict().optional(),
}).strict();

export const CreateNodeInputSchema = z.object({
  id: NodeSchema.shape.id.optional(),
  // Optional since v0.0.38: a typed name wins, and leaving it out falls back to
  // the hostname the node agent reports for its own machine.
  name: NodeSchema.shape.name.optional(),
  connectionMode: NodeSchema.shape.connectionMode.optional(),
  connectionPath: NodeSchema.shape.connectionPath.optional(),
  connectionEnabled: NodeSchema.shape.connectionEnabled.optional(),
  auth: NodeAuthInputSchema.optional(),
  joinToken: z.string().trim().min(1).max(4096).optional(),
  endpoint: NodeSchema.shape.endpoint,
  controlEndpoint: NodeSchema.shape.controlEndpoint,
  containerEndpoint: NodeSchema.shape.containerEndpoint,
  publicWebBase: NodeSchema.shape.publicWebBase,
  status: z.enum(["unknown", "online", "offline", "degraded"]).optional(),
  health: z.enum(["unknown", "ok", "degraded", "failed"]).optional(),
  capabilities: NodeSchema.shape.capabilities.optional(),
  labels: NodeSchema.shape.labels.optional(),
  lastSeenAt: NodeSchema.shape.lastSeenAt,
}).strict();

export const UpdateNodeInputSchema = z.object({
  name: NodeSchema.shape.name.optional(),
  connectionMode: NodeSchema.shape.connectionMode.unwrap().optional(),
  connectionPath: NodeSchema.shape.connectionPath.unwrap().optional(),
  connectionEnabled: NodeSchema.shape.connectionEnabled.unwrap().optional(),
  auth: NodeAuthInputSchema.optional(),
  endpoint: NodeSchema.shape.endpoint,
  controlEndpoint: NodeSchema.shape.controlEndpoint,
  containerEndpoint: NodeSchema.shape.containerEndpoint,
  publicWebBase: NodeSchema.shape.publicWebBase,
  status: NodeSchema.shape.status.unwrap().optional(),
  health: NodeSchema.shape.health.unwrap().optional(),
  capabilities: NodeSchema.shape.capabilities.unwrap().optional(),
  labels: NodeSchema.shape.labels.unwrap().optional(),
  lastSeenAt: NodeSchema.shape.lastSeenAt,
}).strict();

export const CreateNodeControlPlaneConnectionInputSchema = z.object({
  controlPlaneUrl: z.string().trim().url().max(2048),
  joinToken: z.string().trim().min(1).max(4096),
  controlPlaneName: z.string().trim().min(1).max(160).optional(),
  activate: z.boolean().optional(),
}).strict();

export const CreateNodeJoinInviteInputSchema = z.object({
  nodeName: z.string().trim().min(1).max(160).optional(),
  expiresInMs: z.number().int().positive().max(60 * 60 * 1000).optional(),
}).strict();
