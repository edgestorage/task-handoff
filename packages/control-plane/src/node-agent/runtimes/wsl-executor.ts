import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import type { RuntimeLiveness } from "./contracts.ts";

/**
 * WSL2 runtime primitives for the Windows node agent (openspec change add-wsl-runtime).
 *
 * 实测约束（DESKTOP-LT4T521 / WSL 3.0.1.0，见该 change 的 tasks.md 第 1 节）：
 * - Node Agent 继承的 PATH 可能缺少 `%SystemRoot%\System32`，裸 `wsl.exe` 会 `CommandNotFoundException`，
 *   因此 MUST 用绝对路径调用（本模块的 `defaultWslExecutablePath`）。
 * - `wsl.exe` 管理类命令（`--list --verbose`、`--import`、`--terminate`、`--unregister`）的输出是 UTF-16LE，
 *   而 distro 内命令的输出是 UTF-8；解码 MUST 自适应，否则中文/状态列会乱码。
 * - distro 生命周期由「是否存在活跃 `wsl.exe` 会话」决定，与 distro 内是否有进程无关：空闲窗口仅约
 *   10–15 秒，常驻 systemd 单元与周期性调用都不足以保活。保活 MUST 由常驻会话（`holdSession`）完成，
 *   管理类命令（`--list --verbose` 等）既不算活跃会话也不反映真实运行状态。
 */

export const WSL_DISTRO_PREFIX = "th-wsl-";
/** containerName 上限是 240；distro 名上限 128 更严格，且必须留出前缀与单射后缀。 */
export const WSL_DISTRO_NAME_MAX_LENGTH = 128;
/** 实测空闲回收窗口约 10–15 秒（D13）：任何会话重建/唤醒逻辑都必须远小于该预算。 */
export const WSL_IDLE_RECLAIM_WINDOW_MS = 15_000;
/** 会话保持命令：distro 内长驻进程，使 `wsl.exe` 会话保持 attached（D13）。 */
export const WSL_DEFAULT_SESSION_COMMAND = ["sh", "-c", "while true; do sleep 30; done"] as const;

export const WSL_COMMAND_FAILED = "WSL_COMMAND_FAILED";
export const WSL_RUNTIME_UNSUPPORTED_PLATFORM = "WSL_RUNTIME_UNSUPPORTED_PLATFORM";
export const WSL_DISTRO_MISSING = "WSL_DISTRO_MISSING";
export const WSL_INSTANCE_ID_INVALID = "WSL_INSTANCE_ID_INVALID";
export const WSL_SESSION_FAILED = "WSL_SESSION_FAILED";

function wslError(code: string, message: string, details?: Record<string, unknown>) {
  return Object.assign(new Error(message), { code, ...(details ? { details } : {}) });
}

/** POSIX 单引号转义：把任意字符串安全嵌入 `sh -c` 脚本。 */
export function shellQuote(value: string) {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function normalizeForDistroName(instanceId: string) {
  return instanceId
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * 由 instanceId 单射派生 distro 名（4.7）：
 * 固定前缀 + 归一化 instanceId + instanceId 的短摘要。摘要保证「非法/超长/归一化后相同」的
 * instanceId 不会碰撞，字符集只有 `[a-z0-9-]`，长度不超过 128，也不会以 `.` 开头。
 */
export function wslDistroNameForInstance(instanceId: string) {
  const trimmed = instanceId.trim();
  if (!trimmed) throw wslError(WSL_INSTANCE_ID_INVALID, "Instance id is required to derive a WSL distro name.");
  const digest = crypto.createHash("sha256").update(trimmed).digest("hex").slice(0, 8);
  const suffix = `-${digest}`;
  const head = normalizeForDistroName(trimmed)
    .slice(0, WSL_DISTRO_NAME_MAX_LENGTH - WSL_DISTRO_PREFIX.length - suffix.length);
  return `${WSL_DISTRO_PREFIX}${head ? `${head}${suffix}` : digest}`;
}

export function defaultWslExecutablePath(env: NodeJS.ProcessEnv = process.env) {
  const systemRoot = env.SystemRoot?.trim() || env.windir?.trim() || "C:\\Windows";
  return path.win32.join(systemRoot, "System32", "wsl.exe");
}

/** `wsl.exe` 管理类输出是 UTF-16LE，distro 内命令输出是 UTF-8，因此按字节特征自适应解码。 */
export function decodeWslOutput(buffer: Buffer): string {
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return buffer.subarray(2).toString("utf16le");
  }
  const sample = buffer.subarray(0, Math.min(buffer.length, 1024));
  let nulAtOdd = 0;
  let nulAtEven = 0;
  for (let index = 0; index < sample.length; index += 1) {
    if (sample[index] !== 0) continue;
    if (index % 2 === 1) nulAtOdd += 1;
    else nulAtEven += 1;
  }
  if (nulAtOdd === 0 && nulAtEven === 0) return buffer.toString("utf8");
  return nulAtOdd > nulAtEven ? buffer.toString("utf16le") : buffer.toString("utf8");
}

export type WslDecodeHint = "auto" | "utf16le" | "utf8";

export type WslCommandOptions = {
  timeoutMs?: number;
  signal?: AbortSignal;
  decode?: WslDecodeHint;
  /**
   * 由 Node Agent 侧文件喂给 distro 内命令的 stdin（例如把 tar.gz 与 bootstrap 资源
   * 桥接进 distro）。这样 WSL runtime 不依赖宿主盘符在 distro 内的 drvfs 自动挂载。
   */
  stdinFile?: string;
};

export type WslCommandResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
};

