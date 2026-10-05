import type { ManagedAppProvider } from "../types";
import { launcherDetection } from "../shared";

export const thctlProvider: ManagedAppProvider = {
  id: "thctl",
  definition: ({ env }) => ({
    launcher: {
      id: "thctl",
      name: "thctl",
      kind: "tty",
      description: "TaskHandoff Control Plane command line client.",
      command: env.TASK_HANDOFF_THCTL_COMMAND || "thctl",
    },
    // Managed (install/uninstall) but never offered as a launchable app session.
    launchable: false,
    detection: launcherDetection(),
    distribution: {
      recipes: [
        { type: "node-package", platforms: ["linux", "darwin", "win32"], arches: ["x64", "arm64"], installer: "npm", packages: ["@task-handoff/thctl"], privilege: "user" },
        { type: "node-package", platforms: ["linux", "darwin", "win32"], arches: ["x64", "arm64"], installer: "npm", packages: ["@task-handoff/thctl"], privilege: "passwordless-sudo" },
      ],
    },
  }),
};
