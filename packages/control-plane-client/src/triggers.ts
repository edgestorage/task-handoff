import { z } from "zod";
import {
  ControlPlaneTriggerTemplateInputSchema,
  ControlPlaneTriggerMutationFailureSchema,
  ControlPlaneTriggersSchema,
  TriggerConfigSchema,
  TriggerDeploymentSchema,
  TriggerRuntimeStateSchema,
  type ControlPlaneTriggerTemplateInput,
} from "@task-handoff/protocol/triggers";
import type { ControlPlaneClientTransport } from "./transport.ts";

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

export function createControlPlaneTriggersApi(transport: ControlPlaneClientTransport) {
  const requestData = async <T>(path: string, schema: z.ZodType<T>, init?: RequestInit) => (
    (await transport.request(path, DataSchema(schema), init)).data
  );
  const json = (method: string, body?: unknown): RequestInit => ({
    method,
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return {
    list(signal?: AbortSignal) {
      return requestData("/api/triggers", ControlPlaneTriggersSchema, { signal });
    },
    create(input: ControlPlaneTriggerTemplateInput) {
      return requestData("/api/triggers", TriggerTemplateSchema, json("POST", ControlPlaneTriggerTemplateInputSchema.parse(input)));
    },
    update(configHash: string, input: ControlPlaneTriggerTemplateInput) {
      return requestData(`/api/triggers/${encodeURIComponent(configHash)}`, TriggerMutationResultSchema, json("PUT", ControlPlaneTriggerTemplateInputSchema.parse(input)));
    },
    remove(configHash: string) {
      return requestData(`/api/triggers/${encodeURIComponent(configHash)}`, TriggerMutationResultSchema, json("DELETE"));
    },
    bindSession(instanceId: string, sessionId: string, configHash: string) {
      return requestData(
        `/api/controlled-instances/${encodeURIComponent(instanceId)}/ai-sessions/${encodeURIComponent(sessionId)}/triggers`,
        TriggerBindingSchema,
        json("POST", { configHash }),
      );
    },
    unbindSession(instanceId: string, sessionId: string, configHash: string) {
      return requestData(
        `/api/controlled-instances/${encodeURIComponent(instanceId)}/ai-sessions/${encodeURIComponent(sessionId)}/triggers/${encodeURIComponent(configHash)}`,
        z.unknown(),
        json("DELETE"),
      );
    },
    run(instanceId: string, configHash: string, deploymentId?: string) {
      return requestData(
        `/api/controlled-instances/${encodeURIComponent(instanceId)}/triggers/${encodeURIComponent(configHash)}/run`,
        z.unknown(),
        json("POST", deploymentId ? { deploymentId } : {}),
      );
    },
  };
}

export type ControlPlaneTriggersApi = ReturnType<typeof createControlPlaneTriggersApi>;
