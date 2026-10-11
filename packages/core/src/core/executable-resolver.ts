import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type ExecutableResolution = {
  executable: string;
  resolver: string;
  env?: Record<string, string>;
};

export type ExecutableResolverOptions = {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  platform?: NodeJS.Platform;
  homeDir?: string;
  nvmDir?: string;
  homebrewBinDirectories?: string[];
  npmGlobalBinDirectories?: string[];
  nodeRuntimeDirectories?: string[];
  resolvers?: ExecutableResolver[];
};

export type ExecutableResolverContext = {
  command: string;
  env: NodeJS.ProcessEnv;
  cwd: string;
  platform: NodeJS.Platform;
  homeDir: string;
  nvmDir: string;
  homebrewBinDirectories: string[];
  npmGlobalBinDirectories: string[];
  explicitPath: boolean;
};

export type ExecutableResolver = {
  id: string;
  resolve(context: ExecutableResolverContext): ExecutableResolution | undefined;
};

function executableCandidate(candidate: string, platform: NodeJS.Platform, env: NodeJS.ProcessEnv) {
  // Windows matches PATHEXT case-insensitively, so probing the lowercase form
  // as well keeps npm's lowercase `.cmd` shims resolvable everywhere.
  const extensions = platform === "win32"
    ? [...new Set((env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean).flatMap((extension) => [extension, extension.toLowerCase()]))]
    : [""];
  for (const extension of extensions) {
    const resolved = platform === "win32" && !path.extname(candidate) ? `${candidate}${extension}` : candidate;
    try {
      fs.accessSync(resolved, fs.constants.X_OK);
      if (fs.statSync(resolved).isFile()) return resolved;
    } catch {
      // This resolver candidate is unavailable; continue with the next one.
    }
  }
  return undefined;
}

function resolutionFromBin(
  id: string,
  binDirectory: string,
  context: ExecutableResolverContext,
  extraEnv: Record<string, string> = {},
) {
  const executable = executableCandidate(path.join(binDirectory, context.command), context.platform, context.env);
  if (!executable) return undefined;
  const currentPath = context.env.PATH || "";
  return {
    executable,
    resolver: id,
    env: {
      PATH: currentPath ? `${binDirectory}${path.delimiter}${currentPath}` : binDirectory,
      ...extraEnv,
    },
  } satisfies ExecutableResolution;
}

export const pathExecutableResolver: ExecutableResolver = {
  id: "path",
  resolve(context) {
    if (path.isAbsolute(context.command)) {
      const executable = executableCandidate(context.command, context.platform, context.env);
      return executable ? { executable, resolver: this.id } : undefined;
    }
    if (context.explicitPath) {
      const executable = executableCandidate(path.resolve(context.cwd, context.command), context.platform, context.env);
      return executable ? { executable, resolver: this.id } : undefined;
    }
    for (const directory of (context.env.PATH || "").split(path.delimiter).filter(Boolean)) {
      const executable = executableCandidate(path.join(directory, context.command), context.platform, context.env);
      if (executable) return { executable, resolver: this.id };
    }
    return undefined;
  },
};

function installedNvmVersions(nvmDir: string) {
  const versionsDir = path.join(nvmDir, "versions", "node");
  try {
    return fs.readdirSync(versionsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort(compareNodeVersionsDescending);
  } catch {
    return [];
  }
}

function compareNodeVersionsDescending(left: string, right: string) {
  const parse = (value: string) => value.replace(/^v/, "").split(/[.-]/).map((part) => /^\d+$/.test(part) ? Number(part) : part);
  const leftParts = parse(left);
  const rightParts = parse(right);
  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
    const leftPart = leftParts[index] ?? 0;
    const rightPart = rightParts[index] ?? 0;
    if (leftPart === rightPart) continue;
    if (typeof leftPart === "number" && typeof rightPart === "number") return rightPart - leftPart;
    return String(rightPart).localeCompare(String(leftPart));
  }
  return 0;
}

function readNvmAlias(nvmDir: string, alias: string) {
  if (!alias || path.isAbsolute(alias) || alias.split("/").some((segment) => !segment || segment === "." || segment === "..")) return undefined;
  const aliasPath = path.join(nvmDir, "alias", ...alias.split("/"));
  try {
    return fs.readFileSync(aliasPath, "utf8").trim().split(/\s+/)[0];
  } catch {
    return undefined;
  }
}

