import { spawn as spawnPty } from "node-pty";
import type { CommandResult } from "./command-runner.ts";

export type TerminalCommandRunOptions = {
  cols?: number;
  rows?: number;
  timeoutMs?: number;
  onData?: (data: string) => void;
};

export type TerminalCommandRunner = (command: string, args: string[], options?: TerminalCommandRunOptions) => Promise<CommandResult>;

export const defaultTerminalCommandRunner: TerminalCommandRunner = (command, args, options = {}) => new Promise((resolve, reject) => {
  const output: string[] = [];
  let timedOut = false;
  let terminal: ReturnType<typeof spawnPty>;
  try {
    terminal = spawnPty(command, args, {
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
  timer?.unref?.();
  terminal.onData((data) => {
    output.push(data);
    options.onData?.(data);
  });
  terminal.onExit(({ exitCode }) => {
    if (timer) clearTimeout(timer);
    const result = { stdout: output.join(""), stderr: "" };
    if (timedOut) {
      reject(Object.assign(new Error(`${command} timed out after ${options.timeoutMs}ms`), {
        statusCode: 504,
        code: "RUNTIME_COMMAND_TIMEOUT",
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
