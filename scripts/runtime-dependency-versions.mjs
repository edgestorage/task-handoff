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

export function exactInstalledDependencies(root, dependencies, workspaceDirectories = ["apps", "packages"]) {
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
    return [name, String([...versions][0]).replace(/^v(?=\d)/, "")];
  }));
}
