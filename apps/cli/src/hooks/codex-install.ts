import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import TOML from "@iarna/toml";

const MANAGED_STATUS = "Managed by task-handoff";
const CODEX_HOOK_TIMEOUT_SECONDS = 86_400;

type InstallOptions = {
  codexHome?: string;
  command?: string;
};

type JsonObject = Record<string, unknown>;
type TomlMap = ReturnType<typeof TOML.parse>;

function asRecord(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : {};
}

function stringifyToml(record: JsonObject) {
  return TOML.stringify(record as TomlMap);
}

function codexHome(options: InstallOptions = {}) {
  return path.resolve(options.codexHome || process.env.CODEX_HOME || path.join(os.homedir(), ".codex"));
}

function shellQuote(value: string) {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function hookCommand(options: InstallOptions = {}) {
  if (options.command) {
    return options.command;
  }
  return `${shellQuote(process.execPath)} ${shellQuote(path.resolve(process.argv[1]))} codex-approval-hook`;
}

function readText(filePath: string) {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch (error: unknown) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return "";
    }
    throw error;
  }
}

function readHooks(filePath: string) {
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

function enableHooksFeature(contents: string) {
  const config = asRecord(contents.trim() ? TOML.parse(contents) : {});
  const features = asRecord(config.features);
  features.hooks = true;
  delete features.codex_hooks;
  config.features = features;
  return stringifyToml(config);
}

function managedGroup(command: string) {
  return {
    matcher: "*",
    hooks: [
      {
        type: "command",
        command,
        timeout: CODEX_HOOK_TIMEOUT_SECONDS,
        statusMessage: `${MANAGED_STATUS}: Forwarding approval request`,
      },
    ],
  };
}

function isManagedGroup(group: unknown) {
  const groupRecord = asRecord(group);
  const hooks = Array.isArray(groupRecord.hooks) ? groupRecord.hooks : [];
  return hooks.some(
    (hook: unknown) => {
      const entry = asRecord(hook);
      return (
        String(entry.statusMessage || "").includes(MANAGED_STATUS) ||
        String(entry.command || "").includes("codex-approval-hook")
      );
    },
  );
}

function installHooks(contents: unknown, command: string) {
  const root = asRecord(contents);
  const hooks = asRecord(root.hooks);
  const existing = Array.isArray(hooks.PermissionRequest) ? hooks.PermissionRequest : [];
  hooks.PermissionRequest = existing.filter((group: unknown) => !isManagedGroup(group)).concat(managedGroup(command));
  root.hooks = hooks;
  return root;
}

function removeManagedHooks(contents: unknown) {
  const root = asRecord(contents);
  const hooks = asRecord(root.hooks);
  const existing = Array.isArray(hooks.PermissionRequest) ? hooks.PermissionRequest : [];
  const next = existing.filter((group: unknown) => !isManagedGroup(group));
  if (next.length > 0) {
    hooks.PermissionRequest = next;
  } else {
    delete hooks.PermissionRequest;
  }
  root.hooks = hooks;
  return root;
}

function hasManagedHooks(contents: unknown) {
  const hooks = asRecord(contents).hooks;
  const permissionRequest = asRecord(hooks).PermissionRequest;
  return Array.isArray(permissionRequest) && permissionRequest.some(isManagedGroup);
}

export function runCodexHookInstall(options: InstallOptions = {}) {
  const home = codexHome(options);
  const configPath = path.join(home, "config.toml");
  const hooksPath = path.join(home, "hooks.json");
  const command = hookCommand(options);
  fs.mkdirSync(home, { recursive: true });

  const configBefore = readText(configPath);
  const configAfter = enableHooksFeature(configBefore);
  const hooksBefore = readHooks(hooksPath);
  const hooksTextBefore = JSON.stringify(hooksBefore, null, 2);
  const hooksAfter = installHooks(hooksBefore, command);

  if (configAfter !== configBefore) {
    backup(configPath);
    fs.writeFileSync(configPath, `${configAfter.replace(/\s+$/, "")}\n`, { mode: 0o600 });
  }
  const hooksTextAfter = JSON.stringify(hooksAfter, null, 2);
  if (hooksTextAfter !== hooksTextBefore) {
    backup(hooksPath);
    fs.writeFileSync(hooksPath, `${hooksTextAfter}\n`, { mode: 0o600 });
  }

  console.log(`Codex hook installed at ${hooksPath}`);
  console.log(`Command: ${command}`);
  console.log("Open /hooks in Codex and trust the task-handoff hook if prompted.");
}

export function runCodexHookStatus(options: InstallOptions = {}) {
  const home = codexHome(options);
  const configPath = path.join(home, "config.toml");
  const hooksPath = path.join(home, "hooks.json");
  const config = readText(configPath);
  const hooks = readHooks(hooksPath);
  const parsedConfig = config.trim() ? TOML.parse(config) : {};
  const features = asRecord(asRecord(parsedConfig).features);
  console.log(`Codex home: ${home}`);
  console.log(`features.hooks: ${features?.hooks === true}`);
  console.log(`managed PermissionRequest hook: ${hasManagedHooks(hooks)}`);
}

export function runCodexHookUninstall(options: InstallOptions = {}) {
  const home = codexHome(options);
  const hooksPath = path.join(home, "hooks.json");
  const hooksBefore = readHooks(hooksPath);
  const hooksTextBefore = JSON.stringify(hooksBefore, null, 2);
  const hooksAfter = removeManagedHooks(hooksBefore);
  const hooksTextAfter = JSON.stringify(hooksAfter, null, 2);
  if (hooksTextAfter !== hooksTextBefore) {
    backup(hooksPath);
    fs.writeFileSync(hooksPath, `${hooksTextAfter}\n`, { mode: 0o600 });
  }
  console.log(`task-handoff Codex hook removed from ${hooksPath}`);
}
