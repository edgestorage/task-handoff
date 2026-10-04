import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { CLI_EXIT_CODES, ThctlError, protocolError, usageError } from "./errors.ts";
import { isNewerSkillVersion, isReleaseChannelVersion, isValidVersionRange, satisfiesRange } from "./release.ts";

/**
 * 产品只发布一个 Agent Skill：入口 `SKILL.md` 说明通用规则，功能模块放在
 * `references/` 里按需加载。skill 名与产品名一致，CLI 与发布索引都写死这一项。
 */
export const SKILL_NAME = "taskhandoff";
/** 早期草稿名，仅用于识别已安装副本并提示迁移；不再发布。 */
export const LEGACY_SKILL_NAMES: readonly string[] = ["task-handoff", "task-handoff-nodes"];
export const SKILLS_INDEX_URL_ENV = "TASK_HANDOFF_SKILLS_INDEX_URL";
export const DEFAULT_SKILLS_INDEX_URL = "https://docs.thandoff.com/.well-known/skills/index.json";
export const SKILL_ENTRY_FILE = "SKILL.md";
export const SKILL_PROVENANCE_FILE = ".thandoff-skill.json";

const SkillIndexEntrySchema = z.object({
  name: z.string().trim().min(1).max(64),
  description: z.string().trim().max(2048).optional(),
  version: z.union([z.string().trim().min(1).max(120), z.number()]).transform((value) => String(value)),
  thctl: z.string().trim().min(1).max(240).optional(),
  files: z.array(z.string().trim().min(1).max(512)).min(1).max(200),
  integrity: z.record(z.string(), z.string().trim().min(1).max(200)).optional(),
}).loose();
export type SkillIndexEntry = z.infer<typeof SkillIndexEntrySchema>;

const SkillIndexDocumentSchema = z.object({
  skills: z.array(SkillIndexEntrySchema).min(1).max(100),
}).loose();

const SkillProvenanceSchema = z.object({
  schemaVersion: z.literal(1),
  name: z.string().trim().min(1).max(64),
  version: z.string().trim().min(1).max(120),
  thctl: z.string().trim().max(240).optional(),
  source: z.literal("index"),
  indexUrl: z.string().trim().min(1).max(2048),
  installedAt: z.string().datetime(),
  cliVersion: z.string().trim().min(1).max(120),
  verified: z.boolean().optional(),
  files: z.record(z.string(), z.string().trim().min(1).max(128)),
}).loose();
export type SkillProvenance = z.infer<typeof SkillProvenanceSchema>;

export type SkillScope = "project" | "user";

export type SkillTarget = {
  scope: SkillScope;
  root: string;
  directory: string;
};

export type SkillRelease = {
  entry: SkillIndexEntry;
  indexUrl: string;
  baseUrl: string;
};

export type SkillReleaseFile = {
  path: string;
  content: Buffer;
  sha256: string;
};

export function sha256Hex(value: Buffer | string) {
  return createHash("sha256").update(value).digest("hex");
}

