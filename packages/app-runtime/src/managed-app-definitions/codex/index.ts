import type { ManagedAppProvider } from "../types";
import { launcherDetection, modelArgs } from "../shared";

export const codexProvider: ManagedAppProvider = {
  id: "codex",
  capabilities: { supportsCwdSelection: true, supportsAiSessionResume: true },
  aiSessionResumeArgs: (providerSessionId) => ["resume", providerSessionId],
  definition: ({ env }) => ({
    launcher: {
      id: "codex",
      name: "Codex",
      kind: "tty",
      description: "OpenAI Codex CLI in the task workspace.",
      command: env.TASK_HANDOFF_CODEX_COMMAND || "codex",
      // This is the interactive Codex CLI launch path. The app-server is a
      // protocol backend and does not show the startup upgrade prompt.
      args: ["-c", "check_for_update_on_startup=false", ...modelArgs(env, "TASK_HANDOFF_CODEX_MODEL", "CODEX_MODEL")],
    },
    detection: launcherDetection(),
    distribution: {
      recipes: [
        { type: "node-package", platforms: ["linux", "darwin", "win32"], arches: ["x64", "arm64"], installer: "npm", packages: ["@openai/codex"], privilege: "user" },
        { type: "node-package", platforms: ["linux", "darwin", "win32"], arches: ["x64", "arm64"], installer: "npm", packages: ["@openai/codex"], privilege: "passwordless-sudo" },
      ],
    },
  }),
};
