import type { ManagedAppProvider } from "../types";
import { bundledDistribution, envFlag, launcherDetection } from "../shared";

export const ccSwitchProvider: ManagedAppProvider = {
  id: "cc-switch",
  optional: true,
  enabled: ({ env }) => envFlag(env, "TASK_HANDOFF_ENABLE_CC_SWITCH"),
  definition: ({ env }) => ({
    launcher: {
      id: "cc-switch",
      name: "CC Switch",
      kind: "gui",
      description: "CC Switch desktop app in an isolated virtual desktop.",
      command: env.TASK_HANDOFF_CC_SWITCH_COMMAND || "cc-switch",
      display: { width: 1440, height: 900, depth: 24 },
    },
    detection: launcherDetection(),
    distribution: bundledDistribution(),
  }),
};
