import { z } from "zod";
import {
  AppSessionDeltaResponseSchema,
  AppSessionAccessLeaseSchema,
  AppSessionAccessRevocationSchema,
  AppSessionRecordSchema,
  AppSessionsSnapshotSchema,
} from "@task-handoff/protocol/app-sessions";
import type { ControlPlaneClientTransport } from "./transport.ts";

const DataSchema = <T extends z.ZodType>(schema: T) => z.object({ data: schema }).strict();
const LaunchAppSessionInputSchema = z.object({
  appId: z.string().trim().min(1).max(120),
  cwdFolderId: z.string().trim().min(1).max(120).optional(),
}).strict();
const RenameAppSessionInputSchema = z.object({
  title: z.string().trim().min(1).max(120),
}).strict();

export const ControlPlaneAppSessionsSchema = z.object({
  updatedAt: z.string().datetime(),
  instances: z.array(z.object({
    instanceId: z.string().trim().min(1).max(160),
    streamId: z.string().trim().min(1).max(240),
    appSessions: AppSessionsSnapshotSchema,
    revision: z.number().int().nonnegative().optional(),
    lastEventAt: z.string().datetime().optional(),
  }).strict()),
}).strict();

export function createControlPlaneAppSessionsApi(transport: ControlPlaneClientTransport) {
  const requestData = async <T>(path: string, schema: z.ZodType<T>, init?: RequestInit) => (
    (await transport.request(path, DataSchema(schema), init)).data
  );
  return {
    list(signal?: AbortSignal, instanceId?: string) {
      const query = instanceId ? `?instanceId=${encodeURIComponent(instanceId)}` : "";
      return requestData(`/api/app-sessions${query}`, ControlPlaneAppSessionsSchema, { signal });
    },
    refresh(signal?: AbortSignal, instanceId?: string) {
      const query = new URLSearchParams({ refresh: "true" });
      if (instanceId) query.set("instanceId", instanceId);
      return requestData(`/api/app-sessions?${query}`, ControlPlaneAppSessionsSchema, { signal });
    },
    launch(instanceId: string, input: LaunchAppSessionInput) {
      const body = LaunchAppSessionInputSchema.parse(input);
      return requestData(
        `/api/controlled-instances/${encodeURIComponent(instanceId)}/apps/sessions`,
        AppSessionRecordSchema,
        { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
      );
    },
    stop(instanceId: string, sessionId: string) {
      return requestData(
        `/api/controlled-instances/${encodeURIComponent(instanceId)}/apps/sessions/${encodeURIComponent(sessionId)}/stop`,
        AppSessionRecordSchema,
        { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({}) },
      );
    },
    rename(instanceId: string, sessionId: string, title: string) {
      const body = RenameAppSessionInputSchema.parse({ title });
      return requestData(
        `/api/controlled-instances/${encodeURIComponent(instanceId)}/apps/sessions/${encodeURIComponent(sessionId)}`,
        AppSessionRecordSchema,
        { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
      );
    },
    access(instanceId: string, sessionId: string) {
      return requestData(
        `/api/controlled-instances/${encodeURIComponent(instanceId)}/apps/sessions/${encodeURIComponent(sessionId)}/access`,
        AppSessionAccessLeaseSchema,
        { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({}) },
      );
    },
    revokeAccess(instanceId: string, sessionId: string, token: string) {
      return requestData(
        `/api/controlled-instances/${encodeURIComponent(instanceId)}/apps/sessions/${encodeURIComponent(sessionId)}/access`,
        AppSessionAccessRevocationSchema,
        { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ token }) },
      );
    },
    delta(instanceId: string, streamId: string, sinceRevision: number, signal?: AbortSignal) {
      const query = new URLSearchParams({ instanceId, streamId, sinceRevision: String(sinceRevision) });
      return requestData(`/api/app-sessions?${query}`, AppSessionDeltaResponseSchema, { signal });
    },
  };
}

export type ControlPlaneAppSessions = z.infer<typeof ControlPlaneAppSessionsSchema>;
export type LaunchAppSessionInput = z.infer<typeof LaunchAppSessionInputSchema>;