/** 索引里的文件路径必须相对、可嵌套，且不能逃出 skill 目录。 */
export function normalizeSkillFilePath(value: string) {
  const normalized = value.trim().replace(/\\/g, "/").replace(/^\.\//, "");
  const segments = normalized.split("/");
  if (!normalized || normalized.startsWith("/") || /^[A-Za-z]:/.test(normalized)
    || segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw protocolError(`The skill index contains an unsafe file path: ${value}`);
  }
  return segments.join("/");
}

export function resolveSkillTarget(
  cwd: string,
  options: { scope?: string; dir?: string } = {},
  home = os.homedir(),
): SkillTarget {
  const directory = options.dir?.trim();
  const scope = resolveSkillScope(options.scope);
  if (directory) {
    const root = path.resolve(cwd, directory);
    return { scope, root, directory: path.join(root, SKILL_NAME) };
  }
  const root = scope === "user"
    ? path.join(home, ".agents", "skills")
    : path.join(cwd, ".agents", "skills");
  return { scope, root, directory: path.join(root, SKILL_NAME) };
}

export function resolveSkillScope(value: string | undefined): SkillScope {
  const scope = value?.trim() || "user";
  if (scope !== "project" && scope !== "user") {
    throw usageError("CLI_ARGUMENT_INVALID", `Unknown --scope \`${scope}\`; expected project or user.`, { scope });
  }
  return scope;
}

export function resolveSkillTargets(
  cwd: string,
  options: { scope?: string; dir?: string } = {},
  home = os.homedir(),
): SkillTarget[] {
  if (options.dir?.trim() || options.scope?.trim()) return [resolveSkillTarget(cwd, options, home)];
  return [
    resolveSkillTarget(cwd, { scope: "user" }, home),
    resolveSkillTarget(cwd, { scope: "project" }, home),
  ];
}

export async function fetchSkillRelease(options: {
  fetchImpl: typeof fetch;
  env?: Record<string, string | undefined>;
  indexUrl?: string;
  timeoutMs?: number;
}): Promise<SkillRelease> {
  const indexUrl = (options.indexUrl ?? options.env?.[SKILLS_INDEX_URL_ENV] ?? DEFAULT_SKILLS_INDEX_URL).trim();
  let response: Response;
  try {
    response = await options.fetchImpl(indexUrl, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(options.timeoutMs ?? 5000),
    });
  } catch (error) {
    throw new ThctlError(
      "CLI_SKILL_INDEX_UNAVAILABLE",
      `Could not reach the skill index ${indexUrl}: ${error instanceof Error ? error.message : String(error)}`,
      CLI_EXIT_CODES.network,
      { indexUrl },
    );
  }
  if (!response.ok) {
    throw new ThctlError(
      "CLI_SKILL_INDEX_UNAVAILABLE",
      `The skill index ${indexUrl} answered HTTP ${response.status}.`,
      CLI_EXIT_CODES.network,
      { indexUrl, status: response.status },
    );
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw protocolError(`The skill index ${indexUrl} is not valid JSON.`, { indexUrl });
  }
  const parsed = SkillIndexDocumentSchema.safeParse(payload);
  if (!parsed.success) {
    throw protocolError(`The skill index ${indexUrl} does not match the published schema.`, { indexUrl });
  }
  const entry = parsed.data.skills.find((skill) => skill.name === SKILL_NAME);
  if (!entry) {
    throw protocolError(
      `The skill index ${indexUrl} does not publish \`${SKILL_NAME}\`; the CLI and the published skill are out of sync.`,
      { indexUrl, expected: SKILL_NAME },
    );
  }
  const files = [...new Set(entry.files.map(normalizeSkillFilePath))];
  if (!files.includes(SKILL_ENTRY_FILE)) {
    throw protocolError(`The skill index entry for \`${SKILL_NAME}\` does not declare ${SKILL_ENTRY_FILE}.`, { indexUrl });
  }
  if (entry.thctl !== undefined && !isValidVersionRange(entry.thctl)) {
    throw protocolError(`The skill index declares an invalid thctl range: ${entry.thctl}`, { indexUrl, thctl: entry.thctl });
  }
  return {
    entry: { ...entry, files },
    indexUrl,
    baseUrl: indexUrl.replace(/[^/]*$/, ""),
  };
}

export function assertSkillCompatibility(entry: SkillIndexEntry, cliVersion: string) {
  if (!entry.thctl) return;
  if (satisfiesSkillRange(cliVersion, entry.thctl)) return;
  throw new ThctlError(
    "CLI_SKILL_REQUIRES_NEWER_CLI",
    `Skill \`${SKILL_NAME}\` ${entry.version} requires thctl ${entry.thctl}, but this CLI is ${cliVersion}. Update the CLI first: npm install -g @task-handoff/thctl@latest`,
    CLI_EXIT_CODES.capability,
    { command: "skill install", requiredThctl: entry.thctl, cliVersion },
  );
}

/**
 * 发布通道（正式 / alpha / beta）按 semver 判定 skill 兼容范围；本地和开发构建
 * 直接来自源码，与发布版本不可比，不参与门控。
 */
export function satisfiesSkillRange(cliVersion: string, range: string | undefined) {
  if (!range) return true;
  if (!isReleaseChannelVersion(cliVersion)) return true;
  return satisfiesRange(cliVersion, range);
}

