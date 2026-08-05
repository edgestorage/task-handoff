import { createControlPlaneAiSessionsApi } from "./ai-sessions.ts";
import { createControlPlaneAuthApi } from "./auth.ts";
import type { ControlPlaneClientTransport } from "./transport.ts";
import { createControlPlaneResourcesApi } from "./resources.ts";

export function createControlPlaneClient(transport: ControlPlaneClientTransport) {
  return {
    auth: createControlPlaneAuthApi(transport),
    aiSessions: createControlPlaneAiSessionsApi(transport),
    resources: createControlPlaneResourcesApi(transport),
  };
}

export type ControlPlaneClient = ReturnType<typeof createControlPlaneClient>;
