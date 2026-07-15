import { ImageProfileSchema, ProjectSchema, ProjectSourceSchema, UpdateChannelSchema, WorkspacePolicySchema } from "@task-handoff/protocol/control-plane";
import { z } from "zod";

export const CreateProjectInputSchema = z.object({
  id: ProjectSchema.shape.id.optional(), name: ProjectSchema.shape.name, source: ProjectSourceSchema,
  defaultImageId: ProjectSchema.shape.defaultImageId, defaultNodeId: ProjectSchema.shape.defaultNodeId,
  defaultRuntimeId: ProjectSchema.shape.defaultRuntimeId, workspacePolicy: WorkspacePolicySchema.optional(),
  labels: ProjectSchema.shape.labels.optional(),
}).strict();
export const UpdateProjectInputSchema = CreateProjectInputSchema.omit({ id: true }).partial().strict();
export const ControlPlaneSettingsSchema = z.object({ publicBaseUrl: z.string().trim().max(2048).optional(), updateChannel: UpdateChannelSchema.default("stable") }).strict();
export const UpdateControlPlaneSettingsSchema = ControlPlaneSettingsSchema.partial().strict();
export const CreateImageInputSchema = z.object({
  id: ImageProfileSchema.shape.id.optional(), name: ImageProfileSchema.shape.name, image: ImageProfileSchema.shape.image,
  registry: ImageProfileSchema.shape.registry.optional(), capabilities: z.array(z.string().trim().min(1).max(80)).optional(),
  optionalApps: z.array(z.string().trim().min(1).max(120)).optional(), defaultEnv: ImageProfileSchema.shape.defaultEnv.optional(),
  labels: ImageProfileSchema.shape.labels.optional(),
}).strict();
export const UpdateImageInputSchema = CreateImageInputSchema.omit({ id: true }).partial().strict();
export type CreateProjectInput = z.infer<typeof CreateProjectInputSchema>;
export type UpdateProjectInput = z.infer<typeof UpdateProjectInputSchema>;
export type CreateImageInput = z.infer<typeof CreateImageInputSchema>;
export type UpdateImageInput = z.infer<typeof UpdateImageInputSchema>;
export type ControlPlaneSettings = z.infer<typeof ControlPlaneSettingsSchema>;
export type UpdateControlPlaneSettingsInput = z.infer<typeof UpdateControlPlaneSettingsSchema>;
