import path from "node:path";
import type { ManagedAppProvider } from "../types";
import { launcherDetection } from "../shared";
import { createTerminalGuiRuntime } from "./runtime";

export const terminalGuiProvider: ManagedAppProvider = {
  id: "terminal-gui",
  matchesRuntime: (app) => app.kind === "gui" && path.basename(app.command || "") === "xterm",
  createRuntime: () => createTerminalGuiRuntime(),
  definition: ({ env }) => ({
    launcher: {
      id: "terminal-gui",
      name: "GUI Terminal",
      kind: "gui",
      description: "xterm terminal in an isolated virtual desktop with VNC access.",
      command: env.TASK_HANDOFF_XTERM_COMMAND || "xterm",
      args: ["-geometry", "120x32"],
      display: { width: 1024, height: 768, depth: 24 },
    },
    detection: launcherDetection(),
    distribution: {
      recipes: [{ type: "system-package", platforms: ["linux"], installer: "apt", packages: ["xterm"], privilege: "passwordless-sudo" }],
    },
  }),
};
