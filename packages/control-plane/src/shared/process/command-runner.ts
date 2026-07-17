import { spawn } from "node:child_process";

export type CommandResult = {
  stdout: string;
  stderr: string;
};

export type CommandRunOptions = {
  timeoutMs?: number;
};

export type CommandRunner = (command: string, args: string[], options?: CommandRunOptions) => Promise<CommandResult>;

export function defaultCommandRunner(command: string, args: string[], options: CommandRunOptions = {}): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let timedOut = false;
    const timer = options.timeoutMs ? setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, options.timeoutMs) : undefined;
    timer?.unref?.();
    child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
    child.on("error", (error) => {
      if (timer) clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      const result = {
        stdout: Buffer.concat(stdout).toString("utf8").trim(),
        stderr: Buffer.concat(stderr).toString("utf8").trim(),
      };
      if (timedOut) {
        const error = new Error(`${command} timed out after ${options.timeoutMs}ms`);
        Object.assign(error, { statusCode: 504, code: "RUNTIME_COMMAND_TIMEOUT", details: result });
        reject(error);
        return;
      }
      if (code === 0) {
        resolve(result);
        return;
      }
      const error = new Error(result.stderr || `${command} exited with code ${code}`);
      Object.assign(error, { statusCode: 502, code: "RUNTIME_EXECUTOR_FAILED", details: result });
      reject(error);
    });
  });
}
