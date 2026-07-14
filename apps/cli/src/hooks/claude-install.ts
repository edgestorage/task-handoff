import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const MANAGED_STATUS = "Managed by task-handoff";
const CLAUDE_HOOK_TIMEOUT_SECONDS = 86_400;
const CLAUDE_APPROVAL_TIMEOUT_MS = 12 * 60 * 60 * 1000;

type InstallOptions = {
  claudeHome?: string;
  command?: string;
};

type JsonObject = Record<string, unknown>;

function asRecord(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : {};
}

function claudeHome(options: InstallOptions = {}) {
  return path.resolve(options.claudeHome || process.env.CLAUDE_HOME || path.join(os.homedir(), ".claude"));
}

function shellQuote(value: string) {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function hookCommand(options: InstallOptions = {}) {
  if (options.command) {
    return options.command;
  }
  return `${shellQuote(process.execPath)} ${shellQuote(path.resolve(process.argv[1]))} claude-approval-hook --timeout ${CLAUDE_APPROVAL_TIMEOUT_MS}`;
}

function readSettings(filePath: string) {
  try {
    const text = fs.readFileSync(filePath, "utf8");
    if (!text.trim()) {
      return {};
    }
    return JSON.parse(text);
  } catch (error: unknown) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return {};
    }
    throw error;
  }
}

function backup(filePath: string) {
  if (!fs.existsSync(filePath)) {
    return undefined;
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = `${filePath}.bak.${stamp}`;
  fs.copyFileSync(filePath, backupPath);
  return backupPath;
}

function managedGroup(command: string) {
  return {
    matcher: "*",
    hooks: [
      {
        type: "command",
        command,
        timeout: CLAUDE_HOOK_TIMEOUT_SECONDS,
        statusMessage: `${MANAGED_STATUS}: Forwarding Claude permission request`,
      },
    ],
  };
}

function isManagedHook(hook: unknown) {
  const entry = asRecord(hook);
  return (
    String(entry.statusMessage || "").includes(MANAGED_STATUS) ||
    String(entry.command || "").includes("claude-approval-hook") ||
    String(entry.command || "").includes("codex-approval-hook")
  );
}

function removeManagedHooksFromGroups(groups: unknown[]) {
  return groups
    .map((group: unknown) => {
      if (!group || typeof group !== "object" || Array.isArray(group)) {
        return undefined;
      }
      const groupRecord = group as JsonObject;
      const existingHooks = Array.isArray(groupRecord.hooks) ? groupRecord.hooks : [];
      const nextHooks = existingHooks.filter((hook: unknown) => !isManagedHook(hook));
      if (nextHooks.length === 0) {
        return undefined;
      }
      return { ...group, hooks: nextHooks };
    })
    .filter(Boolean);
}

function removeManagedHooksFromEvents(hooks: JsonObject) {
  const next: JsonObject = {};
  for (const [eventName, groups] of Object.entries(hooks)) {
    const cleanedGroups = removeManagedHooksFromGroups(Array.isArray(groups) ? groups : []);
    if (cleanedGroups.length > 0) {
      next[eventName] = cleanedGroups;
    }
  }
  return next;
}

function installHooks(contents: unknown, command: string) {
  const root = asRecord(contents);
  const hooks = asRecord(root.hooks);
  const nextHooks = removeManagedHooksFromEvents(hooks);
  const existing = Array.isArray(nextHooks.PermissionRequest) ? nextHooks.PermissionRequest : [];
  nextHooks.PermissionRequest = existing.concat(managedGroup(command));
  root.hooks = nextHooks;
  return root;
}

function removeManagedHooks(contents: unknown) {
  const root = asRecord(contents);
  const hooks = asRecord(root.hooks);
  const nextHooks = removeManagedHooksFromEvents(hooks);
  if (Object.keys(nextHooks).length > 0) {
    root.hooks = nextHooks;
  } else {
    delete root.hooks;
  }
  return root;
}

function hasManagedHooks(contents: unknown) {
  const hooks = asRecord(contents).hooks;
  if (!hooks || typeof hooks !== "object" || Array.isArray(hooks)) {
    return false;
  }
  return Object.values(hooks).some((groups: unknown) =>
    Array.isArray(groups) &&
    groups.some((group: unknown) => {
      const entry = asRecord(group);
      return Array.isArray(entry.hooks) && entry.hooks.some(isManagedHook);
    }),
  );
}

export function runClaudeHookInstall(options: InstallOptions = {}) {
  const home = claudeHome(options);
  const settingsPath = path.join(home, "settings.json");
  const command = hookCommand(options);
  fs.mkdirSync(home, { recursive: true });

  const settingsBefore = readSettings(settingsPath);
  const settingsTextBefore = JSON.stringify(settingsBefore, null, 2);
  const settingsAfter = installHooks(settingsBefore, command);
  const settingsTextAfter = JSON.stringify(settingsAfter, null, 2);

  if (settingsTextAfter !== settingsTextBefore) {
    backup(settingsPath);
    fs.writeFileSync(settingsPath, `${settingsTextAfter}\n`, { mode: 0o600 });
  }

  console.log(`Claude hook installed at ${settingsPath}`);
  console.log(`Command: ${command}`);
  console.log("Open /hooks in Claude Code to verify the task-handoff hook if needed.");
}

export function runClaudeHookStatus(options: InstallOptions = {}) {
  const home = claudeHome(options);
  const settingsPath = path.join(home, "settings.json");
  const settings = readSettings(settingsPath);
  console.log(`Claude home: ${home}`);
  console.log(`managed PermissionRequest hook: ${hasManagedHooks(settings)}`);
}

export function runClaudeHookUninstall(options: InstallOptions = {}) {
  const home = claudeHome(options);
  const settingsPath = path.join(home, "settings.json");
  const settingsBefore = readSettings(settingsPath);
  const settingsTextBefore = JSON.stringify(settingsBefore, null, 2);
  const settingsAfter = removeManagedHooks(settingsBefore);
  const settingsTextAfter = JSON.stringify(settingsAfter, null, 2);
  if (settingsTextAfter !== settingsTextBefore) {
    backup(settingsPath);
    fs.writeFileSync(settingsPath, `${settingsTextAfter}\n`, { mode: 0o600 });
  }
  console.log(`task-handoff Claude hook removed from ${settingsPath}`);
}
