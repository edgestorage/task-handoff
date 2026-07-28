import { CustomImageProfileSchema, ProjectSchema, ProjectSourceSchema, UpdateChannelSchema, WorkspacePolicySchema } from "@task-handoff/protocol/control-plane";
import { z } from "zod";

export const CreateProjectInputSchema = z.object({
  id: ProjectSchema.shape.id.optional(), name: ProjectSchema.shape.name, source: ProjectSourceSchema,
  defaultImageSelection: ProjectSchema.shape.defaultImageSelection, defaultNodeId: ProjectSchema.shape.defaultNodeId,
  defaultRuntimeId: ProjectSchema.shape.defaultRuntimeId, workspacePolicy: WorkspacePolicySchema.optional(),
  labels: ProjectSchema.shape.labels.optional(),
}).strict();
export const UpdateProjectInputSchema = CreateProjectInputSchema.omit({ id: true }).partial().strict();
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
}).strict().refine((settings) => settings.mentionTrigger !== settings.commandTrigger, {
  path: ["commandTrigger"], message: "Command and mention triggers must be different.",
});
export const UpdateControlPlaneSettingsSchema = z.object({
  publicBaseUrl: z.string().trim().max(2048).optional(),
  updateChannel: UpdateChannelSchema.optional(),
  mentionTrigger: MentionTriggerSchema.optional(),
  commandTrigger: CommandTriggerSchema.optional(),
}).strict();

export function sanitizeStoredControlPlaneSettings(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const record = { ...(value as Record<string, unknown>) };
  if (typeof record.mentionTrigger !== "string" || !isValidMentionTrigger(record.mentionTrigger)) {
    record.mentionTrigger = DEFAULT_MENTION_TRIGGER;
  }
  if (typeof record.commandTrigger !== "string" || !isValidCommandTrigger(record.commandTrigger) || record.commandTrigger === record.mentionTrigger) {
    record.commandTrigger = DEFAULT_COMMAND_TRIGGER;
  }
  return record;
}
export const CreateImageInputSchema = z.object({
  id: CustomImageProfileSchema.shape.id.optional(), name: CustomImageProfileSchema.shape.name,
  description: CustomImageProfileSchema.shape.description, cover: CustomImageProfileSchema.shape.cover,
  reference: CustomImageProfileSchema.shape.reference,
  pullPolicy: CustomImageProfileSchema.shape.pullPolicy.optional(), capabilities: z.array(z.string().trim().min(1).max(80)).optional(),
  optionalApps: z.array(z.string().trim().min(1).max(120)).optional(), defaultEnv: CustomImageProfileSchema.shape.defaultEnv.optional(),
  labels: CustomImageProfileSchema.shape.labels.optional(),
}).strict();
export const UpdateImageInputSchema = CreateImageInputSchema.omit({ id: true }).partial().strict();
export type CreateProjectInput = z.infer<typeof CreateProjectInputSchema>;
export type UpdateProjectInput = z.infer<typeof UpdateProjectInputSchema>;
export type CreateImageInput = z.infer<typeof CreateImageInputSchema>;
export type UpdateImageInput = z.infer<typeof UpdateImageInputSchema>;
export type ControlPlaneSettings = z.infer<typeof ControlPlaneSettingsSchema>;
export type UpdateControlPlaneSettingsInput = z.infer<typeof UpdateControlPlaneSettingsSchema>;