export async function downloadSkillReleaseFiles(
  release: SkillRelease,
  options: { fetchImpl: typeof fetch; timeoutMs?: number },
): Promise<SkillReleaseFile[]> {
  const files: SkillReleaseFile[] = [];
  for (const relativePath of release.entry.files) {
    const url = new URL(relativePath, release.baseUrl).toString();
    let response: Response;
    try {
      response = await options.fetchImpl(url, { signal: AbortSignal.timeout(options.timeoutMs ?? 5000) });
    } catch (error) {
      throw new ThctlError(
        "CLI_SKILL_DOWNLOAD_FAILED",
        `Could not download ${relativePath}: ${error instanceof Error ? error.message : String(error)}`,
        CLI_EXIT_CODES.network,
        { path: relativePath, url },
      );
    }
    if (!response.ok) {
      throw new ThctlError(
        "CLI_SKILL_DOWNLOAD_FAILED",
        `The skill file ${url} answered HTTP ${response.status}.`,
        CLI_EXIT_CODES.network,
        { path: relativePath, status: response.status },
      );
    }
    const content = Buffer.from(await response.arrayBuffer());
    const sha256 = sha256Hex(content);
    const expected = release.entry.integrity?.[relativePath];
    if (expected !== undefined) {
      const normalized = expected.trim().toLowerCase().replace(/^sha256:/, "");
      if (!/^[a-f0-9]{64}$/.test(normalized)) {
        throw protocolError(`The skill index integrity for ${relativePath} is not a sha256 digest.`, { path: relativePath });
      }
      if (normalized !== sha256) {
        throw protocolError(`The downloaded ${relativePath} does not match the published sha256.`, {
          path: relativePath,
          expected: normalized,
          actual: sha256,
        });
      }
    }
    files.push({ path: relativePath, content, sha256 });
  }
  return files;
}

export function skillProvenancePath(directory: string) {
  return path.join(directory, SKILL_PROVENANCE_FILE);
}

export function readSkillProvenance(directory: string): SkillProvenance | undefined {
  try {
    const parsed = SkillProvenanceSchema.safeParse(JSON.parse(fs.readFileSync(skillProvenancePath(directory), "utf8")));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/** 从 SKILL.md frontmatter 的 `metadata.version` 读取版本；脱离 provenance 的副本也能自证。 */
export function skillFrontmatterVersion(contents: string) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(contents);
  if (!match) return undefined;
  let inMetadata = false;
  for (const rawLine of match[1].split(/\r?\n/)) {
    const line = rawLine.replace(/\s+$/, "");
    if (!line.trim()) continue;
    const indent = line.length - line.trimStart().length;
    const trimmed = line.trim();
    if (indent === 0) {
      inMetadata = /^metadata:\s*$/.test(trimmed);
      continue;
    }
    if (!inMetadata) continue;
    const version = /^version:\s*"?([^"\s]+)"?\s*$/.exec(trimmed);
    if (version) return version[1];
  }
  return undefined;
}

export type InstalledSkill = {
  directory: string;
  exists: boolean;
  version?: string;
  managed: boolean;
  /** null 表示无法判定（无 provenance 的历史副本）。 */
  modified: boolean | null;
  /** 托管副本的发布内容指纹；无 provenance 时为空，此时只能退回版本比较。 */
  contentSignature?: string;
};

export function inspectSkillDirectory(directory: string): InstalledSkill {
  if (!fs.existsSync(directory)) {
    return { directory, exists: false, managed: false, modified: null };
  }
  const provenance = readSkillProvenance(directory);
  if (!provenance) {
    let version: string | undefined;
    try {
      version = skillFrontmatterVersion(fs.readFileSync(path.join(directory, SKILL_ENTRY_FILE), "utf8"));
    } catch {
      version = undefined;
    }
    return { directory, exists: true, ...(version ? { version } : {}), managed: false, modified: null };
  }
  return {
    directory,
    exists: true,
    version: provenance.version,
    managed: true,
    modified: provenanceModified(directory, provenance),
    contentSignature: skillContentSignature(provenance.files),
  };
}

/**
 * 发布内容指纹：把每个文件的 sha256 归一化后合成一个稳定摘要。
 * 索引里的 `integrity` 与安装时写入 provenance 的 `files` 是同一种数据，所以
 * “发布内容和我装的是不是同一份”可以直接比这个指纹，不需要版本号可比大小。
 */
