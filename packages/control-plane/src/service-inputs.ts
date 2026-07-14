import {
  ChatBridgeConfigSchema,
  ControlledInstanceSchema,
  ImageProfileSchema,
  ModelConfigSchema,
  NodeSchema,
  ProjectSchema,
  ProjectSourceSchema,
  UpdateChannelSchema,
  WorkspacePolicySchema,
} from "@task-handoff/protocol/control-plane";
import {
  TriggerActionSchema,
  TriggerConfigSchema,
  TriggerPolicySchema,
  TriggerSourceSchema,
  TriggerTargetSchema,
} from "@task-handoff/protocol/triggers";
import { z } from "zod";

const NodeAuthInputSchema = z.object({
  mode: z.enum(["local-static-key", "paired-hmac"]).default("local-static-key"),
  keyId: NodeSchema.shape.id.optional(),
  secret: z.string().trim().max(4096).optional(),
  pairedAt: NodeSchema.shape.createdAt.optional(),
  pairing: z.object({
    status: z.enum(["pending", "paired", "expired"]).default("pending"),
    joinToken: z.string().trim().max(4096).optional(),
    expiresAt: NodeSchema.shape.createdAt.optional(),
  }).strict().optional(),
}).strict();

export const CreateProjectInputSchema = z.object({
  id: ProjectSchema.shape.id.optional(),
  name: ProjectSchema.shape.name,
  source: ProjectSourceSchema,
  defaultImageId: ProjectSchema.shape.defaultImageId,
  defaultNodeId: ProjectSchema.shape.defaultNodeId,
  defaultRuntimeId: ProjectSchema.shape.defaultRuntimeId,
  workspacePolicy: WorkspacePolicySchema.optional(),
  labels: ProjectSchema.shape.labels.optional(),
}).strict();

export const UpdateProjectInputSchema = CreateProjectInputSchema.omit({ id: true }).partial().strict();

export const CreateInstanceInputSchema = z.object({
  id: ControlledInstanceSchema.shape.id.optional(),
  name: ControlledInstanceSchema.shape.name.optional(),
  projectId: ControlledInstanceSchema.shape.projectId,
  source: ProjectSourceSchema.optional(),
  sourceSnapshot: z.record(z.string(), z.unknown()).optional(),
  nodeId: ControlledInstanceSchema.shape.nodeId.optional(),
  runtimeId: ControlledInstanceSchema.shape.runtimeId.optional(),
  imageId: ControlledInstanceSchema.shape.imageId,
  config: ControlledInstanceSchema.shape.config.optional(),
  modelSelection: ControlledInstanceSchema.shape.modelSelection.optional(),
}).strict();

export const UpdateInstanceInputSchema = z.object({
  name: ControlledInstanceSchema.shape.name.optional(),
  modelSelection: ControlledInstanceSchema.shape.modelSelection.optional(),
}).strict();

export const ControlPlaneSettingsSchema = z.object({
  publicBaseUrl: z.string().trim().max(2048).optional(),
  updateChannel: UpdateChannelSchema.default("stable"),
}).strict();

export const UpdateControlPlaneSettingsSchema = ControlPlaneSettingsSchema.partial().strict();

export const CreateModelInputSchema = z.object({
  id: ModelConfigSchema.shape.id.optional(),
  name: ModelConfigSchema.shape.name,
  endpoint: ModelConfigSchema.shape.endpoint,
  key: ModelConfigSchema.shape.key,
  model: ModelConfigSchema.shape.model,
  app: ModelConfigSchema.shape.app,
  enabled: ModelConfigSchema.shape.enabled.optional(),
  order: ModelConfigSchema.shape.order.optional(),
  labels: ModelConfigSchema.shape.labels.optional(),
}).strict();

export const UpdateModelInputSchema = CreateModelInputSchema.omit({ id: true }).partial().strict();

export const CreateImageInputSchema = z.object({
  id: ImageProfileSchema.shape.id.optional(),
  name: ImageProfileSchema.shape.name,
  image: ImageProfileSchema.shape.image,
  registry: ImageProfileSchema.shape.registry.optional(),
  capabilities: z.array(z.string().trim().min(1).max(80)).optional(),
  optionalApps: z.array(z.string().trim().min(1).max(120)).optional(),
  defaultEnv: ImageProfileSchema.shape.defaultEnv.optional(),
  labels: ImageProfileSchema.shape.labels.optional(),
}).strict();

