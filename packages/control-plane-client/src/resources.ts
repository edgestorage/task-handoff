import { z } from "zod";
import {
  ControlPlaneInstanceDirectorySchema,
  ControlPlaneNodeDirectorySchema,
} from "@task-handoff/protocol/control-plane-directory";
import { AiSessionPermissionModeSchema, type AiSessionPermissionMode } from "@task-handoff/protocol/ai-sessions";
import type { ControlPlaneClientTransport } from "./transport.ts";

const DataSchema = <T extends z.ZodType>(schema: T) => z.object({ data: schema }).passthrough();
const InstancePermissionConfigSchema = z.object({
  config: z.object({ defaultCodexPermissionMode: AiSessionPermissionModeSchema }).passthrough(),
}).passthrough();
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
  };
}
