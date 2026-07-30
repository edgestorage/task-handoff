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

export function resolvePackageVersion(
  packageName: string,
  env: NodeJS.ProcessEnv = process.env,
  workspacePackageName = packageName,
) {
  const explicitVersion = env.TASK_HANDOFF_VERSION?.trim();
  if (explicitVersion) return explicitVersion;

  const packageDirectory = workspacePackageName.split("/").at(-1);
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
        const workspaceVersion = manifestVersion(
          path.join(directory, "packages", packageDirectory, "package.json"),
          workspacePackageName,
        );
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

export function packageVersionResolver(
  packageName: string,
  env: NodeJS.ProcessEnv = process.env,
  workspacePackageName = packageName,
) {
  let resolvedVersion: string | undefined;
  return () => {
    const explicitVersion = env.TASK_HANDOFF_VERSION?.trim();
    if (explicitVersion) return explicitVersion;
    resolvedVersion ||= resolvePackageVersion(packageName, env, workspacePackageName);
    return resolvedVersion;
  };
}

/**
 * Resolves the version from the package that owns the running executable.
 * Managed application runtimes can be replaced without rebuilding their base
 * image, so an image-level TASK_HANDOFF_VERSION is not authoritative for them.
 */
export function executablePackageVersionResolver(
  packageName: string,
  env: NodeJS.ProcessEnv = process.env,
  workspacePackageName = packageName,
) {
  const executableEnv = { ...env };
  delete executableEnv.TASK_HANDOFF_VERSION;
  return packageVersionResolver(packageName, executableEnv, workspacePackageName);
}

/**
 * Resolves the controlled-instance release that is actually being executed.
 * A Local Runtime is bundled inside the node-agent executable, so its launcher
 * materializes that outer release explicitly. Replaceable managed artifacts
 * omit the override and continue to use their own manifest.
 */
export function controlledInstancePackageVersionResolver(env: NodeJS.ProcessEnv = process.env) {
  const executableResolver = executablePackageVersionResolver("@task-handoff/controlled-instance", env);
  return () => env.TASK_HANDOFF_CONTROLLED_INSTANCE_VERSION?.trim() || executableResolver();
}
