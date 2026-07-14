import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type GuiVncBackend = "novnc" | "kasmvnc";

export function guiVncBackend(): GuiVncBackend {
  return process.env.TASK_HANDOFF_VNC_BACKEND === "kasmvnc" ? "kasmvnc" : "novnc";
}

export function guiScaleFromEnv(env: NodeJS.ProcessEnv) {
  const parsed = Number(env.TASK_HANDOFF_GUI_SCALE || process.env.TASK_HANDOFF_GUI_SCALE || "1");
  if (!Number.isFinite(parsed)) {
    return 1;
  }
  return Math.min(3, Math.max(1, parsed));
}

export function formatGuiScale(scale: number) {
  return scale.toFixed(2).replace(/\.?0+$/, "");
}

export function guiAppHomeDir() {
  return process.env.TASK_HANDOFF_GUI_APP_HOME || process.env.HOME || os.homedir();
}

export function chromiumUserDataDir(sessionDir: string) {
  const configured = process.env.TASK_HANDOFF_CHROMIUM_USER_DATA_DIR?.trim();
  if (configured) {
    return configured;
  }
  return path.join(sessionDir, "profile");
}

export function codexAppServerSocketPath(runtimeDir: string) {
  const configuredRoot = process.env.TASK_HANDOFF_CODEX_APP_SERVER_SOCKET_DIR?.trim();
  const root = configuredRoot ? fs.realpathSync(configuredRoot) : process.platform === "darwin" ? "/private/tmp" : fs.realpathSync(os.tmpdir());
  const hash = createHash("sha256").update(runtimeDir).digest("hex").slice(0, 16);
  return path.join(root, `task-handoff-codex-${hash}`, "app-server.sock");
}

export function ensureNodePtySpawnHelperExecutable() {
  if (process.platform !== "darwin" && process.platform !== "linux") {
    return;
  }
  try {
    const packageRoot = path.resolve(path.dirname(require.resolve("node-pty")), "..");
    const helperPath = path.join(packageRoot, "prebuilds", `${process.platform}-${process.arch}`, "spawn-helper");
    const stat = fs.statSync(helperPath);
    if ((stat.mode & 0o111) === 0) {
      fs.chmodSync(helperPath, stat.mode | 0o755);
    }
  } catch {
    // node-pty will surface the original launch error if the helper is unavailable.
  }
}

export function claudeShortFromOutput(output: string) {
  const labeled = output.match(/\b(?:short|id|worker|session)\D+([a-f0-9]{8})\b/i)?.[1];
  return labeled || output.match(/\b([a-f0-9]{8})\b/i)?.[1];
}
