import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

let cachedInstaller: string | undefined;

export function nodeAgentInstallerPath() {
  const moduleDir = import.meta.url ? path.dirname(fileURLToPath(import.meta.url)) : __dirname;
  // Source runs beside the repository script; packaged runtimes carry a copy in `dist`.
  const candidates = [
    path.join(moduleDir, "install-node-agent.sh"),
    path.resolve(moduleDir, "../../../../../scripts/install-node-agent.sh"),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) || candidates[0];
}

export function nodeAgentInstallScript() {
  if (cachedInstaller !== undefined) return cachedInstaller;
  const installerPath = nodeAgentInstallerPath();
  if (!fs.existsSync(installerPath)) {
    throw new Error(`Node agent installer is missing: ${installerPath}`);
  }
  cachedInstaller = fs.readFileSync(installerPath, "utf8");
  return cachedInstaller;
}
