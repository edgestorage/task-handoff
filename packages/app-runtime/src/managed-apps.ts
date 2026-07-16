import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import type {
  FinalComputerCapabilities,
  ManagedAppActionReason,
  ManagedAppProjection,
} from "@task-handoff/protocol/control-plane";
import type {
  InstallRecipe,
  ManagedAppDefinition,
  ManagedAppDetectionResult,
  ManagedAppRecipeArch,
  ManagedAppRecipePlatform,
  ManagedAppRecipePrivilege,
} from "./types";

const PLATFORM_VALUES = new Set(["linux", "darwin", "win32", "freebsd", "openbsd", "aix", "sunos"]);
const ARCH_VALUES = new Set(["x64", "arm64", "arm", "ia32", "ppc64", "s390x", "riscv64"]);
const PRIVILEGE_RANK: Record<ManagedAppRecipePrivilege, number> = { user: 0, "passwordless-sudo": 1, root: 2 };

function executableCandidate(candidate: string, platform: NodeJS.Platform, env: NodeJS.ProcessEnv) {
  const extensions = platform === "win32" ? (env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean) : [""];
  for (const extension of extensions) {
    const resolved = platform === "win32" && !path.extname(candidate) ? `${candidate}${extension}` : candidate;
    try {
      fs.accessSync(resolved, fs.constants.X_OK);
      if (fs.statSync(resolved).isFile()) return resolved;
    } catch {
      // Continue searching PATH.
    }
  }
  return undefined;
}

export function findManagedExecutable(command: string, options: { env?: NodeJS.ProcessEnv; cwd?: string; platform?: NodeJS.Platform } = {}) {
  const env = options.env || process.env;
  const cwd = options.cwd || process.cwd();
  const platform = options.platform || process.platform;
  if (path.isAbsolute(command)) return executableCandidate(command, platform, env);
  if (command.includes("/") || command.includes("\\")) return executableCandidate(path.resolve(cwd, command), platform, env);
  for (const directory of (env.PATH || "").split(path.delimiter).filter(Boolean)) {
    const resolved = executableCandidate(path.join(directory, command), platform, env);
    if (resolved) return resolved;
  }
  return undefined;
}

export function normalizeManagedPlatform(value: string) {
  return PLATFORM_VALUES.has(value) ? value as ManagedAppRecipePlatform : "unknown" as const;
}

export function normalizeManagedArch(value: string) {
  return ARCH_VALUES.has(value) ? value as ManagedAppRecipeArch : "unknown" as const;
}

export function detectFinalComputerCapabilities(options: {
  platform?: NodeJS.Platform;
  arch?: string;
  env?: NodeJS.ProcessEnv;
  getuid?: () => number;
  canPasswordlessSudo?: () => boolean;
  executable?: (command: string) => string | undefined;
} = {}): FinalComputerCapabilities {
  const platform = normalizeManagedPlatform(options.platform || process.platform);
  const arch = normalizeManagedArch(options.arch || process.arch);
  const env = options.env || process.env;
  const executable = options.executable || ((command: string) => findManagedExecutable(command, { env, platform: options.platform || process.platform }));
  const installers = (["apt", "dnf", "brew"] as const).filter((installer) => executable(installer));
  const uid = (options.getuid || (() => typeof process.getuid === "function" ? process.getuid() : -1))();
  const canPasswordlessSudo = options.canPasswordlessSudo || (() => {
    if (!executable("sudo")) return false;
    return spawnSync("sudo", ["-n", "true"], { stdio: "ignore", timeout: 2_000 }).status === 0;
  });
  return {
    platform,
    arch,
    installers,
    privilege: uid === 0 ? "root" : canPasswordlessSudo() ? "passwordless-sudo" : "user",
  };
}

