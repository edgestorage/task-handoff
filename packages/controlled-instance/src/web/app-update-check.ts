import { resolveExecutable } from "@task-handoff/app-runtime";
import type { FinalComputerCapabilities, ManagedAppUpdateStatus } from "@task-handoff/protocol/control-plane";
import type { InstallRecipe, NodePackageInstallRecipe, SystemPackageInstallRecipe } from "@task-handoff/app-runtime/types";
import { runAppRecipeCommand, type AppRecipeCommand, type AppRecipeCommandResult } from "./app-recipe-executor";

const DEFAULT_TIMEOUT_MS = 20_000;
const MAX_VERSION_CHARS = 120;
const PACKAGE_NAME = /^[a-zA-Z0-9][a-zA-Z0-9+._:@/-]{0,199}$/;
const NODE_PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._-]{0,99}\/)?[a-z0-9][a-z0-9._-]{0,99}$/i;

export type AppUpdateCheckResult = {
  status: ManagedAppUpdateStatus;
  installedVersion?: string;
  latestVersion?: string;
  reason?: string;
};

export type AppUpdateCheckContext = {
  appId: string;
  capabilities: FinalComputerCapabilities;
};

export type AppUpdateCheckerOptions = {
  env?: NodeJS.ProcessEnv;
  commandRunner?: (command: AppRecipeCommand) => Promise<AppRecipeCommandResult>;
  timeoutMs?: number;
};

function version(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, MAX_VERSION_CHARS) : undefined;
}

function result(status: ManagedAppUpdateStatus, details: { installedVersion?: unknown; latestVersion?: unknown; reason?: unknown } = {}): AppUpdateCheckResult {
  const installedVersion = version(details.installedVersion);
  const latestVersion = version(details.latestVersion);
  const reason = version(details.reason);
  return {
    status,
    ...(installedVersion ? { installedVersion } : {}),
    ...(latestVersion ? { latestVersion } : {}),
    ...(reason ? { reason } : {}),
  };
}

function firstLine(value: string) {
  const line = value.split(/\r?\n/).map((item) => item.trim()).find(Boolean);
  return line ? line.slice(0, 500) : undefined;
}

export function parseAptPolicy(stdout: string): AppUpdateCheckResult {
  let installedVersion: string | undefined;
  let latestVersion: string | undefined;
  for (const block of stdout.split(/\n\s*\n/)) {
    const installed = block.match(/^\s*Installed:\s*(\S+)/m)?.[1];
    const candidate = block.match(/^\s*Candidate:\s*(\S+)/m)?.[1];
    const hasInstalled = installed !== undefined && installed !== "(none)";
    const hasCandidate = candidate !== undefined && candidate !== "(none)";
    if (hasInstalled && !installedVersion) installedVersion = installed;
    if (hasCandidate && !latestVersion) latestVersion = candidate;
    if (hasInstalled && hasCandidate && installed !== candidate) {
      return result("update-available", { installedVersion: installed, latestVersion: candidate });
    }
  }
  return result("up-to-date", { installedVersion, latestVersion });
}

export function parseBrewOutdated(stdout: string): AppUpdateCheckResult {
  let parsed: unknown;
  try { parsed = JSON.parse(stdout); } catch { return result("unknown", { reason: "brew outdated output could not be parsed." }); }
  const source = parsed && typeof parsed === "object" ? parsed as { formulae?: unknown; casks?: unknown } : {};
  const entries = [...(Array.isArray(source.formulae) ? source.formulae : []), ...(Array.isArray(source.casks) ? source.casks : [])];
  for (const entry of entries) {
    const record = entry && typeof entry === "object" ? entry as { installed?: unknown; current_version?: unknown } : {};
    const installed = Array.isArray(record.installed)
      ? record.installed.map((item) => (item && typeof item === "object" ? (item as { version?: unknown }).version : undefined)).filter((item): item is string => typeof item === "string" && Boolean(item))
      : [];
    const latest = typeof record.current_version === "string" ? record.current_version : undefined;
    if (latest && (installed.length === 0 || installed.some((item) => item !== latest))) {
      return result("update-available", { installedVersion: installed[0], latestVersion: latest });
    }
  }
  return result("up-to-date");
}

function parseDnfUpdate(stdout: string, packages: string[]) {
  for (const line of stdout.split(/\r?\n/)) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 2) continue;
    const [name, latest] = parts;
    if (packages.some((item) => name === item || name.startsWith(`${item}.`))) return version(latest);
  }
  return undefined;
}

