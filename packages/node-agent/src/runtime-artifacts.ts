import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, lstat, open, readFile, readdir, readlink, rename, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { RuntimeArtifactIdentitySchema, type RuntimeArtifactIdentity } from "@task-handoff/protocol/control-plane";
import { safeParseResponse } from "@task-handoff/protocol/response-validation";
import { extract } from "tar";

export const RUNTIME_ARTIFACT_MANIFEST = "runtime-manifest.json";
export const RUNTIME_ARTIFACT_FORMAT_VERSION = 1;

export class RuntimeArtifactError extends Error {
  readonly code: "INSTANCE_RUNTIME_ARTIFACT_UNAVAILABLE" | "INSTANCE_RUNTIME_ARTIFACT_INVALID" | "INSTANCE_RUNTIME_INSTALL_FAILED" | "INSTANCE_BASE_RUNTIME_INCOMPATIBLE";
  readonly retryable: boolean;

  constructor(code: RuntimeArtifactError["code"], message: string, options?: { cause?: unknown; retryable?: boolean }) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = "RuntimeArtifactError";
    this.code = code;
    this.retryable = options?.retryable ?? false;
  }
}

export type RuntimeArtifactSource = {
  archiveUrl?: string;
  archivePath?: string;
  archiveSha256: string;
};

export type ResolvedRuntimeArtifact = {
  identity: RuntimeArtifactIdentity;
  archivePath: string;
  cacheHit: boolean;
};

export type RuntimeInstallResult = {
  releasePath: string;
  reused: boolean;
};

function assertSafeRelativePath(value: string, label: string): string {
  if (!value || value.includes("\\") || path.posix.isAbsolute(value)) {
    throw new RuntimeArtifactError("INSTANCE_RUNTIME_ARTIFACT_INVALID", `${label} must be a non-empty POSIX relative path.`);
  }
  const normalized = path.posix.normalize(value);
  if (normalized === "." || normalized === ".." || normalized.startsWith("../")) {
    throw new RuntimeArtifactError("INSTANCE_RUNTIME_ARTIFACT_INVALID", `${label} escapes the runtime root.`);
  }
  return normalized;
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

type PayloadEntry = { absolutePath: string; relativePath: string; kind: "file"; size: number }
  | { absolutePath: string; relativePath: string; kind: "symlink"; target: string; size: number };

async function payloadFiles(rootDir: string, relativeDir = ""): Promise<PayloadEntry[]> {
  const result: PayloadEntry[] = [];
  const entries = await readdir(path.join(rootDir, relativeDir), { withFileTypes: true });
  for (const entry of entries) {
    const relativePath = relativeDir ? path.posix.join(relativeDir, entry.name) : entry.name;
    if (!relativeDir && relativePath === RUNTIME_ARTIFACT_MANIFEST) continue;
    const absolutePath = path.join(rootDir, ...relativePath.split("/"));
    if (entry.isDirectory()) {
      result.push(...await payloadFiles(rootDir, relativePath));
      continue;
    }
    if (entry.isSymbolicLink()) {
      const target = await readlink(absolutePath);
      if (path.isAbsolute(target)) {
        throw new RuntimeArtifactError("INSTANCE_RUNTIME_ARTIFACT_INVALID", `Runtime payload symlink is absolute: ${relativePath}`);
      }
      const resolved = path.resolve(path.dirname(absolutePath), target);
      const relativeTarget = path.relative(path.resolve(rootDir), resolved);
      if (!relativeTarget || relativeTarget === ".." || relativeTarget.startsWith(`..${path.sep}`) || path.isAbsolute(relativeTarget)) {
        throw new RuntimeArtifactError("INSTANCE_RUNTIME_ARTIFACT_INVALID", `Runtime payload symlink escapes the artifact: ${relativePath}`);
      }
      if (!await lstat(resolved).catch(() => undefined)) {
        throw new RuntimeArtifactError("INSTANCE_RUNTIME_ARTIFACT_INVALID", `Runtime payload symlink is broken: ${relativePath}`);
      }
      result.push({ absolutePath, relativePath, kind: "symlink", target, size: Buffer.byteLength(target) });
      continue;
    }
    if (!entry.isFile()) {
      throw new RuntimeArtifactError("INSTANCE_RUNTIME_ARTIFACT_INVALID", `Runtime payload contains unsupported entry: ${relativePath}`);
    }
    const stats = await lstat(absolutePath);
    result.push({ absolutePath, relativePath, kind: "file", size: stats.size });
  }
  return result;
}

/**
 * Hashes payload files independently of tar metadata. Directories and the root
 * manifest are excluded. Relative in-tree symlinks are hashed by link target;
 * absolute/escaping symlinks and special files are rejected.
 */
export async function computeRuntimePayloadSha256(rootDir: string): Promise<string> {
  const files = (await payloadFiles(rootDir)).sort((left, right) => compareUtf8(left.relativePath, right.relativePath));
  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(file.kind === "file" ? "F" : "L", "ascii");
    hash.update(Buffer.from(file.relativePath, "utf8"));
    hash.update(Buffer.from([0]));
    hash.update(Buffer.from(String(file.size), "ascii"));
    hash.update(Buffer.from([0]));
    if (file.kind === "file") {
      for await (const chunk of createReadStream(file.absolutePath)) hash.update(chunk as Buffer);
    } else {
      hash.update(Buffer.from(file.target, "utf8"));
    }
    hash.update(Buffer.from([0]));
  }
  return hash.digest("hex");
}

