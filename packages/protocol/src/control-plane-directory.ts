import { z } from "zod";
import { AiSessionPermissionModeSchema, InstanceBoardAiSummarySchema } from "./ai-sessions.ts";

const IdSchema = z.string().trim().min(1).max(120).regex(/^[a-zA-Z0-9][a-zA-Z0-9_.:-]*$/);
const TimestampSchema = z.string().datetime();

const DirectoryErrorSchema = z.object({
  code: z.string().trim().min(1).max(120),
  message: z.string().trim().min(1).max(2048),
}).strict();

export const ControlPlaneNodeDirectoryEntrySchema = z.object({
  id: IdSchema,
  name: z.string().trim().min(1).max(160),
  status: z.enum(["unknown", "online", "offline", "degraded"]),
  health: z.enum(["unknown", "ok", "degraded", "failed"]),
  connectionMode: z.enum(["local-ipc", "local-loopback", "direct-http", "reverse-wss", "control-plane-proxy"]),
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
  availableApps: z.array(ControlPlaneAvailableAppSchema).max(256).default([]),
  availableAgents: z.array(ControlPlaneAvailableAppSchema).max(256),
  error: DirectoryErrorSchema.optional(),
}).strict();

export const ControlPlaneInstanceDirectorySchema = z.array(ControlPlaneInstanceDirectoryEntrySchema);

export type ControlPlaneNodeDirectoryEntry = z.infer<typeof ControlPlaneNodeDirectoryEntrySchema>;
export type ControlPlaneInstanceDirectoryEntry = z.infer<typeof ControlPlaneInstanceDirectoryEntrySchema>;
