import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { installedCliVersion } from "./client-info.ts";
import {
  fetchNpmDistTagVersion,
  isNewerSkillVersion,
  isNewerVersion,
  isReleaseChannelVersion,
  registryTagForChannel,
  resolveNpmRegistry,
  updateChannelForVersion,
} from "./release.ts";
import type { CliContext } from "./runtime.ts";
import { SKILL_NAME, fetchSkillRelease, inspectSkillDirectory, resolveSkillTargets, satisfiesSkillRange, skillContentSignature } from "./skill.ts";

export const UPDATE_CHECK_ENV = "TASK_HANDOFF_CLI_UPDATE_CHECK";
export const UPDATE_CHECK_INTERVAL_ENV = "TASK_HANDOFF_CLI_UPDATE_CHECK_INTERVAL";
export const UPDATE_CHECK_CHILD_ARG = "__update-check";
export const UPDATE_STATE_FILE = "update-check.json";

const DEFAULT_INTERVAL_MS = 24 * 60 * 60 * 1000;
const RETRY_INTERVAL_MS = 60 * 60 * 1000;
const NOTICE_INTERVAL_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 4000;

const CliCheckStateSchema = z.object({
  channel: z.string().optional(),
  tag: z.string().optional(),
  registry: z.string().optional(),
  latestVersion: z.string().optional(),
  checkedAt: z.string().optional(),
}).loose();

const SkillCheckStateSchema = z.object({
  indexUrl: z.string().optional(),
  latestVersion: z.string().optional(),
  /** 发布内容指纹；与本地 provenance 的摘要比对即可判断“有没有变”，与版本号样式无关。 */
  contentSignature: z.string().optional(),
  thctl: z.string().optional(),
  checkedAt: z.string().optional(),
}).loose();

const UpdateCheckStateSchema = z.object({
  schemaVersion: z.number().int().positive().default(1),
  lastAttemptAt: z.string().optional(),
  lastAttemptOk: z.boolean().optional(),
  checkedAt: z.string().optional(),
  cli: CliCheckStateSchema.optional(),
  skill: SkillCheckStateSchema.optional(),
  noticeShownAt: z.string().optional(),
  noticeShownKey: z.string().optional(),
}).loose();
export type UpdateCheckState = z.infer<typeof UpdateCheckStateSchema>;

export function updateCheckStatePath(context: CliContext) {
  return path.join(context.store.directory, UPDATE_STATE_FILE);
}

export function loadUpdateCheckState(file: string): UpdateCheckState {
  try {
    const parsed = UpdateCheckStateSchema.safeParse(JSON.parse(fs.readFileSync(file, "utf8")));
    if (parsed.success) return parsed.data;
  } catch {
    // 缺失、损坏或旧格式的状态一律当作没有状态。
  }
  return { schemaVersion: 1 };
}

export function saveUpdateCheckState(file: string, state: UpdateCheckState) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, file);
}

function envFlag(value: string | undefined) {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return undefined;
  if (["0", "false", "off", "no"].includes(normalized)) return false;
  if (["1", "true", "on", "yes"].includes(normalized)) return true;
  return undefined;
}

export function updateCheckDisabled(env: Record<string, string | undefined>, argv: readonly string[] = []) {
  if (argv.includes("--no-update-check")) return true;
  return envFlag(env[UPDATE_CHECK_ENV]) === false;
}

export function updateCheckForced(env: Record<string, string | undefined>) {
  return envFlag(env[UPDATE_CHECK_ENV]) === true;
}

export function updateCheckIntervalMs(env: Record<string, string | undefined>) {
  const raw = env[UPDATE_CHECK_INTERVAL_ENV]?.trim();
  if (!raw) return DEFAULT_INTERVAL_MS;
  const seconds = Number(raw);
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : DEFAULT_INTERVAL_MS;
}

/**
 * 命令启动时按间隔触发一次 detached 后台检查；结果落盘，供下一次命令提示。
 * 检查失败只影响退避窗口，绝不影响当前命令。
 */
export function maybeScheduleUpdateCheck(
  context: CliContext,
  options: {
    argv?: readonly string[];
    now?: number;
    spawnDetached?: (execPath: string, args: string[]) => void;
  } = {},
) {
  const argv = options.argv ?? process.argv;
  if (updateCheckDisabled(context.env, argv)) return;
  const entryPath = process.argv[1];
  if (!entryPath) return;
  const now = options.now ?? Date.now();
  const file = updateCheckStatePath(context);
  const state = loadUpdateCheckState(file);
  const lastAttempt = state.lastAttemptAt ? Date.parse(state.lastAttemptAt) : Number.NaN;
  const throttle = state.lastAttemptOk === false
    ? Math.min(RETRY_INTERVAL_MS, updateCheckIntervalMs(context.env))
    : updateCheckIntervalMs(context.env);
  if (Number.isFinite(lastAttempt) && now - lastAttempt < throttle) return;
  try {
    saveUpdateCheckState(file, { ...state, schemaVersion: 1, lastAttemptAt: new Date(now).toISOString() });
  } catch {
    return;
  }
  try {
    const spawnDetached = options.spawnDetached ?? defaultSpawnDetached;
    spawnDetached(process.execPath, [entryPath, UPDATE_CHECK_CHILD_ARG]);
  } catch {
    // 无法派生后台进程时放弃本次检查。
  }
}

function defaultSpawnDetached(execPath: string, args: string[]) {
  spawn(execPath, args, { detached: true, stdio: "ignore", windowsHide: true }).unref();
}

