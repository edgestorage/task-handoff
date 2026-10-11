import { createHash } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import writeFileAtomic from "write-file-atomic";
import { JsonFile } from "../../shared/persistence/store.ts";
import { WSL_DISTRO_PREFIX, wslDistroNameForInstance, type WslDistro } from "./wsl-executor.ts";

/**
 * WSL distro 供给（openspec change add-wsl-runtime，Phase 4）。
 *
 * 本模块负责：单一 base 模板的定位/版本化/node 级缓存（4.1）、幂等的 `wsl --import`（4.2）、
 * 归属标签写入与校验（4.3/4.4）、命名（4.7，规则在 wsl-executor）与孤立 distro 对账（4.8）。
 *
 * 设计约束：
 * - base 模板身份与版本是 Node Agent 私有信息，MUST NOT 进入公共协议。
 * - 归属证据有两份：distro 内 `/var/lib/task-handoff/distro.json`（权威、跨 Node Agent 数据目录丢失仍可读）
 *   与 Node Agent 私有索引（快路径，避免为一次所有权检查唤醒 distro）。两者任一与当前实例不符即视为冲突，
 *   MUST NOT 接管同名 distro。
 * - 供给 MUST 幂等：重复供给不得产生第二个 distro。
 */

export const WSL_BASE_TEMPLATE_MISSING = "WSL_BASE_TEMPLATE_MISSING";
export const WSL_BASE_TEMPLATE_INVALID = "WSL_BASE_TEMPLATE_INVALID";
export const WSL_DISTRO_OWNERSHIP_CONFLICT = "WSL_DISTRO_OWNERSHIP_CONFLICT";

/** distro 内归属标记（root 可读写；由 `wsl -u root` 写入）。 */
export const WSL_DISTRO_MARKER_PATH = "/var/lib/task-handoff/distro.json";
export const WSL_BASE_TEMPLATE_FORMAT_VERSION = 1;
/** base 模板缓存与 distro 安装目录都在 Node Agent 私有数据目录下（见 persistence/paths.ts）。 */
export const WSL_BASE_TEMPLATE_ID = "wsl-base";

export const WSL_RUNTIME_KIND_LABEL = "task-handoff.runtime-kind";
export const WSL_RUNTIME_KIND_VALUE = "wsl";
export const WSL_INSTANCE_ID_LABEL = "task-handoff.instance-id";
export const WSL_RUNTIME_ID_LABEL = "task-handoff.runtime-id";
export const WSL_OWNER_NODE_ID_LABEL = "task-handoff.owner-node-id";
export const WSL_BASE_TEMPLATE_LABEL = "task-handoff.base-template";

function provisioningError(code: string, message: string, details?: Record<string, unknown>, statusCode = 500) {
  return Object.assign(new Error(message), { statusCode, code, ...(details ? { details } : {}) });
}

export const WslBaseTemplateManifestSchema = z.object({
  id: z.string().min(1),
  version: z.string().min(1),
  platform: z.literal("linux"),
  arch: z.string().min(1),
  formatVersion: z.literal(WSL_BASE_TEMPLATE_FORMAT_VERSION),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  sizeBytes: z.number().int().nonnegative().optional(),
  createdAt: z.string().optional(),
  /** 供诊断：模板内 Node/Python/git 等工具版本，MUST NOT 作为行为依据。 */
  tools: z.record(z.string(), z.string()).optional(),
}).strict();

export type WslBaseTemplateManifest = z.infer<typeof WslBaseTemplateManifestSchema>;

export const WslDistroOwnershipSchema = z.object({
  runtimeKind: z.literal(WSL_RUNTIME_KIND_VALUE),
  distroName: z.string().min(1),
  instanceId: z.string().min(1),
  runtimeId: z.string().min(1),
  nodeId: z.string().min(1),
  baseTemplateId: z.string().min(1),
  baseTemplateVersion: z.string().min(1),
  createdAt: z.string().min(1),
}).strict();

export type WslDistroOwnership = z.infer<typeof WslDistroOwnershipSchema>;

