import type { ManagedAppProvider } from "../types";
import { envFlag, launcherDetection, modelArgs } from "../shared";
import { createClaudeRuntime } from "./runtime";

export const claudeProvider: ManagedAppProvider = {
  id: "claude",
  capabilities: { supportsCwdSelection: true, supportsAiSessionResume: true },
  aiSessionResumeArgs: (providerSessionId) => ["--resume", providerSessionId],
  createRuntime: () => createClaudeRuntime(),
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
        env: { DISABLE_AUTOUPDATER: "1" },
        args: [
          ...(skipPermissions ? ["--dangerously-skip-permissions"] : []),
          ...(env.TASK_HANDOFF_CONTROL_MODE === "controlled" ? [] : modelArgs(env, "TASK_HANDOFF_CLAUDE_MODEL", "CLAUDE_MODEL")),
        ],
      },
      detection: launcherDetection(),
      distribution: {
        recipes: [
          {
            type: "native-package", platforms: ["linux"], arches: ["x64"], libc: "gnu", package: "@anthropic-ai/claude-code-linux-x64", packageVersion: "2.1.286", version: "2.1.286",
            integrity: "sha512-PnVL8ZCEev3IexLeOc9/QRfqRDUZRgnsaMLdpjlBN0VaieeTrf7mZ2JJi29ue2KAqHvq6SsOadU5G/shnFE4MA==",
            launchPath: "claude", privilege: "user",
          },
          {
            type: "native-package", platforms: ["linux"], arches: ["x64"], libc: "musl", package: "@anthropic-ai/claude-code-linux-x64-musl", packageVersion: "2.1.286", version: "2.1.286",
            integrity: "sha512-+jDoHSkrSoucNqsnwQP/bioMEb39r3pBxn0sZPA7MINUZUBdrdG87nr/lzXxEAHaqspWvHMLaWMtmduEg4cIhg==",
            launchPath: "claude", privilege: "user",
          },
          {
            type: "native-package", platforms: ["linux"], arches: ["arm64"], libc: "gnu", package: "@anthropic-ai/claude-code-linux-arm64", packageVersion: "2.1.286", version: "2.1.286",
            integrity: "sha512-dHQ/ObyC4jaGHVk+gFE8P8PALMIVLhQSyhiC3y3kkuLp0H0MHgLxHt/srQ3zJs892ClDbtl1swxv4bw1ioruZA==",
            launchPath: "claude", privilege: "user",
          },
          {
            type: "native-package", platforms: ["linux"], arches: ["arm64"], libc: "musl", package: "@anthropic-ai/claude-code-linux-arm64-musl", packageVersion: "2.1.286", version: "2.1.286",
            integrity: "sha512-FZVGE3iU0eFRudjgyooGRsPAUqjqlcJ4dq64g4HDp9Wg6FsUpDFpVsKn9S6phSXogwSyMU3SfiI9oOTKvw4wVA==",
            launchPath: "claude", privilege: "user",
          },
          {
            type: "native-package", platforms: ["darwin"], arches: ["x64"], package: "@anthropic-ai/claude-code-darwin-x64", packageVersion: "2.1.286", version: "2.1.286",
            integrity: "sha512-RlnglbMpkdvIdKzPphXI+KMwXefKpMJXYGpGAfpTI6XvkDcjgj5j8WXxvoySyl2qTetWOEqjkFB/V8rtW4qp4g==",
            launchPath: "claude", privilege: "user",
          },
          {
            type: "native-package", platforms: ["darwin"], arches: ["arm64"], package: "@anthropic-ai/claude-code-darwin-arm64", packageVersion: "2.1.286", version: "2.1.286",
            integrity: "sha512-QlU1+S7cNO1BKzlMJGRR/ZqdsP6c3+QAA2u9EX7dTO6HUo1/RAenn/q+mlyX60MZzTZOjPkAmTt77eYrH1IAwg==",
            launchPath: "claude", privilege: "user",
          },
          {
            type: "native-package", platforms: ["win32"], arches: ["x64"], package: "@anthropic-ai/claude-code-win32-x64", packageVersion: "2.1.286", version: "2.1.286",
            integrity: "sha512-Cvq6m1e2eP0p47Ze+b6rw+DjXMhLCcT9g8ZKfFDxT0NB9d9mjHcNs6Qjb1oTqbO6AsN3Ie1DIqWt50J7kboz7g==",
            launchPath: "claude.exe", privilege: "user",
          },
          {
            type: "native-package", platforms: ["win32"], arches: ["arm64"], package: "@anthropic-ai/claude-code-win32-arm64", packageVersion: "2.1.286", version: "2.1.286",
            integrity: "sha512-d1pLr6/Z+/y4J+9j2AwpsfkKlGzf93cA2nfCbSqV81rciTCZpYYMKG1T0AhtJ2RbfQFicO1/rl1XdLOZAHZn0w==",
            launchPath: "claude.exe", privilege: "user",
          },
        ],
      },
    };
  },
};
