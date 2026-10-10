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
  explicitPath: boolean;
};

export type ExecutableResolver = {
  id: string;
  resolve(context: ExecutableResolverContext): ExecutableResolution | undefined;
};

function executableCandidate(candidate: string, platform: NodeJS.Platform, env: NodeJS.ProcessEnv) {
  const extensions = platform === "win32"
    ? (env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)
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

export const DEFAULT_EXECUTABLE_RESOLVERS: ExecutableResolver[] = [
  pathExecutableResolver,
  nvmExecutableResolver,
  homebrewExecutableResolver,
];

function defaultHomebrewBinDirectories(platform: NodeJS.Platform, env: NodeJS.ProcessEnv) {
  const directories = env.HOMEBREW_PREFIX ? [path.join(env.HOMEBREW_PREFIX, "bin")] : [];
  if (platform === "darwin") directories.push("/opt/homebrew/bin", "/usr/local/bin");
  if (platform === "linux") directories.push("/home/linuxbrew/.linuxbrew/bin");
  return [...new Set(directories)];
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
    explicitPath: path.isAbsolute(command) || command.includes("/") || command.includes("\\"),
  };
  for (const resolver of options.resolvers || DEFAULT_EXECUTABLE_RESOLVERS) {
    const resolution = resolver.resolve(context);
    if (resolution) return resolution;
  }
  return undefined;
}
