import fs from "node:fs";
import path from "node:path";

function packageRoots(root, workspaceDirectories) {
  const roots = [root];
  for (const workspaceDirectory of workspaceDirectories) {
    const directory = path.join(root, workspaceDirectory);
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const packageRoot = path.join(directory, entry.name);
      if (fs.existsSync(path.join(packageRoot, "package.json"))) roots.push(packageRoot);
    }
  }
  return roots;
}

export function installedDependencyManifests(root, dependencies, workspaceDirectories = ["apps", "packages"]) {
  const roots = packageRoots(root, workspaceDirectories);
  return Object.fromEntries(Object.keys(dependencies).map((name) => {
    const manifests = roots
      .map((packageRoot) => path.join(packageRoot, "node_modules", ...name.split("/"), "package.json"))
      .filter(fs.existsSync)
      .map((manifestPath) => ({
        manifestPath,
        manifest: JSON.parse(fs.readFileSync(manifestPath, "utf8")),
      }));
    if (!manifests.length) throw new Error(`Installed runtime dependency was not found: ${name}`);
    const versions = new Set(manifests.map(({ manifest }) => manifest.version).filter(Boolean));
    if (versions.size !== 1) {
      throw new Error(`Installed runtime dependency has ambiguous versions: ${name} (${[...versions].join(", ") || "missing"})`);
    }
    return [name, manifests[0].manifestPath];
  }));
}

export function exactInstalledDependencies(root, dependencies, workspaceDirectories = ["apps", "packages"]) {
  const manifests = installedDependencyManifests(root, dependencies, workspaceDirectories);
  return Object.fromEntries(Object.entries(manifests).map(([name, manifestPath]) => {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    return [name, String(manifest.version).replace(/^v(?=\d)/, "")];
  }));
}

export function materializeInstalledDependencies(packageRoot, root, dependencies, workspaceDirectories = ["apps", "packages"]) {
  const nodeModules = path.join(packageRoot, "node_modules");
  const nodeModulesExisted = fs.existsSync(nodeModules);
  const manifests = installedDependencyManifests(root, dependencies, workspaceDirectories);
  const links = [];
  for (const [name, manifestPath] of Object.entries(manifests)) {
    const linkPath = path.join(nodeModules, ...name.split("/"));
    if (fs.existsSync(linkPath)) throw new Error(`Runtime package dependency path already exists: ${linkPath}`);
    fs.mkdirSync(path.dirname(linkPath), { recursive: true });
    fs.symlinkSync(path.dirname(manifestPath), linkPath, process.platform === "win32" ? "junction" : "dir");
    links.push(linkPath);
  }
  return () => {
    if (!nodeModulesExisted) {
      fs.rmSync(nodeModules, { recursive: true, force: true });
      return;
    }
    for (const linkPath of links) {
      fs.rmSync(linkPath, { recursive: true, force: true });
      let parent = path.dirname(linkPath);
      while (parent !== nodeModules) {
        try {
          fs.rmdirSync(parent);
        } catch {
          break;
        }
        parent = path.dirname(parent);
      }
    }
  };
}
