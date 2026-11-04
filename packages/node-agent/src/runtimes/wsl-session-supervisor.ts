import { WSL_UNIT_NAME } from "./wsl-lifecycle.ts";
import { WSL_IDLE_RECLAIM_WINDOW_MS, type WslSessionHandle } from "./wsl-executor.ts";

/**
 * WSL 保活会话监督（openspec change add-wsl-runtime，Phase 8.6/8.7，D13）。
 *
 * distro 生命周期由「是否存在活跃 `wsl.exe` 会话」决定，与 distro 内进程无关；空闲回收窗口实测
 * 仅约 10–15 秒。因此 desired lifecycle 为 running 的实例 MUST 持有常驻 `wsl.exe` 会话；会话
 * 一旦丢失，distro 会在空闲窗口内被回收、实例进程被重启。监督者负责重建会话、唤醒 distro、等待
 * 单元与端点健康，并把「会话丢失/被回收」与「实例自身崩溃」区分开。
 */

export const WSL_SESSION_LOST = "WSL_SESSION_LOST";
export const WSL_SESSION_RECOVERED = "WSL_SESSION_RECOVERED";
export const WSL_SESSION_RECOVERY_FAILED = "WSL_SESSION_RECOVERY_FAILED";

export type WslSessionDiagnostic = {
  code: typeof WSL_SESSION_LOST | typeof WSL_SESSION_RECOVERED | typeof WSL_SESSION_RECOVERY_FAILED;
  instanceId: string;
  distroName: string;
  /** `session-lost`（distro 被空闲回收）与 `instance-crash`（distro 仍在但单元不活跃）区分。 */
  classification: "session-lost" | "instance-crash" | "recovered";
  message: string;
  error?: string;
};

export type WslSessionSupervisorOptions = {
  /** 当前 desired lifecycle 为 running 的实例。 */
  listRunningInstances(): Array<{ id: string; distroName: string }>;
  holdSession(distroName: string): Promise<WslSessionHandle>;
  sessionAlive(distroName: string): boolean;
  releaseSession(distroName: string): Promise<void>;
  distroState(distroName: string): Promise<"running" | "stopped" | "absent" | "unknown">;
  ensureDistroRunning(distroName: string): Promise<void>;
  unitActive(distroName: string): Promise<string>;
  /** 会话重建后等待端点健康的钩子（由 app 层注入 probe）。 */
  waitForEndpointHealthy?(instanceId: string): Promise<boolean>;
  onDiagnostic(event: WslSessionDiagnostic): void;
  /** 会话被判定丢失、准备重建前触发（可用于状态机/事件同步）。 */
  onSessionLost?(instanceId: string, distroName: string): void | Promise<void>;
  intervalMs?: number;
  /** 冷启动预算：实测带 systemd 的冷启动 3.6–4.1 秒，默认预算 60 秒覆盖冷启动 + 单元 + 端点。 */
  recoveryBudgetMs?: number;
  nowMs?: () => number;
  delay?: (milliseconds: number) => Promise<void>;
};

export class WslSessionSupervisor {
  private readonly options: WslSessionSupervisorOptions;
  private readonly recovering = new Map<string, Promise<void>>();
  private timer?: ReturnType<typeof setTimeout>;
  private active?: Promise<unknown>;
  private started = false;
  private stopped = false;

  constructor(options: WslSessionSupervisorOptions) {
    this.options = options;
  }

  start() {
    if (this.started || this.stopped) return;
    this.started = true;
    this.schedule(0);
  }

  /** desired lifecycle 变化时主动触发一次监督。 */
  notify() {
    if (!this.started || this.stopped) return;
    this.schedule(0);
  }

  async stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    await this.active;
  }

  private schedule(delayMs: number) {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.runCycle();
    }, delayMs);
    this.timer.unref?.();
  }

  private runCycle() {
    const cycle = this.checkOnce()
      .catch((error) => this.options.onDiagnostic({
        code: WSL_SESSION_RECOVERY_FAILED,
        instanceId: "node",
        distroName: "node",
        classification: "recovered",
        message: "WSL session supervision cycle failed.",
        error: error instanceof Error ? error.message : String(error),
      }))
      .finally(() => {
        if (this.active === cycle) this.active = undefined;
        this.schedule(this.options.intervalMs ?? Math.max(1_000, Math.floor(WSL_IDLE_RECLAIM_WINDOW_MS / 3)));
      });
    this.active = cycle;
  }

  /** 单轮检查：对每个运行中的实例确保保活会话存在，丢失时重建。返回本轮重建的实例数。 */
  async checkOnce() {
    let recovered = 0;
    for (const instance of this.options.listRunningInstances()) {
      const { id, distroName } = instance;
      if (this.options.sessionAlive(distroName)) continue;
      await this.recover(instance);
      recovered += 1;
    }
    return recovered;
  }

  private recover(instance: { id: string; distroName: string }) {
    const existing = this.recovering.get(instance.id);
    if (existing) return existing;
    const task = this.recoverInstance(instance).finally(() => this.recovering.delete(instance.id));
    this.recovering.set(instance.id, task);
    return task;
  }

  private async recoverInstance(instance: { id: string; distroName: string }) {
    const { id, distroName } = instance;
    const budgetMs = this.options.recoveryBudgetMs ?? 60_000;
    const nowMs = this.options.nowMs ?? (() => Date.now());
    const delay = this.options.delay ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
    const deadline = nowMs() + budgetMs;
    let lastState = await this.options.distroState(distroName).catch(() => "unknown" as const);
    const classification = lastState === "running" ? "instance-crash" as const : "session-lost" as const;
    this.options.onDiagnostic({
      code: WSL_SESSION_LOST,
      instanceId: id,
      distroName,
      classification,
      message: classification === "session-lost"
        ? `WSL keep-alive session for ${distroName} was lost and the distro may have been reclaimed; rebuilding.`
        : `WSL distro ${distroName} is running but its keep-alive session was lost; rebuilding without treating it as an instance crash.`,
    });
    await this.options.onSessionLost?.(id, distroName);
    try {
      // 1) 唤醒 distro（被回收时为冷启动，实测 3.6–4.1 秒）。
      if (lastState !== "running") {
        await this.options.ensureDistroRunning(distroName);
        lastState = "running";
      }
      // 2) 重建常驻会话。
      await this.options.holdSession(distroName);
      // 3) 等待单元与端点健康。
      while (nowMs() < deadline) {
        const active = await this.options.unitActive(distroName).catch(() => "unknown");
        if (active === "active") {
          const healthy = this.options.waitForEndpointHealthy ? await this.options.waitForEndpointHealthy(id).catch(() => false) : true;
          if (healthy) {
            this.options.onDiagnostic({
              code: WSL_SESSION_RECOVERED,
              instanceId: id,
              distroName,
              classification: "recovered",
              message: `WSL keep-alive session for ${distroName} was rebuilt and the instance is healthy.`,
            });
            return;
          }
        }
        await delay(500);
      }
      throw new Error(`WSL distro ${distroName} did not reach unit ${WSL_UNIT_NAME} active with a healthy endpoint within ${budgetMs}ms.`);
    } catch (error) {
      this.options.onDiagnostic({
        code: WSL_SESSION_RECOVERY_FAILED,
        instanceId: id,
        distroName,
        classification,
        message: `WSL keep-alive session for ${distroName} could not be rebuilt.`,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** 实例停止/删除后释放会话，让 distro 在空闲窗口内自然回收。 */
  async releaseFor(instanceId: string, distroName: string) {
    this.recovering.delete(instanceId);
    await this.options.releaseSession(distroName).catch(() => undefined);
  }
}
