import { z } from "zod";
import { AI_SESSION_DEFAULT_MAX_FILE_ATTACHMENT_BYTES, AiSessionPermissionModeSchema, InstanceBoardAiSummarySchema } from "./ai-sessions.ts";
import { AiSessionProviderCapabilitiesSchema } from "./ai-session-provider-capabilities.ts";

const IdSchema = z.string().trim().min(1).max(120).regex(/^[a-zA-Z0-9][a-zA-Z0-9_.:-]*$/);
const TimestampSchema = z.string().datetime();

const ControlPlaneDirectoryTimelineCapabilitiesSchema = z.object({
  sessionReadAgents: z.array(z.string().trim().min(1).max(120)).max(100).default([]),
  turnReadAgents: z.array(z.string().trim().min(1).max(120)).max(100).default([]),
  liveItemAgents: z.array(z.string().trim().min(1).max(120)).max(100).default([]),
}).passthrough();

function emptyDirectoryTimelineCapabilities() {
  return { sessionReadAgents: [] as string[], turnReadAgents: [] as string[], liveItemAgents: [] as string[] };
}

const ControlPlaneDirectoryConversationAttachmentCapabilitiesSchema = z.object({
  metadataAgents: z.array(z.string().trim().min(1).max(120)).max(100).default([]),
  contentAgents: z.array(z.string().trim().min(1).max(120)).max(100).default([]),
  uploadAgents: z.array(z.string().trim().min(1).max(120)).max(100).default([]),
  retentionSettings: z.boolean().default(false),
}).passthrough();

function emptyDirectoryConversationAttachmentCapabilities() {
  return { metadataAgents: [] as string[], contentAgents: [] as string[], uploadAgents: [] as string[], retentionSettings: false };
}

// Compatibility for v0.0.21: older directory responses omit this additive
// public capability projection and therefore normalize to unsupported.
export const ControlPlaneInstanceDirectoryCapabilitiesSchema = z.object({
  aiSessionTimeline: ControlPlaneDirectoryTimelineCapabilitiesSchema.default(emptyDirectoryTimelineCapabilities),
  aiSessionConversationAttachments: ControlPlaneDirectoryConversationAttachmentCapabilitiesSchema.optional(),
  aiSessionProviders: AiSessionProviderCapabilitiesSchema.optional(),
  browserTunnel: z.boolean().optional(),
  // Compatibility for v0.0.35: older directory producers omit this additive
  // projection, so the AI Session queue pause control normalizes to unsupported.
  aiSessionQueuePause: z.boolean().optional(),
}).passthrough();

export function supportsDirectoryBrowserTunnel(capabilities: unknown) {
  const parsed = ControlPlaneInstanceDirectoryCapabilitiesSchema.safeParse(capabilities);
  return parsed.success && parsed.data.browserTunnel === true;
}

export function supportsDirectoryAiSessionQueuePause(capabilities: unknown) {
  const parsed = ControlPlaneInstanceDirectoryCapabilitiesSchema.safeParse(capabilities);
  return parsed.success && parsed.data.aiSessionQueuePause === true;
}

export function directoryAiSessionProviderCapability(capabilities: unknown, agent: string) {
  const parsed = ControlPlaneInstanceDirectoryCapabilitiesSchema.safeParse(capabilities);
  return parsed.success ? parsed.data.aiSessionProviders?.find((provider) => provider.agent === agent) : undefined;
}

export function supportsDirectoryAiSessionTimelineCapability(
  capabilities: unknown,
  agent: string,
  capability: "session-read" | "turn-read" | "live-items",
) {
  const parsed = ControlPlaneInstanceDirectoryCapabilitiesSchema.safeParse(capabilities);
  if (!parsed.success) return false;
  const timeline = parsed.data.aiSessionTimeline;
  const agents = capability === "session-read" ? timeline.sessionReadAgents
    : capability === "turn-read" ? timeline.turnReadAgents
      : timeline.liveItemAgents;
  return agents.includes(agent);
}

