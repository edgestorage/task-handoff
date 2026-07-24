import fs from "node:fs";
import path from "node:path";
import { chromiumUserDataDir } from "../../runtime-utils";
import type { ManagedAppGuiLaunchInput, ManagedAppRuntimeExtension } from "../types";

const DEFAULT_EXTENSION_DIR = "/opt/task-handoff/chromium-extensions";

function isExtensionDir(extensionDir: string) {
  return fs.existsSync(path.join(extensionDir, "manifest.json"));
}

function extensionDirs() {
  const configured = process.env.TASK_HANDOFF_CHROMIUM_EXTENSION_DIRS;
  if (configured) {
    return configured.split(/[,;]/).map((entry) => entry.trim()).filter((entry) => isExtensionDir(entry));
  }
  const root = process.env.TASK_HANDOFF_CHROMIUM_EXTENSION_DIR || DEFAULT_EXTENSION_DIR;
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(root, entry.name))
    .filter((entry) => isExtensionDir(entry))
    .sort();
}

function chromiumArgs(input: ManagedAppGuiLaunchInput) {
  const sandboxArgs = ["1", "true", "yes", "on"].includes(String(process.env.TASK_HANDOFF_CHROMIUM_NO_SANDBOX || "").toLowerCase()) ? ["--no-sandbox"] : [];
  const userDataDir = chromiumUserDataDir(input.sessionDir);
  const extensions = extensionDirs();
  return [
    ...sandboxArgs,
    "--disable-dev-shm-usage",
    "--no-first-run",
    ...(extensions.length ? [`--load-extension=${extensions.join(",")}`] : []),
    "--remote-debugging-address=127.0.0.1",
    ...(userDataDir ? [`--user-data-dir=${userDataDir}`] : []),
    ...(input.app.automation?.portArg
      ? [input.app.automation.portArg.replaceAll("{port}", String(input.automationPort))]
      : [`--remote-debugging-port=${input.automationPort}`]),
    ...input.defaultArgs,
  ];
}

export function createChromiumRuntime(): ManagedAppRuntimeExtension {
  return { prepareGuiArgs: chromiumArgs };
}
