import { launcherDetection } from "./shared";
import type { ManagedAppProvider } from "./types";

/**
 * Every currently supported ACP Agent is published as a Node CLI whose `bin`
 * entry is a JavaScript file. Their native pieces are optional npm packages
 * (node-pty, ripgrep, sharp, koffi, ...), so npm must resolve the whole
 * dependency graph. The native-package recipes deliberately verify and unpack
 * one directly executable platform artifact without invoking npm or lifecycle
 * scripts; using them here would leave the Agent without its JS runtime and
 * dependencies. Keep these Agents on the managed node-package recipe unless
 * upstream starts publishing a directly executable platform package.
 */
export const managedAcpAgents = [
  { id: "gemini", name: "Gemini CLI", description: "Google Gemini CLI agent over ACP.", packageName: "@google/gemini-cli", version: "0.71.1", binName: "gemini", acpArgs: ["--acp"], loadSession: true },
  { id: "commandcode", name: "Command Code", description: "Command Code agent over ACP.", packageName: "command-code", version: "1.93.2", binName: "cmd", acpArgs: ["acp"], loadSession: true },
  { id: "dsh", name: "DeepSeek Harness", description: "DeepSeek Harness agent over ACP.", packageName: "@deepseek-ai/dsh", version: "0.2.2-rc.5", binName: "dsh", acpArgs: ["acp"], loadSession: false },
] as const;

export const managedAcpAppProviders: ManagedAppProvider[] = managedAcpAgents.map((agent) => ({
  id: agent.id,
  capabilities: { supportsCwdSelection: true },
  definition: () => ({
    launcher: { id: agent.id, name: agent.name, description: agent.description, kind: "tty", command: agent.id },
    detection: launcherDetection(),
    distribution: {
      recipes: [{
        type: "node-package",
        platforms: ["linux", "darwin"],
        arches: ["x64", "arm64"],
        installer: "npm",
        packages: [agent.packageName],
        binName: agent.binName,
        version: agent.version,
        managed: true,
        privilege: "user",
      }],
    },
  }),
}));
