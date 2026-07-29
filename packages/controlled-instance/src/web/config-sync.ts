import fs from "node:fs";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import type { NodeFolderTreeEntry } from "@task-handoff/protocol/control-plane";
import {
  ConfigSyncBatchResultSchema,
  ConfigSyncProgramSchema,
  type ConfigSyncProgram,
  type ConfigSyncRequest,
} from "@task-handoff/protocol/config-sync";

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

export function configSyncPrograms(): ConfigSyncProgram[] {
  return configSyncPresets().map((preset) => ConfigSyncProgramSchema.parse({
    id: preset.id,
    label: preset.label,
    directoryName: preset.id,
  }));
}

function resolveProjectPath(projectRoot: string, relativePath: string) {
  const workspace = path.resolve(workspaceDir());
  const root = path.resolve(workspace, projectRoot);
  if (root !== workspace && !root.startsWith(`${workspace}${path.sep}`)) {
    const error = new Error(`Config sync folder escapes the workspace: ${projectRoot}`);
    Object.assign(error, { statusCode: 400, code: "CONFIG_SYNC_FOLDER_INVALID" });
    throw error;
  }
  assertNoSymlinkSegments(workspace, root, "CONFIG_SYNC_FOLDER_INVALID");
  const resolved = path.resolve(root, relativePath);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    const error = new Error(`Config sync path escapes project root: ${relativePath}`);
    Object.assign(error, { statusCode: 400, code: "CONFIG_SYNC_PATH_INVALID" });
    throw error;
  }
  assertNoSymlinkSegments(workspace, resolved, "CONFIG_SYNC_PATH_INVALID");
  return resolved;
}

function assertNoSymlinkSegments(root: string, candidate: string, code: string) {
  const relative = path.relative(root, candidate);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    const error = new Error("Config sync path escapes its allowed root.");
    Object.assign(error, { statusCode: 400, code });
    throw error;
  }
  let current = root;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") break;
      throw error;
    }
    if (stat.isSymbolicLink()) {
      const error = new Error(`Config sync path contains a symbolic link: ${current}`);
      Object.assign(error, { statusCode: 400, code });
      throw error;
    }
  }
}

function resolveWorkspaceFolder(relativePath = ".") {
  const workspace = path.resolve(workspaceDir());
  if (path.isAbsolute(relativePath)) {
    const error = new Error("Config sync folder must be relative to the instance workspace.");
    Object.assign(error, { statusCode: 400, code: "CONFIG_SYNC_FOLDER_INVALID" });
    throw error;
  }
  const resolved = path.resolve(workspace, relativePath);
  if (resolved !== workspace && !resolved.startsWith(`${workspace}${path.sep}`)) {
    const error = new Error("Config sync folder must stay inside the instance workspace.");
    Object.assign(error, { statusCode: 400, code: "CONFIG_SYNC_FOLDER_INVALID" });
    throw error;
  }
  assertNoSymlinkSegments(workspace, resolved, "CONFIG_SYNC_FOLDER_INVALID");
  return { workspace, resolved };
}

function relativeWorkspacePath(workspace: string, target: string) {
  const relative = path.relative(workspace, target).split(path.sep).join("/");
  return relative || ".";
}

function folderTreeEntry(workspace: string, directory: string, depth: number): NodeFolderTreeEntry {
  const children = depth > 0
    ? fs.readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .sort((left, right) => left.name.localeCompare(right.name))
      .map((entry) => folderTreeEntry(workspace, path.join(directory, entry.name), depth - 1))
    : [];
  return {
    name: directory === workspace ? path.basename(workspace) || workspace : path.basename(directory),
    path: relativeWorkspacePath(workspace, directory),
    children,
  };
}

export function listConfigSyncFolders(relativePath = ".", depth = 0): NodeFolderTreeEntry[] {
  const { workspace, resolved } = resolveWorkspaceFolder(relativePath);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    const error = new Error(`Config sync folder was not found: ${relativePath}`);
    Object.assign(error, { statusCode: 404, code: "CONFIG_SYNC_FOLDER_NOT_FOUND" });
    throw error;
  }
  const realWorkspace = fs.realpathSync(workspace);
  const realResolved = fs.realpathSync(resolved);
  if (realResolved !== realWorkspace && !realResolved.startsWith(`${realWorkspace}${path.sep}`)) {
    const error = new Error("Config sync folder must stay inside the instance workspace.");
    Object.assign(error, { statusCode: 400, code: "CONFIG_SYNC_FOLDER_INVALID" });
    throw error;
  }
  return [folderTreeEntry(realWorkspace, realResolved, Math.min(2, Math.max(0, depth)))];
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
  const allowedRoot = allowedRoots.find((root) => resolved === root || resolved.startsWith(`${root}${path.sep}`));
  if (!allowedRoot) {
    const error = new Error(`Config sync target path is not allowed: ${containerPath}`);
    Object.assign(error, { statusCode: 400, code: "CONFIG_SYNC_CONTAINER_PATH_INVALID" });
    throw error;
  }
  assertNoSymlinkSegments(allowedRoot, resolved, "CONFIG_SYNC_CONTAINER_PATH_INVALID");
  return resolved;
}

