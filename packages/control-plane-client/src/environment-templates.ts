import { z } from "zod";
import { EnvironmentTemplateSchema } from "@task-handoff/protocol/control-plane";
import type { ControlPlaneClientTransport } from "./transport.ts";
import { jsonRequest } from "./json-request.ts";

const DataSchema = <T extends z.ZodType>(schema: T) => z.object({ data: schema }).passthrough();
const DeleteResultSchema = z.object({
  deleted: z.boolean(),
  templateId: z.string().trim().min(1).max(120),
}).strict();

export function createControlPlaneEnvironmentTemplatesApi(transport: ControlPlaneClientTransport) {
  const requestData = async <T>(path: string, schema: z.ZodType<T>, init?: RequestInit) => (
    (await transport.request(path, DataSchema(schema), init)).data
  );
  const nodeTemplatesPath = (nodeId: string) => `/api/nodes/${encodeURIComponent(nodeId)}/environment-templates`;
  return {
    listForNode(nodeId: string, signal?: AbortSignal) {
      return requestData(nodeTemplatesPath(nodeId), z.array(EnvironmentTemplateSchema), { signal });
    },
    get(nodeId: string, templateId: string, signal?: AbortSignal) {
      return requestData(`${nodeTemplatesPath(nodeId)}/${encodeURIComponent(templateId)}`, EnvironmentTemplateSchema, { signal });
    },
    createFromInstance(instanceId: string, input: unknown) {
      return requestData(
        `/api/controlled-instances/${encodeURIComponent(instanceId)}/environment-templates`,
        EnvironmentTemplateSchema,
        jsonRequest("POST", input),
      );
    },
    remove(nodeId: string, templateId: string) {
      return requestData(`${nodeTemplatesPath(nodeId)}/${encodeURIComponent(templateId)}`, DeleteResultSchema, jsonRequest("DELETE"));
    },
  };
}

export type ControlPlaneEnvironmentTemplatesApi = ReturnType<typeof createControlPlaneEnvironmentTemplatesApi>;
