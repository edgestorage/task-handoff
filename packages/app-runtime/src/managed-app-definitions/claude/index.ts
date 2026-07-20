import type { ManagedAppProvider } from "../types";
import { envFlag, launcherDetection, modelArgs } from "../shared";

export const claudeProvider: ManagedAppProvider = {
  id: "claude",
  capabilities: { supportsCwdSelection: true, supportsAiSessionResume: true },
  aiSessionResumeArgs: (providerSessionId) => ["--resume", providerSessionId],
  definition: ({ env }) => {
    const skipPermissions = envFlag(env, "TASK_HANDOFF_CLAUDE_DANGEROUSLY_SKIP_PERMISSIONS")
      || envFlag(env, "TASK_HANDOFF_CLAUDE_SKIP_PERMISSIONS");
    return {
      launcher: {
        id: "claude",
        name: "Claude",
        kind: "tty",
        description: "Claude Code CLI in the task workspace.",
        command: env.TASK_HANDOFF_CLAUDE_COMMAND || "claude",
        args: [...(skipPermissions ? ["--dangerously-skip-permissions"] : []), ...modelArgs(env, "TASK_HANDOFF_CLAUDE_MODEL", "CLAUDE_MODEL")],
      },
      detection: launcherDetection(),
      distribution: {
        recipes: [
          { type: "node-package", platforms: ["linux", "darwin", "win32"], arches: ["x64", "arm64"], installer: "npm", packages: ["@anthropic-ai/claude-code"], privilege: "user" },
          { type: "node-package", platforms: ["linux", "darwin", "win32"], arches: ["x64", "arm64"], installer: "npm", packages: ["@anthropic-ai/claude-code"], privilege: "passwordless-sudo" },
        ],
      },
    };
  },
};