export function runtimeArtifactKey(identity: Pick<RuntimeArtifactIdentity, "version" | "platform" | "arch">): string {
  for (const [label, value] of [["version", identity.version], ["platform", identity.platform], ["arch", identity.arch]] as const) {
    if (!/^[0-9A-Za-z._-]+$/.test(value)) {
      throw new RuntimeArtifactError("INSTANCE_RUNTIME_ARTIFACT_INVALID", `Invalid runtime artifact ${label}: ${value}`);
    }
  }
  return `${identity.version}-${identity.platform}-${identity.arch}`;
}

function runtimeArtifactCacheKey(identity: RuntimeArtifactIdentity, archiveSha256: string): string {
  return `${runtimeArtifactKey(identity)}-${identity.sha256}-${archiveSha256}`;
}

export async function readRuntimeArtifactManifest(rootDir: string): Promise<RuntimeArtifactIdentity> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path.join(rootDir, RUNTIME_ARTIFACT_MANIFEST), "utf8"));
  } catch (error) {
    throw new RuntimeArtifactError("INSTANCE_RUNTIME_ARTIFACT_INVALID", "Runtime artifact manifest is missing or invalid JSON.", { cause: error });
  }
  const parsed = safeParseResponse(RuntimeArtifactIdentitySchema, value);
  if (!parsed.success) {
    throw new RuntimeArtifactError("INSTANCE_RUNTIME_ARTIFACT_INVALID", `Runtime artifact manifest is invalid: ${parsed.error.message}`);
  }
  return parsed.data;
}

function assertIdentity(actual: RuntimeArtifactIdentity, expected: RuntimeArtifactIdentity): void {
  for (const key of ["packageName", "version", "platform", "arch", "formatVersion", "launcherAbi", "entrypoint", "sha256"] as const) {
    if (actual[key] !== expected[key]) {
      const label = key === "sha256" ? "SHA-256" : key;
      throw new RuntimeArtifactError("INSTANCE_RUNTIME_ARTIFACT_INVALID", `Runtime artifact ${label} mismatch: expected ${expected[key]}, got ${actual[key]}.`);
    }
  }
}

