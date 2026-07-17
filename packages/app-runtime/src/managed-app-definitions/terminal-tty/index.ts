import type { ManagedAppProvider } from "../types";
import { bundledDistribution, launcherDetection } from "../shared";

export const terminalTtyProvider: ManagedAppProvider = {
  id: "terminal-tty",
  capabilities: { supportsCwdSelection: true },
  definition: ({ env }) => ({
    launcher: {
      id: "terminal-tty",
      name: "Terminal",
      kind: "tty",
      description: "Interactive shell in the task workspace.",
      command: env.SHELL || "/bin/bash",
    },
    detection: launcherDetection(),
    distribution: bundledDistribution(),
  }),
};