export function supportsDirectoryAiSessionConversationAttachmentCapability(
  capabilities: unknown,
  agent: string,
  capability: "metadata" | "content" | "upload",
) {
  const parsed = ControlPlaneInstanceDirectoryCapabilitiesSchema.safeParse(capabilities);
  if (!parsed.success) return false;
  const attachments = parsed.data.aiSessionConversationAttachments || emptyDirectoryConversationAttachmentCapabilities();
  const agents = capability === "metadata" ? attachments.metadataAgents
    : capability === "content" ? attachments.contentAgents
      : attachments.uploadAgents;
  return agents.includes(agent);
}

export function supportsDirectoryAiSessionAttachmentRetentionSettings(capabilities: unknown) {
  const parsed = ControlPlaneInstanceDirectoryCapabilitiesSchema.safeParse(capabilities);
  return parsed.success && (parsed.data.aiSessionConversationAttachments?.retentionSettings ?? false);
}

export const ControlPlaneNodeConnectionPhaseSchema = z.enum([
  "connecting",
  "handshaking",
  "healthy",
  "reconnecting",
  "suspect",
  "offline",
]);

export const ControlPlaneInstanceActionSchema = z.enum([
  "start",
  "stop",
  "restart",
  "retry-image",
  "retry-git",
]);

const ControlPlaneInstanceStatusSchema = z.enum(["created", "provisioning", "starting", "registering", "registered", "running", "stopping", "stopped", "deleting", "failed", "unhealthy"]);
const ControlPlaneInstanceConnectionStatusSchema = z.enum(["unknown", "online", "offline", "endpoint-unreachable"]);
const ControlPlaneInstanceAccessStatusSchema = z.enum(["reachable", "endpoint-unreachable"]);

/**
 * Action availability depends on lifecycle fields only, so the Control Plane and the
 * mobile directory derive it from one rule instead of keeping a second implementation
 * that drifts. A directory client can therefore recompute the actions from a lifecycle
 * snapshot instead of re-fetching the board whenever an instance revision moves.
 */
export function instanceDirectoryAvailableActions(input: {
  status: z.infer<typeof ControlPlaneInstanceStatusSchema>;
  connectionStatus: z.infer<typeof ControlPlaneInstanceConnectionStatusSchema>;
  accessStatus?: z.infer<typeof ControlPlaneInstanceAccessStatusSchema> | "unknown";
  imageProvisioningPhase?: string;
  gitProvisioningPhase?: string;
}): ControlPlaneInstanceAction[] {
  const { status, connectionStatus } = input;
  const running = status === "running" || connectionStatus === "online" || input.accessStatus === "reachable";
  const connecting = !["failed", "stopped", "stopping", "unhealthy"].includes(status)
    && connectionStatus !== "online"
    && ["provisioning", "starting", "registering", "registered"].includes(status);
  return [
    !running && !["provisioning", "starting", "registering", "registered", "stopping"].includes(status) ? "start" as const : undefined,
    !["failed", "stopped", "stopping", "unhealthy"].includes(status) && (running || connecting) ? "stop" as const : undefined,
    running ? "restart" as const : undefined,
    status === "failed" && input.imageProvisioningPhase === "failed" ? "retry-image" as const : undefined,
    status === "failed" && input.gitProvisioningPhase === "failed" ? "retry-git" as const : undefined,
  ].filter((action): action is ControlPlaneInstanceAction => Boolean(action));
}

/**
 * The Relay publishes the full node-agent lifecycle snapshot on the `instances` topic,
 * so this directory event keeps the provisioning phases it needs to derive the actions
 * above locally. Unknown keys stay stripped.
 */
const ControlPlaneInstanceLifecycleProvisioningSchema = z.object({
  phase: z.string().trim().min(1).max(80).optional(),
}).strip();

export const ControlPlaneInstanceLifecycleDirectoryEventSchema = z.object({
  instanceId: IdSchema,
  revision: z.number().int().nonnegative(),
  updatedAt: TimestampSchema,
  status: ControlPlaneInstanceStatusSchema,
  health: z.enum(["unknown", "ok", "degraded", "failed"]),
  connectionStatus: ControlPlaneInstanceConnectionStatusSchema,
  accessStatus: ControlPlaneInstanceAccessStatusSchema.optional(),
  imageProvisioning: ControlPlaneInstanceLifecycleProvisioningSchema.optional(),
  workspace: z.object({ gitProvisioning: ControlPlaneInstanceLifecycleProvisioningSchema.optional() }).strip().optional(),
  ready: z.boolean(),
  lastHeartbeatAt: TimestampSchema.optional(),
}).strip();

