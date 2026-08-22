import { z } from "zod";
import { AiSessionPermissionModeSchema, InstanceBoardAiSummarySchema } from "./ai-sessions.ts";

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
}).passthrough();

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
]);

export const ControlPlaneInstanceLifecycleDirectoryEventSchema = z.object({
  instanceId: IdSchema,
  revision: z.number().int().nonnegative(),
  updatedAt: TimestampSchema,
  status: z.enum(["created", "provisioning", "starting", "registering", "registered", "running", "stopping", "stopped", "deleting", "failed", "unhealthy"]),
  health: z.enum(["unknown", "ok", "degraded", "failed"]),
  connectionStatus: z.enum(["unknown", "online", "offline", "endpoint-unreachable"]),
  ready: z.boolean(),
  lastHeartbeatAt: TimestampSchema.optional(),
}).strip();

const DirectoryErrorSchema = z.object({
  code: z.string().trim().min(1).max(120),
  message: z.string().trim().min(1).max(2048),
}).strict();

export const ControlPlaneFleetResourceSchema = z.enum(["instances", "runtimes", "models"]);
export const ControlPlaneFleetResourcePhaseSchema = z.enum(["uninitialized", "loading", "ready", "stale", "error"]);
export const ControlPlaneNodeFleetStateSchema = z.object({
  nodeId: IdSchema,
  resource: ControlPlaneFleetResourceSchema,
  phase: ControlPlaneFleetResourcePhaseSchema,
  revision: z.number().int().nonnegative().optional(),
  updatedAt: TimestampSchema.optional(),
  error: z.object({
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
  }).passthrough().optional(),
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
  }).strict().default({ defaultCodexPermissionMode: "ask" }),
  lastHeartbeatAt: TimestampSchema.optional(),
  heartbeatAgeMs: z.number().int().nonnegative().optional(),
  observedAt: TimestampSchema,
  runtime: z.object({
    id: IdSchema,
    name: z.string().trim().min(1).max(160).optional(),
    type: z.enum(["docker", "kubernetes", "local"]).optional(),
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
export type ControlPlaneInstanceDirectoryEntry = z.infer<typeof ControlPlaneInstanceDirectoryEntrySchema>;
export type ControlPlaneNodeConnectionPhase = z.infer<typeof ControlPlaneNodeConnectionPhaseSchema>;
export type ControlPlaneInstanceAction = z.infer<typeof ControlPlaneInstanceActionSchema>;
export type ControlPlaneInstanceLifecycleDirectoryEvent = z.infer<typeof ControlPlaneInstanceLifecycleDirectoryEventSchema>;
export type ControlPlaneFleetResource = z.infer<typeof ControlPlaneFleetResourceSchema>;
export type ControlPlaneFleetResourcePhase = z.infer<typeof ControlPlaneFleetResourcePhaseSchema>;
export type ControlPlaneNodeFleetState = z.infer<typeof ControlPlaneNodeFleetStateSchema>;
