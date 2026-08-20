import { createControlPlaneAiSessionsApi } from "./ai-sessions.ts";
import { createControlPlaneAppSessionsApi } from "./app-sessions.ts";
import { createControlPlaneAuthApi } from "./auth.ts";
import { responseSchema } from "@task-handoff/protocol/response-validation";
import type { ControlPlaneClientTransport } from "./transport.ts";
import { createControlPlaneResourcesApi } from "./resources.ts";
import { createControlPlaneTriggersApi } from "./triggers.ts";

export function createControlPlaneClient(transport: ControlPlaneClientTransport) {
  const compatibleTransport: ControlPlaneClientTransport = {
    request(path, schema, init, onUploadProgress) {
      return transport.request(path, responseSchema(schema), init, onUploadProgress);
    },
  };
  return {
    auth: createControlPlaneAuthApi(compatibleTransport),
    aiSessions: createControlPlaneAiSessionsApi(compatibleTransport),
    appSessions: createControlPlaneAppSessionsApi(compatibleTransport),
    resources: createControlPlaneResourcesApi(compatibleTransport),
    triggers: createControlPlaneTriggersApi(compatibleTransport),
  };
}

export type ControlPlaneClient = ReturnType<typeof createControlPlaneClient>;
