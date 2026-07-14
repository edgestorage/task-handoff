import fs from "node:fs";
import os from "node:os";
import path from "node:path";

type ConfigSyncItem = {
  id: string;
  type: "file" | "dir";
  projectPath: string;
  containerPath: string;
};

type ConfigSyncPreset = {
  id: string;
  label: string;
  projectRoot: string;
  items: ConfigSyncItem[];
};

type ConfigSyncDirection = "import" | "export";

function homeDir() {
  return process.env.HOME || os.homedir() || "/home/agent";
}

function workspaceDir() {
  return process.env.TASK_HANDOFF_WORKSPACE || process.env.WORKSPACE || "/workspace";
}

function codexHomeDir() {
  return process.env.CODEX_HOME || path.join(homeDir(), ".codex");
}

function claudeHomeDir() {
  return process.env.CLAUDE_HOME || path.join(homeDir(), ".claude");
}

function chromiumUserDataDirs() {
  const dirs = [path.join(homeDir(), ".config", "chromium")];
  const configured = process.env.TASK_HANDOFF_CHROMIUM_USER_DATA_DIR?.trim();
  if (configured && !dirs.includes(configured)) {
    dirs.push(configured);
  }
  return dirs;
}

export function configSyncPresets(): ConfigSyncPreset[] {
  const home = homeDir();
  const browserItems = chromiumUserDataDirs().map((containerPath, index) => ({
    id: index === 0 ? "chromium-profile" : `chromium-profile-${index + 1}`,
    type: "dir" as const,
    projectPath: index === 0 ? "chromium" : `chromium-${index + 1}`,
    containerPath,
  }));
  return [
    {
      id: "codex",
      label: "Codex",
      projectRoot: ".task-handoff/configs/codex",
      items: [
        { id: "config", type: "file", projectPath: "config.toml", containerPath: path.join(home, ".codex", "config.toml") },
        { id: "auth", type: "file", projectPath: "auth.json", containerPath: path.join(home, ".codex", "auth.json") },
        { id: "agents", type: "file", projectPath: "AGENTS.md", containerPath: path.join(home, ".codex", "AGENTS.md") },
        { id: "skills", type: "dir", projectPath: "skills", containerPath: path.join(home, ".codex", "skills") },
      ],
    },
    {
      id: "claude",
      label: "Claude",
      projectRoot: ".task-handoff/configs/claude",
      items: [
        { id: "claude-json", type: "file", projectPath: ".claude.json", containerPath: path.join(home, ".claude.json") },
        { id: "settings", type: "file", projectPath: "settings.json", containerPath: path.join(home, ".claude", "settings.json") },
        { id: "claude-md", type: "file", projectPath: "CLAUDE.md", containerPath: path.join(home, ".claude", "CLAUDE.md") },
        { id: "commands", type: "dir", projectPath: "commands", containerPath: path.join(home, ".claude", "commands") },
        { id: "agents", type: "dir", projectPath: "agents", containerPath: path.join(home, ".claude", "agents") },
        { id: "skills", type: "dir", projectPath: "skills", containerPath: path.join(home, ".claude", "skills") },
      ],
    },
    {
      id: "browser",
      label: "Browser",
      projectRoot: ".task-handoff/configs/browser",
      items: browserItems,
    },
  ];
}

function resolveProjectPath(projectRoot: string, relativePath: string) {
  const root = path.resolve(workspaceDir(), projectRoot);
  const resolved = path.resolve(root, relativePath);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    const error = new Error(`Config sync path escapes project root: ${relativePath}`);
    Object.assign(error, { statusCode: 400, code: "CONFIG_SYNC_PATH_INVALID" });
    throw error;
  }
  return resolved;
}

function expandContainerPath(containerPath: string) {
  const replacements: Record<string, string> = {
    HOME: homeDir(),
    WORKSPACE: workspaceDir(),
    CODEX_HOME: codexHomeDir(),
    CLAUDE_HOME: claudeHomeDir(),
  };
  return containerPath.replace(/\$\{([A-Z_]+)\}/g, (match, key: string) => replacements[key] || match);
}

function resolveContainerPath(containerPath: string) {
  const resolved = path.resolve(expandContainerPath(containerPath));
  const allowedRoots = [
    path.resolve(homeDir()),
    path.resolve(workspaceDir()),
    path.resolve(process.env.TASK_HANDOFF_DATA_DIR || "/data/task-handoff"),
    path.resolve(process.env.TASK_HANDOFF_LOG_DIR || "/data/logs"),
    path.resolve(process.env.TASK_HANDOFF_ARTIFACT_DIR || "/data/artifacts"),
  ];
  if (!allowedRoots.some((root) => resolved === root || resolved.startsWith(`${root}${path.sep}`))) {
    const error = new Error(`Config sync target path is not allowed: ${containerPath}`);
    Object.assign(error, { statusCode: 400, code: "CONFIG_SYNC_CONTAINER_PATH_INVALID" });
    throw error;
  }
  return resolved;
}

function copyItem(type: ConfigSyncItem["type"], source: string, target: string) {
  if (!fs.existsSync(source)) {
    return "skipped_missing_source" as const;
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  if (type === "dir") {
    fs.cpSync(source, target, { recursive: true, force: true });
  } else {
    fs.copyFileSync(source, target);
  }
  return "copied" as const;
}

export function runConfigSync(direction: ConfigSyncDirection, presetId: string, presetOverride?: ConfigSyncPreset) {
  const preset = presetOverride || configSyncPresets().find((item) => item.id === presetId);
  if (!preset) {
    const error = new Error(`Config sync preset ${presetId} was not found.`);
    Object.assign(error, { statusCode: 404, code: "CONFIG_SYNC_PRESET_NOT_FOUND" });
    throw error;
  }
  const items = preset.items.map((item) => {
    const projectPath = resolveProjectPath(preset.projectRoot, item.projectPath);
    const containerPath = resolveContainerPath(item.containerPath);
    const source = direction === "import" ? projectPath : containerPath;
    const target = direction === "import" ? containerPath : projectPath;
    try {
      return {
        ...item,
        source,
        target,
        status: copyItem(item.type, source, target),
      };
    } catch (error) {
      return {
        ...item,
        source,
        target,
        status: "failed" as const,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  });
  return {
    preset: {
      id: preset.id,
      label: preset.label,
      projectRoot: preset.projectRoot,
    },
    direction,
    items,
  };
}