export type WslCommandRunner = (args: string[], options?: WslCommandOptions) => Promise<WslCommandResult>;

function decodeWithHint(buffer: Buffer, decode: WslDecodeHint) {
  if (decode === "utf8") return buffer.toString("utf8");
  if (decode === "utf16le") {
    const body = buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe ? buffer.subarray(2) : buffer;
    return body.toString("utf16le");
  }
  return decodeWslOutput(buffer);
}

/** 默认 runner：绝对路径 + 无 shell 调用 + 超时终止，失败以 exitCode 返回而不是抛错，便于上层映射结构化诊断。 */
export function defaultWslCommandRunner(wslPath: string, spawnImpl: typeof spawn = spawn): WslCommandRunner {
  return (args, options = {}) => new Promise<WslCommandResult>((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(wslError(WSL_COMMAND_FAILED, `${wslPath} ${args.join(" ")} was aborted.`));
      return;
    }
    const child = spawnImpl(wslPath, args, { stdio: [options.stdinFile ? "pipe" : "ignore", "pipe", "pipe"], windowsHide: true });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let timedOut = false;
    let aborted = false;
    const timeoutMs = options.timeoutMs ?? 30_000;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    const onAbort = () => {
      aborted = true;
      child.kill("SIGKILL");
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });
    const cleanup = () => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
    };
    timer.unref?.();
    child.stdout?.on("data", (chunk: Buffer) => stdout.push(Buffer.from(chunk)));
    child.stderr?.on("data", (chunk: Buffer) => stderr.push(Buffer.from(chunk)));
    if (options.stdinFile && child.stdin) {
      const source = fs.createReadStream(options.stdinFile);
      source.on("error", (error) => {
        child.stdin?.destroy();
        cleanup();
        reject(wslError(WSL_COMMAND_FAILED, `${wslPath} could not read stdin file ${options.stdinFile}: ${error.message}`, { args }));
      });
      source.pipe(child.stdin);
    }
    child.on("error", (error) => {
      cleanup();
      reject(wslError(WSL_COMMAND_FAILED, `${wslPath} could not be started: ${error.message}`, { args }));
    });
    child.on("close", (code) => {
      cleanup();
      const result = {
        stdout: decodeWithHint(Buffer.concat(stdout), options.decode ?? "auto").trim(),
        stderr: decodeWithHint(Buffer.concat(stderr), options.decode ?? "auto").trim(),
        exitCode: code ?? -1,
      };
      if (timedOut) {
        reject(wslError(WSL_COMMAND_FAILED, `${wslPath} ${args.join(" ")} timed out after ${timeoutMs}ms`, { ...result, args, timeoutMs }));
        return;
      }
      if (aborted) {
        reject(wslError(WSL_COMMAND_FAILED, `${wslPath} ${args.join(" ")} was aborted.`, { ...result, args }));
        return;
      }
      resolve(result);
    });
  });
}

