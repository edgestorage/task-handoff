import { ChatBridgeConfigSchema } from "@task-handoff/protocol/control-plane";
import { z } from "zod";

export const UpdateChatBridgeInputSchema = z.object({
  name: ChatBridgeConfigSchema.shape.name.optional(), channel: ChatBridgeConfigSchema.shape.channel.optional(), enabled: z.boolean().optional(),
  token: ChatBridgeConfigSchema.shape.token, defaultChatId: ChatBridgeConfigSchema.shape.defaultChatId,
  allowedUserIds: z.array(z.string().trim().min(1).max(240)).optional(), pollIntervalMs: ChatBridgeConfigSchema.shape.pollIntervalMs.optional(),
  settings: ChatBridgeConfigSchema.shape.settings.optional(),
}).strict();
export const CreateChatBridgeInputSchema = UpdateChatBridgeInputSchema.extend({ channel: ChatBridgeConfigSchema.shape.channel, name: ChatBridgeConfigSchema.shape.name.optional() });
export type UpdateChatBridgeInput = z.infer<typeof UpdateChatBridgeInputSchema>;
export type CreateChatBridgeInput = z.infer<typeof CreateChatBridgeInputSchema>;