export async function validateExtractedRuntimeArtifact(
  rootDir: string,
  expected: RuntimeArtifactIdentity,
  environment?: { launcherAbi?: number; platform?: string; arch?: string },
): Promise<RuntimeArtifactIdentity> {
  const actual = await readRuntimeArtifactManifest(rootDir);
  assertIdentity(actual, expected);
  if (actual.formatVersion !== RUNTIME_ARTIFACT_FORMAT_VERSION) {
    throw new RuntimeArtifactError("INSTANCE_RUNTIME_ARTIFACT_INVALID", `Unsupported runtime artifact format ${actual.formatVersion}.`);
  }
  if (environment?.platform && actual.platform !== "universal" && actual.platform !== environment.platform) {
    throw new RuntimeArtifactError("INSTANCE_RUNTIME_ARTIFACT_INVALID", `Runtime artifact platform ${actual.platform} does not match ${environment.platform}.`);
  }
  if (environment?.arch && actual.arch !== "universal" && actual.arch !== environment.arch) {
    throw new RuntimeArtifactError("INSTANCE_RUNTIME_ARTIFACT_INVALID", `Runtime artifact architecture ${actual.arch} does not match ${environment.arch}.`);
  }
  if (environment?.launcherAbi !== undefined && actual.launcherAbi > environment.launcherAbi) {
    throw new RuntimeArtifactError(
      "INSTANCE_BASE_RUNTIME_INCOMPATIBLE",
      `Runtime requires launcher ABI ${actual.launcherAbi}, but the base runtime provides ${environment.launcherAbi}.`,
    );
  }
  const entrypoint = assertSafeRelativePath(actual.entrypoint, "Runtime entrypoint");
  const entryStats = await lstat(path.join(rootDir, ...entrypoint.split("/"))).catch(() => undefined);
  if (!entryStats?.isFile()) {
    throw new RuntimeArtifactError("INSTANCE_RUNTIME_ARTIFACT_INVALID", `Runtime entrypoint is missing: ${entrypoint}`);
  }
  const digest = await computeRuntimePayloadSha256(rootDir);
  if (digest !== actual.sha256) {
    throw new RuntimeArtifactError("INSTANCE_RUNTIME_ARTIFACT_INVALID", `Runtime payload SHA-256 mismatch: expected ${actual.sha256}, got ${digest}.`);
  }
  return actual;
}

