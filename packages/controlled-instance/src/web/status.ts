import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { executablePath } from "@task-handoff/app-runtime/catalog";
import { AppRuntimeManager } from "@task-handoff/app-runtime/runtime";
import { createAiSessionRegistry } from "@task-handoff/ai-session-runtime";
import type { TaskHandoffStoragePaths } from "@task-handoff/core/storage/paths";
import { controlledInstancePackageVersionResolver } from "@task-handoff/core/core/package-version";
import {
  CONTROL_PLANE_PROTOCOL_VERSION,
  ControlledInstanceCapabilitiesSchema,
  type AiSessionTimelineCapabilities,
  type AiSessionProviderCapability,
  type ControlledInstanceCapabilities,
} from "@task-handoff/protocol/control-plane";
import { TriggerStore } from "../triggers/store";

// The controlled-instance artifact is hot-swapped inside an older base image.
// TASK_HANDOFF_VERSION describes that image and must not override the active
// artifact's own package manifest.
export const packageVersion = controlledInstancePackageVersionResolver();

function optionalEnv(name: string) {
  const value = process.env[name]?.trim();
  return value || undefined;
}

function buildInfo() {
  return {
    component: "controlled-instance",
    packageName: "@task-handoff/controlled-instance",
    packageVersion: packageVersion(),
    protocolVersion: CONTROL_PLANE_PROTOCOL_VERSION,
    buildId: optionalEnv("TASK_HANDOFF_BUILD_ID"),
    builtAt: optionalEnv("TASK_HANDOFF_BUILT_AT"),
    gitCommit: optionalEnv("TASK_HANDOFF_GIT_COMMIT"),
    imageRef: optionalEnv("TASK_HANDOFF_IMAGE_REF"),
    imageDigest: optionalEnv("TASK_HANDOFF_IMAGE_DIGEST"),
  };
}

export function controlledMode() {
  return process.env.TASK_HANDOFF_CONTROL_MODE === "controlled";
}

function storageDiagnostic(paths: TaskHandoffStoragePaths) {
  const nearestExistingDirectory = (inputPath: string) => {
    let current = inputPath;
    while (!fs.existsSync(current)) {
      const parent = path.dirname(current);
      if (parent === current) {
        return current;
      }
      current = parent;
    }
    const stat = fs.statSync(current);
    return stat.isDirectory() ? current : path.dirname(current);
  };
  return Object.entries(paths).map(([key, value]) => {
    const targetPath = path.resolve(value);
    const isFilePath = key.endsWith("Path");
    const directory = isFilePath ? path.dirname(targetPath) : targetPath;
    let exists = false;
    let writable = false;
    let type: "file" | "directory" | "missing" = "missing";
    try {
      const stat = fs.existsSync(targetPath) ? fs.statSync(targetPath) : undefined;
      exists = Boolean(stat);
      type = stat?.isFile() ? "file" : stat?.isDirectory() ? "directory" : "missing";
      const accessPath = exists ? (isFilePath ? targetPath : directory) : nearestExistingDirectory(directory);
      fs.accessSync(accessPath, fs.constants.W_OK);
      writable = true;
    } catch {
      writable = false;
    }
    return {
      key,
      path: targetPath,
      exists,
      type,
      writable,
    };
  });
}

