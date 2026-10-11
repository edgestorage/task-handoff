import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { localIpcEndpoint } from "@task-handoff/core/core/local-ipc-endpoint";

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

export function codexAppServerSocketPath(runtimeDir: string) {
  const configuredRoot = process.env.TASK_HANDOFF_CODEX_APP_SERVER_SOCKET_DIR?.trim();
  return localIpcEndpoint({
    kind: "codex-af-unix",
    scope: "task-handoff-codex",
    key: runtimeDir,
    fileName: "app-server.sock",
    rootDir: configuredRoot ? fs.realpathSync(configuredRoot) : undefined,
  }).path;
}

export type CodexAppServerTransport = "unix" | "ws";

/**
 * Transport for the shared Codex app-server.
 *
 * POSIX keeps the AF_UNIX endpoint: the CLI owns the socket, Node reaches it
 * through `codex app-server proxy --sock`, and the TUI attaches to the loopback
 * proxy the runtime runs. Windows cannot bind or connect AF_UNIX from Node (and
 * the CLI re-homes a unix listener behind a daemon symlink there), so it uses
 * the app-server's own loopback WebSocket listener guarded by a capability
 * token. `TASK_HANDOFF_CODEX_APP_SERVER_TRANSPORT` overrides the choice so both
 * paths stay exercisable on one machine.
 */
export function codexAppServerTransport(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): CodexAppServerTransport {
  const configured = env.TASK_HANDOFF_CODEX_APP_SERVER_TRANSPORT?.trim().toLowerCase();
  if (configured === "unix" || configured === "ws") return configured;
  return platform === "win32" ? "ws" : "unix";
}

export function codexAppServerWsEndpoint(port: number) {
  return `ws://127.0.0.1:${port}`;
}

/**
 * Readiness surface of the same loopback port. The app-server answers `/readyz`
 * over HTTP (no token required) once it can serve the websocket endpoint.
 */
export function codexAppServerHealthUrl(port: number, path = "/readyz") {
  return `http://127.0.0.1:${port}${path}`;
}

export function codexAppServerWsListenArgs(endpoint: string, tokenFile: string) {
  return ["--listen", endpoint, "--ws-auth", "capability-token", "--ws-token-file", tokenFile];
}

/**
 * Capability token the loopback listener requires. It lives in the per-user
 * runtime directory: POSIX tightens it with 0600, Windows inherits the profile
 * ACL of that directory.
 */
export function codexAppServerTokenFile(runtimeDir: string) {
  return path.join(runtimeDir, "app-server-token");
}

export function createCodexAppServerToken() {
  return crypto.randomBytes(32).toString("base64url");
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
