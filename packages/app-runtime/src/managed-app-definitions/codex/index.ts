import type { ManagedAppProvider } from "../types";
import { launcherDetection, modelArgs } from "../shared";
import { createCodexRuntime } from "./runtime";

export const codexProvider: ManagedAppProvider = {
  id: "codex",
  capabilities: { supportsCwdSelection: true, supportsAiSessionResume: true },
  aiSessionResumeArgs: (providerSessionId) => ["resume", providerSessionId],
  createRuntime: createCodexRuntime,
  definition: ({ env }) => ({
    launcher: {
      id: "codex",
      name: "Codex",
      kind: "tty",
      description: "OpenAI Codex CLI in the task workspace.",
      command: env.TASK_HANDOFF_CODEX_COMMAND || "codex",
      // This is the interactive Codex CLI launch path. The app-server is a
      // protocol backend and does not show the startup upgrade prompt.
      args: ["-c", "check_for_update_on_startup=false", ...modelArgs(env, "TASK_HANDOFF_CODEX_MODEL", "CODEX_MODEL")],
    },
    detection: launcherDetection(),
    distribution: {
      recipes: [
        {
          type: "native-package", platforms: ["linux"], arches: ["x64"], package: "@openai/codex", packageVersion: "0.165.0-linux-x64", version: "0.165.0",
          integrity: "sha512-FotDc7bVHwaommtsdDP8PPrH0a5IwC/t8H/LhdEcH4EBqgeYFRCtptiHcuwgvNRCLbTbOyFE/Ur6GzYCljgaSQ==",
          launchPath: "vendor/x86_64-unknown-linux-musl/bin/codex", privilege: "user",
        },
        {
          type: "native-package", platforms: ["linux"], arches: ["arm64"], package: "@openai/codex", packageVersion: "0.165.0-linux-arm64", version: "0.165.0",
          integrity: "sha512-qdrYdcabxn3biX2qTtb/GuuMk20ZAQYxcmY7lHcp6CkAzyqsXbL0vIJFwWJr83/pNM+CUZH4YaTPns2kN7ZIfA==",
          launchPath: "vendor/aarch64-unknown-linux-musl/bin/codex", privilege: "user",
        },
        {
          type: "native-package", platforms: ["darwin"], arches: ["x64"], package: "@openai/codex", packageVersion: "0.165.0-darwin-x64", version: "0.165.0",
          integrity: "sha512-mxMtlntnUq0Xb8rjvHph3Ws045Q82BLbeKRRdkN70Es9mho/D/Blh1ShZvzQOnsoeVw8lbV9fOLjW1vncoufKQ==",
          launchPath: "vendor/x86_64-apple-darwin/bin/codex", privilege: "user",
        },
        {
          type: "native-package", platforms: ["darwin"], arches: ["arm64"], package: "@openai/codex", packageVersion: "0.165.0-darwin-arm64", version: "0.165.0",
          integrity: "sha512-MQ/Z0Xw9v08DHunnzodi9NwA844MI3+RO72IM8o0Lr/UemnlEoBMCxpojstxX6mf5ZQwUrIg0yekDd9cFZ29hg==",
          launchPath: "vendor/aarch64-apple-darwin/bin/codex", privilege: "user",
        },
        {
          type: "native-package", platforms: ["win32"], arches: ["x64"], package: "@openai/codex", packageVersion: "0.165.0-win32-x64", version: "0.165.0",
          integrity: "sha512-f5LMyugPSnAovnTnR1N+SNHSTfWZ+ym5A4H3zZHz/zhuMGMGZD8IxUdlSUlEbiENYyPXrJ8G3Jh+CLyzTfQB6Q==",
          launchPath: "vendor/x86_64-pc-windows-msvc/bin/codex.exe", privilege: "user",
        },
        {
          type: "native-package", platforms: ["win32"], arches: ["arm64"], package: "@openai/codex", packageVersion: "0.165.0-win32-arm64", version: "0.165.0",
          integrity: "sha512-6HLE44VQECPITRZN85NCV/w268Fw/083VKe+5ReOKO9wlL6Kyq1j1mLP2vZ3rmr0goG/HOykrJpZZT0aUD1ntg==",
          launchPath: "vendor/aarch64-pc-windows-msvc/bin/codex.exe", privilege: "user",
        },
      ],
    },
  }),
};
