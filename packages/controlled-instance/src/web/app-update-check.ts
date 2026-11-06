import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readNativeAppManifest, resolveExecutable } from "@task-handoff/app-runtime";
import type { FinalComputerCapabilities, ManagedAppUpdateStatus } from "@task-handoff/protocol/control-plane";
import type { InstallRecipe, NativePackageInstallRecipe, NodePackageInstallRecipe, SystemPackageInstallRecipe } from "@task-handoff/app-runtime/types";
import { runAppRecipeCommand, type AppRecipeCommand, type AppRecipeCommandResult } from "./app-recipe-executor";
import type { AppInstallEnvironmentManager, AppInstallExecutionPolicy } from "./app-install-environment";

const DEFAULT_TIMEOUT_MS = 20_000;
const MAX_VERSION_CHARS = 120;
const PACKAGE_NAME = /^[a-zA-Z0-9][a-zA-Z0-9+._:@/-]{0,199}$/;
const NODE_PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._-]{0,99}\/)?[a-z0-9][a-z0-9._-]{0,99}$/i;
const NODE_PACKAGE_VERSION = /^[a-zA-Z0-9][a-zA-Z0-9+._-]{0,120}$/;
const NPM_INTEGRITY = /^sha(256|512)-[A-Za-z0-9+/]+={0,2}$/;

export type AppUpdateCheckResult = {
  status: ManagedAppUpdateStatus;
  installedVersion?: string;
  latestVersion?: string;
  reason?: string;
};

export type AppUpdateCheckContext = {
  appId: string;
  capabilities: FinalComputerCapabilities;
  installBaseDir?: string;
};