const WslDistroIndexSchema = z.object({
  version: z.literal(1),
  distros: z.record(z.string(), WslDistroOwnershipSchema),
}).strict();

export type WslRuntimeLabelsInput = {
  instanceId: string;
  runtimeId: string;
  nodeId: string;
  baseTemplateId?: string;
};

/** 4.3：写入 `instance.runtime.labels` 的归属标签。 */
export function wslRuntimeLabels(input: WslRuntimeLabelsInput): Record<string, string> {
  return {
    [WSL_RUNTIME_KIND_LABEL]: WSL_RUNTIME_KIND_VALUE,
    [WSL_INSTANCE_ID_LABEL]: input.instanceId,
    [WSL_RUNTIME_ID_LABEL]: input.runtimeId,
    [WSL_OWNER_NODE_ID_LABEL]: input.nodeId,
    ...(input.baseTemplateId ? { [WSL_BASE_TEMPLATE_LABEL]: input.baseTemplateId } : {}),
  };
}

/** 4.3 的"校验"侧：labels 与实例归属不符时按身份冲突失败。 */
export function assertWslRuntimeLabels(labels: Record<string, string> | undefined, expected: WslRuntimeLabelsInput) {
  if (!labels) {
    throw provisioningError(
      WSL_DISTRO_OWNERSHIP_CONFLICT,
      `Instance ${expected.instanceId} is missing WSL runtime ownership labels.`,
      { instanceId: expected.instanceId },
      409,
    );
  }
  for (const [key, value] of Object.entries(wslRuntimeLabels(expected))) {
    if (labels[key] !== value) {
      throw provisioningError(
        WSL_DISTRO_OWNERSHIP_CONFLICT,
        `Instance ${expected.instanceId} has WSL runtime label ${key}="${labels[key] ?? ""}" but expected "${value}".`,
        { instanceId: expected.instanceId, label: key, actual: labels[key], expected: value },
        409,
      );
    }
  }
}

/** 4.1：base 模板随附目录的解析顺序（显式目录 → 随附 runtime-artifacts/wsl-base → runtime-artifacts 根）。 */
export function defaultWslBaseTemplateSourceDirs(env: NodeJS.ProcessEnv = process.env) {
  const dirs: string[] = [];
  const explicitDir = env.TASK_HANDOFF_WSL_BASE_TEMPLATE_DIR?.trim();
  if (explicitDir) dirs.push(path.resolve(explicitDir));
  const bundledRoot = env.TASK_HANDOFF_BUNDLED_RUNTIME_DIR?.trim();
  const root = bundledRoot
    ? path.resolve(bundledRoot)
    : path.resolve(path.dirname(process.argv[1] || process.cwd()), "..", "runtime-artifacts");
  dirs.push(path.join(root, "wsl-base"), root);
  return dirs;
}

