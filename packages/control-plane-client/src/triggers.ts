import { z } from "zod";
import {
  ControlPlaneTriggerTemplateInputSchema,
  ControlPlaneTriggerMutationFailureSchema,
  ControlPlaneTriggersSchema,
  TriggerConfigSchema,
  TriggerDeploymentSchema,
  TriggerRuntimeStateSchema,
  TriggerTargetSchema,
  type ControlPlaneTriggerTemplateInput,
} from "@task-handoff/protocol/triggers";
import type { ControlPlaneClientTransport } from "./transport.ts";
import { jsonRequest } from "./json-request.ts";

const DataSchema = <T extends z.ZodType>(schema: T) => z.object({ data: schema }).passthrough();
const TriggerTemplateSchema = TriggerConfigSchema.extend({ id: TriggerConfigSchema.shape.configHash }).strip();
const TriggerBindingSchema = z.object({
  config: TriggerConfigSchema,
  deployment: TriggerDeploymentSchema,
  runtime: TriggerRuntimeStateSchema.optional(),
}).strip();
const TriggerMutationResultSchema = z.object({
  previousConfigHash: TriggerConfigSchema.shape.configHash.optional(),
  trigger: TriggerTemplateSchema.optional(),
  configHash: TriggerConfigSchema.shape.configHash.optional(),
  deletedTemplate: z.boolean().optional(),
  results: z.array(z.unknown()).optional(),
  partialFailures: z.array(ControlPlaneTriggerMutationFailureSchema).default([]),
}).strip();
const TriggerApplyResultSchema = z.object({
  configHash: TriggerConfigSchema.shape.configHash,
  results: z.array(z.unknown()).default([]),
}).passthrough();

export function createControlPlaneTriggersApi(transport: ControlPlaneClientTransport) {
  const requestData = async <T>(path: string, schema: z.ZodType<T>, init?: RequestInit) => (
    (await transport.request(path, DataSchema(schema), init)).data
  );
  return {
    list(signal?: AbortSignal) {
      return requestData("/api/triggers", ControlPlaneTriggersSchema, { signal });
    },
    create(input: ControlPlaneTriggerTemplateInput) {
      return requestData("/api/triggers", TriggerTemplateSchema, jsonRequest("POST", ControlPlaneTriggerTemplateInputSchema.parse(input)));
    },
    update(configHash: string, input: ControlPlaneTriggerTemplateInput) {
      return requestData(`/api/triggers/${encodeURIComponent(configHash)}`, TriggerMutationResultSchema, jsonRequest("PUT", ControlPlaneTriggerTemplateInputSchema.parse(input)));
    },
    remove(configHash: string) {
      return requestData(`/api/triggers/${encodeURIComponent(configHash)}`, TriggerMutationResultSchema, jsonRequest("DELETE"));
    },
    apply(configHash: string, input: { instanceIds: readonly string[]; target: z.infer<typeof TriggerTargetSchema>; enabled?: boolean }) {
      return requestData(`/api/triggers/${encodeURIComponent(configHash)}/apply`, TriggerApplyResultSchema, jsonRequest("POST", input));
    },
    bindSession(instanceId: string, sessionId: string, configHash: string) {
      return requestData(
        `/api/controlled-instances/${encodeURIComponent(instanceId)}/ai-sessions/${encodeURIComponent(sessionId)}/triggers`,
        TriggerBindingSchema,
        jsonRequest("POST", { configHash }),
      );
    },
    unbindSession(instanceId: string, sessionId: string, configHash: string) {
      return requestData(
        `/api/controlled-instances/${encodeURIComponent(instanceId)}/ai-sessions/${encodeURIComponent(sessionId)}/triggers/${encodeURIComponent(configHash)}`,
        z.unknown(),
        jsonRequest("DELETE"),
      );
    },
    run(instanceId: string, configHash: string, deploymentId?: string) {
      return requestData(
        `/api/controlled-instances/${encodeURIComponent(instanceId)}/triggers/${encodeURIComponent(configHash)}/run`,
        z.unknown(),
        jsonRequest("POST", deploymentId ? { deploymentId } : {}),
      );
    },
  };
}

export type ControlPlaneTriggersApi = ReturnType<typeof createControlPlaneTriggersApi>;
