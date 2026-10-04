import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import semver from "semver";

export type UpdateChannel = "stable" | "beta" | "alpha";

export const CLI_REGISTRY_ENV = "TASK_HANDOFF_CLI_REGISTRY";

export function updateChannelForVersion(version: string): UpdateChannel {
  const prerelease = semver.prerelease(version)?.[0];
  return prerelease === "alpha" || prerelease === "beta" ? prerelease : "stable";
}

export function registryTagForChannel(channel: UpdateChannel) {
  return channel === "stable" ? "latest" : channel;
}

/** 正式发布或 alpha/beta 预发布属于发布通道；local/dev 等构建不参与 registry 比较。 */
export function isReleaseChannelVersion(version: string) {
  const parsed = semver.parse(version);
  if (!parsed) return false;
  if (parsed.prerelease.length === 0) return true;
  const channel = parsed.prerelease[0];
  return channel === "alpha" || channel === "beta";
}

/**
 * 候选版本是否值得提示升级。本地/预发布构建不会被同核心版本的正式发布提示
 * “降级”；无法解析的版本一律不提示。
 */
export function isNewerVersion(current: string | undefined, available: string | undefined) {
  if (!current || !available) return false;
  const parsedCurrent = semver.parse(current);
  const parsedAvailable = semver.parse(available);
  if (!parsedCurrent || !parsedAvailable) return false;
  if (semver.eq(parsedCurrent, parsedAvailable)) return false;
  const sameCore = parsedCurrent.major === parsedAvailable.major
    && parsedCurrent.minor === parsedAvailable.minor
    && parsedCurrent.patch === parsedAvailable.patch;
  if (sameCore && parsedCurrent.prerelease.length > 0 && parsedAvailable.prerelease.length === 0) {
    const channel = parsedCurrent.prerelease[0];
    if (channel !== "alpha" && channel !== "beta") return false;
  }
  return semver.gt(parsedAvailable, parsedCurrent);
}

/** skill 内容版本比较：数字修订号优先，其次语义版本，无法比较时不提示。 */
export function isNewerSkillVersion(current: string | undefined, available: string | undefined) {
  const currentValue = current?.trim();
  const availableValue = available?.trim();
  if (!currentValue || !availableValue || currentValue === availableValue) return false;
  if (/^\d+$/.test(currentValue) && /^\d+$/.test(availableValue)) {
    return Number(availableValue) > Number(currentValue);
  }
  if (semver.valid(currentValue) && semver.valid(availableValue)) {
    return semver.gt(availableValue, currentValue);
  }
  return false;
}

export function isValidVersionRange(range: string) {
  return semver.validRange(range.trim()) !== null;
}

/** 无效 range 返回 false；索引侧会先校验 range 合法性再使用。 */
export function satisfiesRange(version: string | undefined, range: string | undefined) {
  if (!range) return true;
  if (!version) return false;
  try {
    return semver.satisfies(version, range, { includePrerelease: true });
  } catch {
    return false;
  }
}

export function normalizeRegistryUrl(value: string) {
  const trimmed = value.trim();
  return trimmed.endsWith("/") ? trimmed : `${trimmed}/`;
}

/** registry 覆盖顺序：CLI 专用变量 > npm 环境 > ~/.npmrc > 官方 registry。 */
export function resolveNpmRegistry(env: Record<string, string | undefined> = process.env, home = os.homedir()) {
  const override = env[CLI_REGISTRY_ENV]?.trim();
  if (override) return normalizeRegistryUrl(override);
  const npmRegistry = env.npm_config_registry?.trim();
  if (npmRegistry) return normalizeRegistryUrl(npmRegistry);
  const fromNpmrc = readNpmrcRegistry(home);
  if (fromNpmrc) return normalizeRegistryUrl(fromNpmrc);
  return "https://registry.npmjs.org/";
}

function readNpmrcRegistry(home: string) {
  try {
    for (const line of fs.readFileSync(path.join(home, ".npmrc"), "utf8").split(/\r?\n/)) {
      const match = /^\s*registry\s*=\s*(.+?)\s*$/.exec(line);
      if (match) return match[1];
    }
  } catch {
    // 没有 ~/.npmrc 时回退到官方 registry。
  }
  return undefined;
}

export function npmPackageUrl(registry: string, packageName: string) {
  const encoded = packageName.startsWith("@") ? packageName.replace("/", "%2f") : packageName;
  return `${registry}${encoded}`;
}

/** 读取 npm dist-tag 指向的版本；任何失败都返回 undefined，由调用方决定降级策略。 */
export async function fetchNpmDistTagVersion(options: {
  registry: string;
  packageName: string;
  tag: string;
  fetchImpl: typeof fetch;
  timeoutMs?: number;
}) {
  const response = await options.fetchImpl(npmPackageUrl(options.registry, options.packageName), {
    headers: { accept: "application/vnd.npm.install-v1+json" },
    signal: AbortSignal.timeout(options.timeoutMs ?? 3000),
  });
  if (!response.ok) return undefined;
  const payload = await response.json() as { "dist-tags"?: Record<string, unknown> };
  const version = payload?.["dist-tags"]?.[options.tag];
  return typeof version === "string" && version.trim() ? version.trim() : undefined;
}