async function extractArchive(archivePath: string, destination: string): Promise<void> {
  await mkdir(destination, { recursive: true });
  try {
    await extract({
      file: archivePath,
      cwd: destination,
      strict: true,
      preservePaths: false,
      filter: (entryPath, entry) => {
        const normalized = path.posix.normalize(entryPath.replace(/^\.\//, ""));
        if (!normalized || normalized === ".." || normalized.startsWith("../") || path.posix.isAbsolute(normalized)) {
          throw new RuntimeArtifactError("INSTANCE_RUNTIME_ARTIFACT_INVALID", `Runtime archive entry escapes the artifact root: ${entryPath}`);
        }
        const entryType = (entry as { type?: string }).type;
        if (entryType !== "File" && entryType !== "OldFile" && entryType !== "Directory" && entryType !== "SymbolicLink") {
          throw new RuntimeArtifactError("INSTANCE_RUNTIME_ARTIFACT_INVALID", `Runtime archive contains unsupported entry type ${entryType ?? "unknown"}: ${entryPath}`);
        }
        return true;
      },
    });
  } catch (error) {
    throw new RuntimeArtifactError("INSTANCE_RUNTIME_ARTIFACT_INVALID", "Could not extract runtime artifact safely.", { cause: error });
  }
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

export class RuntimeArtifactResolver {
  readonly #cacheDir: string;
  readonly #fetch: typeof fetch;
  readonly #inFlight = new Map<string, Promise<ResolvedRuntimeArtifact>>();

  constructor(options: { cacheDir: string; fetchImpl?: typeof fetch }) {
    this.#cacheDir = options.cacheDir;
    this.#fetch = options.fetchImpl ?? fetch;
  }

  resolve(identity: RuntimeArtifactIdentity, source: RuntimeArtifactSource): Promise<ResolvedRuntimeArtifact> {
    const parsed = RuntimeArtifactIdentitySchema.parse(identity);
    if (!/^[a-f0-9]{64}$/.test(source.archiveSha256)) {
      throw new RuntimeArtifactError("INSTANCE_RUNTIME_ARTIFACT_INVALID", "Runtime archive SHA-256 is invalid.");
    }
    if ((source.archiveUrl ? 1 : 0) + (source.archivePath ? 1 : 0) !== 1) {
      throw new RuntimeArtifactError("INSTANCE_RUNTIME_ARTIFACT_INVALID", "Runtime artifact source must specify exactly one archive location.");
    }
    const key = runtimeArtifactCacheKey(parsed, source.archiveSha256);
    const active = this.#inFlight.get(key);
    if (active) return active;
    const operation = this.#resolve(parsed, source).finally(() => this.#inFlight.delete(key));
    this.#inFlight.set(key, operation);
    return operation;
  }

  async #resolve(identity: RuntimeArtifactIdentity, source: RuntimeArtifactSource): Promise<ResolvedRuntimeArtifact> {
    if (!/^[a-f0-9]{64}$/.test(source.archiveSha256)) {
      throw new RuntimeArtifactError("INSTANCE_RUNTIME_ARTIFACT_INVALID", "Runtime archive SHA-256 is invalid.");
    }
    const key = runtimeArtifactCacheKey(identity, source.archiveSha256);
    const archivesDir = path.join(this.#cacheDir, "archives");
    const archivePath = path.join(archivesDir, `${key}.tar.gz`);
    await mkdir(archivesDir, { recursive: true });
    if (await this.#validateCached(archivePath, identity, source.archiveSha256)) {
      return { identity, archivePath, cacheHit: true };
    }
    await rm(archivePath, { force: true });
    const temporaryPath = path.join(archivesDir, `.${key}.${randomUUID()}.part`);
    try {
      const handle = await open(temporaryPath, "wx");
      if (source.archivePath) {
        await pipeline(createReadStream(source.archivePath), handle.createWriteStream());
      } else {
        const response = await this.#fetch(source.archiveUrl!);
        if (!response.ok || !response.body) {
          await handle.close();
          throw new RuntimeArtifactError("INSTANCE_RUNTIME_ARTIFACT_UNAVAILABLE", `Runtime artifact download failed with HTTP ${response.status}.`, { retryable: response.status >= 500 });
        }
        await pipeline(response.body, handle.createWriteStream());
      }
      if (await sha256File(temporaryPath) !== source.archiveSha256) {
        throw new RuntimeArtifactError("INSTANCE_RUNTIME_ARTIFACT_INVALID", "Downloaded runtime archive SHA-256 does not match release metadata.");
      }
      await this.#validateArchive(temporaryPath, identity);
      await rename(temporaryPath, archivePath);
      return { identity, archivePath, cacheHit: false };
    } catch (error) {
      if (error instanceof RuntimeArtifactError) throw error;
      throw new RuntimeArtifactError("INSTANCE_RUNTIME_ARTIFACT_UNAVAILABLE", "Could not download runtime artifact.", { cause: error, retryable: true });
    } finally {
      await rm(temporaryPath, { force: true });
    }
  }

  async #validateCached(archivePath: string, identity: RuntimeArtifactIdentity, archiveSha256: string): Promise<boolean> {
    try {
      if (await sha256File(archivePath) !== archiveSha256) return false;
      await this.#validateArchive(archivePath, identity);
      return true;
    } catch {
      return false;
    }
  }

  async #validateArchive(archivePath: string, identity: RuntimeArtifactIdentity): Promise<void> {
    const probe = path.join(this.#cacheDir, "validation", `${runtimeArtifactKey(identity)}-${randomUUID()}`);
    try {
      await extractArchive(archivePath, probe);
      await validateExtractedRuntimeArtifact(probe, identity, { platform: identity.platform, arch: identity.arch });
    } finally {
      await rm(probe, { recursive: true, force: true });
    }
  }
}

async function activeRelease(runtimeRoot: string): Promise<string | undefined> {
  try {
    const target = await readlink(path.join(runtimeRoot, "current"));
    const normalized = target.replaceAll("\\", "/");
    const match = normalized.match(/(?:^|\/)releases\/([^/]+)$/);
    return match?.[1];
  } catch {
    return undefined;
  }
}

export async function switchCurrentRuntime(runtimeRoot: string, release: string, platform = process.platform): Promise<void> {
  const next = path.join(runtimeRoot, `.current-${randomUUID()}`);
  const current = path.join(runtimeRoot, "current");
  await symlink(path.posix.join("releases", release), next, platform === "win32" ? "junction" : "dir");
  if (platform !== "win32") {
    await rename(next, current);
    return;
  }

  // Windows cannot replace an existing directory junction with rename(). Keep
  // the old junction available for recovery while installing the new pointer.
  const previous = path.join(runtimeRoot, `.previous-current-${randomUUID()}`);
  let movedPrevious = false;
  try {
    await rename(current, previous);
    movedPrevious = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      await rm(next, { recursive: true, force: true });
      throw error;
    }
  }
  try {
    await rename(next, current);
  } catch (error) {
    if (movedPrevious) await rename(previous, current).catch(() => undefined);
    throw error;
  } finally {
    await rm(next, { recursive: true, force: true });
  }
  if (movedPrevious) await rm(previous, { recursive: true, force: true });
}

export async function installRuntimeArtifact(options: {
  archivePath: string;
  identity: RuntimeArtifactIdentity;
  runtimeRoot: string;
  launcherAbi: number;
  platform?: string;
  arch?: string;
  faultInjection?: "after-extract" | "after-release" | "after-switch";
}): Promise<RuntimeInstallResult> {
  const identity = RuntimeArtifactIdentitySchema.parse(options.identity);
  if (identity.launcherAbi > options.launcherAbi) {
    throw new RuntimeArtifactError("INSTANCE_BASE_RUNTIME_INCOMPATIBLE", `Runtime requires launcher ABI ${identity.launcherAbi}, but the base runtime provides ${options.launcherAbi}.`);
  }
  const key = runtimeArtifactKey(identity);
  const releasesDir = path.join(options.runtimeRoot, "releases");
  const stagingDir = path.join(options.runtimeRoot, "staging");
  const quarantineDir = path.join(options.runtimeRoot, "quarantine");
  const release = runtimeReleaseKey(identity);
  const releasePath = path.join(releasesDir, release);
  await Promise.all([mkdir(releasesDir, { recursive: true }), mkdir(stagingDir, { recursive: true }), mkdir(quarantineDir, { recursive: true })]);
  await cleanupRuntimeStaging(options.runtimeRoot);
  const activeReleaseKey = await activeRelease(options.runtimeRoot);
  let reused = false;
  try {
    await validateExtractedRuntimeArtifact(releasePath, identity, {
      launcherAbi: options.launcherAbi,
      platform: options.platform ?? identity.platform,
      arch: options.arch ?? identity.arch,
    });
    reused = true;
  } catch (error) {
    const stats = await lstat(releasePath).catch(() => undefined);
    if (stats) await rename(releasePath, path.join(quarantineDir, `${key}-${randomUUID()}`));
    const operationDir = path.join(stagingDir, `${key}-${randomUUID()}`);
    try {
      await extractArchive(options.archivePath, operationDir);
      await validateExtractedRuntimeArtifact(operationDir, identity, {
        launcherAbi: options.launcherAbi,
        platform: options.platform ?? identity.platform,
        arch: options.arch ?? identity.arch,
      });
      if (options.faultInjection === "after-extract") throw new Error("Injected failure after extract.");
      await rename(operationDir, releasePath);
      if (options.faultInjection === "after-release") throw new Error("Injected failure after release install.");
    } catch (installError) {
      await rm(operationDir, { recursive: true, force: true });
      if (installError instanceof RuntimeArtifactError) throw installError;
      throw new RuntimeArtifactError("INSTANCE_RUNTIME_INSTALL_FAILED", "Could not install controlled instance runtime.", { cause: installError, retryable: true });
    }
  }
  if (activeReleaseKey !== release) {
    await switchCurrentRuntime(options.runtimeRoot, release);
  }
  if (options.faultInjection === "after-switch") throw new RuntimeArtifactError("INSTANCE_RUNTIME_INSTALL_FAILED", "Injected failure after active release switch.", { retryable: true });
  return { releasePath, reused };
}

export async function cleanupRuntimeStaging(runtimeRoot: string): Promise<void> {
  await rm(path.join(runtimeRoot, "staging"), { recursive: true, force: true });
  await mkdir(path.join(runtimeRoot, "staging"), { recursive: true });
}

export function runtimeReleaseKey(identity: Pick<RuntimeArtifactIdentity, "version" | "sha256">): string {
  if (!/^[0-9A-Za-z._-]+$/.test(identity.version) || !/^[a-f0-9]{64}$/.test(identity.sha256)) {
    throw new RuntimeArtifactError("INSTANCE_RUNTIME_ARTIFACT_INVALID", "Runtime release identity is invalid.");
  }
  return `${identity.version}-${identity.sha256}`;
}
