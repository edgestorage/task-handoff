import { z } from "zod";
import {
  ControlPlaneInstanceActionSchema,
  ControlPlaneInstanceDirectorySchema,
  ControlPlaneFleetDirectoryMetaSchema,
  ControlPlaneNodeDirectorySchema,
  type ControlPlaneInstanceDirectoryEntry,
} from "@task-handoff/protocol/control-plane-directory";
import { AiSessionPermissionModeSchema, type AiSessionPermissionMode } from "@task-handoff/protocol/ai-sessions";
import type { ControlPlaneClientTransport } from "./transport.ts";

const DataSchema = <T extends z.ZodType>(schema: T) => z.object({ data: schema }).passthrough();
const FleetDirectoryPayloadSchema = z.object({
  data: ControlPlaneInstanceDirectorySchema,
  meta: ControlPlaneFleetDirectoryMetaSchema.optional(),
}).passthrough();
const InstancePermissionConfigSchema = z.object({
  config: z.object({ defaultCodexPermissionMode: AiSessionPermissionModeSchema }).passthrough(),
}).passthrough();
const InstanceWorkspaceSourceSchema = z.object({
  source: z.object({
    type: z.string().trim().min(1).max(80),
    localFolderId: z.string().trim().min(1).max(120).optional(),
    path: z.string().trim().min(1).max(4096).optional(),
  }).passthrough(),
}).passthrough();
const NamedResourceSchema = z.object({
  id: z.string().trim().min(1).max(160),
  name: z.string().trim().min(1).max(160),
});
const PublicModelRegistrySchema = z.object({
  models: z.array(z.object({
    id: z.string().trim().min(1).max(120),
    model: z.object({
      id: z.string().trim().min(1).max(120),
      name: z.string().trim().min(1).max(160),
      model: z.string().trim().min(1).max(240),
      modelNames: z.array(z.object({ name: z.string(), order: z.number().int() }).strip()).default([]),
      protocols: z.array(z.string()).default([]),
      app: z.string().optional(),
      enabled: z.boolean(),
      order: z.number().int(),
    }).passthrough(),
    locations: z.array(z.object({
      type: z.enum(["control-plane", "node"]),
      nodeId: z.string().optional(),
      enabled: z.boolean(),
    }).passthrough()),
  }).passthrough()),
}).passthrough();
const InstanceActionResultSchema = z.object({
  id: z.string().trim().min(1).max(160),
  status: z.string().trim().min(1).max(80),
}).strip();
export const ControlPlaneNodeLocalFolderSchema = z.object({
  id: z.string().trim().min(1).max(120),
  nodeId: z.string().trim().min(1).max(120),
  name: z.string().trim().min(1).max(160),
  path: z.string().trim().min(1).max(4096),
  labels: z.record(z.string(), z.string()),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
}).passthrough();
export type ControlPlaneNodeLocalFolder = z.infer<typeof ControlPlaneNodeLocalFolderSchema>;

export function controlPlaneLocalFolderDisplayName(folder: Pick<ControlPlaneNodeLocalFolder, "name" | "path">) {
  const name = folder.name.trim();
  if (name) return name;
  const path = folder.path.replace(/[\\/]+$/u, "");
  return path.split(/[\\/]+/u).filter(Boolean).at(-1) || folder.path;
}

export type ControlPlaneInstanceResourceEntry = ControlPlaneInstanceDirectoryEntry;

export function createControlPlaneResourcesApi(transport: ControlPlaneClientTransport) {
  const requestData = async <T>(path: string, schema: z.ZodType<T>, signal?: AbortSignal) => (
    (await transport.request(path, DataSchema(schema), { signal })).data
  );
  return {
    nodes(signal?: AbortSignal) {
      return requestData("/api/nodes?projection=directory", ControlPlaneNodeDirectorySchema, signal);
    },
    instanceBoard(signal?: AbortSignal) {
      return requestData("/api/instance-board?projection=directory", ControlPlaneInstanceDirectorySchema, signal);
    },
    instanceDirectory(signal?: AbortSignal) {
      return transport.request("/api/instance-board?projection=directory&progressive=true", FleetDirectoryPayloadSchema, { signal });
    },
    models(signal?: AbortSignal) {
      return requestData("/api/models", PublicModelRegistrySchema, signal);
    },
    async instanceWorkspaceSource(instanceId: string, signal?: AbortSignal) {
      return (await requestData(
        `/api/controlled-instances/${encodeURIComponent(instanceId)}`,
        InstanceWorkspaceSourceSchema,
        signal,
      )).source;
    },
    async updateInstanceName(instanceId: string, name: string) {
      const response = await transport.request(
        `/api/controlled-instances/${encodeURIComponent(instanceId)}`,
        DataSchema(NamedResourceSchema),
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name }),
        },
      );
      return response.data;
    },
    async updateNodeName(nodeId: string, name: string) {
      const response = await transport.request(
        `/api/nodes/${encodeURIComponent(nodeId)}`,
        DataSchema(NamedResourceSchema),
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name }),
        },
      );
      return response.data;
    },
    async updateInstanceDefaultPermissionMode(instanceId: string, permissionMode: AiSessionPermissionMode) {
      const response = await transport.request(
        `/api/controlled-instances/${encodeURIComponent(instanceId)}`,
        DataSchema(InstancePermissionConfigSchema),
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ config: { defaultCodexPermissionMode: permissionMode } }),
        },
      );
      return response.data.config.defaultCodexPermissionMode;
    },
    nodeLocalFolders(nodeId: string, signal?: AbortSignal) {
      return requestData(`/api/nodes/${encodeURIComponent(nodeId)}/local-folders`, z.array(ControlPlaneNodeLocalFolderSchema), signal);
    },
    instanceAction(instanceId: string, action: z.infer<typeof ControlPlaneInstanceActionSchema>) {
      const parsedAction = ControlPlaneInstanceActionSchema.parse(action);
      const suffix = parsedAction === "retry-image" ? "image-provisioning/retry" : parsedAction;
      return transport.request(
        `/api/controlled-instances/${encodeURIComponent(instanceId)}/${suffix}`,
        DataSchema(InstanceActionResultSchema),
        { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({}) },
      ).then((response) => response.data);
    },
  };
}
