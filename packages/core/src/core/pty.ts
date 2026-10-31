import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import type { IPty } from "node-pty";
import { isBunRuntime } from "./javascript-runtime.ts";

export type PtyExitEvent = {
  exitCode: number;
  signal?: string | number;
};

export type PtyDisposable = {
  dispose(): void;
};

export type PtyProcess = {
  readonly pid: number;
  readonly runtime: "node" | "bun";
  /** Whether killing `-pid` reaches this process and its descendants. */
  readonly processGroupLeader: boolean;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
  onData(listener: (data: string) => void): PtyDisposable;
  onExit(listener: (event: PtyExitEvent) => void): PtyDisposable;
};

export type PtySpawnOptions = {
  name?: string;
  cols?: number;
  rows?: number;
  cwd?: string;
  env?: Record<string, string | undefined>;
};

type BunTerminal = {
  readonly closed: boolean;
  write(data: string): number;
  resize(cols: number, rows: number): void;
  close(): void;
};

type BunSubprocess = {
  readonly pid: number;
  readonly terminal?: BunTerminal;
  readonly exited: Promise<number>;
  readonly exitCode: number | null;
  readonly signalCode: NodeJS.Signals | number | null;
  kill(signal?: NodeJS.Signals | number): void;
};

type BunSpawnOptions = {
  cwd?: string;
  env?: Record<string, string | undefined>;
  terminal: {
    name?: string;
    cols?: number;
    rows?: number;
    data?: (terminal: BunTerminal, data: Uint8Array) => void;
    exit?: (terminal: BunTerminal, exitCode: number, signal: string | null) => void;
  };
};

type BunRuntime = {
  spawn(command: string[], options: BunSpawnOptions): BunSubprocess;
};

function requireBasePath() {
  if (typeof __filename === "string") return __filename;
  return process.argv[1] ? path.resolve(process.argv[1]) : path.join(process.cwd(), "package.json");
}

const requireFromHere = createRequire(requireBasePath());

function bunRuntime(): BunRuntime | undefined {
  if (!isBunRuntime()) return undefined;
  return (globalThis as typeof globalThis & { Bun?: BunRuntime }).Bun;
}

function processGroupLeader(pid: number) {
  if (process.platform === "win32") return false;
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
}

function spawnNodePty(executable: string, args: string[], options: PtySpawnOptions): PtyProcess {
  const { spawn } = requireFromHere("node-pty") as typeof import("node-pty");
  const terminal: IPty = spawn(executable, args, {
    name: options.name || "xterm-256color",
    cols: options.cols || 120,
    rows: options.rows || 40,
    cwd: options.cwd || process.cwd(),
    env: options.env || (process.env as Record<string, string>),
  });
  return {
    pid: terminal.pid,
    runtime: "node",
    processGroupLeader: true,
    write: (data) => terminal.write(data),
    resize: (cols, rows) => terminal.resize(cols, rows),
    kill: (signal) => terminal.kill(signal),
    onData: (listener) => {
      const disposable = terminal.onData(listener);
      return { dispose: () => disposable.dispose() };
    },
    onExit: (listener) => {
      const disposable = terminal.onExit(({ exitCode, signal }) => listener({ exitCode, signal }));
      return { dispose: () => disposable.dispose() };
    },
  };
}

function spawnBunPty(executable: string, args: string[], options: PtySpawnOptions): PtyProcess {
  const Bun = bunRuntime();
  if (!Bun) throw new Error("Bun runtime is not available.");
  const dataListeners = new Set<(data: string) => void>();
  const exitListeners = new Set<(event: PtyExitEvent) => void>();
  const pendingData: string[] = [];
  const decoder = new TextDecoder();
  let exitEvent: PtyExitEvent | undefined;
  const emitExit = (event: PtyExitEvent) => {
    if (exitEvent) return;
    exitEvent = event;
    const tail = decoder.decode();
    if (tail) {
      if (dataListeners.size) for (const listener of dataListeners) listener(tail);
      else pendingData.push(tail);
    }
    for (const listener of exitListeners) listener(event);
    exitListeners.clear();
  };
  const env = {
    ...options.env,
    TERM: options.env?.TERM || options.name || "xterm-256color",
  };
  const terminal = Bun.spawn([executable, ...args], {
    cwd: options.cwd || process.cwd(),
    env,
    terminal: {
      name: options.name || "xterm-256color",
      cols: options.cols || 120,
      rows: options.rows || 40,
      data: (_terminal, data) => {
        if (exitEvent) return;
        const text = decoder.decode(data, { stream: true });
        if (!text) return;
        if (dataListeners.size) for (const listener of dataListeners) listener(text);
        else pendingData.push(text);
      },
    },
  });
  const childTerminal = terminal.terminal;
  if (!childTerminal) throw new Error("Bun did not create a terminal for the spawned process.");
  void terminal.exited.then(
    (exitCode) => emitExit({
      exitCode,
      signal: terminal.signalCode ?? undefined,
    }),
    () => {
      emitExit({ exitCode: 1 });
    },
  );
  return {
    pid: terminal.pid,
    runtime: "bun",
    processGroupLeader: processGroupLeader(terminal.pid),
    write: (data) => {
      childTerminal.write(data);
    },
    resize: (cols, rows) => childTerminal.resize(cols, rows),
    kill: (signal) => {
      terminal.kill(signal as NodeJS.Signals | undefined);
    },
    onData: (listener) => {
      if (pendingData.length) {
        const buffered = pendingData.splice(0).join("");
        listener(buffered);
      }
      dataListeners.add(listener);
      return { dispose: () => dataListeners.delete(listener) };
    },
    onExit: (listener) => {
      if (exitEvent) {
        listener(exitEvent);
        return { dispose: () => {} };
      }
      exitListeners.add(listener);
      return { dispose: () => exitListeners.delete(listener) };
    },
  };
}

export function ensureNodePtySpawnHelperExecutable() {
  if (isBunRuntime() || (process.platform !== "darwin" && process.platform !== "linux")) return;
  try {
    const packageRoot = path.resolve(path.dirname(requireFromHere.resolve("node-pty")), "..");
    const helperPath = path.join(packageRoot, "prebuilds", `${process.platform}-${process.arch}`, "spawn-helper");
    const stat = fs.statSync(helperPath);
    if ((stat.mode & 0o111) === 0) fs.chmodSync(helperPath, stat.mode | 0o755);
  } catch {
    // node-pty surfaces the original launch error if its helper is unavailable.
  }
}

export function spawnPty(executable: string, args: string[], options: PtySpawnOptions = {}): PtyProcess {
  ensureNodePtySpawnHelperExecutable();
  if (isBunRuntime()) return spawnBunPty(executable, args, options);
  return spawnNodePty(executable, args, options);
}
