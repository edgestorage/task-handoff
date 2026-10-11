#!/usr/bin/env node
/**
 * current-1 兼容基线自动锚定（openspec change refactor-runtime-adapter-registry，D6）。
 *
 * 从 `--current`（或最新稳定 git tag，或 `TASK_HANDOFF_VERSION`）推导 current-1，并重写 openspec
 * 变更文档里的 current-1 基线标记块，避免各提案手写 `v0.0.39` 造成漂移。
 *
 * 标记语法：`<!-- baseline:current-1 -->v0.0.39<!-- /baseline -->`
 *
 * 用法：
 *   node scripts/openspec-reanchor-baseline.mjs            # 重锚
 *   node scripts/openspec-reanchor-baseline.mjs --check    # 校验，不一致时非零退出
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const BASELINE_MARKER_START = "<!-- baseline:current-1 -->";
export const BASELINE_MARKER_END = "<!-- /baseline -->";
const MARKER_PATTERN = /<!--\s*baseline:current-1\s*-->[\s\S]*?<!--\s*\/baseline\s*-->/g;

/** 由 current 版本推导 current-1（只有 patch 递减；minor/major 归零时保守回退到上一 minor/major）。 */
export function computeBaselineVersion(version) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(String(version).trim());
  if (!match) throw new Error(`Unsupported release version: ${version}`);
  const [, majorText, minorText, patchText] = match;
  const major = Number(majorText);
  const minor = Number(minorText);
  const patch = Number(patchText);
  if (patch > 0) return `${major}.${minor}.${patch - 1}`;
  if (minor > 0) return `${major}.${minor - 1}.0`;
  if (major > 0) return `${major - 1}.0.0`;
  throw new Error(`Cannot derive a previous version from ${version}`);
}

/** 只改写基线条目内的版本号；标记块外文本保持不变。 */
export function rewriteBaselineMarkers(content, baseline) {
  const replacement = `${BASELINE_MARKER_START}v${baseline}${BASELINE_MARKER_END}`;
  let changed = false;
  const next = content.replace(MARKER_PATTERN, (match) => {
    if (match === replacement) return match;
    changed = true;
    return replacement;
  });
  return { changed, content: next };
}

/** 列出 `openspec/changes` 下所有变更文档（跳过 `archive`）。 */
export function baselineMarkedFiles(root) {
  const base = path.join(root, "openspec", "changes");
  const files = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === "archive") continue;
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(absolute);
      else if (entry.name.endsWith(".md")) files.push(absolute);
    }
  };
  walk(base);
  return files.sort();
}

/** 解析 current 版本：显式参数 → TASK_HANDOFF_VERSION → 最新稳定 git tag。 */
/**
 * 解析 current 版本：显式 `--current` → 最新稳定 git tag → `TASK_HANDOFF_VERSION`。
 * git tag 是本仓库的发布权威；环境变量只在无 tag（例如浅克隆）时兜底，避免开发 shell 里
 * 无关的 `TASK_HANDOFF_VERSION` 把基线改错。
 */
export function resolveCurrentVersion(root, explicit) {
  const normalize = (value) => value.trim().replace(/^v/, "");
  if (explicit?.trim()) return normalize(explicit);
  try {
    const tags = execFileSync("git", ["tag", "--list", "v[0-9]*", "--sort=-v:refname"], { cwd: root, encoding: "utf8" })
      .split("\n")
      .map((tag) => tag.trim())
      .filter((tag) => /^v\d+\.\d+\.\d+$/.test(tag));
    if (tags.length) return normalize(tags[0]);
  } catch {
    // 没有 git 或不在此仓库：交给环境变量/调用方。
  }
  const env = process.env.TASK_HANDOFF_VERSION?.trim();
  if (env) return normalize(env);
  return undefined;
}

export function anchorBaseline({ root, current, check = false }) {
  const resolvedCurrent = resolveCurrentVersion(root, current);
  if (!resolvedCurrent) {
    throw new Error("Could not resolve the current release version. Pass --current <version> or set TASK_HANDOFF_VERSION.");
  }
  const baseline = computeBaselineVersion(resolvedCurrent);
  const changedFiles = [];
  for (const file of baselineMarkedFiles(root)) {
    const content = fs.readFileSync(file, "utf8");
    const { changed, content: next } = rewriteBaselineMarkers(content, baseline);
    if (!changed) continue;
    changedFiles.push(path.relative(root, file));
    if (!check) fs.writeFileSync(file, next);
  }
  return { current: resolvedCurrent, baseline, changedFiles, check };
}

function parseArgs(argv) {
  const args = { check: false, root: path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."), current: undefined };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--check") args.check = true;
    else if (value === "--root") args.root = path.resolve(argv[++index] ?? ".");
    else if (value === "--current") args.current = argv[++index];
    else throw new Error(`Unknown argument: ${value}`);
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const result = anchorBaseline(args);
  if (args.check && result.changedFiles.length) {
    console.error(JSON.stringify({
      message: "openspec current-1 baseline is stale",
      baseline: `v${result.baseline}`,
      current: `v${result.current}`,
      files: result.changedFiles,
      hint: "Run `node scripts/openspec-reanchor-baseline.mjs` to re-anchor.",
    }));
    process.exit(1);
  }
  console.log(JSON.stringify({
    message: args.check ? "openspec current-1 baseline is up to date" : "openspec current-1 baseline anchored",
    baseline: `v${result.baseline}`,
    current: `v${result.current}`,
    updated: result.changedFiles.length,
  }));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(2);
  }
}
