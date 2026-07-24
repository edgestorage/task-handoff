import type { ManagedAppProvider } from "../types";
import { bundledDistribution, launcherDetection } from "../shared";
import { createVscodeWebRuntime } from "./runtime";

export const vscodeWebProvider: ManagedAppProvider = {
  id: "vscode-web",
  createRuntime: () => createVscodeWebRuntime(),
  definition: ({ env }) => ({
    launcher: {
      id: "vscode-web",
      name: "VS Code",
      kind: "web",
      description: "VS Code Web in the task workspace.",
      command: env.TASK_HANDOFF_VSCODE_WEB_COMMAND || "code-server",
      args: [
        "--auth", "none",
        "--bind-addr", "127.0.0.1:{port}",
        "--disable-telemetry",
        "--user-data-dir", "{sessionDir}/user-data",
        "--extensions-dir", "{sessionDir}/extensions",
        "{cwd}",
      ],
      web: { readyPath: "/" },
    },
    detection: launcherDetection(),
    distribution: bundledDistribution(),
  }),
};
