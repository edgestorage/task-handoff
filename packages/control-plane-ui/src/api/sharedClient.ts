import { createControlPlaneClient, type ControlPlaneClientTransport } from "@task-handoff/control-plane-client";
import { api, withApiError } from "./client";

export const webControlPlaneTransport: ControlPlaneClientTransport = {
  async request(path, schema, init) {
    const route = path.startsWith("/api/") ? path.slice("/api/".length) : path;
    const payload = await withApiError(api(route, init).json<unknown>());
    return schema.parse(payload);
  },
};

export const sharedControlPlaneClient = createControlPlaneClient(webControlPlaneTransport);
export const sharedAiSessionsApi = sharedControlPlaneClient.aiSessions;