function preferredNvmVersion(nvmDir: string, installed: string[]) {
  let alias = "default";
  const visited = new Set<string>();
  for (let depth = 0; depth < 8 && alias && !visited.has(alias); depth += 1) {
    visited.add(alias);
    const target = readNvmAlias(nvmDir, alias);
    if (!target) break;
    const exact = installed.find((version) => version === target || version === `v${target}`);
    if (exact) return exact;
    if (/^(?:node|stable)$/.test(target)) return installed[0];
    if (/^v?\d+(?:\.\d+){0,2}$/.test(target)) {
      const prefix = target.startsWith("v") ? target : `v${target}`;
      const match = installed.find((version) => version === prefix || version.startsWith(`${prefix}.`));
      if (match) return match;
    }
    alias = target;
  }
  return undefined;
}

export const nvmExecutableResolver: ExecutableResolver = {
  id: "nvm",
  resolve(context) {
    if (context.explicitPath || context.platform === "win32") return undefined;
    const directories: string[] = [];
    if (context.env.NVM_BIN) directories.push(context.env.NVM_BIN);
    const installed = installedNvmVersions(context.nvmDir);
    const preferred = preferredNvmVersion(context.nvmDir, installed);
    if (preferred) directories.push(path.join(context.nvmDir, "versions", "node", preferred, "bin"));
    for (const version of installed) directories.push(path.join(context.nvmDir, "versions", "node", version, "bin"));
    for (const directory of [...new Set(directories)]) {
      const resolution = resolutionFromBin(this.id, directory, context, { NVM_BIN: directory, NVM_DIR: context.nvmDir });
      if (resolution) return resolution;
    }
    return undefined;
  },
};

export const homebrewExecutableResolver: ExecutableResolver = {
  id: "homebrew",
  resolve(context) {
    if (context.explicitPath || context.platform === "win32") return undefined;
    for (const directory of context.homebrewBinDirectories) {
      const resolution = resolutionFromBin(this.id, directory, context);
      if (resolution) return resolution;
    }
    return undefined;
  },
};

export const npmGlobalExecutableResolver: ExecutableResolver = {
  id: "npm-global",
  resolve(context) {
    if (context.explicitPath) return undefined;
    for (const directory of context.npmGlobalBinDirectories) {
      const resolution = resolutionFromBin(this.id, directory, context);
      if (resolution) return resolution;
    }
    return undefined;
  },
};

export const DEFAULT_EXECUTABLE_RESOLVERS: ExecutableResolver[] = [
  pathExecutableResolver,
  nvmExecutableResolver,
  homebrewExecutableResolver,
  npmGlobalExecutableResolver,
];

function defaultHomebrewBinDirectories(platform: NodeJS.Platform, env: NodeJS.ProcessEnv) {
  const directories = env.HOMEBREW_PREFIX ? [path.join(env.HOMEBREW_PREFIX, "bin")] : [];
  if (platform === "darwin") directories.push("/opt/homebrew/bin", "/usr/local/bin");
  if (platform === "linux") directories.push("/home/linuxbrew/.linuxbrew/bin");
  return [...new Set(directories)];
}

/**
 * The directory npm installs global CLI shims into. Windows keeps it under the
 * roaming profile, which is only reachable through the user PATH, so anything
 * that runs without the user PATH (services, installers, GUI apps started from
 * a stale environment) resolves `npm` but not the tools npm installed.
 */
function defaultNpmGlobalBinDirectories(platform: NodeJS.Platform, env: NodeJS.ProcessEnv, homeDir: string) {
  const directories: string[] = [];
  const prefix = env.NPM_CONFIG_PREFIX || env.npm_config_prefix;
  if (prefix) directories.push(platform === "win32" ? prefix : path.join(prefix, "bin"));
  if (platform === "win32") {
    const roaming = env.APPDATA || (homeDir ? path.join(homeDir, "AppData", "Roaming") : undefined);
    if (roaming) directories.push(path.join(roaming, "npm"));
  }
  return [...new Set(directories)];
}

/**
 * Where a win32 Node runtime lives. `node.exe` ships as a plain PE image in a
 * directory that only the Node installer, nvm-windows, or a package-manager
 * shim adds to `PATH`, so a process that starts without the user PATH has no
 * way to reach it. `NVM_SYMLINK`, `NVM_HOME`, and `TASK_HANDOFF_NODE` are
 * honored first because they are explicit rather than guessed.
 */
