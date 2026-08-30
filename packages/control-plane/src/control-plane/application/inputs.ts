import {
  ControlledInstanceSchema,
  EnvironmentSourceSchema,
  ModelConfigSchema,
  NodeSchema,
  ProjectSourceSchema,
} from "@task-handoff/protocol/control-plane";
import { z } from "zod";
import { AI_SESSION_ATTACHMENT_RETENTION_MAX_DAYS, AI_SESSION_HISTORY_MAX_LIMIT, AI_SESSION_MAX_CONFIGURABLE_FILE_ATTACHMENT_BYTES, AiSessionPermissionModeSchema } from "@task-handoff/protocol/ai-sessions";
import { GitCredentialRetentionSchema } from "@task-handoff/protocol/managed-git-credentials";

export * from "../catalog/inputs.ts";
export * from "../chat/bridges/inputs.ts";
export * from "../triggers/inputs.ts";

const NodeAuthInputSchema = z.object({
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

export const InstanceConfigInputSchema = z.object({
  autoImportAgentConfigs: z.boolean().optional(),
  defaultCodexPermissionMode: AiSessionPermissionModeSchema.optional(),
  aiSessionHistoryLimit: z.number().int().min(1).max(AI_SESSION_HISTORY_MAX_LIMIT).optional(),
  aiSessionAttachmentRetentionDays: z.number().int().min(0).max(AI_SESSION_ATTACHMENT_RETENTION_MAX_DAYS).optional(),
  aiSessionMaxFileAttachmentBytes: z.number().int().positive().max(AI_SESSION_MAX_CONFIGURABLE_FILE_ATTACHMENT_BYTES).optional(),
}).strict();

export const CreateInstanceInputSchema = z.object({
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

export const UpdateInstanceInputSchema = z.object({
  name: ControlledInstanceSchema.shape.name.optional(),
  config: InstanceConfigInputSchema.optional(),
  modelSelection: ControlledInstanceSchema.shape.modelSelection.unwrap().optional(),
}).strict();

export const CreateModelInputSchema = z.object({
  name: ModelConfigSchema.shape.name,
  endpoint: ModelConfigSchema.shape.endpoint,
  key: ModelConfigSchema.shape.key,
  model: ModelConfigSchema.shape.model,
  modelNames: ModelConfigSchema.shape.modelNames.optional(),
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

export const CreateNodeInputSchema = z.object({
  id: NodeSchema.shape.id.optional(),
  name: NodeSchema.shape.name,
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

export type CreateModelInput = z.infer<typeof CreateModelInputSchema>;
export type UpdateModelInput = z.infer<typeof UpdateModelInputSchema>;
export type ModelDiscoveryInput = z.infer<typeof ModelDiscoveryInputSchema>;
export type ModelTestInput = z.infer<typeof ModelTestInputSchema>;
export type CreateNodeInput = z.infer<typeof CreateNodeInputSchema>;
export type UpdateNodeInput = z.infer<typeof UpdateNodeInputSchema>;
export type CreateNodeControlPlaneConnectionInput = z.infer<typeof CreateNodeControlPlaneConnectionInputSchema>;
export type CreateInstanceInput = z.infer<typeof CreateInstanceInputSchema>;
export type UpdateInstanceInput = z.infer<typeof UpdateInstanceInputSchema>;