export type WslSessionHandle = {
  readonly name: string;
  readonly pid?: number;
  alive(): boolean;
  stop(): Promise<void>;
};

export type WslSessionSpawner = (args: string[], name: string) => WslSessionHandle;

/** 默认会话保持器：以 detached 方式启动 `wsl.exe` 并让它在 distro 内跑长驻命令（D13）。 */
export function defaultWslSessionSpawner(wslPath: string, spawnImpl: typeof spawn = spawn): WslSessionSpawner {
  return (args, name) => {
    const child = spawnImpl(wslPath, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let stopped = false;
    child.stdout?.on("data", () => undefined);
    child.stderr?.on("data", () => undefined);
    child.on("error", () => {
      stopped = true;
    });
    child.unref?.();
    return {
      name,
      pid: child.pid,
      alive: () => !stopped && child.exitCode === null && !child.killed,
      stop: () => new Promise<void>((resolve) => {
        stopped = true;
        if (child.exitCode !== null) {
          resolve();
          return;
        }
        const done = () => resolve();
        child.once("close", done);
        child.kill();
        const fallback = setTimeout(done, 5_000);
        fallback.unref?.();
      }),
    };
  };
}

export type WslDistro = {
  name: string;
  state: "Running" | "Stopped" | "Installing" | "Uninstalling" | "Unknown";
  version: number;
  isDefault: boolean;
};

export function parseWslDistroList(stdout: string): WslDistro[] {
  const distros: WslDistro[] = [];
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.replace(/\0/g, "").trimEnd();
    if (!line.trim()) continue;
    const match = /^(\*?)\s*(.+?)\s+(Running|Stopped|Installing|Uninstalling)\s+(\d+)\s*$/i.exec(line);
    if (!match) continue;
    distros.push({
      isDefault: match[1] === "*",
      name: match[2].trim(),
      state: `${match[3][0].toUpperCase()}${match[3].slice(1).toLowerCase()}` as WslDistro["state"],
      version: Number(match[4]),
    });
  }
  return distros;
}

export type WslExecutorOptions = {
  wslPath?: string;
  runner?: WslCommandRunner;
  sessionSpawner?: WslSessionSpawner;
  platform?: string;
  commandTimeoutMs?: number;
  sessionCommand?: readonly string[];
};

export class WslExecutor {
  private readonly wslPath: string;
  private readonly runner: WslCommandRunner;
  private readonly spawnSession: WslSessionSpawner;
  private readonly platform: string;
  private readonly commandTimeoutMs: number;
  private readonly sessionCommand: readonly string[];
  private readonly sessions = new Map<string, WslSessionHandle>();

  constructor(options: WslExecutorOptions = {}) {
    this.wslPath = options.wslPath ?? defaultWslExecutablePath();
    this.runner = options.runner ?? defaultWslCommandRunner(this.wslPath);
    this.spawnSession = options.sessionSpawner ?? defaultWslSessionSpawner(this.wslPath);
    this.platform = options.platform ?? process.platform;
    this.commandTimeoutMs = options.commandTimeoutMs ?? 30_000;
    this.sessionCommand = options.sessionCommand ?? WSL_DEFAULT_SESSION_COMMAND;
  }

  get executablePath() {
    return this.wslPath;
  }

  private async run(args: string[], options: WslCommandOptions = {}) {
    if (this.platform !== "win32") {
      throw wslError(WSL_RUNTIME_UNSUPPORTED_PLATFORM, "The WSL runtime is available only on Windows nodes.", { platform: this.platform, args });
    }
    return this.runner(args, { timeoutMs: this.commandTimeoutMs, ...options });
  }

  /** 管理类调用：非零退出码映射为结构化 `WSL_COMMAND_FAILED`（包含原始 stdout/stderr 供诊断）。 */
  private async runOrThrow(args: string[], options: WslCommandOptions = {}, message?: string) {
    const result = await this.run(args, options);
    if (result.exitCode !== 0) {
      throw wslError(WSL_COMMAND_FAILED, message ?? `wsl.exe ${args.join(" ")} failed with exit code ${result.exitCode}.`, {
        args,
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
      });
    }
    return result;
  }