/** 隐藏子命令：只更新状态文件，不产生任何输出，也不改变退出码。 */
export async function runUpdateCheckChild(context: CliContext) {
  const file = updateCheckStatePath(context);
  const state = loadUpdateCheckState(file);
  const [cliResult, skillResult] = await Promise.allSettled([
    checkCliRelease(context),
    checkSkillRelease(context),
  ]);
  const next: UpdateCheckState = {
    ...state,
    schemaVersion: 1,
    checkedAt: new Date().toISOString(),
    lastAttemptOk: cliResult.status === "fulfilled" || skillResult.status === "fulfilled",
  };
  if (cliResult.status === "fulfilled" && cliResult.value) next.cli = cliResult.value;
  if (skillResult.status === "fulfilled" && skillResult.value) next.skill = skillResult.value;
  try {
    saveUpdateCheckState(file, next);
  } catch {
    // 状态写入失败只丢一次提示机会。
  }
}

async function checkCliRelease(context: CliContext) {
  const cliVersion = installedCliVersion();
  if (!updateCheckForced(context.env) && !isReleaseChannelVersion(cliVersion)) return undefined;
  const channel = updateChannelForVersion(cliVersion);
  const tag = registryTagForChannel(channel);
  const registry = resolveNpmRegistry(context.env);
  const latestVersion = await fetchNpmDistTagVersion({
    registry,
    packageName: "@task-handoff/thctl",
    tag,
    fetchImpl: context.fetchImpl,
    timeoutMs: FETCH_TIMEOUT_MS,
  });
  if (!latestVersion) return undefined;
  return { channel, tag, registry, latestVersion, checkedAt: new Date().toISOString() };
}

async function checkSkillRelease(context: CliContext) {
  const release = await fetchSkillRelease({
    fetchImpl: context.fetchImpl,
    env: context.env,
    timeoutMs: FETCH_TIMEOUT_MS,
  });
  const contentSignature = skillContentSignature(release.entry.integrity);
  return {
    indexUrl: release.indexUrl,
    latestVersion: release.entry.version,
    ...(contentSignature ? { contentSignature } : {}),
    ...(release.entry.thctl ? { thctl: release.entry.thctl } : {}),
    checkedAt: new Date().toISOString(),
  };
}

/**
 * 下一次运行时读取缓存状态并生成提示；本次命令的检查结果从下一次开始生效。
 * 默认只在交互终端提示，`--no-update-check` / `TASK_HANDOFF_CLI_UPDATE_CHECK=0` 关闭，
 * `=1` 强制在非交互、`--json` 与本地构建下也提示。
 */
export function pendingUpdateNotice(
  context: CliContext,
  options: { argv?: readonly string[]; now?: number; cwd?: string; home?: string; cliVersion?: string } = {},
) {
  const argv = options.argv ?? process.argv;
  if (updateCheckDisabled(context.env, argv)) return undefined;
  const forced = updateCheckForced(context.env);
  if (!forced && (!context.isTty || context.output.json)) return undefined;
  const now = options.now ?? Date.now();
  const file = updateCheckStatePath(context);
  const state = loadUpdateCheckState(file);
  const cliVersion = options.cliVersion ?? installedCliVersion();
  const cliLatest = state.cli?.latestVersion;
  const skillLatest = state.skill?.latestVersion;
  const lines: string[] = [];
  if (cliLatest && isNewerVersion(cliVersion, cliLatest) && (forced || isReleaseChannelVersion(cliVersion))) {
    const tag = state.cli?.tag ?? "latest";
    lines.push(`thctl ${cliVersion} → ${cliLatest} is available: npm install -g @task-handoff/thctl@${tag}`);
  }
  if (skillLatest) {
    const publishedSignature = state.skill?.contentSignature;
    const installed = resolveSkillTargets(options.cwd ?? process.cwd(), {}, options.home)
      .map((target) => inspectSkillDirectory(target.directory))
      .filter((skill) => skill.exists);
    const outdated = installed.filter((skill) => {
      if (publishedSignature !== undefined && skill.contentSignature !== undefined) {
        return skill.contentSignature !== publishedSignature;
      }
      return skill.version !== undefined && isNewerSkillVersion(skill.version, skillLatest);
    });
    if (outdated.length > 0) {
      const current = [...new Set(outdated.map((skill) => skill.version ?? "unknown"))].join(", ");
      if (state.skill?.thctl && !satisfiesSkillRange(cliVersion, state.skill.thctl)) {
        lines.push(`skill ${SKILL_NAME} ${current} → ${skillLatest} needs thctl ${state.skill.thctl}: update the CLI first`);
      } else {
        lines.push(`skill ${SKILL_NAME} ${current} → ${skillLatest} is available: thctl skill update`);
      }
    }
  }
  if (lines.length === 0) return undefined;
  const key = `${cliLatest ?? ""}|${skillLatest ?? ""}`;
  const shownAt = state.noticeShownAt ? Date.parse(state.noticeShownAt) : Number.NaN;
  if (state.noticeShownKey === key && Number.isFinite(shownAt) && now - shownAt < NOTICE_INTERVAL_MS) return undefined;
  try {
    saveUpdateCheckState(file, { ...state, noticeShownAt: new Date(now).toISOString(), noticeShownKey: key });
  } catch {
    // 记不住节流信息时最多多提示一次。
  }
  return lines.join("\n");
}
