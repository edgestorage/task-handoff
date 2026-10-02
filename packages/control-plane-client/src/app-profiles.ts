import { z } from "zod";
import { AppProfileListSchema, AppProfileSchema } from "@task-handoff/protocol/app-profiles";
import type { ControlPlaneClientTransport } from "./transport.ts";

const DataSchema = <T extends z.ZodType>(schema: T) => z.object({ data: schema }).strict();
const ProfileRemovedSchema = z.object({ removed: z.literal(true) }).strict();

export function createControlPlaneAppProfilesApi(transport: ControlPlaneClientTransport) {
  const base = (instanceId: string, appId: string) => `/api/controlled-instances/${encodeURIComponent(instanceId)}/apps/${encodeURIComponent(appId)}/profiles`;
  const requestData = async <T>(path: string, schema: z.ZodType<T>, init?: RequestInit) => (
    (await transport.request(path, DataSchema(schema), init)).data
  );
  return {
    list(instanceId: string, appId: string, signal?: AbortSignal) {
      return requestData(base(instanceId, appId), AppProfileListSchema, { method: "GET", signal });
    },
    create(instanceId: string, appId: string, name: string) {
      return requestData(base(instanceId, appId), AppProfileSchema, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name }),
      });
    },
    rename(instanceId: string, appId: string, profileId: string, name: string) {
      return requestData(`${base(instanceId, appId)}/${encodeURIComponent(profileId)}`, AppProfileSchema, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name }),
      });
    },
    setDefault(instanceId: string, appId: string, profileId: string) {
      return requestData(`${base(instanceId, appId)}/${encodeURIComponent(profileId)}/default`, AppProfileSchema, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
    },
    remove(instanceId: string, appId: string, profileId: string) {
      return requestData(`${base(instanceId, appId)}/${encodeURIComponent(profileId)}`, ProfileRemovedSchema, { method: "DELETE" });
    },
  };
}