  async version() {
    const result = await this.runOrThrow(["--version"]);
    return result.stdout;
  }

  async available() {
    try {
      await this.version();
      return true;
    } catch {
      return false;
    }
  }

  async listDistros() {
    // 管理类输出：UTF-16LE，且与 distro 状态无关（不会唤醒 distro，也不使其保持运行）。
    const result = await this.runOrThrow(["--list", "--verbose"], { decode: "auto" });
    return parseWslDistroList(result.stdout);
  }

  async findDistro(name: string) {
    const distros = await this.listDistros();
    return distros.find((distro) => distro.name === name);
  }

  async distroState(name: string): Promise<RuntimeLiveness> {
    const distro = await this.findDistro(name);
    if (!distro) return "absent";
    if (distro.state === "Running") return "running";
    if (distro.state === "Stopped") return "stopped";
    return "unknown";
  }

  async importDistro(input: { name: string; installDir: string; tarballPath: string; version?: number }) {
    await this.runOrThrow([
      "--import",
      input.name,
      input.installDir,
      input.tarballPath,
      "--version",
      String(input.version ?? 2),
    ]);
    return this.findDistro(input.name);
  }

  async terminate(name: string) {
    await this.runOrThrow(["--terminate", name]);
  }

  async unregister(name: string) {
    await this.runOrThrow(["--unregister", name]);
  }

  /** distro 内命令：输出是 UTF-8，且会隐式唤醒 distro（因此也算一次活跃会话）。 */
  async exec(name: string, argv: readonly string[], options: WslCommandOptions = {}) {
    if (!argv.length) {
      throw wslError(WSL_COMMAND_FAILED, "A command is required to exec inside a WSL distro.", { name });
    }
    return this.run(["-d", name, "-u", "root", "--", ...argv], { decode: "utf8", ...options });
  }

  async execOrThrow(name: string, argv: readonly string[], options: WslCommandOptions = {}) {
    const result = await this.exec(name, argv, options);
    if (result.exitCode !== 0) {
      throw wslError(WSL_COMMAND_FAILED, `wsl.exe -d ${name} -- ${argv.join(" ")} failed with exit code ${result.exitCode}.`, {
        args: ["-d", name, "-u", "root", "--", ...argv],
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
      });
    }
    return result;
  }