export function skillContentSignature(digests: Record<string, string> | undefined): string | undefined {
  if (!digests) return undefined;
  const entries = Object.entries(digests)
    .map(([relativePath, digest]) => [relativePath, digest.trim().toLowerCase().replace(/^sha256:/, "")] as const)
    .filter(([, digest]) => digest.length > 0)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  if (entries.length === 0) return undefined;
  return createHash("sha256").update(entries.map(([relativePath, digest]) => `${relativePath}:${digest}`).join("\n")).digest("hex");
}

/**
 * 是否需要更新。优先比对发布内容指纹：索引声明了 `integrity` 且本地有 provenance 时，
 * 指纹不同就更新，因此版本号可以是日期、哈希等任意样式。
 * 缺少任一侧摘要时（老索引、手工安装且没有 provenance 的副本）退回版本比较。
 */
export function skillNeedsUpdate(installed: InstalledSkill, entry: SkillIndexEntry): boolean {
  if (!installed.exists) return false;
  const published = skillContentSignature(entry.integrity);
  const local = installed.contentSignature;
  if (published !== undefined && local !== undefined) return published !== local;
  return installed.version === undefined || isNewerSkillVersion(installed.version, entry.version);
}

export function provenanceModified(directory: string, provenance: SkillProvenance) {
  const expected = new Set(Object.keys(provenance.files));
  for (const [relativePath, digest] of Object.entries(provenance.files)) {
    try {
      const actual = sha256Hex(fs.readFileSync(path.join(directory, ...relativePath.split("/"))));
      if (actual !== digest) return true;
    } catch {
      return true;
    }
  }
  try {
    return listSkillFiles(directory).some((file) => !expected.has(file));
  } catch {
    return true;
  }
}

export function listSkillFiles(directory: string, relative = ""): string[] {
  const entries = fs.readdirSync(path.join(directory, relative), { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.name === SKILL_PROVENANCE_FILE) continue;
    const next = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...listSkillFiles(directory, next));
    else files.push(next);
  }
  return files;
}

export function findLegacySkillDirectories(root: string) {
  return LEGACY_SKILL_NAMES
    .map((name) => path.join(root, name))
    .filter((directory) => fs.existsSync(directory));
}

export function applySkillRelease(options: {
  target: SkillTarget;
  release: SkillRelease;
  files: readonly SkillReleaseFile[];
  cliVersion: string;
  now?: Date;
}): SkillProvenance {
  const { target, release, files } = options;
  fs.mkdirSync(target.root, { recursive: true, mode: 0o755 });
  const temporary = fs.mkdtempSync(path.join(target.root, `.taskhandoff-${SKILL_NAME}-`));
  const backup = `${target.directory}.backup-${process.pid}`;
  try {
    for (const file of files) {
      const destination = path.join(temporary, ...file.path.split("/"));
      fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o755 });
      fs.writeFileSync(destination, file.content, { mode: 0o644 });
    }
    const provenance: SkillProvenance = {
      schemaVersion: 1,
      name: SKILL_NAME,
      version: release.entry.version,
      ...(release.entry.thctl ? { thctl: release.entry.thctl } : {}),
      source: "index",
      indexUrl: release.indexUrl,
      installedAt: (options.now ?? new Date()).toISOString(),
      cliVersion: options.cliVersion,
      verified: files.every((file) => release.entry.integrity?.[file.path] !== undefined),
      files: Object.fromEntries(files.map((file) => [file.path, file.sha256])),
    };
    fs.writeFileSync(path.join(temporary, SKILL_PROVENANCE_FILE), `${JSON.stringify(provenance, null, 2)}\n`, { mode: 0o600 });
    if (fs.existsSync(target.directory)) fs.renameSync(target.directory, backup);
    try {
      fs.renameSync(temporary, target.directory);
    } catch (error) {
      if (fs.existsSync(backup) && !fs.existsSync(target.directory)) fs.renameSync(backup, target.directory);
      throw error;
    }
    fs.rmSync(backup, { recursive: true, force: true });
    return provenance;
  } catch (error) {
    fs.rmSync(temporary, { recursive: true, force: true });
    throw error;
  }
}