export function runtimeDiagnostics(paths: TaskHandoffStoragePaths, noVncRoot: string | undefined) {
  const imageProfile = optionalEnv("TASK_HANDOFF_IMAGE_PROFILE");
  const declaredCapabilities = optionalEnv("TASK_HANDOFF_IMAGE_CAPABILITIES")
    ?.split(",")
    .map((capability) => capability.trim())
    .filter(Boolean);
  const requiredCapabilities = declaredCapabilities ? new Set(declaredCapabilities) : undefined;
  const commands = [
    { name: "Xvfb", requiredFor: ["browser", "gui-terminal", "vscode-web"] },
    { name: "openbox", requiredFor: ["browser", "gui-terminal", "vscode-web"] },
    { name: "picom", requiredFor: ["browser", "gui-terminal", "vscode-web"] },
    { name: "x11vnc", requiredFor: ["browser", "gui-terminal", "vscode-web"] },
    { name: "websockify", requiredFor: ["browser", "gui-terminal", "vscode-web"] },
    { name: "vncserver", requiredFor: ["browser", "gui-terminal", "vscode-web"] },
    { name: "vncpasswd", requiredFor: ["browser", "gui-terminal", "vscode-web"] },
    { name: "openssl", requiredFor: ["browser", "gui-terminal", "vscode-web"] },
    { name: "xrdb", requiredFor: ["browser", "gui-terminal", "vscode-web"] },
    { name: "xrandr", requiredFor: ["browser", "gui-terminal", "vscode-web"] },
    { name: process.env.TASK_HANDOFF_CHROMIUM_COMMAND || "chromium", label: "chromium", requiredFor: ["browser"] },
    { name: process.env.TASK_HANDOFF_VSCODE_WEB_COMMAND || "code-server", label: "code-server", requiredFor: ["vscode-web"] },
    { name: process.env.TASK_HANDOFF_XTERM_COMMAND || "xterm", label: "xterm", requiredFor: ["gui-terminal"] },
    { name: "import", requiredFor: ["browser", "gui-terminal", "vscode-web"] },
    { name: process.env.TASK_HANDOFF_CODEX_COMMAND || "codex", label: "codex", requiredFor: ["codex"] },
    { name: process.env.TASK_HANDOFF_CLAUDE_COMMAND || process.env.CLAUDE_CLI_PATH || "claude", label: "claude", requiredFor: ["claude"] },
    { name: process.env.TASK_HANDOFF_OPENCODE_COMMAND || "opencode", label: "opencode", requiredFor: ["opencode"] },
  ].map((command) => {
    const resolvedPath = executablePath(command.name);
    const required = requiredCapabilities
      ? command.requiredFor.some((capability) => requiredCapabilities.has(capability))
      : true;
    return {
      name: command.label || command.name,
      command: command.name,
      available: Boolean(resolvedPath),
      path: resolvedPath,
      requiredFor: command.requiredFor,
      required,
    };
  });
  const storage = storageDiagnostic(paths);
  const linuxRuntime = process.platform === "linux";
  const guiRequired = requiredCapabilities
    ? ["browser", "gui-terminal", "vscode-web"].some((capability) => requiredCapabilities.has(capability))
    : true;
  const requiredRuntimeReady = linuxRuntime
    && commands.every((command) => !command.required || command.available)
    && (!guiRequired || Boolean(noVncRoot))
    && storage.every((entry) => entry.writable);
  return {
    ok: requiredRuntimeReady,
    image: {
      profile: imageProfile,
      capabilities: declaredCapabilities || [],
    },
    runtime: {
      platform: process.platform,
      arch: process.arch,
      linuxRuntime,
      node: process.version,
      pid: process.pid,
      hostname: os.hostname(),
      uptimeSeconds: Math.round(process.uptime()),
    },
    noVnc: {
      available: Boolean(noVncRoot),
      root: noVncRoot,
    },
    commands,
    storage,
  };
}

function controlledInstanceTarget() {
  const web = process.env.TASK_HANDOFF_INSTANCE_WEB_URL || process.env.TASK_HANDOFF_PUBLIC_WEB_URL;
  const api = process.env.TASK_HANDOFF_INSTANCE_API_URL || (web ? `${web.replace(/\/$/, "")}/api` : undefined);
  return {
    strategy: process.env.TASK_HANDOFF_INSTANCE_ENDPOINT_STRATEGY || "direct-port",
    web,
    api,
    status: web || api ? "reachable" : "unknown",
  };
}

export function workspaceStatus(paths: TaskHandoffStoragePaths) {
  const workspacePath = process.env.TASK_HANDOFF_WORKSPACE || process.env.WORKSPACE || "/workspace";
  const exists = fs.existsSync(workspacePath);
  return {
    mode: process.env.TASK_HANDOFF_WORKSPACE_MODE || (process.env.TASK_HANDOFF_GIT_URL ? "git-clone" : "local-bind"),
    status: exists ? "ready" : "unknown",
    path: workspacePath,
    exists,
    git: {
      url: process.env.TASK_HANDOFF_GIT_URL,
      ref: process.env.TASK_HANDOFF_GIT_REF,
      resolvedCommit: process.env.TASK_HANDOFF_GIT_COMMIT,
    },
    storage: {
      dataDir: paths.dataDir,
      logDir: paths.logDir,
    },
  };
}

