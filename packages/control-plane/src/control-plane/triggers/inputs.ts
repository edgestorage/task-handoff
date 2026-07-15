import { ControlledInstanceSchema } from "@task-handoff/protocol/control-plane";
import { TriggerActionSchema, TriggerConfigSchema, TriggerPolicySchema, TriggerSourceSchema, TriggerTargetSchema } from "@task-handoff/protocol/triggers";
import { z } from "zod";

export const ControlPlaneTriggerRecordSchema = TriggerConfigSchema.extend({ id: TriggerConfigSchema.shape.configHash });
export const CreateControlPlaneTriggerSchema = z.object({ name: TriggerConfigSchema.shape.name, description: TriggerConfigSchema.shape.description, source: TriggerSourceSchema, action: TriggerActionSchema, policy: TriggerPolicySchema.partial().optional() }).strict();
export const ApplyControlPlaneTriggerSchema = z.object({ instanceIds: z.array(ControlledInstanceSchema.shape.id).min(1), target: TriggerTargetSchema, enabled: z.boolean().optional() }).strict();
export const BindAiSessionTriggerSchema = z.object({ configHash: TriggerConfigSchema.shape.configHash, enabled: z.boolean().optional() }).strict();
export type ControlPlaneTriggerRecord = z.infer<typeof ControlPlaneTriggerRecordSchema>;
