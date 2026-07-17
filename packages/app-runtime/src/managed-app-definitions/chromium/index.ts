import type { ManagedAppProvider } from "../types";
import { launcherDetection } from "../shared";

export const chromiumProvider: ManagedAppProvider = {
  id: "chromium",
  definition: ({ env }) => ({
    launcher: {
      id: "chromium",
      name: "Browser",
      kind: "gui",
      description: "Chromium browser with VNC and CDP endpoints.",
      command: env.TASK_HANDOFF_CHROMIUM_COMMAND || "chromium",
      args: ["about:blank"],
      display: { width: 1440, height: 900, depth: 24 },
      automation: { type: "cdp", portArg: "--remote-debugging-port={port}" },
    },
    detection: launcherDetection(),
    distribution: {
      recipes: [{ type: "system-package", platforms: ["linux"], installer: "apt", packages: ["chromium", "chromium-sandbox"], privilege: "passwordless-sudo" }],
    },
  }),
};
