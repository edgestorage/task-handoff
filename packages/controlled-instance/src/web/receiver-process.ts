import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";

export type ReceiverProcessStatus = {
  running: boolean;
  pid?: number;
  startedAt?: string;
  exitedAt?: string;
  exitCode?: number | null;
  signal?: string | null;
};

export class ReceiverProcessManager extends EventEmitter {
  private child?: ChildProcess;
  private statusValue: ReceiverProcessStatus = { running: false };
  private readonly logPath?: string;
  private exitPromise?: Promise<ReceiverProcessStatus>;

  constructor(private readonly socketPath: string, logDir?: string) {
    super();
    this.logPath = logDir ? path.join(logDir, "receiver.log") : undefined;
  }

  status() {
    return { ...this.statusValue };
  }

  start() {
    if (this.child && !this.child.killed && this.statusValue.running) {
      return this.status();
    }

    const cliPath = process.env.TASK_HANDOFF_CLI_PATH || path.resolve(__dirname, "cli.js");
    this.child = spawn(process.execPath, [cliPath, "receiver", "--headless", "--socket", this.socketPath], {
      env: { ...process.env, TASK_HANDOFF_RECEIVER_HEADLESS: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.statusValue = {
      running: true,
      pid: this.child.pid,
      startedAt: new Date().toISOString(),
      exitedAt: undefined,
      exitCode: undefined,
      signal: undefined,
    };

    this.appendLog(`\n[${this.statusValue.startedAt}] receiver started pid=${this.child.pid}\n`);
    this.child.stdout?.on("data", (chunk) => this.handleLog(chunk));
    this.child.stderr?.on("data", (chunk) => this.handleLog(chunk));
    let resolveExit: ((status: ReceiverProcessStatus) => void) | undefined;
    this.exitPromise = new Promise((resolve) => {
      resolveExit = resolve;
    });
    this.child.on("exit", (exitCode, signal) => {
      const exitedAt = new Date().toISOString();
      this.statusValue = {
        ...this.statusValue,
        running: false,
        exitedAt,
        exitCode,
        signal,
      };
      this.appendLog(`[${exitedAt}] receiver exited code=${exitCode ?? "null"} signal=${signal ?? "null"}\n`);
      this.emit("exit", this.status());
      this.child = undefined;
      resolveExit?.(this.status());
    });
    this.emit("start", this.status());
    return this.status();
  }

  stop() {
    if (!this.child || !this.statusValue.running) {
      return this.status();
    }
    this.child.kill("SIGTERM");
    return this.status();
  }

  async stopAndWait(timeoutMs = 2000) {
    const child = this.child;
    if (!child || !this.statusValue.running) {
      return this.status();
    }
    const exitPromise = this.exitPromise;
    this.stop();
    if (!exitPromise) {
      return this.status();
    }
    return await Promise.race([
      exitPromise,
      new Promise<ReceiverProcessStatus>((resolve) => {
        setTimeout(() => resolve(this.status()), timeoutMs);
      }),
    ]);
  }

  readLogs(maxBytes = 64 * 1024) {
    const logPath = this.logPath;
    if (!logPath || !fs.existsSync(logPath)) {
      return { logPath, maxBytes, size: 0, truncated: false, content: "" };
    }
    const stat = fs.statSync(logPath);
    const start = Math.max(0, stat.size - maxBytes);
    const fd = fs.openSync(logPath, "r");
    try {
      const buffer = Buffer.alloc(stat.size - start);
      fs.readSync(fd, buffer, 0, buffer.length, start);
      return {
        logPath,
        maxBytes,
        size: stat.size,
        updatedAt: stat.mtime.toISOString(),
        truncated: start > 0,
        content: buffer.toString("utf8"),
      };
    } finally {
      fs.closeSync(fd);
    }
  }

  private handleLog(chunk: Buffer | string) {
    const message = String(chunk);
    this.appendLog(message);
    this.emit("log", message);
  }

  private appendLog(message: string) {
    if (!this.logPath) {
      return;
    }
    fs.mkdirSync(path.dirname(this.logPath), { recursive: true });
    fs.appendFileSync(this.logPath, message);
  }
}
