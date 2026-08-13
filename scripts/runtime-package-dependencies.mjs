import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

export function resolveInstalledManifest(name, resolutionRoot) {
  if (!resolutionRoot) throw new Error(`Runtime dependency has no resolution owner: ${name}`);
  const resolver = createRequire(resolutionRoot);
  try {
    return resolver.resolve(`${name}/package.json`);
  } catch (error) {
    if (error?.code !== "ERR_PACKAGE_PATH_NOT_EXPORTED") throw error;
  }
  let current = path.dirname(resolver.resolve(name));
  while (true) {
    const manifestPath = path.join(current, "package.json");
    if (fs.existsSync(manifestPath)) {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      if (manifest.name === name) return manifestPath;
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  throw new Error(`Could not resolve installed runtime dependency manifest: ${name}`);
}

export function exactRuntimeDependencies(dependencies, resolutionRoots) {
  return Object.fromEntries(
    Object.keys(dependencies).map((name) => {
      const manifestPath = resolveInstalledManifest(name, resolutionRoots[name]);
      const installed = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      if (!installed.version) throw new Error(`Installed runtime dependency has no version: ${name}`);
      return [name, String(installed.version).replace(/^v(?=\d)/, "")];
    }),
  );
}

export function runtimeDependencyNodePaths(dependencies, resolutionRoots) {
  return [...new Set(Object.keys(dependencies).map((name) => {
    const packageDir = path.dirname(resolveInstalledManifest(name, resolutionRoots[name]));
    return path.dirname(name.startsWith("@") ? path.dirname(packageDir) : packageDir);
  }))];
}