export function controlledInstanceCapabilities(
  appRuntime: AppRuntimeManager,
  aiSessionTimeline: AiSessionTimelineCapabilities,
  aiSessionProviders: AiSessionProviderCapability[] = [],
  gitCredentialBrokerInstalled = false,
): ControlledInstanceCapabilities {
  const inventory = appRuntime.appInventory();
  const available = inventory.items.filter((item) => item.availability === "available");
  const availableAppIds = new Set(available.map((item) => item.id));
  const availableProviders = aiSessionProviders.filter((provider) => availableAppIds.has(provider.agent));
  return ControlledInstanceCapabilitiesSchema.parse({
    features: {
      appRuntime: true,
      tty: available.some((item) => item.kind === "tty"),
      gui: available.some((item) => item.kind === "gui"),
      browser: available.some((item) => item.id === "browser" || item.id === "chromium"),
      screenshots: available.some((item) => item.kind === "gui") && Boolean(executablePath("import")),
      logs: true,
      aiSessionWorkspaceSelection: true,
      aiSessionPersistenceSettings: true,
      privateModelCatalog: true,
      gitCliCredentialBroker: gitCredentialBrokerInstalled,
      gitCredentialProxy: gitCredentialBrokerInstalled,
      aiSessionTimeline,
      aiSessionProviders: availableProviders,
      aiSessionConversationAttachments: {
        metadataAgents: availableProviders.filter((provider) => provider.actions.send).map((provider) => provider.agent),
        contentAgents: availableProviders.filter((provider) => provider.actions.send).map((provider) => provider.agent),
        uploadAgents: availableProviders.filter((provider) => provider.actions.send).map((provider) => provider.agent),
        retentionSettings: true,
        fileSizeLimitSettings: true,
      },
    },
  });
}

export function triggerSnapshot(triggers: TriggerStore) {
  const index = triggers.list();
  return {
    enabledCount: index.deployments.filter((entry) => entry.enabled).length,
    runningCount: index.runtime.filter((entry) => entry.status === "running").length,
    errorCount: index.runtime.filter((entry) => entry.status === "error").length,
    configs: index.configs.map((config) => ({
      configHash: config.configHash,
      config,
      deployments: index.deployments.filter((entry) => entry.configHash === config.configHash),
      runtime: index.runtime.filter((entry) => entry.configHash === config.configHash),
    })),
    recentRuns: index.recentRuns.slice(0, 20),
  };
}

export async function controlledInstanceSnapshot(
  appRuntime: AppRuntimeManager,
  paths: TaskHandoffStoragePaths,
  aiSessions: ReturnType<typeof createAiSessionRegistry>,
  triggers: TriggerStore | undefined,
  aiSessionTimeline: AiSessionTimelineCapabilities,
  aiSessionProviders: AiSessionProviderCapability[] = [],
  gitCredentialBrokerInstalled = false,
) {
  const appSessions = appRuntime.listSessions();
  return {
    status: "running" as const,
    health: "ok" as const,
    instanceVersion: packageVersion(),
    protocolVersion: CONTROL_PLANE_PROTOCOL_VERSION,
    build: buildInfo(),
    controlMode: (controlledMode() ? "controlled" : "standalone") as "standalone" | "controlled",
    capabilities: controlledInstanceCapabilities(appRuntime, aiSessionTimeline, aiSessionProviders, gitCredentialBrokerInstalled),
    appInventory: appRuntime.appInventory(),
    apps: {
      runningCount: appRuntime.runningSessionCount(),
      problemCount: appRuntime.problemSessionCount(),
    },
    aiSessions: aiSessions.boundSnapshot(appSessions),
    triggers: triggers ? triggerSnapshot(triggers) : undefined,
    workspace: workspaceStatus(paths),
    target: controlledInstanceTarget(),
  };
}
