import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { executablePath } from "@task-handoff/app-runtime/catalog";
import { AppRuntimeManager } from "@task-handoff/app-runtime/runtime";
import { createAiSessionRegistry } from "@task-handoff/ai-session-runtime";
import type { TaskHandoffStoragePaths } from "@task-handoff/core/storage/paths";
import { CONTROL_PLANE_PROTOCOL_VERSION } from "@task-handoff/protocol/control-plane";
import { TriggerStore } from "../triggers/store";

export function packageVersion() {
  try {
    const packagePath = path.resolve(__dirname, "..", "package.json");
    return JSON.parse(fs.readFileSync(packagePath, "utf8")).version || "unknown";
  } catch {
    return "unknown";
  }
}

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
  const commands = [
    { name: "Xvfb", requiredFor: ["gui-display"] },
    { name: "openbox", requiredFor: ["gui-window-manager"] },
    { name: "picom", requiredFor: ["gui-compositor"] },
    { name: "x11vnc", requiredFor: ["vnc"] },
    { name: "websockify", requiredFor: ["novnc-proxy"] },
    { name: "vncserver", requiredFor: ["kasmvnc"] },
    { name: "vncpasswd", requiredFor: ["kasmvnc-auth"] },
    { name: "openssl", requiredFor: ["kasmvnc-cert"] },
    { name: "xrdb", requiredFor: ["kasmvnc-hidpi"] },
    { name: "xrandr", requiredFor: ["kasmvnc-resize"] },
    { name: process.env.TASK_HANDOFF_CHROMIUM_COMMAND || "chromium", label: "chromium", requiredFor: ["browser"] },
    { name: process.env.TASK_HANDOFF_VSCODE_WEB_COMMAND || "code-server", label: "code-server", requiredFor: ["vscode-web"] },
    { name: process.env.TASK_HANDOFF_XTERM_COMMAND || "xterm", label: "xterm", requiredFor: ["gui-terminal"] },
    { name: "import", requiredFor: ["screenshot"] },
    { name: process.env.TASK_HANDOFF_CODEX_COMMAND || "codex", label: "codex", requiredFor: ["active-codex-agent"] },
    { name: process.env.TASK_HANDOFF_CLAUDE_COMMAND || process.env.CLAUDE_CLI_PATH || "claude", label: "claude", requiredFor: ["active-claude-agent"] },
  ].map((command) => {
    const resolvedPath = executablePath(command.name);
    return {
      name: command.label || command.name,
      command: command.name,
      available: Boolean(resolvedPath),
      path: resolvedPath,
      requiredFor: command.requiredFor,
    };
  });
  const storage = storageDiagnostic(paths);
  const linuxRuntime = process.platform === "linux";
  const requiredRuntimeReady = linuxRuntime && commands.every((command) => command.available) && Boolean(noVncRoot) && storage.every((entry) => entry.writable);
  return {
    ok: requiredRuntimeReady,
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

export function controlledInstanceCapabilities(appRuntime: AppRuntimeManager) {
  const catalog = appRuntime.catalog();
  return {
    protocolVersion: CONTROL_PLANE_PROTOCOL_VERSION,
    apps: catalog.map((item) => ({
      id: item.id,
      name: item.name,
      kind: item.kind,
      automation: item.automation,
    })),
    features: {
      appRuntime: true,
      tty: catalog.some((item) => item.kind === "tty"),
      gui: catalog.some((item) => item.kind === "gui"),
      browser: catalog.some((item) => item.id === "browser" || item.id === "chromium"),
      screenshots: true,
      logs: true,
    },
  };
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
  aiSessions = createAiSessionRegistry(),
  triggers?: TriggerStore,
) {
  const appSessions = appRuntime.listSessions();
  return {
    status: "running" as const,
    health: "ok" as const,
    instanceVersion: packageVersion(),
    protocolVersion: CONTROL_PLANE_PROTOCOL_VERSION,
    build: buildInfo(),
    controlMode: (controlledMode() ? "controlled" : "standalone") as "standalone" | "controlled",
    capabilities: controlledInstanceCapabilities(appRuntime),
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
