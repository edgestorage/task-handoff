import { z } from "zod";
import {
  AppManagementJobResponseSchema,
  AppManagementOperationRequestSchema,
  AppManagementSnapshotSchema,
} from "@task-handoff/protocol/control-plane";
import { CustomAppCatalogSchema, CustomAppCatalogUpdateInputSchema, InstanceAppCatalogSchema, type CustomAppCatalogUpdateInput } from "@task-handoff/protocol/app-catalog";
import type { ControlPlaneClientTransport } from "./transport.ts";

const DataSchema = <T extends z.ZodType>(schema: T) => z.object({ data: schema }).strict();

export function createControlPlaneAppManagementApi(transport: ControlPlaneClientTransport) {
  const base = (instanceId: string) => `/api/controlled-instances/${encodeURIComponent(instanceId)}/apps`;
  const requestData = async <T>(path: string, schema: z.ZodType<T>, init?: RequestInit) => (
    (await transport.request(path, DataSchema(schema), init)).data
  );
  const requestOperation = (instanceId: string, appId: string, operation: "install" | "uninstall", requestId?: string) => {
    const body = AppManagementOperationRequestSchema.parse(requestId ? { requestId } : {});
    return requestData(`${base(instanceId)}/${encodeURIComponent(appId)}/${operation}`, AppManagementJobResponseSchema, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  };
  return {
    management(instanceId: string, signal?: AbortSignal) {
      return requestData(`${base(instanceId)}/management`, AppManagementSnapshotSchema, { signal });
    },
    install(instanceId: string, appId: string, requestId?: string) {
      return requestOperation(instanceId, appId, "install", requestId);
    },
    uninstall(instanceId: string, appId: string, requestId?: string) {
      return requestOperation(instanceId, appId, "uninstall", requestId);
    },
    job(instanceId: string, jobId: string, signal?: AbortSignal) {
      return requestData(`${base(instanceId)}/jobs/${encodeURIComponent(jobId)}`, AppManagementJobResponseSchema, { signal });
    },
    catalog(instanceId: string, signal?: AbortSignal) {
      return requestData(`${base(instanceId)}/catalog`, InstanceAppCatalogSchema, { signal });
    },
    customCatalog(instanceId: string, signal?: AbortSignal) {
      return requestData(`${base(instanceId)}/catalog/custom`, CustomAppCatalogSchema, { signal });
    },
    updateCustomCatalog(instanceId: string, input: CustomAppCatalogUpdateInput) {
      return requestData(`${base(instanceId)}/catalog/custom`, CustomAppCatalogSchema, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(CustomAppCatalogUpdateInputSchema.parse(input)),
      });
    },
  };
}