/**
 * Liveness-only projection of the lifecycle stream. The node agent republishes an
 * instance on every heartbeat observation, and only the observation timestamps move;
 * this frame keeps the heartbeat clock fresh without repeating the directory fields a
 * consumer already holds, so it must never be treated as a full snapshot.
 */
export const ControlPlaneInstanceLifecycleHeartbeatDirectoryEventSchema = z.object({
  instanceId: IdSchema,
  revision: z.number().int().nonnegative(),
  updatedAt: TimestampSchema,
  lastHeartbeatAt: TimestampSchema.optional(),
}).strip();

const DirectoryErrorSchema = z.object({
  code: z.string().trim().min(1).max(120),
  message: z.string().trim().min(1).max(2048),
}).strict();

export const ControlPlaneFleetResourceSchema = z.enum(["instances", "runtimes", "models"]);
export const ControlPlaneFleetResourcePhaseSchema = z.enum(["uninitialized", "loading", "ready", "stale", "error"]);
/** One node-agent request failure scoped to the node it was read from. */
export const ControlPlaneNodeFleetErrorSchema = z.object({
  nodeId: IdSchema,
  route: z.string().trim().min(1).max(500),
  method: z.string().trim().min(1).max(20),
  code: z.string().trim().min(1).max(120),
  message: z.string().trim().min(1).max(4096),
  statusCode: z.number().int().optional(),
  issues: z.array(z.object({
    path: z.array(z.union([z.string(), z.number()])).optional(),
    message: z.string(),
  }).passthrough()).optional(),
}).passthrough();

export const ControlPlaneNodeFleetStateSchema = z.object({
  nodeId: IdSchema,
  resource: ControlPlaneFleetResourceSchema,
  phase: ControlPlaneFleetResourcePhaseSchema,
  revision: z.number().int().nonnegative().optional(),
  updatedAt: TimestampSchema.optional(),
  error: ControlPlaneNodeFleetErrorSchema.optional(),
}).strict();

// Event wire model is intentionally separate from the directory snapshot.
// Compatibility for v0.0.23: old producers omit this additive hint. Consumers
// must treat absence as unknown and recover their authoritative topic; current
// producers send an explicit false for diagnostic-only changes.
export const ControlPlaneNodeFleetUpdatedEventSchema = ControlPlaneNodeFleetStateSchema.extend({
  contentChanged: z.boolean().optional(),
}).strict();

export const ControlPlaneFleetDirectoryMetaSchema = z.object({
  nodeStates: z.array(ControlPlaneNodeFleetStateSchema).default([]),
}).passthrough();

export const ControlPlaneNodeDirectoryEntrySchema = z.object({
  id: IdSchema,
  name: z.string().trim().min(1).max(160),
  status: z.enum(["unknown", "online", "offline", "degraded"]),
  health: z.enum(["unknown", "ok", "degraded", "failed"]),
  connectionMode: z.enum(["local-ipc", "local-loopback", "direct-http", "reverse-wss", "control-plane-proxy"]),
  connectionPhase: ControlPlaneNodeConnectionPhaseSchema.optional(),
  lastSeenAt: TimestampSchema.optional(),
  observedAt: TimestampSchema,
  capabilities: z.array(z.string().trim().min(1).max(120)).max(256),
  error: DirectoryErrorSchema.optional(),
}).strict();

export const ControlPlaneNodeDirectorySchema = z.array(ControlPlaneNodeDirectoryEntrySchema);

export const ControlPlaneAvailableAppSchema = z.object({
  id: z.string().trim().min(1).max(120),
  name: z.string().trim().min(1).max(120),
  kind: z.enum(["tty", "gui", "web"]),
  supportsCwdSelection: z.boolean(),
}).strict();

const ControlPlaneDirectoryModelSelectionSchema = z.object({
  modelEntityIds: z.array(IdSchema).max(64).transform((ids) => [...new Set(ids)]).optional(),
  // Compatibility for v0.0.23 directory producers.
  codexModelHash: IdSchema.nullable().optional(),
  claudeModelHash: IdSchema.nullable().optional(),
  opencodeModelHash: IdSchema.nullable().optional(),
}).strict().default({});

