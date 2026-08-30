import { createControlPlaneClient, type ControlPlaneClientTransport } from "@task-handoff/control-plane-client";
import { api, withApiError } from "./client";
import { requestJsonWithUploadProgress } from "./xhrUpload.ts";

export const webControlPlaneTransport: ControlPlaneClientTransport = {
  async request(path, schema, init, onUploadProgress) {
    const route = path.startsWith("/api/") ? path.slice("/api/".length) : path;
    const payload = onUploadProgress
      ? await requestJsonWithUploadProgress(`/api/${route}`, init || {}, onUploadProgress)
      : await withApiError(api(route, init).json<unknown>());
    return schema.parse(payload);
  },
};

export const sharedControlPlaneClient = createControlPlaneClient(webControlPlaneTransport);
export const sharedAiSessionsApi = sharedControlPlaneClient.aiSessions;