export const UpdateImageInputSchema = CreateImageInputSchema.omit({ id: true }).partial().strict();

export const CreateNodeInputSchema = z.object({
  id: NodeSchema.shape.id.optional(),
  name: NodeSchema.shape.name,
  connectionMode: NodeSchema.shape.connectionMode.optional(),
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

export const ConnectNodeRemoteInputSchema = z.object({
  controlPlaneUrl: z.string().trim().url().max(2048),
  joinToken: z.string().trim().min(1).max(4096),
  controlPlaneName: z.string().trim().min(1).max(160).optional(),
  activate: z.boolean().optional(),
}).strict();

export const CreateNodeJoinInviteInputSchema = z.object({
  nodeName: z.string().trim().min(1).max(160).optional(),
  expiresInMs: z.number().int().positive().max(60 * 60 * 1000).optional(),
}).strict();

export const UpdateChatBridgeInputSchema = z.object({
  name: ChatBridgeConfigSchema.shape.name.optional(),
  channel: ChatBridgeConfigSchema.shape.channel.optional(),
  enabled: z.boolean().optional(),
  token: ChatBridgeConfigSchema.shape.token,
  defaultChatId: ChatBridgeConfigSchema.shape.defaultChatId,
  allowedUserIds: z.array(z.string().trim().min(1).max(240)).optional(),
  pollIntervalMs: ChatBridgeConfigSchema.shape.pollIntervalMs.optional(),
  settings: ChatBridgeConfigSchema.shape.settings.optional(),
}).strict();

export const CreateChatBridgeInputSchema = UpdateChatBridgeInputSchema.extend({
  channel: ChatBridgeConfigSchema.shape.channel,
  name: ChatBridgeConfigSchema.shape.name.optional(),
});

export const ControlPlaneTriggerRecordSchema = TriggerConfigSchema.extend({
  id: TriggerConfigSchema.shape.configHash,
});

export const CreateControlPlaneTriggerSchema = z.object({
  name: TriggerConfigSchema.shape.name,
  description: TriggerConfigSchema.shape.description,
  source: TriggerSourceSchema,
  action: TriggerActionSchema,
  policy: TriggerPolicySchema.partial().optional(),
}).strict();

export const ApplyControlPlaneTriggerSchema = z.object({
  instanceIds: z.array(ControlledInstanceSchema.shape.id).min(1),
  target: TriggerTargetSchema,
  enabled: z.boolean().optional(),
}).strict();

export const BindAiSessionTriggerSchema = z.object({
  configHash: TriggerConfigSchema.shape.configHash,
  enabled: z.boolean().optional(),
}).strict();

export type CreateProjectInput = z.infer<typeof CreateProjectInputSchema>;
export type UpdateProjectInput = z.infer<typeof UpdateProjectInputSchema>;
export type CreateModelInput = z.infer<typeof CreateModelInputSchema>;
export type UpdateModelInput = z.infer<typeof UpdateModelInputSchema>;
export type CreateImageInput = z.infer<typeof CreateImageInputSchema>;
export type UpdateImageInput = z.infer<typeof UpdateImageInputSchema>;
export type CreateNodeInput = z.infer<typeof CreateNodeInputSchema>;
export type UpdateNodeInput = z.infer<typeof UpdateNodeInputSchema>;
export type ConnectNodeRemoteInput = z.infer<typeof ConnectNodeRemoteInputSchema>;
export type CreateInstanceInput = z.infer<typeof CreateInstanceInputSchema>;
export type UpdateInstanceInput = z.infer<typeof UpdateInstanceInputSchema>;
export type ControlPlaneSettings = z.infer<typeof ControlPlaneSettingsSchema>;
export type UpdateControlPlaneSettingsInput = z.infer<typeof UpdateControlPlaneSettingsSchema>;
export type UpdateChatBridgeInput = z.infer<typeof UpdateChatBridgeInputSchema>;
export type CreateChatBridgeInput = z.infer<typeof CreateChatBridgeInputSchema>;
export type ControlPlaneTriggerRecord = z.infer<typeof ControlPlaneTriggerRecordSchema>;