function defaultNodeRuntimeDirectories(platform: NodeJS.Platform, env: NodeJS.ProcessEnv, homeDir: string) {
  if (platform !== "win32") return [];
  const localAppData = env.LOCALAPPDATA || (homeDir ? path.join(homeDir, "AppData", "Local") : undefined);
  const roaming = env.APPDATA || (homeDir ? path.join(homeDir, "AppData", "Roaming") : undefined);
  // A process that is already the win32 Node runtime knows exactly where its
  // siblings are, which is the only reliable answer for a CLI or a service.
  const runningNode = path.basename(process.execPath).toLowerCase() === "node.exe" ? path.dirname(process.execPath) : undefined;
  const candidates = [
    env.NVM_SYMLINK,
    env.NVM_HOME,
    env.TASK_HANDOFF_NODE ? path.dirname(env.TASK_HANDOFF_NODE) : undefined,
    runningNode,
    env.ProgramFiles ? path.join(env.ProgramFiles, "nodejs") : undefined,
    env["ProgramFiles(x86)"] ? path.join(env["ProgramFiles(x86)"], "nodejs") : undefined,
    localAppData ? path.join(localAppData, "Programs", "nodejs") : undefined,
    localAppData ? path.join(localAppData, "Volta", "bin") : undefined,
    localAppData ? path.join(localAppData, "Microsoft", "WinGet", "Links") : undefined,
    homeDir ? path.join(homeDir, "scoop", "shims") : undefined,
    roaming ? path.join(roaming, "nvm") : undefined,
  ];
  return [...new Set(candidates.filter((directory): directory is string => Boolean(directory)))];
}

/** The first directory that actually holds a `node` the current PATHEXT can start. */
function nodeRuntimeDirectory(env: NodeJS.ProcessEnv, options: ExecutableResolverOptions = {}) {
  const platform = options.platform || process.platform;
  if (platform !== "win32") return undefined;
  const homeDir = options.homeDir || os.homedir();
  const directories = options.nodeRuntimeDirectories || defaultNodeRuntimeDirectories(platform, env, homeDir);
  for (const directory of directories) {
    if (executableCandidate(path.join(directory, "node"), platform, env)) return directory;
  }
  return undefined;
}

function nodeRuntimeOnPath(env: NodeJS.ProcessEnv, platform: NodeJS.Platform) {
  for (const directory of (env.PATH || "").split(path.delimiter).filter(Boolean)) {
    if (executableCandidate(path.join(directory, "node"), platform, env)) return true;
  }
  return false;
}

const WINDOWS_COMMAND_INTERPRETER_PATHEXT = ".COM;.EXE;.BAT;.CMD";

/**
 * The environment a win32 `.cmd`/`.bat` shim needs from whoever starts it.
 *
 * `cmd.exe` resolves the shim's own commands through PATHEXT, and every npm
 * shim — `npm`, `npx`, and each globally installed CLI — is a batch file that
 * shells out to the bare name `node`. An environment captured before Node was
 * installed (a GUI app started from a stale session, a service) therefore
 * resolves the shim but not its interpreter, and the launch dies with
 * `'"node"' is not recognized` before the shim can do anything.
 */
export function commandInterpreterShimEnvironment(env: NodeJS.ProcessEnv, options: ExecutableResolverOptions = {}) {
  const platform = options.platform || process.platform;
  if (platform !== "win32") return env;
  const prepared = env.PATHEXT ? env : { ...env, PATHEXT: WINDOWS_COMMAND_INTERPRETER_PATHEXT };
  if (nodeRuntimeOnPath(prepared, platform)) return prepared;
  const directory = nodeRuntimeDirectory(prepared, { ...options, platform });
  if (!directory) return prepared;
  return {
    ...prepared,
    PATH: prepared.PATH ? `${directory}${path.delimiter}${prepared.PATH}` : directory,
  };
}

export function resolveExecutable(command: string, options: ExecutableResolverOptions = {}) {
  const env = options.env || process.env;
  const platform = options.platform || process.platform;
  const homeDir = options.homeDir || os.homedir();
  const context: ExecutableResolverContext = {
    command,
    env,
    cwd: options.cwd || process.cwd(),
    platform,
    homeDir,
    nvmDir: options.nvmDir || env.NVM_DIR || path.join(homeDir, ".nvm"),
    homebrewBinDirectories: options.homebrewBinDirectories || defaultHomebrewBinDirectories(platform, env),
    npmGlobalBinDirectories: options.npmGlobalBinDirectories || defaultNpmGlobalBinDirectories(platform, env, homeDir),
    explicitPath: path.isAbsolute(command) || command.includes("/") || command.includes("\\"),
  };
  for (const resolver of options.resolvers || DEFAULT_EXECUTABLE_RESOLVERS) {
    const resolution = resolver.resolve(context);
    if (resolution) return resolution;
  }
  return undefined;
}