function parseNpmOutdated(stdout: string): AppUpdateCheckResult {
  let parsed: unknown;
  try { parsed = JSON.parse(stdout); } catch { return result("unknown", { reason: "npm outdated output could not be parsed." }); }
  if (!parsed || typeof parsed !== "object") return result("unknown", { reason: "npm outdated returned an unexpected payload." });
  for (const entry of Object.values(parsed as Record<string, unknown>)) {
    const record = entry && typeof entry === "object" ? entry as { current?: unknown; latest?: unknown } : {};
    const current = version(record.current);
    const latest = version(record.latest);
    if (latest && latest !== current) return result("update-available", { installedVersion: current, latestVersion: latest });
  }
  return result("up-to-date");
}

export function createAppUpdateChecker(options: AppUpdateCheckerOptions = {}) {
  const env = { ...(options.env || process.env), LC_ALL: "C", LANG: "C" };
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const runner = options.commandRunner || ((command: AppRecipeCommand) => runAppRecipeCommand(command));

  const run = async (executable: string, args: string[], capabilities: FinalComputerCapabilities, elevate: boolean) => {
    const resolution = resolveExecutable(executable, { env, platform: capabilities.platform as NodeJS.Platform });
    const resolvedExecutable = resolution?.executable || executable;
    const command: AppRecipeCommand = elevate
      ? { executable: "sudo", args: ["-n", resolvedExecutable, ...args], timeoutMs }
      : { executable: resolvedExecutable, args, timeoutMs, env: { ...env, ...resolution?.env } };
    try {
      return await runner(command);
    } catch (error) {
      return { exitCode: -1, stdout: "", stderr: error instanceof Error ? error.message : String(error) };
    }
  };

  const checkSystemPackage = async (recipe: SystemPackageInstallRecipe, capabilities: FinalComputerCapabilities): Promise<AppUpdateCheckResult> => {
    if (!recipe.packages.length || recipe.packages.some((item) => !PACKAGE_NAME.test(item))) {
      return result("unknown", { reason: "The built-in system package recipe contains an invalid package name." });
    }
    if (!capabilities.installers.includes(recipe.installer)) return result("unknown", { reason: `The ${recipe.installer} installer is unavailable.` });
    if (recipe.installer === "apt") {
      const response = await run("apt-cache", ["policy", ...recipe.packages], capabilities, false);
      if (response.exitCode !== 0) return result("unknown", { reason: firstLine(response.stderr) || "apt-cache failed." });
      return parseAptPolicy(response.stdout);
    }
    if (recipe.installer === "dnf") {
      const response = await run("dnf", ["-q", "check-update", ...recipe.packages], capabilities, false);
      if (response.exitCode === 100) return result("update-available", { latestVersion: parseDnfUpdate(response.stdout, recipe.packages) });
      if (response.exitCode === 0) return result("up-to-date");
      return result("unknown", { reason: firstLine(response.stderr) || "dnf check-update failed." });
    }
    const response = await run("brew", ["outdated", "--json=v2", ...recipe.packages], capabilities, false);
    if (response.exitCode !== 0 && !response.stdout.trim()) return result("unknown", { reason: firstLine(response.stderr) || "brew outdated failed." });
    return parseBrewOutdated(response.stdout);
  };

  const checkNodePackage = async (recipe: NodePackageInstallRecipe, capabilities: FinalComputerCapabilities): Promise<AppUpdateCheckResult> => {
    if (!recipe.packages.length || recipe.packages.some((item) => !NODE_PACKAGE_NAME.test(item))) {
      return result("unknown", { reason: "The built-in Node package recipe contains an invalid package name." });
    }
    if (!capabilities.installers.includes(recipe.installer)) return result("unknown", { reason: `The ${recipe.installer} installer is unavailable.` });
    const elevate = capabilities.privilege === "passwordless-sudo" && recipe.privilege !== "user";
    const response = await run("npm", ["outdated", "--global", "--json", "--depth=0", ...recipe.packages], capabilities, elevate);
    if (!response.stdout.trim()) {
      if (response.exitCode === 0 || response.exitCode === 1) return result("up-to-date");
      return result("unknown", { reason: firstLine(response.stderr) || "npm outdated failed." });
    }
    return parseNpmOutdated(response.stdout);
  };

  return async (recipe: InstallRecipe, context: AppUpdateCheckContext): Promise<AppUpdateCheckResult> => {
    if (recipe.type === "bundled") return result("unsupported", { reason: "Bundled apps ship with the controlled computer and have no update source." });
    if (recipe.type === "archive") return result("unsupported", { reason: "Archive updates are delivered with the built-in app definition." });
    return recipe.type === "system-package" ? checkSystemPackage(recipe, context.capabilities) : checkNodePackage(recipe, context.capabilities);
  };
}