async function sha256File(filePath: string) {
  const hash = createHash("sha256");
  const stream = fs.createReadStream(filePath);
  for await (const chunk of stream) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

function baseTemplateStem(version: string, arch: string) {
  return `${WSL_BASE_TEMPLATE_ID}-${version}-${arch}`;
}

export type ResolvedWslBaseTemplate = {
  identity: WslBaseTemplateManifest;
  /** 缓存内的 tar.gz 路径，可直接交给 `wsl --import`。 */
  archivePath: string;
  manifestPath: string;
  cacheHit: boolean;
};

export type EnsureWslBaseTemplateOptions = {
  cacheDir: string;
  sourceDirs?: string[];
  archivePath?: string;
  manifestPath?: string;
  expectedVersion?: string;
  expectedArch?: string;
  logger?: (message: string, data: Record<string, unknown>) => void;
};

async function readManifest(filePath: string): Promise<WslBaseTemplateManifest> {
  let raw: unknown;
  try {
    raw = JSON.parse(await fsp.readFile(filePath, "utf8"));
  } catch (error) {
    throw provisioningError(WSL_BASE_TEMPLATE_INVALID, `WSL base template manifest ${filePath} could not be read.`, {
      manifestPath: filePath,
      cause: error instanceof Error ? error.message : String(error),
    });
  }
  const parsed = WslBaseTemplateManifestSchema.safeParse(raw);
  if (!parsed.success) {
    throw provisioningError(WSL_BASE_TEMPLATE_INVALID, `WSL base template manifest ${filePath} is invalid.`, {
      manifestPath: filePath,
      issues: parsed.error.issues,
    });
  }
  return parsed.data;
}

function assertExpectedIdentity(identity: WslBaseTemplateManifest, options: EnsureWslBaseTemplateOptions) {
  if (options.expectedVersion && identity.version !== options.expectedVersion) {
    throw provisioningError(WSL_BASE_TEMPLATE_INVALID, `WSL base template version ${identity.version} does not match expected ${options.expectedVersion}.`, {
      actualVersion: identity.version,
      expectedVersion: options.expectedVersion,
    });
  }
  if (options.expectedArch && identity.arch !== options.expectedArch) {
    throw provisioningError(WSL_BASE_TEMPLATE_INVALID, `WSL base template arch ${identity.arch} does not match expected ${options.expectedArch}.`, {
      actualArch: identity.arch,
      expectedArch: options.expectedArch,
    });
  }
}

async function readCacheEntry(cacheDir: string, options: EnsureWslBaseTemplateOptions): Promise<ResolvedWslBaseTemplate | undefined> {
  let entries: string[];
  try {
    entries = await fsp.readdir(cacheDir);
  } catch {
    return undefined;
  }
  const candidates: ResolvedWslBaseTemplate[] = [];
  for (const entry of entries) {
    const entryDir = path.join(cacheDir, entry);
    const manifestPath = path.join(entryDir, "manifest.json");
    const readyPath = path.join(entryDir, ".ready");
    if (!fs.existsSync(readyPath) || !fs.existsSync(manifestPath)) continue;
    const identity = await readManifest(manifestPath).catch(() => undefined);
    if (!identity) continue;
    if (options.expectedVersion && identity.version !== options.expectedVersion) continue;
    if (options.expectedArch && identity.arch !== options.expectedArch) continue;
    const archivePath = path.join(entryDir, `${baseTemplateStem(identity.version, identity.arch)}.tar.gz`);
    if (!fs.existsSync(archivePath)) continue;
    candidates.push({ identity, archivePath, manifestPath, cacheHit: true });
  }
  candidates.sort((left, right) => right.identity.version.localeCompare(left.identity.version));
  return candidates[0];
}

async function locateBaseTemplateSource(options: EnsureWslBaseTemplateOptions) {
  if (options.archivePath) {
    const archivePath = path.resolve(options.archivePath);
    const manifestPath = options.manifestPath
      ? path.resolve(options.manifestPath)
      : archivePath.endsWith(".tar.gz")
      ? `${archivePath.slice(0, -".tar.gz".length)}.manifest.json`
      : `${archivePath}.manifest.json`;
    if (!fs.existsSync(archivePath)) {
      throw provisioningError(WSL_BASE_TEMPLATE_MISSING, `WSL base template archive ${archivePath} does not exist.`, { archivePath });
    }
    if (!fs.existsSync(manifestPath)) {
      throw provisioningError(WSL_BASE_TEMPLATE_MISSING, `WSL base template manifest ${manifestPath} does not exist.`, { manifestPath });
    }
    return { archivePath, manifestPath };
  }
  for (const dir of options.sourceDirs ?? []) {
    let entries: string[];
    try {
      entries = await fsp.readdir(dir);
    } catch {
      continue;
    }
    const manifests = entries
      .filter((entry) => entry.startsWith(`${WSL_BASE_TEMPLATE_ID}-`) && entry.endsWith(".manifest.json"))
      .map((entry) => path.join(dir, entry))
      .sort()
      .reverse();
    for (const manifestPath of manifests) {
      const identity = await readManifest(manifestPath).catch(() => undefined);
      if (!identity) continue;
      if (options.expectedVersion && identity.version !== options.expectedVersion) continue;
      if (options.expectedArch && identity.arch !== options.expectedArch) continue;
      const archivePath = path.join(dir, `${baseTemplateStem(identity.version, identity.arch)}.tar.gz`);
      if (!fs.existsSync(archivePath)) continue;
      return { archivePath, manifestPath };
    }
  }
  throw provisioningError(
    WSL_BASE_TEMPLATE_MISSING,
    "No cached or bundled WSL base template was found. Build/package one or set TASK_HANDOFF_WSL_BASE_TEMPLATE.",
    { sourceDirs: options.sourceDirs ?? [] },
  );
}

/**
 * 4.1：定位、校验并缓存 base 模板。缓存命中时不重新读取随附来源；未命中时校验 SHA-256 后再原子写入缓存，
 * 使多个实例复用同一份模板资产。
 */
export async function ensureWslBaseTemplate(options: EnsureWslBaseTemplateOptions): Promise<ResolvedWslBaseTemplate> {
  const cached = await readCacheEntry(options.cacheDir, options);
  if (cached) return cached;
  const source = await locateBaseTemplateSource(options);
  const identity = await readManifest(source.manifestPath);
  assertExpectedIdentity(identity, options);
  const actualSha256 = await sha256File(source.archivePath);
  if (actualSha256 !== identity.sha256) {
    throw provisioningError(WSL_BASE_TEMPLATE_INVALID, `WSL base template ${identity.id}@${identity.version} failed SHA-256 verification.`, {
      archivePath: source.archivePath,
      expectedSha256: identity.sha256,
      actualSha256,
    });
  }
  const entryDir = path.join(options.cacheDir, baseTemplateStem(identity.version, identity.arch));
  await fsp.mkdir(entryDir, { recursive: true });
  const archivePath = path.join(entryDir, `${baseTemplateStem(identity.version, identity.arch)}.tar.gz`);
  const manifestPath = path.join(entryDir, "manifest.json");
  const stagingPath = `${archivePath}.staging-${process.pid}`;
  await fsp.copyFile(source.archivePath, stagingPath);
  await fsp.rename(stagingPath, archivePath);
  writeFileAtomic.sync(manifestPath, `${JSON.stringify(identity, null, 2)}\n`, { encoding: "utf8" });
  writeFileAtomic.sync(path.join(entryDir, ".ready"), "", { encoding: "utf8" });
  options.logger?.("wsl base template cached", {
    version: identity.version,
    arch: identity.arch,
    sourceArchivePath: source.archivePath,
    cacheArchivePath: archivePath,
    sizeBytes: identity.sizeBytes,
  });
  return { identity, archivePath, manifestPath, cacheHit: false };
}

/** 只读索引：distro 名 → 归属。作为快路径避免为所有权检查唤醒 distro。 */
export class WslDistroIndexStore {
  private readonly filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  private file() {
    return new JsonFile<z.infer<typeof WslDistroIndexSchema>>(
      this.filePath,
      () => ({ version: 1, distros: {} }),
      { schema: WslDistroIndexSchema },
    );
  }

  get(distroName: string) {
    return this.file().get().distros[distroName];
  }

  list() {
    return this.file().get().distros;
  }

  put(record: WslDistroOwnership) {
    const current = this.file().get();
    return this.file().put({ version: 1, distros: { ...current.distros, [record.distroName]: record } });
  }

  delete(distroName: string) {
    const current = this.file().get();
    const { [distroName]: _removed, ...rest } = current.distros;
    return this.file().put({ version: 1, distros: rest });
  }
}

/** 供给所用的 `wsl.exe` 子集；`WslExecutor` 结构性满足该契约，测试可用假实现。 */
export type WslProvisioningExecutor = {
  listDistros(): Promise<WslDistro[]>;
  findDistro(name: string): Promise<WslDistro | undefined>;
  importDistro(input: { name: string; installDir: string; tarballPath: string; version?: number }): Promise<WslDistro | undefined>;
  exec(name: string, argv: readonly string[]): Promise<{ stdout: string; stderr: string; exitCode: number }>;
  execOrThrow(name: string, argv: readonly string[]): Promise<{ stdout: string; stderr: string; exitCode: number }>;
  unregister(name: string): Promise<void>;
};

export type WslProvisionResult = {
  distroName: string;
  created: boolean;
  ownership: WslDistroOwnership;
  labels: Record<string, string>;
  state: WslDistro["state"] | "unknown";
};

export type WslDistroProvisionerOptions = {
  executor: WslProvisioningExecutor;
  nodeId: string;
  /** distro 安装目录根（Windows 路径，`wsl --import` 的 installDir）。 */
  distroRoot: string;
  baseTemplateCacheDir: string;
  index: WslDistroIndexStore;
  baseTemplateSourceDirs?: string[];
  expectedBaseTemplateVersion?: string;
  /** 该 runtime 声明的唯一受支持架构（WSL2 与宿主同架构）。 */
  expectedArch?: string;
  now?: () => Date;
  logger?: (message: string, data: Record<string, unknown>) => void;
};

export type WslReconcileOptions = {
  /** 当前仍存在的 Controlled Instance id。 */
  instanceIds: Iterable<string>;
  /** 显式回收（默认 false，只标记并诊断）。 */
  reclaim?: boolean;
  /** 忽略保留期，直接回收。 */
  force?: boolean;
  retentionMs?: number;
  /** 索引缺失时是否唤醒 distro 读取归属标记来认领（默认 false，避免唤醒未知 distro）。 */
  inspectUnindexedMarkers?: boolean;
  now?: () => number;
};

export type WslReconcileDiagnostic = {
  code: "WSL_DISTRO_ORPHANED" | "WSL_DISTRO_RECLAIMED" | "WSL_DISTRO_UNOWNED" | "WSL_DISTRO_FOREIGN_NODE";
  distroName: string;
  instanceId?: string;
  action: "retained" | "reclaimed" | "skipped";
  message: string;
};

export type WslReconcileResult = {
  diagnostics: WslReconcileDiagnostic[];
  reclaimable: string[];
  reclaimed: string[];
};

export const WSL_DEFAULT_ORPHAN_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;

export class WslDistroProvisioner {
  private readonly executor: WslProvisioningExecutor;
  private readonly nodeId: string;
  private readonly distroRoot: string;
  private readonly index: WslDistroIndexStore;
  private readonly options: WslDistroProvisionerOptions;

  constructor(options: WslDistroProvisionerOptions) {
    this.options = options;
    this.executor = options.executor;
    this.nodeId = options.nodeId;
    this.distroRoot = options.distroRoot;
    this.index = options.index;
  }

  distroNameForInstance(instance: { id: string; containerName?: string }) {
    const persisted = instance.containerName?.trim();
    return persisted || wslDistroNameForInstance(instance.id);
  }

  /** 删除实例时同步移除宿主侧索引，避免同一 distro 名在下次供给时被判为冲突。 */
  forgetDistro(distroName: string) {
    this.index.delete(distroName);
  }

  labelsFor(instance: { id: string; runtimeId: string }, ownership: { baseTemplateId: string }) {
    return wslRuntimeLabels({
      instanceId: instance.id,
      runtimeId: instance.runtimeId,
      nodeId: this.nodeId,
      baseTemplateId: ownership.baseTemplateId,
    });
  }

  private async ensureBaseTemplate() {
    return ensureWslBaseTemplate({
      cacheDir: this.options.baseTemplateCacheDir,
      sourceDirs: this.options.baseTemplateSourceDirs ?? defaultWslBaseTemplateSourceDirs(),
      expectedVersion: this.options.expectedBaseTemplateVersion,
      expectedArch: this.options.expectedArch,
      logger: this.options.logger,
    });
  }

  /**
   * 4.2/4.6：幂等供给。distro 已存在时只校验归属（必要时修复 distro 内标记），不重复 import；
   * distro 不存在时用已缓存的单一 base 模板 import。
   */
  async provision(instance: { id: string; runtimeId: string; containerName?: string }): Promise<WslProvisionResult> {
    const distroName = this.distroNameForInstance(instance);
    const existing = await this.executor.findDistro(distroName);
    if (existing) {
      const ownership = await this.assertOwnership(distroName, instance);
      await this.ensureMarker(distroName, ownership);
      return {
        distroName,
        created: false,
        ownership,
        labels: this.labelsFor(instance, ownership),
        state: existing.state,
      };
    }
    const template = await this.ensureBaseTemplate();
    const installDir = path.join(this.distroRoot, distroName);
    await fsp.mkdir(installDir, { recursive: true });
    const imported = await this.executor.importDistro({ name: distroName, installDir, tarballPath: template.archivePath });
    const ownership: WslDistroOwnership = {
      runtimeKind: WSL_RUNTIME_KIND_VALUE,
      distroName,
      instanceId: instance.id,
      runtimeId: instance.runtimeId,
      nodeId: this.nodeId,
      baseTemplateId: template.identity.id,
      baseTemplateVersion: template.identity.version,
      createdAt: (this.options.now?.() ?? new Date()).toISOString(),
    };
    // 先写宿主侧索引（证明"本节点创建了它"），再写 distro 内标记；标记写失败时重试仍可从索引恢复。
    this.index.put(ownership);
    await this.writeMarker(distroName, ownership);
    this.options.logger?.("wsl distro provisioned", {
      distroName,
      instanceId: instance.id,
      installDir,
      baseTemplateVersion: template.identity.version,
      cacheHit: template.cacheHit,
    });
    return {
      distroName,
      created: true,
      ownership,
      labels: this.labelsFor(instance, ownership),
      state: imported?.state ?? "Stopped",
    };
  }

  /** 4.4：校验 distro 归属；不一致 MUST 以身份冲突失败。 */
  async assertOwnership(
    distroName: string,
    expected: { id: string; runtimeId: string; containerName?: string },
  ): Promise<WslDistroOwnership> {
    const indexed = this.index.get(distroName);
    if (indexed) {
      this.assertOwnershipMatches(indexed, distroName, expected);
      return indexed;
    }
    const marker = await this.readMarker(distroName);
    if (marker) {
      this.assertOwnershipMatches(marker, distroName, expected);
      this.index.put(marker);
      return marker;
    }
    throw provisioningError(
      WSL_DISTRO_OWNERSHIP_CONFLICT,
      `WSL distro ${distroName} already exists but carries no ownership record for instance ${expected.id}.`,
      { distroName, instanceId: expected.id },
      409,
    );
  }

  private assertOwnershipMatches(
    ownership: WslDistroOwnership,
    distroName: string,
    expected: { id: string; runtimeId: string },
  ) {
    if (
      ownership.nodeId !== this.nodeId
      || ownership.distroName !== distroName
      || ownership.instanceId !== expected.id
      || ownership.runtimeId !== expected.runtimeId
    ) {
      throw provisioningError(
        WSL_DISTRO_OWNERSHIP_CONFLICT,
        `WSL distro ${distroName} is owned by node ${ownership.nodeId} instance ${ownership.instanceId}, not ${this.nodeId}/${expected.id}.`,
        {
          distroName,
          ownerNodeId: ownership.nodeId,
          ownerInstanceId: ownership.instanceId,
          expectedNodeId: this.nodeId,
          expectedInstanceId: expected.id,
        },
        409,
      );
    }
  }

  /** 读取 distro 内权威归属标记；缺失或不可读时返回 undefined。 */
  async readMarker(distroName: string): Promise<WslDistroOwnership | undefined> {
    const result = await this.executor.exec(distroName, ["cat", WSL_DISTRO_MARKER_PATH]);
    if (result.exitCode !== 0) return undefined;
    try {
      const parsed = WslDistroOwnershipSchema.safeParse(JSON.parse(result.stdout));
      return parsed.success ? parsed.data : undefined;
    } catch {
      return undefined;
    }
  }

  private async writeMarker(distroName: string, ownership: WslDistroOwnership) {
    // distro 内写入用 base64 + argv 传递，避免 JSON 引号与 Windows 命令行转义问题。
    const payload = Buffer.from(`${JSON.stringify(ownership, null, 2)}\n`, "utf8").toString("base64");
    const markerDir = path.posix.dirname(WSL_DISTRO_MARKER_PATH);
    await this.executor.execOrThrow(distroName, [
      "sh",
      "-c",
      `mkdir -p ${markerDir} && printf '%s' ${payload} | base64 -d > ${WSL_DISTRO_MARKER_PATH}`,
    ]);
  }

  private async ensureMarker(distroName: string, ownership: WslDistroOwnership) {
    if (await this.readMarker(distroName)) return;
    await this.writeMarker(distroName, ownership);
  }

  /**
   * 4.8：对账孤立 distro。只处理带本节点 owner 的 distro；索引缺失时默认不唤醒（避免误动未知 distro），
   * 显式开启 `inspectUnindexedMarkers` 才读取 distro 内标记认领。回收默认只标记，`reclaim` 时才 `--unregister`。
   */
  async reconcileOrphans(options: WslReconcileOptions): Promise<WslReconcileResult> {
    const live = new Set(options.instanceIds);
    const nowMs = options.now?.() ?? Date.now();
    const retentionMs = options.retentionMs ?? WSL_DEFAULT_ORPHAN_RETENTION_MS;
    const result: WslReconcileResult = { diagnostics: [], reclaimable: [], reclaimed: [] };
    const distros = (await this.executor.listDistros()).filter((distro) => distro.name.startsWith(WSL_DISTRO_PREFIX));
    for (const distro of distros) {
      let ownership = this.index.get(distro.name);
      if (!ownership) {
        if (!options.inspectUnindexedMarkers) {
          result.diagnostics.push({
            code: "WSL_DISTRO_UNOWNED",
            distroName: distro.name,
            action: "skipped",
            message: `WSL distro ${distro.name} has no node-agent ownership record and was left untouched.`,
          });
          continue;
        }
        ownership = await this.readMarker(distro.name).catch(() => undefined);
        if (!ownership) {
          result.diagnostics.push({
            code: "WSL_DISTRO_UNOWNED",
            distroName: distro.name,
            action: "skipped",
            message: `WSL distro ${distro.name} has no readable ownership record and was left untouched.`,
          });
          continue;
        }
        this.index.put(ownership);
      }
      if (ownership.nodeId !== this.nodeId) {
        result.diagnostics.push({
          code: "WSL_DISTRO_FOREIGN_NODE",
          distroName: distro.name,
          instanceId: ownership.instanceId,
          action: "skipped",
          message: `WSL distro ${distro.name} belongs to node ${ownership.nodeId} and was left untouched.`,
        });
        continue;
      }
      if (live.has(ownership.instanceId)) continue;
      result.reclaimable.push(distro.name);
      const createdAtMs = Date.parse(ownership.createdAt);
      const expired = options.force || (Number.isFinite(createdAtMs) && nowMs - createdAtMs >= retentionMs);
      if (options.reclaim && expired) {
        await this.executor.unregister(distro.name);
        this.index.delete(distro.name);
        result.reclaimed.push(distro.name);
        result.diagnostics.push({
          code: "WSL_DISTRO_RECLAIMED",
          distroName: distro.name,
          instanceId: ownership.instanceId,
          action: "reclaimed",
          message: `Reclaimed orphaned WSL distro ${distro.name} for deleted instance ${ownership.instanceId}.`,
        });
        continue;
      }
      result.diagnostics.push({
        code: "WSL_DISTRO_ORPHANED",
        distroName: distro.name,
        instanceId: ownership.instanceId,
        action: "retained",
        message: `WSL distro ${distro.name} has no live instance record and is retained${expired ? " (eligible for reclaim)" : ""}.`,
      });
    }
    return result;
  }
}
