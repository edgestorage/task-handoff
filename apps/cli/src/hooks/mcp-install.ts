import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import TOML from "@iarna/toml";

const DEFAULT_SERVER_NAME = "task_handoff";
const DEFAULT_TOOL_TIMEOUT_SEC = 86400;

type InstallOptions = {
  codexHome?: string;
  claudeHome?: string;
  name?: string;
  command?: string;
  args?: string[];
  toolTimeoutSec?: number;
};

type ConfigObject = Record<string, unknown>;
type TomlMap = ReturnType<typeof TOML.parse>;

type McpToolConfig = ConfigObject & {
  approval_mode?: string;
};

type McpServerConfig = ConfigObject & {
  type?: "stdio" | string;
  command?: string;
  args?: string[];
  tool_timeout_sec?: number;
  tools?: Record<string, McpToolConfig>;
};

type CodexConfig = ConfigObject & {
  mcp_servers?: Record<string, McpServerConfig>;
};

function stringifyToml(record: ConfigObject) {
  return TOML.stringify(record as TomlMap);
}

type ClaudeSettings = ConfigObject & {
  mcpServers?: Record<string, McpServerConfig>;
};

function asRecord(value: unknown): ConfigObject {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as ConfigObject) : {};
}

function codexHome(options: InstallOptions = {}) {
  return path.resolve(options.codexHome || process.env.CODEX_HOME || path.join(os.homedir(), ".codex"));
}

function claudeHome(options: InstallOptions = {}) {
  return path.resolve(options.claudeHome || process.env.CLAUDE_HOME || path.join(os.homedir(), ".claude"));
}

function serverName(options: InstallOptions = {}) {
  const name = String(options.name || DEFAULT_SERVER_NAME).trim();
  if (!name) {
    throw new Error("MCP server name must not be empty.");
  }
  return name;
}

function defaultArgs() {
  return [path.resolve(process.argv[1]), "mcp"];
}

function codexServerConfig(options: InstallOptions = {}): McpServerConfig {
  return {
    command: options.command || process.execPath,
    args: options.args || defaultArgs(),
    tool_timeout_sec: options.toolTimeoutSec || DEFAULT_TOOL_TIMEOUT_SEC,
    tools: {
      get_task: {
        approval_mode: "approve",
      },
    },
  };
}