export function detectManagedApp(
  definition: ManagedAppDefinition,
  options: {
    executable?: (command: string, env?: NodeJS.ProcessEnv, cwd?: string) => string | undefined;
    version?: (command: string, args: string[]) => string | undefined;
  } = {},
): ManagedAppDetectionResult {
  const executable = options.executable || ((command: string, env?: NodeJS.ProcessEnv, cwd?: string) => findManagedExecutable(command, { env, cwd }));
  const paths = definition.detection.map((rule) => {
    const command = rule.type === "launcher-executable" ? definition.launcher.command : rule.command;
    return command ? executable(command, { ...process.env, ...definition.launcher.env }, definition.launcher.cwd) : undefined;
  });
  const executablePaths = paths.filter((value): value is string => Boolean(value));
  const state = executablePaths.length === 0
    ? "not-installed" as const
    : executablePaths.length === definition.detection.length
      ? "installed" as const
      : "broken" as const;
  const versionRule = state === "installed" ? definition.detection.find((rule) => rule.versionArgs?.length) : undefined;
  const versionCommand = versionRule?.type === "launcher-executable" ? definition.launcher.command : versionRule?.command;
  const version = versionRule && versionCommand && options.version ? options.version(versionCommand, versionRule.versionArgs || []) : undefined;
  return { state, executablePaths, ...(version?.trim() ? { version: version.trim().slice(0, 120) } : {}) };
}

function privilegeAllows(actual: FinalComputerCapabilities["privilege"], required: ManagedAppRecipePrivilege = "user") {
  return PRIVILEGE_RANK[actual] >= PRIVILEGE_RANK[required];
}

export function selectInstallRecipe(definition: ManagedAppDefinition, capabilities: FinalComputerCapabilities): {
  recipe?: InstallRecipe;
  reason?: ManagedAppActionReason;
} {
  const platformMatches = definition.distribution.recipes.filter((recipe) => recipe.platforms.includes(capabilities.platform as ManagedAppRecipePlatform));
  const archMatches = platformMatches.filter((recipe) => !recipe.arches?.length || recipe.arches.includes(capabilities.arch as ManagedAppRecipeArch));
  if (!archMatches.length) {
    return { reason: { code: "UNSUPPORTED_PLATFORM", message: `No built-in recipe supports ${capabilities.platform}/${capabilities.arch}.` } };
  }
  const installerMatches = archMatches.filter((recipe) => recipe.type !== "system-package" || capabilities.installers.includes(recipe.installer));
  if (!installerMatches.length) {
    return { reason: { code: "INSTALLER_UNAVAILABLE", message: "The required system package installer is unavailable on this computer." } };
  }
  const privilegeMatches = installerMatches.filter((recipe) => privilegeAllows(capabilities.privilege, recipe.privilege));
  if (!privilegeMatches.length) {
    return { reason: { code: "INSUFFICIENT_PRIVILEGE", message: "The controlled instance does not have the privilege required by this recipe." } };
  }
  return { recipe: privilegeMatches[0] };
}

export function managedAppProjection(
  definition: ManagedAppDefinition,
  detection: ManagedAppDetectionResult,
  capabilities: FinalComputerCapabilities,
): ManagedAppProjection {
  const selected = selectInstallRecipe(definition, capabilities);
  const state = detection.state === "not-installed" && !selected.recipe ? "unsupported" : detection.state;
  const bundled = selected.recipe?.type === "bundled";
  const canInstall = state === "not-installed" && Boolean(selected.recipe) && !bundled;
  const canUninstall = (state === "installed" || state === "broken") && Boolean(selected.recipe) && !bundled;
  const installReason = canInstall ? undefined
    : bundled ? { code: "BUNDLED" as const, message: "This app is supplied with the controlled computer." }
      : state === "installed" || state === "broken" ? { code: "ALREADY_INSTALLED" as const, message: "This app is already present." }
        : selected.reason;
  const uninstallReason = canUninstall ? undefined
    : bundled ? { code: "BUNDLED" as const, message: "Bundled apps cannot be removed by app management." }
      : state === "not-installed" || state === "unsupported" ? { code: "NOT_INSTALLED" as const, message: "This app is not installed." }
        : selected.reason;
  return {
    id: definition.launcher.id,
    name: definition.launcher.name,
    kind: definition.launcher.kind,
    description: definition.launcher.description,
    state,
    version: detection.version,
    canInstall,
    canUninstall,
    installReason,
    uninstallReason,
  };
}