export type AppUpdateCheckerOptions = {
  env?: NodeJS.ProcessEnv;
  stateDir?: string;
  installEnvironment?: Pick<AppInstallEnvironmentManager, "createExecutionPolicy">;
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
  const npmCacheDir = path.join(options.stateDir || path.join(os.tmpdir(), "task-handoff-app-management"), "npm-cache");
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const runner = options.commandRunner || ((command: AppRecipeCommand) => runAppRecipeCommand(command));

  const run = async (executable: string, args: string[], capabilities: FinalComputerCapabilities, elevate: boolean, extraEnv: NodeJS.ProcessEnv = {}) => {
    const commandEnv = { ...env, ...extraEnv };
    const resolution = resolveExecutable(executable, { env: commandEnv, platform: capabilities.platform as NodeJS.Platform });
    const resolvedExecutable = resolution?.executable || executable;
    const resolvedEnv = { ...commandEnv, ...resolution?.env };
    const sudoEnvironment = Object.entries(extraEnv)
      .filter((entry): entry is [string, string] => typeof entry[1] === "string")
      .map(([name, value]) => `${name}=${value}`);
    const command: AppRecipeCommand = elevate
      ? { executable: "sudo", args: ["-n", ...(sudoEnvironment.length ? ["env", ...sudoEnvironment] : []), resolvedExecutable, ...args], timeoutMs }
      : { executable: resolvedExecutable, args, timeoutMs, env: resolvedEnv };
    try {
      return await runner(command);
    } catch (error) {
      return { exitCode: -1, stdout: "", stderr: error instanceof Error ? error.message : String(error) };
    }
  };

  const checkSystemPackage = async (recipe: SystemPackageInstallRecipe, capabilities: FinalComputerCapabilities, policy: AppInstallExecutionPolicy | undefined): Promise<AppUpdateCheckResult> => {
    if (!recipe.packages.length || recipe.packages.some((item) => !PACKAGE_NAME.test(item))) {
      return result("unknown", { reason: "The built-in system package recipe contains an invalid package name." });
    }
    if (!capabilities.installers.includes(recipe.installer)) return result("unknown", { reason: `The ${recipe.installer} installer is unavailable.` });
    if (recipe.installer === "apt") {
      let aptOptions: string[] = [];
      if (policy) {
        try {
          aptOptions = policy.aptSourceConfiguration()?.options || [];
        } catch (error) {
          return result("unknown", { reason: firstLine(error instanceof Error ? error.message : String(error)) || "apt sources are unavailable." });
        }
      }
      const response = await run("apt-cache", [...aptOptions, "policy", ...recipe.packages], capabilities, false);
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

  const checkNodePackage = async (recipe: NodePackageInstallRecipe, capabilities: FinalComputerCapabilities, context: AppUpdateCheckContext, policy: AppInstallExecutionPolicy | undefined): Promise<AppUpdateCheckResult> => {
    if (!recipe.packages.length || recipe.packages.some((item) => !NODE_PACKAGE_NAME.test(item))) {
      return result("unknown", { reason: "The built-in Node package recipe contains an invalid package name." });
    }
    if (recipe.managed && recipe.version !== undefined && !NODE_PACKAGE_VERSION.test(recipe.version)) {
      return result("unknown", { reason: "The built-in Node package recipe contains an invalid package version." });
    }
    if (!capabilities.installers.includes(recipe.installer)) return result("unknown", { reason: `The ${recipe.installer} installer is unavailable.` });
    if (recipe.managed) {
      if (!recipe.version) return result("unknown", { reason: "The managed Node package recipe has no pinned version." });
      const manifestPath = context.installBaseDir
        ? path.join(context.installBaseDir, "node-package", context.appId, "managed-app.json")
        : undefined;
      let packages: Record<string, unknown> = {};
      try {
        const parsed = manifestPath ? JSON.parse(fs.readFileSync(manifestPath, "utf8")) : undefined;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) packages = (parsed as { packages?: Record<string, unknown> }).packages || {};
      } catch {
        packages = {};
      }
      const installed = recipe.packages.map((item) => version(packages[item]));
      if (installed.every((item) => item === recipe.version)) {
        return result("up-to-date", { installedVersion: recipe.version, latestVersion: recipe.version });
      }
      return result("update-available", {
        installedVersion: installed.find((item) => item !== undefined),
        latestVersion: recipe.version,
      });
    }
    const elevate = capabilities.privilege === "passwordless-sudo" && recipe.privilege !== "user";
    const npmEnvironment = {
      ...(policy?.nodeEnvironment(env) || {}),
      npm_config_cache: npmCacheDir,
    };
    const response = await run("npm", ["outdated", "--global", "--json", "--depth=0", ...recipe.packages], capabilities, elevate, npmEnvironment);
    if (!response.stdout.trim()) {
      if (response.exitCode === 0 || response.exitCode === 1) return result("up-to-date");
      return result("unknown", { reason: firstLine(response.stderr) || "npm outdated failed." });
    }
    return parseNpmOutdated(response.stdout);
  };

  const checkNativePackage = (recipe: NativePackageInstallRecipe, context: AppUpdateCheckContext): AppUpdateCheckResult => {
    if (!NODE_PACKAGE_NAME.test(recipe.package) || !NODE_PACKAGE_VERSION.test(recipe.packageVersion) || !NODE_PACKAGE_VERSION.test(recipe.version)) {
      return result("unknown", { reason: "The built-in native package recipe contains an invalid package or version." });
    }
    if (!NPM_INTEGRITY.test(recipe.integrity)) return result("unknown", { reason: "The built-in native package recipe contains an invalid integrity value." });
    if (!context.installBaseDir) return result("unknown", { reason: "The managed app install directory is unavailable." });
    const manifest = readNativeAppManifest(context.installBaseDir, context.appId);
    if (!manifest) return result("update-available", { latestVersion: recipe.version, reason: "The native package ownership manifest is missing or invalid." });
    const installedVersion = version(manifest.version);
    const current = manifest.package === recipe.package
      && manifest.packageVersion === recipe.packageVersion
      && manifest.integrity === recipe.integrity
      && manifest.version === recipe.version;
    return current
      ? result("up-to-date", { installedVersion, latestVersion: recipe.version })
      : result("update-available", { installedVersion, latestVersion: recipe.version });
  };

  return async (recipe: InstallRecipe, context: AppUpdateCheckContext): Promise<AppUpdateCheckResult> => {
    if (recipe.type === "bundled") return result("unsupported", { reason: "Bundled apps ship with the controlled computer and have no update source." });
    if (recipe.type === "archive") return result("unsupported", { reason: "Archive updates are delivered with the built-in app definition." });
    if (recipe.type === "native-package") return checkNativePackage(recipe, context);
    const policy = options.installEnvironment?.createExecutionPolicy();
    return recipe.type === "system-package"
      ? checkSystemPackage(recipe, context.capabilities, policy)
      : checkNodePackage(recipe, context.capabilities, context, policy);
  };
}