  /**
   * 流式执行 distro 内命令（Git 供给进度事件用）。stdout/stderr 以 UTF-8 增量回调，
   * 返回值仍是聚合后的结果，便于阶段解析。
   */
  async execStream(
    name: string,
    argv: readonly string[],
    options: WslCommandOptions & { onData?: (chunk: string) => void } = {},
  ): Promise<WslCommandResult> {
    if (this.platform !== "win32") {
      throw wslError(WSL_RUNTIME_UNSUPPORTED_PLATFORM, "The WSL runtime is available only on Windows nodes.", { platform: this.platform, args: argv });
    }
    if (!argv.length) throw wslError(WSL_COMMAND_FAILED, "A command is required to exec inside a WSL distro.", { name });
    const args = ["-d", name, "-u", "root", "--", ...argv];
    const child = spawn(this.wslPath, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const timeoutMs = options.timeoutMs ?? this.commandTimeoutMs;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    timer.unref?.();
    const onAbort = () => child.kill("SIGKILL");
    options.signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout.push(Buffer.from(chunk));
      options.onData?.(chunk.toString("utf8"));
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr.push(Buffer.from(chunk));
      options.onData?.(chunk.toString("utf8"));
    });
    const exitCode = await new Promise<number>((resolve, reject) => {
      child.on("error", (error) => reject(wslError(WSL_COMMAND_FAILED, `${this.wslPath} could not be started: ${error.message}`, { args })));
      child.on("close", (code) => resolve(code ?? -1));
    }).finally(() => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
    });
    const result = {
      stdout: Buffer.concat(stdout).toString("utf8").trim(),
      stderr: Buffer.concat(stderr).toString("utf8").trim(),
      exitCode,
    };
    if (timedOut) throw wslError(WSL_COMMAND_FAILED, `${this.wslPath} ${args.join(" ")} timed out after ${timeoutMs}ms`, { ...result, args, timeoutMs });
    return result;
  }

  async systemctl(name: string, args: readonly string[]) {
    return this.execOrThrow(name, ["systemctl", ...args]);
  }

  /** Windows 宿主路径 → drvfs 路径（`C:\a\b` → `/mnt/c/a/b`）。仅用于诊断展示。 */
  static windowsPathToDrvfs(value: string) {
    const match = /^([a-zA-Z]):[\\/](.*)$/.exec(value.trim());
    if (!match) return undefined;
    return `/mnt/${match[1].toLowerCase()}/${match[2].replace(/\\/g, "/")}`;
  }

  /**
   * 把 Node Agent 侧文件桥接进 distro（不走 drvfs，直接以 stdin 流写入）。
   * 用于 private config、bootstrap 资源与 runtime artifact，避免依赖宿主盘符自动挂载。
   */
  async copyIntoDistro(name: string, sourcePath: string, destinationPath: string, options: WslCommandOptions = {}) {
    const directory = path.posix.dirname(destinationPath);
    await this.execOrThrow(
      name,
      ["sh", "-c", `mkdir -p ${shellQuote(directory)} && cat > ${shellQuote(destinationPath)}`],
      { ...options, stdinFile: sourcePath },
    );
  }

  /** distro 内默认网关地址（WSL2 NAT 下即 Windows 宿主），用于实例回连 Node Agent。 */
  async defaultGateway(name: string) {
    const result = await this.exec(name, ["sh", "-c", "ip -o -4 route show default 2>/dev/null | awk '{print $3; exit}'"]);
    const gateway = result.stdout.trim().split(/\s+/)[0];
    return gateway || undefined;
  }

  async unitActive(name: string, unit: string) {
    const result = await this.exec(name, ["systemctl", "is-active", unit]);
    return result.stdout.split(/\s+/)[0] || "unknown";
  }

  /**
   * 唤醒 distro 并等待其进入 Running。空闲窗口只有约 10–15 秒（见 D13），因此调用方 MUST 用常驻
   * 会话保活；这里只负责「唤醒 + 等就绪」，不作为保活手段。
   */
  async ensureDistroRunning(name: string, options: { timeoutMs?: number; intervalMs?: number } = {}) {
    const deadline = Date.now() + (options.timeoutMs ?? 60_000);
    const state = await this.distroState(name);
    if (state === "absent") {
      throw wslError(WSL_DISTRO_MISSING, `WSL distro ${name} does not exist on this node.`, { name });
    }
    if (state === "running") return "running" as const;
    await this.exec(name, ["true"]);
    const intervalMs = options.intervalMs ?? 500;
    while (Date.now() < deadline) {
      if (await this.distroState(name) === "running") return "running" as const;
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
    throw wslError(WSL_COMMAND_FAILED, `WSL distro ${name} did not reach Running within the timeout.`, { name });
  }

  sessionAlive(name: string) {
    const session = this.sessions.get(name);
    if (!session) return false;
    if (session.alive()) return true;
    this.sessions.delete(name);
    return false;
  }

  /**
   * 为实例持有常驻会话（D13）。同一个 distro 只会有一个会话；已存活时直接返回，避免重复会话。
   */
  async holdSession(name: string) {
    if (this.sessionAlive(name)) return this.sessions.get(name)!;
    const session = this.spawnSession(["-d", name, "-u", "root", "--", ...this.sessionCommand], name);
    this.sessions.set(name, session);
    try {
      await this.ensureDistroRunning(name);
    } catch (error) {
      await this.releaseSession(name).catch(() => undefined);
      throw wslError(WSL_SESSION_FAILED, `Could not hold a keep-alive session for WSL distro ${name}.`, {
        name,
        cause: error instanceof Error ? error.message : String(error),
      });
    }
    return session;
  }

  async releaseSession(name: string) {
    const session = this.sessions.get(name);
    this.sessions.delete(name);
    if (!session) return;
    await session.stop();
  }

  async releaseAllSessions() {
    const names = [...this.sessions.keys()];
    await Promise.all(names.map((name) => this.releaseSession(name).catch(() => undefined)));
  }
}