function claudeServerConfig(options: InstallOptions = {}): McpServerConfig {
  return {
    type: "stdio",
    command: options.command || process.execPath,
    args: options.args || defaultArgs(),
  };
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

function readConfig(filePath: string): CodexConfig {
  const text = readText(filePath);
  return asRecord(text.trim() ? TOML.parse(text) : {}) as CodexConfig;
}

function readJson(filePath: string): ClaudeSettings {
  const text = readText(filePath);
  return asRecord(text.trim() ? JSON.parse(text) : {}) as ClaudeSettings;
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

function normalizeCodexConfig(contents: unknown): CodexConfig {
  return asRecord(contents) as CodexConfig;
}

function normalizeClaudeSettings(contents: unknown): ClaudeSettings {
  return asRecord(contents) as ClaudeSettings;
}

function normalizeServers(value: unknown): Record<string, McpServerConfig> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, McpServerConfig>;
}

function installCodexMcpServer(contents: CodexConfig, options: InstallOptions = {}): CodexConfig {
  const root = { ...normalizeCodexConfig(contents) };
  const servers = { ...normalizeServers(root.mcp_servers) };
  servers[serverName(options)] = codexServerConfig(options);
  root.mcp_servers = servers;
  return root;
}

function isManagedServer(entry: McpServerConfig | undefined) {
  const server = entry || {};
  const command = String(server.command || "");
  const args = Array.isArray(server.args) ? server.args.map((arg) => String(arg)) : [];
  const hasTaskHandoffCommand = command.includes("task-handoff") || args.some((arg: string) => arg.includes("task-handoff"));
  const runsMcp = args.includes("mcp");
  const exposesGetTask = server.tools?.get_task?.approval_mode === "approve";
  return (hasTaskHandoffCommand && runsMcp) || exposesGetTask;
}

function removeCodexMcpServer(contents: CodexConfig, options: InstallOptions = {}): CodexConfig {
  const root = { ...normalizeCodexConfig(contents) };
  const servers = { ...normalizeServers(root.mcp_servers) };
  const name = serverName(options);
  if (isManagedServer(servers[name])) {
    delete servers[name];
  }
  if (Object.keys(servers).length > 0) {
    root.mcp_servers = servers;
  } else {
    delete root.mcp_servers;
  }
  return root;
}

function hasCodexMcpServer(contents: CodexConfig, options: InstallOptions = {}) {
  const servers = normalizeServers(contents.mcp_servers);
  const entry = servers[serverName(options)];
  return {
    exists: Boolean(entry),
    managed: isManagedServer(entry),
  };
}

function installClaudeMcpServer(contents: ClaudeSettings, options: InstallOptions = {}): ClaudeSettings {
  const root = { ...normalizeClaudeSettings(contents) };
  const servers = { ...normalizeServers(root.mcpServers) };
  servers[serverName(options)] = claudeServerConfig(options);
  root.mcpServers = servers;
  return root;
}

function removeClaudeMcpServer(contents: ClaudeSettings, options: InstallOptions = {}): ClaudeSettings {
  const root = { ...normalizeClaudeSettings(contents) };
  const servers = { ...normalizeServers(root.mcpServers) };
  const name = serverName(options);
  if (isManagedServer(servers[name])) {
    delete servers[name];
  }
  if (Object.keys(servers).length > 0) {
    root.mcpServers = servers;
  } else {
    delete root.mcpServers;
  }
  return root;
}

function hasClaudeMcpServer(contents: ClaudeSettings, options: InstallOptions = {}) {
  const servers = normalizeServers(contents.mcpServers);
  const entry = servers[serverName(options)];
  return {
    exists: Boolean(entry),
    managed: isManagedServer(entry),
  };
}

function writeConfigIfChanged(configPath: string, before: CodexConfig, after: CodexConfig) {
  const beforeText = stringifyToml(before);
  const afterText = stringifyToml(after);
  if (afterText !== beforeText) {
    backup(configPath);
    fs.writeFileSync(configPath, `${afterText.replace(/\s+$/, "")}\n`, { mode: 0o600 });
  }
}

function writeJsonIfChanged(settingsPath: string, before: ClaudeSettings, after: ClaudeSettings) {
  const beforeText = JSON.stringify(before, null, 2);
  const afterText = JSON.stringify(after, null, 2);
  if (afterText !== beforeText) {
    backup(settingsPath);
    fs.writeFileSync(settingsPath, `${afterText}\n`, { mode: 0o600 });
  }
}

export function runCodexMcpInstall(options: InstallOptions = {}) {
  const home = codexHome(options);
  const configPath = path.join(home, "config.toml");
  fs.mkdirSync(home, { recursive: true });

  const before = readConfig(configPath);
  const after = installCodexMcpServer(before, options);
  writeConfigIfChanged(configPath, before, after);

  const config = codexServerConfig(options);
  console.log(`Codex MCP server installed in ${configPath}`);
  console.log(`Name: ${serverName(options)}`);
  console.log(`Command: ${config.command} ${config.args.join(" ")}`);
}

export function runCodexMcpStatus(options: InstallOptions = {}) {
  const home = codexHome(options);
  const configPath = path.join(home, "config.toml");
  const config = readConfig(configPath);
  const status = hasCodexMcpServer(config, options);
  console.log(`Codex home: ${home}`);
  console.log(`MCP server: ${serverName(options)}`);
  console.log(`installed: ${status.exists}`);
  console.log(`managed by task-handoff: ${status.managed}`);
}

export function runCodexMcpUninstall(options: InstallOptions = {}) {
  const home = codexHome(options);
  const configPath = path.join(home, "config.toml");
  const before = readConfig(configPath);
  const after = removeCodexMcpServer(before, options);
  writeConfigIfChanged(configPath, before, after);
  console.log(`task-handoff Codex MCP server removed from ${configPath}`);
}

export function runClaudeMcpInstall(options: InstallOptions = {}) {
  const home = claudeHome(options);
  const settingsPath = path.join(home, "settings.json");
  fs.mkdirSync(home, { recursive: true });

  const before = readJson(settingsPath);
  const after = installClaudeMcpServer(before, options);
  writeJsonIfChanged(settingsPath, before, after);

  const config = claudeServerConfig(options);
  console.log(`Claude MCP server installed in ${settingsPath}`);
  console.log(`Name: ${serverName(options)}`);
  console.log(`Command: ${config.command} ${config.args.join(" ")}`);
}

export function runClaudeMcpStatus(options: InstallOptions = {}) {
  const home = claudeHome(options);
  const settingsPath = path.join(home, "settings.json");
  const settings = readJson(settingsPath);
  const status = hasClaudeMcpServer(settings, options);
  console.log(`Claude home: ${home}`);
  console.log(`MCP server: ${serverName(options)}`);
  console.log(`installed: ${status.exists}`);
  console.log(`managed by task-handoff: ${status.managed}`);
}

export function runClaudeMcpUninstall(options: InstallOptions = {}) {
  const home = claudeHome(options);
  const settingsPath = path.join(home, "settings.json");
  const before = readJson(settingsPath);
  const after = removeClaudeMcpServer(before, options);
  writeJsonIfChanged(settingsPath, before, after);
  console.log(`task-handoff Claude MCP server removed from ${settingsPath}`);
}

export {
  installCodexMcpServer,
  removeCodexMcpServer,
  hasCodexMcpServer,
  installClaudeMcpServer,
  removeClaudeMcpServer,
  hasClaudeMcpServer,
};
