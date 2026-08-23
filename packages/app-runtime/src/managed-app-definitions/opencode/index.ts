import type { ManagedAppProvider } from "../types";
import { launcherDetection } from "../shared";
import { createOpenCodeRuntime } from "./runtime";

export const opencodeProvider: ManagedAppProvider = {
  id: "opencode",
  capabilities: { supportsCwdSelection: true, supportsAiSessionResume: true },
  aiSessionResumeArgs: (providerSessionId) => ["--session", providerSessionId],
  createRuntime: createOpenCodeRuntime,
  definition: ({ env }) => ({
    launcher: {
      id: "opencode",
      name: "OpenCode",
      kind: "tty",
      description: "OpenCode CLI attached to the managed TaskHandoff agent server.",
      command: env.TASK_HANDOFF_OPENCODE_COMMAND || "opencode",
      args: [],
    },
    detection: launcherDetection(),
    distribution: {
      recipes: [
        { type: "node-package", platforms: ["linux", "darwin", "win32"], arches: ["x64", "arm64"], installer: "npm", packages: ["opencode-ai"], privilege: "user" },
        { type: "node-package", platforms: ["linux", "darwin", "win32"], arches: ["x64", "arm64"], installer: "npm", packages: ["opencode-ai"], privilege: "passwordless-sudo" },
      ],
    },
  }),
};
