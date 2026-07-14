import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const SECRET_PATTERN = /(TOKEN|KEY|SECRET|AUTH|PASSWORD|COOKIE)/i;
const RELEVANT_ENV_PATTERN = /^(TASK_HANDOFF|CODEX|CLAUDE|PWD$|OLDPWD$|SHELL$|TERM$)/;

function redactValue(key: string, value: string | undefined) {
  if (value === undefined) {
    return undefined;
  }
  if (SECRET_PATTERN.test(key)) {
    return "[redacted]";
  }
  return value;
}

export function relevantEnv(env = process.env) {
  return Object.fromEntries(
    Object.entries(env)
      .filter(([key]) => RELEVANT_ENV_PATTERN.test(key))
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => [key, redactValue(key, value)]),
  );
}

export function processSnapshot() {
  return {
    pid: process.pid,
    ppid: process.ppid,
    cwd: process.cwd(),
    argv: process.argv,
    parent: parentProcess(process.ppid),
    env: relevantEnv(),
  };
}

export function parentProcess(pid: number) {
  if (!pid) {
    return undefined;
  }
  try {
    const output = execFileSync("ps", ["-p", String(pid), "-o", "pid=,ppid=,comm=,args="], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 1000,
    }).trim();
    return output || undefined;
  } catch {
    return undefined;
  }
}

export function appendJsonl(logPath: string, entry: Record<string, unknown>) {
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.appendFileSync(logPath, `${JSON.stringify({ time: new Date().toISOString(), ...entry })}\n`, { mode: 0o600 });
}

export function defaultDiagnosticLogPath(configPath: string, filename: string) {
  if (process.env.CODEX_SANDBOX) {
    return path.join(process.cwd(), ".task-handoff", filename);
  }
  return path.join(path.dirname(configPath), filename);
}
