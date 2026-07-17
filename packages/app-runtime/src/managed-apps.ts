import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile, spawnSync } from "node:child_process";
import type {
  FinalComputerCapabilities,
  ManagedAppActionReason,
  ManagedAppManagementSource,
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

function syncCommandInvocation(command: string, args: string[], options: { env: NodeJS.ProcessEnv; platform: NodeJS.Platform }) {
  const resolvedExecutable = findManagedExecutable(command, options) || command;
  return options.platform === "win32" && /\.(?:cmd|bat)$/i.test(resolvedExecutable)
    ? { executable: options.env.ComSpec || "cmd.exe", args: ["/d", "/s", "/c", "call", resolvedExecutable, ...args] }
    : { executable: resolvedExecutable, args };
}

export function detectFinalComputerCapabilities(options: {
  platform?: NodeJS.Platform;
  arch?: string;
  env?: NodeJS.ProcessEnv;
  getuid?: () => number;
  canPasswordlessSudo?: () => boolean;
  npmGlobalWritable?: () => boolean;
  executable?: (command: string) => string | undefined;
} = {}): FinalComputerCapabilities {
  const platform = normalizeManagedPlatform(options.platform || process.platform);
  const arch = normalizeManagedArch(options.arch || process.arch);
  const env = options.env || process.env;
  const executable = options.executable || ((command: string) => findManagedExecutable(command, { env, platform: options.platform || process.platform }));
  const installers = (["apt", "dnf", "brew", "npm"] as const).filter((installer) => executable(installer));
  const uid = (options.getuid || (() => typeof process.getuid === "function" ? process.getuid() : -1))();
  const canPasswordlessSudo = options.canPasswordlessSudo || (() => {
    if (!executable("sudo")) return false;
    const invocation = syncCommandInvocation("sudo", ["-n", "true"], { env, platform: options.platform || process.platform });
    return spawnSync(invocation.executable, invocation.args, { env, stdio: "ignore", timeout: 2_000 }).status === 0;
  });
  const npmGlobalWritable = options.npmGlobalWritable || (() => {
    const prefixInvocation = syncCommandInvocation("npm", ["prefix", "--global"], { env, platform: options.platform || process.platform });
    const rootInvocation = syncCommandInvocation("npm", ["root", "--global"], { env, platform: options.platform || process.platform });
    const prefixResult = spawnSync(prefixInvocation.executable, prefixInvocation.args, { env, encoding: "utf8", timeout: 2_000 });
    const rootResult = spawnSync(rootInvocation.executable, rootInvocation.args, { env, encoding: "utf8", timeout: 2_000 });
    const prefix = prefixResult.status === 0 ? prefixResult.stdout.trim() : "";
    const root = rootResult.status === 0 ? rootResult.stdout.trim() : "";
    if (!prefix || !root || !path.isAbsolute(prefix) || !path.isAbsolute(root)) return false;
    const bin = platform === "win32" ? prefix : path.join(prefix, "bin");
    return [root, bin].every(pathWritableOrCreatableSync);
  });
  return {
    platform,
    arch,
    installers,
    privilege: uid === 0 ? "root" : canPasswordlessSudo() ? "passwordless-sudo" : "user",
    ...(installers.includes("npm") ? { installerAccess: { npmGlobalWritable: npmGlobalWritable() } } : {}),
  };
}

export async function detectFinalComputerCapabilitiesAsync(options: {
  platform?: NodeJS.Platform;
  arch?: string;
  env?: NodeJS.ProcessEnv;
  getuid?: () => number;
  canPasswordlessSudo?: () => boolean | Promise<boolean>;
  npmGlobalWritable?: () => boolean | Promise<boolean>;
  executable?: (command: string) => string | undefined;
} = {}): Promise<FinalComputerCapabilities> {
  const platform = normalizeManagedPlatform(options.platform || process.platform);
  const arch = normalizeManagedArch(options.arch || process.arch);
  const env = options.env || process.env;
  const executable = options.executable || ((command: string) => findManagedExecutable(command, { env, platform: options.platform || process.platform }));
  const installers = (["apt", "dnf", "brew", "npm"] as const).filter((installer) => executable(installer));
  const uid = (options.getuid || (() => typeof process.getuid === "function" ? process.getuid() : -1))();
  const passwordlessSudo = uid === 0 ? false : options.canPasswordlessSudo
    ? await options.canPasswordlessSudo()
    : Boolean(executable("sudo") && (await runOwnershipCommand("sudo", ["-n", "true"], { env, platform: options.platform || process.platform })).exitCode === 0);
  let npmGlobalWritable: boolean | undefined;
  if (installers.includes("npm")) {
    if (options.npmGlobalWritable) npmGlobalWritable = await options.npmGlobalWritable();
    else {
      const [prefixResult, rootResult] = await Promise.all([
        runOwnershipCommand("npm", ["prefix", "--global"], { env, platform: options.platform || process.platform }),
        runOwnershipCommand("npm", ["root", "--global"], { env, platform: options.platform || process.platform }),
      ]);
      const prefix = prefixResult.exitCode === 0 ? prefixResult.stdout.trim() : "";
      const root = rootResult.exitCode === 0 ? rootResult.stdout.trim() : "";
      if (!prefix || !root || !path.isAbsolute(prefix) || !path.isAbsolute(root)) npmGlobalWritable = false;
      else {
        const bin = platform === "win32" ? prefix : path.join(prefix, "bin");
        npmGlobalWritable = (await Promise.all([root, bin].map(pathWritableOrCreatable))).every(Boolean);
      }
    }
  }
  return {
    platform,
    arch,
    installers,
    privilege: uid === 0 ? "root" : passwordlessSudo ? "passwordless-sudo" : "user",
    ...(npmGlobalWritable !== undefined ? { installerAccess: { npmGlobalWritable } } : {}),
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
  const installerMatches = archMatches.filter((recipe) => !recipeUsesInstaller(recipe) || capabilities.installers.includes(recipe.installer));
  if (!installerMatches.length) {
    return { reason: { code: "INSTALLER_UNAVAILABLE", message: "The required package installer is unavailable on this computer." } };
  }
  const privilegeMatches = installerMatches.filter((recipe) => privilegeAllows(capabilities.privilege, recipe.privilege));
  if (!privilegeMatches.length) {
    return { reason: { code: "INSUFFICIENT_PRIVILEGE", message: "The controlled instance does not have the privilege required by this recipe." } };
  }
  const writableMatches = privilegeMatches.filter((recipe) => recipe.type !== "node-package"
    || recipe.privilege !== "user"
    || capabilities.privilege === "root"
    || capabilities.installerAccess?.npmGlobalWritable === true);
  if (!writableMatches.length) {
    return { reason: { code: "INSTALLER_NOT_WRITABLE", message: "The npm global installation directory is not writable by this controlled-instance user." } };
  }
  return { recipe: writableMatches[0] };
}

function recipeUsesInstaller(recipe: InstallRecipe): recipe is Extract<InstallRecipe, { installer: string }> {
  return recipe.type === "system-package" || recipe.type === "node-package";
}

type OwnershipCommandResult = { exitCode: number | null; stdout: string; stderr: string };
type ManagedAppOwnershipOptions = {
  runCommand?: (executable: string, args: string[]) => Promise<OwnershipCommandResult>;
  realpath?: (value: string) => Promise<string>;
  readFile?: (value: string) => Promise<string>;
  archiveManifestOwned?: (definition: ManagedAppDefinition, recipe: Extract<InstallRecipe, { type: "archive" }>, detection: ManagedAppDetectionResult) => Promise<boolean>;
};

function existingAncestor(value: string) {
  let candidate = value;
  while (!fs.existsSync(candidate) && path.dirname(candidate) !== candidate) candidate = path.dirname(candidate);
  return candidate;
}

function pathWritableOrCreatableSync(value: string) {
  try {
    fs.accessSync(existingAncestor(value), fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function pathWritableOrCreatable(value: string) {
  return fs.promises.access(existingAncestor(value), fs.constants.W_OK).then(() => true, () => false);
}

export type ManagedAppOwnershipResult = {
  source: ManagedAppManagementSource;
  recipe?: InstallRecipe;
};

function runOwnershipCommand(executable: string, args: string[], options: { env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform } = {}): Promise<OwnershipCommandResult> {
  const env = options.env || process.env;
  const platform = options.platform || process.platform;
  const resolvedExecutable = platform === "win32" ? findManagedExecutable(executable, { env, platform }) || executable : executable;
  const invocation = platform === "win32" && /\.(?:cmd|bat)$/i.test(resolvedExecutable)
    ? { executable: env.ComSpec || "cmd.exe", args: ["/d", "/s", "/c", "call", resolvedExecutable, ...args] }
    : { executable: resolvedExecutable, args };
  return new Promise((resolve) => {
    execFile(invocation.executable, invocation.args, { env, encoding: "utf8", timeout: 2_000, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({ exitCode: error ? (typeof error.code === "number" ? error.code : null) : 0, stdout: String(stdout || ""), stderr: String(stderr || "") });
    });
  });
}

function pathInside(candidate: string, root: string) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function resolvedPath(value: string, realpath: NonNullable<ManagedAppOwnershipOptions["realpath"]>) {
  try {
    return await realpath(value);
  } catch {
    return path.resolve(value);
  }
}

async function nodePackageOwnsExecutable(
  recipe: Extract<InstallRecipe, { type: "node-package" }>,
  detection: ManagedAppDetectionResult,
  capabilities: FinalComputerCapabilities,
  options: Required<Pick<ManagedAppOwnershipOptions, "runCommand" | "realpath" | "readFile">>,
) {
  const command = capabilities.privilege === "passwordless-sudo" && recipe.privilege !== "user"
    ? { executable: "sudo", args: ["-n", recipe.installer, "root", "--global"] }
    : { executable: recipe.installer, args: ["root", "--global"] };
  const rootResult = await options.runCommand(command.executable, command.args);
  const npmRoot = rootResult.exitCode === 0 ? rootResult.stdout.trim() : "";
  if (!npmRoot || !path.isAbsolute(npmRoot)) return false;
  const detected = await Promise.all(detection.executablePaths.map((value) => resolvedPath(value, options.realpath)));
  for (const packageName of recipe.packages) {
    const packageRoot = path.join(npmRoot, ...packageName.split("/"));
    try {
      const packageJson = JSON.parse(await options.readFile(path.join(packageRoot, "package.json"))) as { bin?: string | Record<string, string> };
      const defaultBinName = packageName.split("/").at(-1) || packageName;
      const binEntries = typeof packageJson.bin === "string" ? { [defaultBinName]: packageJson.bin } : packageJson.bin || {};
      const binValues = Object.values(binEntries).map((value) => path.resolve(packageRoot, value)).filter((value) => pathInside(value, packageRoot));
      const owned = await Promise.all(binValues.map((value) => resolvedPath(value, options.realpath)));
      if (detected.some((candidate) => owned.includes(candidate))) return true;
      if (capabilities.platform === "win32") {
        const prefix = path.dirname(npmRoot);
        const binNames = Object.keys(binEntries);
        if (detection.executablePaths.some((candidate) => path.dirname(candidate) === prefix && binNames.includes(path.basename(candidate).replace(/\.(?:cmd|ps1)$/i, "")))) return true;
      }
    } catch {
      // A missing or invalid package manifest cannot establish ownership.
    }
  }
  return false;
}

async function systemPackageOwnsExecutable(
  recipe: Extract<InstallRecipe, { type: "system-package" }>,
  detection: ManagedAppDetectionResult,
  options: Required<Pick<ManagedAppOwnershipOptions, "runCommand" | "realpath">>,
) {
  const candidates = new Set<string>();
  for (const executablePath of detection.executablePaths) {
    candidates.add(executablePath);
    candidates.add(await resolvedPath(executablePath, options.realpath));
  }
  if (recipe.installer === "apt") {
    for (const candidate of candidates) {
      const result = await options.runCommand("dpkg-query", ["--search", candidate]);
      if (result.exitCode === 0 && result.stdout.split(/\r?\n/).some((line) => recipe.packages.includes(line.split(":", 1)[0].replace(/:[^:]+$/, "")))) return true;
    }
    return false;
  }
  if (recipe.installer === "dnf") {
    for (const candidate of candidates) {
      const result = await options.runCommand("rpm", ["-qf", candidate, "--qf", "%{NAME}"]);
      if (result.exitCode === 0 && recipe.packages.includes(result.stdout.trim())) return true;
    }
    return false;
  }
  for (const packageName of recipe.packages) {
    const result = await options.runCommand("brew", ["--prefix", packageName]);
    if (result.exitCode !== 0) continue;
    const prefix = await resolvedPath(result.stdout.trim(), options.realpath);
    if ([...candidates].some((candidate) => pathInside(candidate, prefix))) return true;
  }
  return false;
}

export async function detectManagedAppOwnership(
  definition: ManagedAppDefinition,
  detection: ManagedAppDetectionResult,
  capabilities: FinalComputerCapabilities,
  options: ManagedAppOwnershipOptions = {},
): Promise<ManagedAppOwnershipResult> {
  if (detection.state === "not-installed") return { source: "none" };
  const viableRecipes = definition.distribution.recipes.filter((recipe) => selectInstallRecipe({ ...definition, distribution: { recipes: [recipe] } }, capabilities).recipe);
  const bundled = viableRecipes.find((recipe) => recipe.type === "bundled");
  if (bundled) return { source: "bundled", recipe: bundled };
  const resolved = {
    runCommand: options.runCommand || runOwnershipCommand,
    realpath: options.realpath || ((value: string) => fs.promises.realpath(value)),
    readFile: options.readFile || ((value: string) => fs.promises.readFile(value, "utf8")),
  };
  for (const recipe of viableRecipes) {
    if (recipe.type === "bundled") continue;
    const owned = recipe.type === "node-package"
      ? await nodePackageOwnsExecutable(recipe, detection, capabilities, resolved)
      : recipe.type === "system-package"
        ? await systemPackageOwnsExecutable(recipe, detection, resolved)
        : Boolean(options.archiveManifestOwned && await options.archiveManifestOwned(definition, recipe, detection));
    if (owned) return { source: "recipe", recipe };
  }
  return { source: "external" };
}

export async function detectManagedAppManagementSource(
  definition: ManagedAppDefinition,
  detection: ManagedAppDetectionResult,
  capabilities: FinalComputerCapabilities,
  options: ManagedAppOwnershipOptions = {},
): Promise<ManagedAppManagementSource> {
  return (await detectManagedAppOwnership(definition, detection, capabilities, options)).source;
}

export function managedAppProjection(
  definition: ManagedAppDefinition,
  detection: ManagedAppDetectionResult,
  capabilities: FinalComputerCapabilities,
  managementSource?: ManagedAppManagementSource,
): ManagedAppProjection {
  const selected = selectInstallRecipe(definition, capabilities);
  const source = managementSource || (detection.state === "not-installed"
    ? "none"
    : selected.recipe?.type === "bundled" ? "bundled" : selected.recipe ? "recipe" : "external");
  const state = detection.state === "not-installed" && !selected.recipe ? "unsupported" : detection.state;
  const bundled = selected.recipe?.type === "bundled";
  const canInstall = state === "not-installed" && Boolean(selected.recipe) && !bundled;
  const canUninstall = (state === "installed" || state === "broken") && Boolean(selected.recipe) && !bundled && source === "recipe";
  const installReason = canInstall ? undefined
    : bundled ? { code: "BUNDLED" as const, message: "This app is supplied with the controlled computer." }
      : state === "installed" || state === "broken" ? { code: "ALREADY_INSTALLED" as const, message: "This app is already present." }
        : selected.reason;
  const uninstallReason = canUninstall ? undefined
    : bundled ? { code: "BUNDLED" as const, message: "Bundled apps cannot be removed by app management." }
      : source === "external" ? { code: "EXTERNALLY_MANAGED" as const, message: "This app was installed outside App management and must be removed with its original installer." }
      : state === "not-installed" || state === "unsupported" ? { code: "NOT_INSTALLED" as const, message: "This app is not installed." }
        : selected.reason;
  return {
    id: definition.launcher.id,
    name: definition.launcher.name,
    kind: definition.launcher.kind,
    description: definition.launcher.description,
    state,
    managementSource: source,
    version: detection.version,
    canInstall,
    canUninstall,
    installReason,
    uninstallReason,
  };
}