export const ControlPlaneInstanceDirectoryEntrySchema = z.object({
  id: IdSchema,
  name: z.string().trim().min(1).max(160),
  nodeId: IdSchema,
  status: z.enum(["created", "provisioning", "starting", "registering", "registered", "running", "stopping", "stopped", "deleting", "failed", "unhealthy"]),
  health: z.enum(["unknown", "ok", "degraded", "failed"]),
  connectionStatus: z.enum(["unknown", "online", "offline", "endpoint-unreachable"]),
  ready: z.boolean(),
  capabilities: ControlPlaneInstanceDirectoryCapabilitiesSchema.default({
    aiSessionTimeline: emptyDirectoryTimelineCapabilities(),
  }),
  config: z.object({
    defaultCodexPermissionMode: AiSessionPermissionModeSchema.default("ask"),
    aiSessionMaxFileAttachmentBytes: z.number().int().positive().default(AI_SESSION_DEFAULT_MAX_FILE_ATTACHMENT_BYTES),
  }).strict().default({ defaultCodexPermissionMode: "ask", aiSessionMaxFileAttachmentBytes: AI_SESSION_DEFAULT_MAX_FILE_ATTACHMENT_BYTES }),
  modelSelection: ControlPlaneDirectoryModelSelectionSchema,
  lastHeartbeatAt: TimestampSchema.optional(),
  heartbeatAgeMs: z.number().int().nonnegative().optional(),
  observedAt: TimestampSchema,
  runtime: z.object({
    id: IdSchema,
    name: z.string().trim().min(1).max(160).optional(),
    // Consumer-side tolerance (add-wsl-runtime D11): 目录投影只发布 runtime 标识，
    // 新增 runtime 类型不得让整条目录项解析失败。
    type: z.string().trim().min(1).max(60).optional(),
  }).strict(),
  workspace: z.object({
    status: z.enum(["unknown", "pending", "ready", "failed"]),
    path: z.string().trim().max(4096).optional(),
  }).strict(),
  protocol: z.object({
    version: z.string().optional(),
    compatible: z.boolean(),
    warning: z.string().trim().min(1).max(500).optional(),
  }).strict(),
  aiSessions: InstanceBoardAiSummarySchema,
  availableActions: z.array(ControlPlaneInstanceActionSchema).max(4).default([]),
  availableApps: z.array(ControlPlaneAvailableAppSchema).max(256).default([]),
  availableAgents: z.array(ControlPlaneAvailableAppSchema).max(256),
  error: DirectoryErrorSchema.optional(),
}).strict();

export const ControlPlaneInstanceDirectorySchema = z.array(ControlPlaneInstanceDirectoryEntrySchema);

export type ControlPlaneNodeDirectoryEntry = z.infer<typeof ControlPlaneNodeDirectoryEntrySchema>;
export type ControlPlaneInstanceDirectoryCapabilities = z.infer<typeof ControlPlaneInstanceDirectoryCapabilitiesSchema>;
export type ControlPlaneInstanceDirectoryEntry = z.infer<typeof ControlPlaneInstanceDirectoryEntrySchema>;
export type ControlPlaneNodeConnectionPhase = z.infer<typeof ControlPlaneNodeConnectionPhaseSchema>;
export type ControlPlaneInstanceAction = z.infer<typeof ControlPlaneInstanceActionSchema>;
export type ControlPlaneInstanceLifecycleDirectoryEvent = z.infer<typeof ControlPlaneInstanceLifecycleDirectoryEventSchema>;
export type ControlPlaneInstanceLifecycleHeartbeatDirectoryEvent = z.infer<typeof ControlPlaneInstanceLifecycleHeartbeatDirectoryEventSchema>;
export type ControlPlaneFleetResource = z.infer<typeof ControlPlaneFleetResourceSchema>;
export type ControlPlaneFleetResourcePhase = z.infer<typeof ControlPlaneFleetResourcePhaseSchema>;
export type ControlPlaneNodeFleetState = z.infer<typeof ControlPlaneNodeFleetStateSchema>;
export type ControlPlaneNodeFleetUpdatedEvent = z.infer<typeof ControlPlaneNodeFleetUpdatedEventSchema>;
