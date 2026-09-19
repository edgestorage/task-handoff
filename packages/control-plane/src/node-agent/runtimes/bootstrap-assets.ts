import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import writeFileAtomic from "write-file-atomic";

const REQUIRED_BOOTSTRAP_ASSETS = new Set([
  "entrypoint.sh",
  "git-provision.sh",
  "instance-launcher.sh",
  "node-agent-unix-proxy.mjs",
  "runtime-installer.mjs",
]);

export function packagedDockerBootstrapAssetsDir() {
  const moduleDir = import.meta.url ? path.dirname(fileURLToPath(import.meta.url)) : __dirname;
  const candidates = [
    path.resolve(moduleDir, "../../../../../docker"),
    path.resolve(moduleDir, "../docker"),
    path.resolve(moduleDir, "../../docker"),
  ];
  return candidates.find((candidate) => fs.existsSync(path.join(candidate, "runtime-installer.mjs"))) || candidates[0];
}

export function materializeDockerBootstrapAssets(targetDir: string, sourceDir = packagedDockerBootstrapAssetsDir()) {
  const sourceEntries = fs.readdirSync(sourceDir, { withFileTypes: true });
  const assets = new Map(sourceEntries.flatMap((entry) => {
    if (!entry.isFile()) return [];
    const source = path.join(sourceDir, entry.name);
    return [[entry.name, { source, mode: fs.statSync(source).mode & 0o777 }] as const];
  }));
  const missing = [...REQUIRED_BOOTSTRAP_ASSETS].filter((name) => !assets.has(name));
  if (missing.length) {
    throw new Error(`Node agent bootstrap assets are incomplete: missing ${missing.sort().join(", ")} in ${sourceDir}.`);
  }

  fs.mkdirSync(targetDir, { recursive: true, mode: 0o755 });
  fs.chmodSync(targetDir, 0o755);
  for (const [name, asset] of assets) {
    const target = path.join(targetDir, name);
    writeFileAtomic.sync(target, fs.readFileSync(asset.source), { mode: asset.mode });
    fs.chmodSync(target, asset.mode);
  }
  for (const entry of fs.readdirSync(targetDir, { withFileTypes: true })) {
    if (!assets.has(entry.name)) fs.rmSync(path.join(targetDir, entry.name), { recursive: true, force: true });
  }
  return path.resolve(targetDir);
}
