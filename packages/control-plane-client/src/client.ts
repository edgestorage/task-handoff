import { createControlPlaneAiSessionsApi } from "./ai-sessions.ts";
import { createControlPlaneAppSessionsApi } from "./app-sessions.ts";
import { createControlPlaneAppProfilesApi } from "./app-profiles.ts";
import { createControlPlaneAppManagementApi } from "./app-management.ts";
import { createControlPlaneAuthApi } from "./auth.ts";
import { responseSchema } from "@task-handoff/protocol/response-validation";
import type { ControlPlaneClientTransport } from "./transport.ts";
import { createControlPlaneResourcesApi } from "./resources.ts";
import { createControlPlaneTriggersApi } from "./triggers.ts";
import { createControlPlaneUsersApi } from "./users.ts";
import { createControlPlaneBrowserApi } from "./browser.ts";
import { createControlPlaneStoriesApi } from "./stories.ts";
import { createControlPlaneAgentsApi } from "./agents.ts";
import { createControlPlaneRepositoryApi } from "./repository.ts";
import { createControlPlaneCatalogApi } from "./catalog.ts";
import { createControlPlaneNodeAdminApi } from "./node-admin.ts";
import { createControlPlaneGitCredentialsApi } from "./git-credentials.ts";
import { createControlPlaneEnvironmentTemplatesApi } from "./environment-templates.ts";
import { createControlPlaneChatGatewayApi } from "./chat-gateway.ts";
import { createControlPlaneAdminApi } from "./control-plane-admin.ts";
import { createOperationApprovalsApi } from "./operation-approvals.ts";

export function createControlPlaneClient(transport: ControlPlaneClientTransport) {
  const compatibleTransport: ControlPlaneClientTransport = {
    request(path, schema, init, onUploadProgress) {
      return transport.request(path, responseSchema(schema), init, onUploadProgress);
    },
    ...(transport.requestBinary
      ? { requestBinary: (path: string, init?: RequestInit) => transport.requestBinary!(path, init) }
      : {}),
  };
  return {
    approvals: createOperationApprovalsApi(compatibleTransport),
    auth: createControlPlaneAuthApi(compatibleTransport),
    users: createControlPlaneUsersApi(compatibleTransport),
    aiSessions: createControlPlaneAiSessionsApi(compatibleTransport),
    appSessions: createControlPlaneAppSessionsApi(compatibleTransport),
    appProfiles: createControlPlaneAppProfilesApi(compatibleTransport),
    apps: createControlPlaneAppManagementApi(compatibleTransport),
    browser: createControlPlaneBrowserApi(compatibleTransport),
    resources: createControlPlaneResourcesApi(compatibleTransport),
    triggers: createControlPlaneTriggersApi(compatibleTransport),
    stories: createControlPlaneStoriesApi(compatibleTransport),
    agents: createControlPlaneAgentsApi(compatibleTransport),
    repository: createControlPlaneRepositoryApi(compatibleTransport),
    catalog: createControlPlaneCatalogApi(compatibleTransport),
    nodeAdmin: createControlPlaneNodeAdminApi(compatibleTransport),
    gitCredentials: createControlPlaneGitCredentialsApi(compatibleTransport),
    environmentTemplates: createControlPlaneEnvironmentTemplatesApi(compatibleTransport),
    chatGateway: createControlPlaneChatGatewayApi(compatibleTransport),
    admin: createControlPlaneAdminApi(compatibleTransport),
  };
}

export type ControlPlaneClient = ReturnType<typeof createControlPlaneClient>;