function copyFileWithoutSymlinks(source: string, target: string) {
  const noFollow = fs.constants.O_NOFOLLOW || 0;
  const sourceFd = fs.openSync(source, fs.constants.O_RDONLY | noFollow);
  const temporaryTarget = path.join(path.dirname(target), `.task-handoff-config-sync-${crypto.randomUUID()}.tmp`);
  let targetFd: number | undefined;
  let readyToRename = false;
  try {
    targetFd = fs.openSync(temporaryTarget, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | noFollow, 0o600);
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let bytesRead = 0;
    while ((bytesRead = fs.readSync(sourceFd, buffer, 0, buffer.length, null)) > 0) {
      let offset = 0;
      while (offset < bytesRead) offset += fs.writeSync(targetFd, buffer, offset, bytesRead - offset);
    }
    fs.fchmodSync(targetFd, fs.fstatSync(sourceFd).mode & 0o777);
    fs.fsyncSync(targetFd);
    readyToRename = true;
  } finally {
    fs.closeSync(sourceFd);
    if (targetFd !== undefined) fs.closeSync(targetFd);
    if (!readyToRename) fs.rmSync(temporaryTarget, { force: true });
  }
  try {
    fs.renameSync(temporaryTarget, target);
  } catch (error) {
    fs.rmSync(temporaryTarget, { force: true });
    throw error;
  }
}

function copyDirectoryWithoutSymlinks(source: string, target: string) {
  const sourceStat = fs.lstatSync(source);
  if (sourceStat.isSymbolicLink() || !sourceStat.isDirectory()) {
    const error = new Error(`Config sync directory source is not a regular directory: ${source}`);
    Object.assign(error, { statusCode: 400, code: "CONFIG_SYNC_SYMLINK_NOT_ALLOWED" });
    throw error;
  }
  if (fs.existsSync(target)) {
    const targetStat = fs.lstatSync(target);
    if (targetStat.isSymbolicLink() || !targetStat.isDirectory()) {
      const error = new Error(`Config sync directory target is not a regular directory: ${target}`);
      Object.assign(error, { statusCode: 400, code: "CONFIG_SYNC_SYMLINK_NOT_ALLOWED" });
      throw error;
    }
  } else {
    fs.mkdirSync(target, { recursive: false, mode: sourceStat.mode & 0o777 });
  }
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const sourceEntry = path.join(source, entry.name);
    const targetEntry = path.join(target, entry.name);
    if (entry.isSymbolicLink()) {
      const error = new Error(`Config sync directory contains a symbolic link: ${sourceEntry}`);
      Object.assign(error, { statusCode: 400, code: "CONFIG_SYNC_SYMLINK_NOT_ALLOWED" });
      throw error;
    }
    if (entry.isDirectory()) copyDirectoryWithoutSymlinks(sourceEntry, targetEntry);
    else if (entry.isFile()) copyFileWithoutSymlinks(sourceEntry, targetEntry);
  }
}

function copyItem(type: ConfigSyncItem["type"], source: string, target: string) {
  if (!fs.existsSync(source)) {
    return "skipped_missing_source" as const;
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  if (type === "dir") {
    copyDirectoryWithoutSymlinks(source, target);
  } else {
    const sourceStat = fs.lstatSync(source);
    if (sourceStat.isSymbolicLink() || !sourceStat.isFile()) {
      const error = new Error(`Config sync file source is not a regular file: ${source}`);
      Object.assign(error, { statusCode: 400, code: "CONFIG_SYNC_SYMLINK_NOT_ALLOWED" });
      throw error;
    }
    copyFileWithoutSymlinks(source, target);
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
  const presetRoot = resolveWorkspaceFolder(preset.projectRoot);
  assertNoSymlinkSegments(presetRoot.workspace, presetRoot.resolved, "CONFIG_SYNC_FOLDER_INVALID");
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

export function runConfigSyncBatch(request: ConfigSyncRequest) {
  const selectedFolder = resolveWorkspaceFolder(request.workspaceFolder);
  const workspaceFolder = relativeWorkspacePath(selectedFolder.workspace, selectedFolder.resolved);
  const presets = request.programIds.map((programId) => {
    const preset = configSyncPresets().find((candidate) => candidate.id === programId);
    if (!preset) {
      const error = new Error(`Config sync program ${programId} was not found.`);
      Object.assign(error, { statusCode: 404, code: "CONFIG_SYNC_PROGRAM_NOT_FOUND" });
      throw error;
    }
    return { ...preset, projectRoot: path.join(workspaceFolder, preset.id) };
  });
  return ConfigSyncBatchResultSchema.parse({
    direction: request.direction,
    workspaceFolder,
    programs: presets.map((preset) => runConfigSync(request.direction, preset.id, preset)),
  });
}
