import fs from "node:fs";
import path from "node:path";

function manifestVersion(manifestPath: string, expectedName?: string) {
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as { name?: unknown; version?: unknown };
    if (expectedName && manifest.name !== expectedName) return undefined;
    return typeof manifest.version === "string" && manifest.version.trim() ? manifest.version.trim() : undefined;
  } catch {
    return undefined;
  }
}

export function resolvePackageVersion(packageName: string, env: NodeJS.ProcessEnv = process.env) {
  const explicitVersion = env.TASK_HANDOFF_VERSION?.trim();
  if (explicitVersion) return explicitVersion;

  const packageDirectory = packageName.split("/").at(-1);
  const entryDirectory = process.argv[1] ? path.dirname(path.resolve(process.argv[1])) : undefined;
  const starts = [entryDirectory, process.cwd()]
    .filter((value): value is string => Boolean(value));

  // A packaged runtime must take its version from the manifest that owns the
  // actual executable, even when it is launched with the monorepo as cwd.
  for (const start of new Set(starts)) {
    let directory = start;
    while (true) {
      const directVersion = manifestVersion(path.join(directory, "package.json"), packageName);
      if (directVersion) return directVersion;
      const parent = path.dirname(directory);
      if (parent === directory) break;
      directory = parent;
    }
  }

  let fallback: string | undefined;
  for (const start of new Set(starts)) {
    let directory = start;
    while (true) {
      if (packageDirectory) {
        const workspaceVersion = manifestVersion(path.join(directory, "packages", packageDirectory, "package.json"), packageName);
        if (workspaceVersion) return workspaceVersion;
      }
      fallback ||= manifestVersion(path.join(directory, "package.json"));
      const parent = path.dirname(directory);
      if (parent === directory) break;
      directory = parent;
    }
  }
  return fallback || "unknown";
}

export function packageVersionResolver(packageName: string, env: NodeJS.ProcessEnv = process.env) {
  let resolvedVersion: string | undefined;
  return () => {
    const explicitVersion = env.TASK_HANDOFF_VERSION?.trim();
    if (explicitVersion) return explicitVersion;
    resolvedVersion ||= resolvePackageVersion(packageName, env);
    return resolvedVersion;
  };
}
