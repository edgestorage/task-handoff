import type { ManagedAppProvider } from "../types";
import { launcherDetection } from "../shared";
import { createOpenCodeRuntime } from "./runtime";

export const opencodeProvider: ManagedAppProvider = {
  id: "opencode",
  capabilities: { supportsCwdSelection: true, supportsAiSessionResume: true },
  aiSessionResumeArgs: (providerSessionId) => ["--session", providerSessionId],
  createRuntime: createOpenCodeRuntime,
  definition: ({ env }) => ({
    launcher: {
      id: "opencode",
      name: "OpenCode",
      kind: "tty",
      description: "OpenCode CLI attached to the managed TaskHandoff agent server.",
      command: env.TASK_HANDOFF_OPENCODE_COMMAND || "opencode",
      env: { OPENCODE_DISABLE_AUTOUPDATE: "1" },
      args: [],
    },
    detection: launcherDetection(),
    distribution: {
      recipes: [
        {
          type: "native-package", platforms: ["darwin"], arches: ["arm64"], package: "opencode-darwin-arm64", packageVersion: "1.18.30", version: "1.18.30",
          integrity: "sha512-KO4FJGZpgmSz+NNQ6PizynT5qAzVfoZI5HJLpyD0tYNqePPu87g2/UgVmNW663Bock2r75koLZFjR5waZiFiqw==",
          launchPath: "bin/opencode", privilege: "user",
        },
        {
          type: "native-package", platforms: ["darwin"], arches: ["x64"], package: "opencode-darwin-x64-baseline", packageVersion: "1.18.30", version: "1.18.30",
          integrity: "sha512-DMQWRe9blvI+639fcwqG+JUxppTOVrPyasMF/uWhTi5N+5veXpB1K/wV15D8Lz7uqblH/CE7apxroaz/E7vudA==",
          launchPath: "bin/opencode", privilege: "user",
        },
        {
          type: "native-package", platforms: ["linux"], arches: ["x64"], libc: "gnu", package: "opencode-linux-x64-baseline", packageVersion: "1.18.30", version: "1.18.30",
          integrity: "sha512-//sHZuMaNZXo6fzBtgUI5vf1oXiMX9Un2a2R3AUzajRahuW42+98wg9J33uuICblE3RS6G4HxobrvnWA8mr4VA==",
          launchPath: "bin/opencode", privilege: "user",
        },
        {
          type: "native-package", platforms: ["linux"], arches: ["x64"], libc: "musl", package: "opencode-linux-x64-baseline-musl", packageVersion: "1.18.30", version: "1.18.30",
          integrity: "sha512-8VAJb4VnNP6MbqWHMDMUwJ5k47tb5SPDqM0lcsCgfbeGjDy7rgFtlA8PYSgUgA9VTByBWmpfERR/34VVOHe82g==",
          launchPath: "bin/opencode", privilege: "user",
        },
        {
          type: "native-package", platforms: ["linux"], arches: ["arm64"], libc: "gnu", package: "opencode-linux-arm64", packageVersion: "1.18.30", version: "1.18.30",
          integrity: "sha512-KU2VO9oGRhV3M9LCYJXeBBtadIIgJYf620KMHFeghrGL0967Zz7PAcMBFZqTy7gUqNEnMaqOqAkSGx57BIw41Q==",
          launchPath: "bin/opencode", privilege: "user",
        },
        {
          type: "native-package", platforms: ["linux"], arches: ["arm64"], libc: "musl", package: "opencode-linux-arm64-musl", packageVersion: "1.18.30", version: "1.18.30",
          integrity: "sha512-IQedvhqaisv886gwk3bR603fPTErdExQa0z3hmqi7waIeuSsQG9B+suhg6iaD74lmxMbYMRlPlg4kIioytiHGg==",
          launchPath: "bin/opencode", privilege: "user",
        },
        {
          type: "native-package", platforms: ["win32"], arches: ["x64"], package: "opencode-windows-x64-baseline", packageVersion: "1.18.30", version: "1.18.30",
          integrity: "sha512-BaqwQxA2TWBUNKsmrDoTF1gg3x6lbt7vA4WluRNuT6GuuJJhQ+lJzOTk2G9tqp4bMybR31p5zXAmPf9JwHP2GA==",
          launchPath: "bin/opencode.exe", privilege: "user",
        },
        {
          type: "native-package", platforms: ["win32"], arches: ["arm64"], package: "opencode-windows-arm64", packageVersion: "1.18.30", version: "1.18.30",
          integrity: "sha512-NLnAzRNqv+6ebLeK5DBGRcN6Fk3PM4STXyrp+IuI8w2WNLJ6JbIk7xxTfbMsrO+CBEV88DCurFOKHB4dpDBaYQ==",
          launchPath: "bin/opencode.exe", privilege: "user",
        },
      ],
    },
  }),
};
