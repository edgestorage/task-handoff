import { z } from "zod";
import {
  ControlPlaneInstanceDirectorySchema,
  ControlPlaneNodeDirectorySchema,
} from "@task-handoff/protocol/control-plane-directory";
import type { ControlPlaneClientTransport } from "./transport.ts";

const DataSchema = <T extends z.ZodType>(schema: T) => z.object({ data: schema }).passthrough();

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
  };
}
