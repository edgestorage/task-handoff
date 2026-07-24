import type { ManagedAppRuntimeExtension } from "../types";

export function createTerminalGuiRuntime(): ManagedAppRuntimeExtension {
  return {
    prepareGuiArgs: ({ defaultArgs }) => [
      "-fa",
      process.env.TASK_HANDOFF_XTERM_FONT_FAMILY || "Monospace",
      "-fs",
      process.env.TASK_HANDOFF_XTERM_FONT_SIZE || "11",
      ...defaultArgs,
    ],
  };
}
