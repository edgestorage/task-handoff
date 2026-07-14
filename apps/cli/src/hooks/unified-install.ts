import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runClaudeHookInstall, runClaudeHookStatus, runClaudeHookUninstall } from "./claude-install";
import { runCodexHookInstall, runCodexHookStatus, runCodexHookUninstall } from "./codex-install";
import {
  runClaudeMcpInstall,
  runClaudeMcpStatus,
  runClaudeMcpUninstall,
  runCodexMcpInstall,
  runCodexMcpStatus,
  runCodexMcpUninstall,
} from "./mcp-install";

type InstallAction = "install" | "status" | "uninstall";
type InstallComponent = "mcp" | "hook";
type InstallTarget = "codex" | "claude" | "all";
type ResolvedTarget = "codex" | "claude";

type UnifiedInstallOptions = {
  codexHome?: string;
  claudeHome?: string;
  name?: string;
  command?: string;
};

function defaultCodexHome() {
  return process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
}

function defaultClaudeHome() {
  return process.env.CLAUDE_HOME || path.join(os.homedir(), ".claude");
}

function hasCodexHome(options: UnifiedInstallOptions = {}) {
  return Boolean(options.codexHome || process.env.CODEX_HOME || fs.existsSync(defaultCodexHome()));
}

function hasClaudeHome(options: UnifiedInstallOptions = {}) {
  return Boolean(options.claudeHome || process.env.CLAUDE_HOME || fs.existsSync(defaultClaudeHome()));
}

function parseComponent(value: string): InstallComponent {
  if (value === "mcp" || value === "hook") {
    return value;
  }
  throw new Error("Install component must be mcp or hook.");
}

function parseTarget(value: string = "all"): InstallTarget {
  if (value === "codex" || value === "claude" || value === "all") {
    return value;
  }
  throw new Error("Install target must be codex, claude, or all.");
}

function resolveInstallTargets(target: InstallTarget, options: UnifiedInstallOptions = {}): ResolvedTarget[] {
  if (target === "codex") {
    return ["codex"];
  }
  if (target === "claude") {
    return ["claude"];
  }

  const targets: ResolvedTarget[] = [];
  if (hasCodexHome(options)) {
    targets.push("codex");
  }
  if (hasClaudeHome(options)) {
    targets.push("claude");
  }
  return targets;
}

function runForTarget(
  action: InstallAction,
  component: InstallComponent,
  target: ResolvedTarget,
  options: UnifiedInstallOptions,
) {
  if (component === "mcp" && target === "codex" && action === "install") {
    runCodexMcpInstall({ codexHome: options.codexHome, name: options.name });
  } else if (component === "mcp" && target === "codex" && action === "status") {
    runCodexMcpStatus({ codexHome: options.codexHome, name: options.name });
  } else if (component === "mcp" && target === "codex" && action === "uninstall") {
    runCodexMcpUninstall({ codexHome: options.codexHome, name: options.name });
  } else if (component === "mcp" && target === "claude" && action === "install") {
    runClaudeMcpInstall({ claudeHome: options.claudeHome, name: options.name });
  } else if (component === "mcp" && target === "claude" && action === "status") {
    runClaudeMcpStatus({ claudeHome: options.claudeHome, name: options.name });
  } else if (component === "mcp" && target === "claude" && action === "uninstall") {
    runClaudeMcpUninstall({ claudeHome: options.claudeHome, name: options.name });
  } else if (component === "hook" && target === "codex" && action === "install") {
    runCodexHookInstall({ codexHome: options.codexHome, command: options.command });
  } else if (component === "hook" && target === "codex" && action === "status") {
    runCodexHookStatus({ codexHome: options.codexHome, command: options.command });
  } else if (component === "hook" && target === "codex" && action === "uninstall") {
    runCodexHookUninstall({ codexHome: options.codexHome, command: options.command });
  } else if (component === "hook" && target === "claude" && action === "install") {
    runClaudeHookInstall({ claudeHome: options.claudeHome, command: options.command });
  } else if (component === "hook" && target === "claude" && action === "status") {
    runClaudeHookStatus({ claudeHome: options.claudeHome, command: options.command });
  } else {
    runClaudeHookUninstall({ claudeHome: options.claudeHome, command: options.command });
  }
}

export function runUnifiedInstallAction(
  action: InstallAction,
  componentValue: string,
  targetValue: string | undefined,
  options: UnifiedInstallOptions = {},
) {
  const component = parseComponent(componentValue);
  const target = parseTarget(targetValue);
  const targets = resolveInstallTargets(target, options);
  if (targets.length === 0) {
    console.log("No Codex or Claude config directory detected. Pass codex, claude, --codex-home, or --claude-home.");
    return;
  }

  for (const item of targets) {
    runForTarget(action, component, item, options);
  }
}

export { parseComponent, parseTarget, resolveInstallTargets };
