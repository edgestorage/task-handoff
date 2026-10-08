import fs from "node:fs";
import path from "node:path";
import { spawn as spawnPty } from "node-pty";
import type { CommandResult } from "./command-runner.ts";
import { defaultCommandRunner, type CommandRunner } from "./command-runner.ts";

export type TerminalCommandRunOptions = {
  cols?: number;
  rows?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  onData?: (data: string) => void;
};

export type TerminalCommandRunner = (command: string, args: string[], options?: TerminalCommandRunOptions) => Promise<CommandResult>;

function isRegularFile(candidate: string) {
  try {
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

/**
 * node-pty resolves a relative command name on Windows by scanning `Path` for a file whose name
 * matches exactly, without applying PATHEXT. Windows only ships `docker.exe`, so spawning the bare
 * name fails with a `File not found: ` error before the process is ever created. Resolving the
 * executable here and handing node-pty an absolute path avoids that lookup entirely.
 */
export function resolveTerminalCommand(
  command: string,
  options: { platform?: NodeJS.Platform; env?: Record<string, string | undefined>; isFile?: (candidate: string) => boolean } = {},
) {
  const platform = options.platform ?? process.platform;
  if (platform !== "win32" || !command) return command;
  const env = options.env ?? (process.env as Record<string, string | undefined>);
  if (path.win32.isAbsolute(command) || /[\\/]/.test(command)) return command;
  const isFile = options.isFile ?? isRegularFile;
  const directories = (env.PATH ?? env.Path ?? "").split(";").map((entry) => entry.trim()).filter(Boolean);
  const extensions = ["", ...(env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").map((entry) => entry.trim()).filter(Boolean)];
  for (const directory of directories) {
    for (const extension of extensions) {
      const candidate = path.win32.join(directory, `${command}${extension}`);
      if (isFile(candidate)) return candidate;
    }
  }
  return command;
}

export const defaultTerminalCommandRunner: TerminalCommandRunner = (command, args, options = {}) => new Promise((resolve, reject) => {
  if (options.signal?.aborted) {
    reject(Object.assign(new Error(`${command} was aborted.`), { code: "RUNTIME_COMMAND_ABORTED" }));
    return;
  }
  const output: string[] = [];
  let timedOut = false;
  let aborted = false;
  let terminal: ReturnType<typeof spawnPty>;
  try {
    terminal = spawnPty(resolveTerminalCommand(command), args, {
      name: "xterm-256color",
      cols: options.cols || 120,
      rows: options.rows || 40,
      cwd: process.cwd(),
      env: process.env as Record<string, string>,
    });
  } catch (error) {
    reject(error);
    return;
  }
  const timer = options.timeoutMs ? setTimeout(() => {
    timedOut = true;
    terminal.kill("SIGKILL");
  }, options.timeoutMs) : undefined;
  const onAbort = () => {
    aborted = true;
    try {
      terminal.kill("SIGKILL");
    } catch {
      // The terminal exited concurrently with cancellation.
    }
  };
  const cleanup = () => {
    if (timer) clearTimeout(timer);
    options.signal?.removeEventListener("abort", onAbort);
  };
  options.signal?.addEventListener("abort", onAbort, { once: true });
  timer?.unref?.();
  terminal.onData((data) => {
    output.push(data);
    options.onData?.(data);
  });
  terminal.onExit(({ exitCode }) => {
    cleanup();
    const result = { stdout: output.join(""), stderr: "" };
    if (timedOut) {
      reject(Object.assign(new Error(`${command} timed out after ${options.timeoutMs}ms`), {
        statusCode: 504,
        code: "RUNTIME_COMMAND_TIMEOUT",
        details: result,
      }));
      return;
    }
    if (aborted) {
      reject(Object.assign(new Error(`${command} was aborted.`), {
        code: "RUNTIME_COMMAND_ABORTED",
        details: result,
      }));
      return;
    }
    if (exitCode === 0) {
      resolve(result);
      return;
    }
    reject(Object.assign(new Error(plainTerminalError(result.stdout) || `${command} exited with code ${exitCode}`), {
      statusCode: 502,
      code: "RUNTIME_EXECUTOR_FAILED",
      details: result,
    }));
  });
});

function plainTerminalError(value: string) {
  return value
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .at(-1);
}

/**
 * Adapts a plain command runner into a streaming terminal runner. Real PTYs are
 * only used for the default process runner; injected runners (tests, custom
 * transports) replay their buffered output once instead of streaming live.
 */
export function terminalRunnerFromCommandRunner(runCommand: CommandRunner): TerminalCommandRunner {
  if (runCommand === defaultCommandRunner) return defaultTerminalCommandRunner;
  return async (command, args, options = {}) => {
    const result = await runCommand(command, args, { timeoutMs: options.timeoutMs, signal: options.signal });
    if (result.stdout) options.onData?.(result.stdout);
    if (result.stderr) options.onData?.(result.stderr);
    return result;
  };
}
