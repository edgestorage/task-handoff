import { spawn } from "node:child_process";

export type CommandResult = {
  stdout: string;
  stderr: string;
};

export type CommandRunner = (command: string, args: string[]) => Promise<CommandResult>;

export function defaultCommandRunner(command: string, args: string[]): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
    child.on("error", reject);
    child.on("close", (code) => {
      const result = {
        stdout: Buffer.concat(stdout).toString("utf8").trim(),
        stderr: Buffer.concat(stderr).toString("utf8").trim(),
      };
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
