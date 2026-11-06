import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFile, execFileSync } from "node:child_process";
import { Readable } from "node:stream";
import { promisify } from "node:util";
import {
  AppInstallEnvironmentSchema,
  AppInstallEnvironmentTestCheckSchema,
  AppInstallSourceCustomSchema,
  AppInstallSourceSettingsSchema,
  AppInstallSourceUpdateSchema,
  AppInstallSourceUrlSchema,
  type AppInstallEffectiveSources,
  type AppInstallEnvironment,
  type AppInstallEnvironmentTestCheck,
  type AppInstallEnvironmentTestResponse,
  type AppInstallNodeToolchain,
  type AppInstallSourceCustom,
  type AppInstallSourceProfile,
  type AppInstallSourceSettings,
  type FinalComputerCapabilities,
} from "@task-handoff/protocol/control-plane";
import { atomicWriteJsonSync } from "@task-handoff/core/storage/atomic-write";
import { resolveExecutable } from "@task-handoff/core/core/executable-resolver";
import { extract as extractTar } from "tar";
import { z } from "zod";

export const MANAGED_NODE_VERSION = "24.19.0";
export const MINIMUM_NODE_VERSION = "24.15.0";
export const APP_INSTALL_SOURCE_PROFILES = ["environment", "official", "china", "custom"] as const;

const SOURCE_FILE = "app-install-sources.json";
const NODE_ARCHIVES: Record<string, { extension: "tar.gz"; sha256: string }> = {
  "linux-x64": { extension: "tar.gz", sha256: "f625d97cd707df4ff96254916fbc5ff014f09c09effe5a1e0ca8f6d41a8789d4" },
  "linux-arm64": { extension: "tar.gz", sha256: "d28c8a5bf0a808f0ed434a1dce8c54ae98f0371c0bd86ac58abc613f73e6643f" },
  "darwin-x64": { extension: "tar.gz", sha256: "d1b5e999db158c62fe8f7267a4476b035d8bd93b1a605bac24a3f0dd166e3316" },
  "darwin-arm64": { extension: "tar.gz", sha256: "8294b7aa9b03997481c06babf1e8b270c859358f27da57a11509afe537ac381d" },
};
const MAX_NODE_ARCHIVE_BYTES = 256 * 1024 * 1024;
const MAX_DOWNLOAD_MS = 10 * 60_000;
const VERSION_PROBE_MS = 5_000;
const SOURCE_TEST_MS = 8_000;

type StoredInstallSources = {
  version: 1;
  revision: number;
  settings: AppInstallSourceSettings;
  updatedAt?: string;
};

type NodeRuntime = {
  state: "host" | "private";
  root: string;
  nodeExecutable: string;
  npmExecutable: string;
  version: string;
  npmVersion: string;
};

export type AptSourceConfiguration = {
  sourcesFile: string;
  listsDir: string;
  options: string[];
  mainMirror: string;
  securityMirror: string;
  codename: string;
  distro: "debian" | "ubuntu";
};

type OsRelease = {
  id: string;
  codename?: string;
  idLike: string[];
};

export type AppInstallEnvironmentManagerOptions = {
  dataDir: string;
  stateDir: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  arch?: NodeJS.Architecture;
  osReleasePath?: string;
  fetcher?: typeof fetch;
  now?: () => string;
  warn?: (message: string) => void;
};

export type AppInstallExecutionPolicy = {
  revision: number;
  effective: AppInstallEffectiveSources;
  npmRegistry?: string;
  prepareNodeRuntime: () => Promise<NodeRuntime>;
  nodeEnvironment: (base: NodeJS.ProcessEnv) => NodeJS.ProcessEnv;
  aptSourceConfiguration: () => AptSourceConfiguration | undefined;
};

export class AppInstallEnvironmentError extends Error {
  readonly code: string;
  readonly statusCode: number;

  constructor(code: string, message: string, statusCode = 400) {
    super(message);
    this.name = "AppInstallEnvironmentError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

const execFileAsync = promisify(execFile);

function trimSourceUrl(value: string | undefined) {
  return value?.replace(/\/+$/, "");
}

function parseVersion(value: string) {
  const match = value.trim().match(/^v?(\d+)\.(\d+)\.(\d+)/);
  return match ? match.slice(1).map(Number) : undefined;
}

export function nodeVersionAtLeast(actual: string, minimum: string) {
  const left = parseVersion(actual);
  const right = parseVersion(minimum);
  if (!left || !right) return false;
  for (let index = 0; index < 3; index += 1) {
    if (left[index] > right[index]) return true;
    if (left[index] < right[index]) return false;
  }
  return true;
}

function defaultSettings(): AppInstallSourceSettings {
  return { profile: "environment", custom: {} };
}

const CUSTOM_SOURCE_KEYS = ["npmRegistry", "nodeDistUrl", "aptMainMirror", "aptSecurityMirror"] as const;

function sanitizeCustom(value: unknown): AppInstallSourceCustom {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const source = value as Record<string, unknown>;
  const custom: AppInstallSourceCustom = {};
  for (const key of CUSTOM_SOURCE_KEYS) {
    if (typeof source[key] !== "string") continue;
    const parsed = AppInstallSourceUrlSchema.safeParse(trimSourceUrl(source[key].trim()));
    if (parsed.success) custom[key] = parsed.data;
  }
  return custom;
}

function sanitizeSettings(value: unknown): AppInstallSourceSettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) return defaultSettings();
  const source = value as Record<string, unknown>;
  const profile = APP_INSTALL_SOURCE_PROFILES.includes(source.profile as AppInstallSourceProfile)
    ? source.profile as AppInstallSourceProfile
    : "environment";
  return { profile, custom: sanitizeCustom(source.custom) };
}

function readOsRelease(file: string): OsRelease | undefined {
  let content: string;
  try {
    content = fs.readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
  const values = new Map<string, string>();
  for (const line of content.split(/\r?\n/)) {
    const match = line.match(/^([A-Z_]+)=(.*)$/);
    if (!match) continue;
    values.set(match[1], match[2].replace(/^['"]|['"]$/g, "").trim());
  }
  const idLike = (values.get("ID_LIKE") || "").split(/\s+/).filter(Boolean);
  return {
    id: (values.get("ID") || "unknown").toLowerCase(),
    codename: values.get("VERSION_CODENAME") || values.get("UBUNTU_CODENAME") || undefined,
    idLike,
  };
}

function platformNodeName(platform: NodeJS.Platform) {
  if (platform === "linux") return "linux";
  if (platform === "darwin") return "darwin";
  return undefined;
}

function nodeArchiveFor(platform: NodeJS.Platform, arch: string) {
  const name = platformNodeName(platform);
  return name ? NODE_ARCHIVES[`${name}-${arch}`] : undefined;
}

function processPathFor(base: NodeJS.ProcessEnv) {
  const key = Object.keys(base).find((name) => name.toUpperCase() === "PATH");
  return key ? base[key] || "" : "";
}

function withPath(base: NodeJS.ProcessEnv, binDir: string) {
  const current = processPathFor(base);
  const next = [binDir, ...current.split(path.delimiter)].filter(Boolean);
  return { ...base, PATH: [...new Set(next)].join(path.delimiter) };
}

function executableIn(binDir: string, command: string, platform: NodeJS.Platform) {
  const candidates = platform === "win32" ? [`${command}.cmd`, `${command}.exe`, command] : [command];
  for (const candidate of candidates) {
    const value = path.join(binDir, candidate);
    try {
      if (fs.statSync(value).isFile()) return value;
    } catch {
      // Continue through the platform shim candidates.
    }
  }
  return undefined;
}

export class AppInstallEnvironmentManager {
  private readonly dataDir: string;
  private readonly stateDir: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly platform: NodeJS.Platform;
  private readonly arch: NodeJS.Architecture;
  private readonly osReleasePath: string;
  private readonly fetcher: typeof fetch;
  private readonly now: () => string;
  private readonly warn: (message: string) => void;
  private readonly listeners = new Set<() => void>();
  private stored: StoredInstallSources;
  private cachedNodeStatus?: { expiresAt: number; value: AppInstallNodeToolchain };
  private cachedPrivateRuntime?: NodeRuntime;
  private preparePromise?: Promise<NodeRuntime>;

  constructor(options: AppInstallEnvironmentManagerOptions) {
    this.dataDir = options.dataDir;
    this.stateDir = options.stateDir;
    this.env = options.env || process.env;
    this.platform = options.platform || process.platform;
    this.arch = options.arch || process.arch;
    this.osReleasePath = options.osReleasePath || "/etc/os-release";
    this.fetcher = options.fetcher || fetch;
    this.now = options.now || (() => new Date().toISOString());
    this.warn = options.warn || (() => {});
    this.stored = this.read();
  }

  private get sourcePath() {
    return path.join(this.dataDir, SOURCE_FILE);
  }

  private get toolchainRoot() {
    return path.join(this.dataDir, "toolchains", "node");
  }

  private get toolchainVersionRoot() {
    return path.join(this.toolchainRoot, `v${MANAGED_NODE_VERSION}`);
  }

  private get toolchainManifestPath() {
    return path.join(this.toolchainRoot, "current.json");
  }

  private read(): StoredInstallSources {
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(this.sourcePath, "utf8"));
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
      if (code !== "ENOENT") this.warn(`Install source settings could not be read: ${error instanceof Error ? error.message : String(error)}`);
      return { version: 1, revision: 0, settings: defaultSettings() };
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { version: 1, revision: 0, settings: defaultSettings() };
    }
    const source = parsed as Record<string, unknown>;
    const revision = typeof source.revision === "number" && Number.isInteger(source.revision) && source.revision >= 0
      ? source.revision
      : 0;
    return {
      version: 1,
      revision,
      settings: sanitizeSettings(source.settings),
      ...(typeof source.updatedAt === "string" ? { updatedAt: source.updatedAt } : {}),
    };
  }

  onChange(listener: () => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify() {
    for (const listener of this.listeners) listener();
  }

  get revision() {
    return this.stored.revision;
  }

  get settings() {
    return this.stored.settings;
  }

  supportsNodeToolchain() {
    return Boolean(nodeArchiveFor(this.platform, this.arch));
  }

  supportsAptSources() {
    return this.platform === "linux" && Boolean(this.aptDistro()?.codename);
  }

  update(input: unknown) {
    let update: z.infer<typeof AppInstallSourceUpdateSchema>;
    let settings: z.infer<typeof AppInstallSourceSettingsSchema>;
    try {
      update = AppInstallSourceUpdateSchema.parse(input);
      if (update.expectedRevision !== undefined && update.expectedRevision !== this.stored.revision) {
        throw new AppInstallEnvironmentError(
          "install_sources_revision_conflict",
          `Install source settings changed from revision ${update.expectedRevision} to ${this.stored.revision}.`,
          409,
        );
      }
      settings = AppInstallSourceSettingsSchema.parse(update.settings);
    } catch (error) {
      if (error instanceof z.ZodError) {
        throw new AppInstallEnvironmentError("install_sources_input_invalid", error.message, 400);
      }
      throw error;
    }
    const normalized: AppInstallSourceSettings = {
      profile: settings.profile,
      custom: Object.fromEntries(Object.entries(settings.custom).map(([key, value]) => [key, trimSourceUrl(value)])),
    };
    this.stored = {
      version: 1,
      revision: this.stored.revision + 1,
      settings: normalized,
      updatedAt: this.now(),
    };
    atomicWriteJsonSync(this.sourcePath, this.stored);
    this.cachedNodeStatus = undefined;
    this.notify();
    return this.snapshot();
  }

  private osRelease() {
    return readOsRelease(this.osReleasePath);
  }

  private aptDistro() {
    const release = this.osRelease();
    if (!release) return undefined;
    const family = [release.id, ...release.idLike];
    if (family.includes("ubuntu")) return { distro: "ubuntu" as const, codename: release.codename };
    if (family.includes("debian")) return { distro: "debian" as const, codename: release.codename };
    return undefined;
  }

  private officialAptMirrors() {
    const distro = this.aptDistro();
    if (distro?.distro === "ubuntu") {
      const ports = ["arm64", "arm", "riscv64", "ppc64", "s390x"].includes(this.arch);
      return {
        aptMainMirror: ports ? "https://ports.ubuntu.com/ubuntu-ports" : "https://archive.ubuntu.com/ubuntu",
        aptSecurityMirror: ports ? "https://ports.ubuntu.com/ubuntu-ports" : "https://security.ubuntu.com/ubuntu",
      };
    }
    return { aptMainMirror: "https://deb.debian.org/debian", aptSecurityMirror: "https://security.debian.org/debian-security" };
  }

  private chinaAptMirrors() {
    const distro = this.aptDistro();
    if (distro?.distro === "ubuntu") {
      const ports = ["arm64", "arm", "riscv64", "ppc64", "s390x"].includes(this.arch);
      const base = ports
        ? "https://mirrors.tuna.tsinghua.edu.cn/ubuntu-ports"
        : "https://mirrors.tuna.tsinghua.edu.cn/ubuntu";
      return { aptMainMirror: base, aptSecurityMirror: base };
    }
    return {
      aptMainMirror: "https://mirrors.tuna.tsinghua.edu.cn/debian",
      aptSecurityMirror: "https://mirrors.tuna.tsinghua.edu.cn/debian-security",
    };
  }

  effectiveSources(): AppInstallEffectiveSources {
    if (this.stored.settings.profile === "environment") return {};
    const aptSupported = this.supportsAptSources();
    const officialApt = aptSupported ? this.officialAptMirrors() : undefined;
    if (this.stored.settings.profile === "official") {
      return {
        npmRegistry: "https://registry.npmjs.org",
        nodeDistUrl: "https://nodejs.org/dist",
        ...officialApt,
      };
    }
    if (this.stored.settings.profile === "china") {
      return {
        npmRegistry: "https://registry.npmmirror.com",
        nodeDistUrl: "https://mirrors.cloud.tencent.com/nodejs-release",
        ...(aptSupported ? this.chinaAptMirrors() : {}),
      };
    }
    return {
      npmRegistry: this.stored.settings.custom.npmRegistry || "https://registry.npmjs.org",
      nodeDistUrl: this.stored.settings.custom.nodeDistUrl || "https://nodejs.org/dist",
      ...(officialApt ? {
        aptMainMirror: this.stored.settings.custom.aptMainMirror || officialApt.aptMainMirror,
        aptSecurityMirror: this.stored.settings.custom.aptSecurityMirror || officialApt.aptSecurityMirror,
      } : {}),
    };
  }

  private privateRuntime(): NodeRuntime | undefined {
    if (this.cachedPrivateRuntime) return this.cachedPrivateRuntime;
    let manifest: unknown;
    try {
      manifest = JSON.parse(fs.readFileSync(this.toolchainManifestPath, "utf8"));
    } catch {
      return undefined;
    }
    if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) return undefined;
    const value = manifest as Record<string, unknown>;
    if (value.version !== MANAGED_NODE_VERSION || typeof value.root !== "string") return undefined;
    const root = path.resolve(value.root);
    const expectedRoot = path.resolve(this.toolchainVersionRoot);
    if (root !== expectedRoot) return undefined;
    const nodeExecutable = executableIn(path.join(root, "bin"), "node", this.platform);
    const npmExecutable = executableIn(path.join(root, "bin"), "npm", this.platform);
    if (!nodeExecutable || !npmExecutable) return undefined;
    this.cachedPrivateRuntime = {
      state: "private",
      root,
      nodeExecutable,
      npmExecutable,
      version: MANAGED_NODE_VERSION,
      npmVersion: "",
    };
    return this.cachedPrivateRuntime;
  }

  private hostRuntime(): NodeRuntime | undefined {
    const node = resolveExecutable("node", { env: this.env, platform: this.platform });
    const npm = resolveExecutable("npm", { env: this.env, platform: this.platform });
    if (!node || !npm) return undefined;
    return {
      state: "host",
      root: path.dirname(node.executable),
      nodeExecutable: node.executable,
      npmExecutable: npm.executable,
      version: "",
      npmVersion: "",
    };
  }

  private async probeRuntime(runtime: NodeRuntime): Promise<NodeRuntime | undefined> {
    const env = runtime.state === "private" ? withPath(this.env, path.dirname(runtime.nodeExecutable)) : { ...this.env };
    try {
      const [nodeResult, npmResult] = await Promise.all([
        execFileAsync(runtime.nodeExecutable, ["--version"], { env, timeout: VERSION_PROBE_MS, maxBuffer: 1024 * 1024 }),
        execFileAsync(runtime.npmExecutable, ["--version"], { env, timeout: VERSION_PROBE_MS, maxBuffer: 1024 * 1024 }),
      ]);
      const version = String(nodeResult.stdout).trim().replace(/^v/, "");
      const npmVersion = String(npmResult.stdout).trim();
      if (!version || !npmVersion) return undefined;
      return { ...runtime, version, npmVersion };
    } catch {
      return undefined;
    }
  }

  private probeRuntimeSync(runtime: NodeRuntime): NodeRuntime | undefined {
    const env = runtime.state === "private" ? withPath(this.env, path.dirname(runtime.nodeExecutable)) : { ...this.env };
    try {
      const version = String(execFileSync(runtime.nodeExecutable, ["--version"], { env, timeout: VERSION_PROBE_MS, encoding: "utf8" })).trim().replace(/^v/, "");
      const npmVersion = String(execFileSync(runtime.npmExecutable, ["--version"], { env, timeout: VERSION_PROBE_MS, encoding: "utf8" })).trim();
      if (!version || !npmVersion) return undefined;
      return { ...runtime, version, npmVersion };
    } catch {
      return undefined;
    }
  }

  nodeStatus(): AppInstallNodeToolchain {
    if (this.cachedNodeStatus && this.cachedNodeStatus.expiresAt > Date.now()) return this.cachedNodeStatus.value;
    let value: AppInstallNodeToolchain;
    const managed = this.privateRuntime();
    if (managed) {
      value = {
        state: "private",
        version: MANAGED_NODE_VERSION,
        minimumVersion: MINIMUM_NODE_VERSION,
        managedVersion: MANAGED_NODE_VERSION,
      };
    } else {
      const host = this.hostRuntime();
      const artifact = nodeArchiveFor(this.platform, this.arch);
      const probed = host ? this.probeRuntimeSync(host) : undefined;
      value = probed && nodeVersionAtLeast(probed.version, MINIMUM_NODE_VERSION)
        ? {
            state: "host",
            version: probed.version,
            npmVersion: probed.npmVersion,
            minimumVersion: MINIMUM_NODE_VERSION,
            managedVersion: MANAGED_NODE_VERSION,
          }
        : {
            state: "missing",
            minimumVersion: MINIMUM_NODE_VERSION,
            managedVersion: MANAGED_NODE_VERSION,
            ...(!artifact ? { reason: `A private Node.js toolchain is not available for ${this.platform}/${this.arch}.` } : {}),
          };
    }
    this.cachedNodeStatus = { expiresAt: Date.now() + 10_000, value };
    return value;
  }

  async refreshNodeStatus() {
    const privateRuntime = this.privateRuntime();
    if (privateRuntime) {
      const probed = await this.probeRuntime(privateRuntime);
      if (probed) {
        this.cachedPrivateRuntime = probed;
        this.cachedNodeStatus = undefined;
        return this.nodeStatus();
      }
      this.cachedPrivateRuntime = undefined;
    }
    const host = this.hostRuntime();
    if (host) {
      const probed = await this.probeRuntime(host);
      if (probed && nodeVersionAtLeast(probed.version, MINIMUM_NODE_VERSION)) {
        this.cachedNodeStatus = {
          expiresAt: Date.now() + 10_000,
          value: {
            state: "host",
            version: probed.version,
            npmVersion: probed.npmVersion,
            minimumVersion: MINIMUM_NODE_VERSION,
            managedVersion: MANAGED_NODE_VERSION,
          },
        };
        return this.nodeStatus();
      }
    }
    this.cachedNodeStatus = undefined;
    return this.nodeStatus();
  }

  runtimeEnvironment(base: NodeJS.ProcessEnv = this.env) {
    const runtime = this.privateRuntime();
    let env = runtime ? withPath(base, path.dirname(runtime.nodeExecutable)) : { ...base };
    const registry = this.effectiveSources().npmRegistry;
    if (registry) env = { ...env, npm_config_registry: registry, NPM_CONFIG_REGISTRY: registry };
    return env;
  }

  runtimeOverrides(base: NodeJS.ProcessEnv = this.env) {
    return Object.fromEntries(Object.entries(this.runtimeEnvironment(base)).filter(([key, value]) => base[key] !== value));
  }

  capabilities(base: FinalComputerCapabilities): FinalComputerCapabilities {
    const status = this.nodeStatus();
    const npmAvailable = status.state !== "missing" || Boolean(nodeArchiveFor(this.platform, this.arch));
    return npmAvailable && !base.installers.includes("npm")
      ? { ...base, installers: [...base.installers, "npm"] }
      : base;
  }

  private async downloadNodeArtifact(url: string, destination: string) {
    const response = await this.fetcher(url, {
      method: "GET",
      redirect: "follow",
      signal: AbortSignal.timeout(MAX_DOWNLOAD_MS),
    });
    if (!response.ok || !response.body) {
      throw new AppInstallEnvironmentError("node_download_failed", `Node.js archive download failed with HTTP ${response.status}.`, 502);
    }
    const announced = Number(response.headers.get("content-length") || 0);
    if (announced > MAX_NODE_ARCHIVE_BYTES) {
      throw new AppInstallEnvironmentError("node_archive_too_large", "The Node.js archive exceeds the managed download limit.", 413);
    }
    await fs.promises.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
    const output = fs.createWriteStream(destination, { mode: 0o600 });
    let bytes = 0;
    try {
      for await (const chunk of Readable.fromWeb(response.body as import("node:stream/web").ReadableStream)) {
        bytes += chunk.length;
        if (bytes > MAX_NODE_ARCHIVE_BYTES) throw new AppInstallEnvironmentError("node_archive_too_large", "The Node.js archive exceeds the managed download limit.", 413);
        if (!output.write(chunk)) await new Promise<void>((resolve) => output.once("drain", resolve));
      }
    } finally {
      await new Promise<void>((resolve) => output.end(resolve));
    }
    return bytes;
  }

  async prepareNodeRuntime(effective: AppInstallEffectiveSources = this.effectiveSources()): Promise<NodeRuntime> {
    const current = this.privateRuntime();
    if (current) {
      const probed = await this.probeRuntime(current);
      if (probed) return probed;
      this.cachedPrivateRuntime = undefined;
    }
    const host = this.hostRuntime();
    if (host) {
      const probed = await this.probeRuntime(host);
      if (probed && nodeVersionAtLeast(probed.version, MINIMUM_NODE_VERSION)) return probed;
    }
    if (this.preparePromise) return this.preparePromise;
    this.preparePromise = this.installPrivateNodeRuntime(effective).finally(() => {
      this.preparePromise = undefined;
    });
    return this.preparePromise;
  }

  async prepareNodeToolchain() {
    await this.prepareNodeRuntime();
    return this.snapshot();
  }

  private async installPrivateNodeRuntime(effective: AppInstallEffectiveSources): Promise<NodeRuntime> {
    const platformName = platformNodeName(this.platform);
    const artifact = nodeArchiveFor(this.platform, this.arch);
    if (!platformName || !artifact) {
      throw new AppInstallEnvironmentError(
        "node_toolchain_unsupported",
        `A private Node.js toolchain is not available for ${this.platform}/${this.arch}.`,
      );
    }
    const base = effective.nodeDistUrl || "https://nodejs.org/dist";
    const archive = `node-v${MANAGED_NODE_VERSION}-${platformName}-${this.arch}.${artifact.extension}`;
    const url = `${base}/v${MANAGED_NODE_VERSION}/${archive}`;
    const tempRoot = path.join(this.stateDir, "downloads");
    fs.mkdirSync(tempRoot, { recursive: true, mode: 0o700 });
    const download = path.join(tempRoot, `${crypto.randomUUID()}-${archive}`);
    const staging = path.join(this.toolchainRoot, `.staging-${crypto.randomUUID()}`);
    try {
      await this.downloadNodeArtifact(url, download);
      const digest = crypto.createHash("sha256").update(fs.readFileSync(download)).digest("hex");
      if (digest !== artifact.sha256) {
        throw new AppInstallEnvironmentError(
          "node_archive_checksum_mismatch",
          `Node.js archive checksum verification failed for ${url}.`,
          502,
        );
      }
      fs.mkdirSync(staging, { recursive: true, mode: 0o700 });
      await extractTar({
        file: download,
        cwd: staging,
        strip: 1,
        strict: true,
        preserveOwner: false,
        filter: (entryPath) => !entryPath.split("/").includes(".."),
      });
      const nodeExecutable = executableIn(path.join(staging, "bin"), "node", this.platform);
      const npmExecutable = executableIn(path.join(staging, "bin"), "npm", this.platform);
      if (!nodeExecutable || !npmExecutable) {
        throw new AppInstallEnvironmentError("node_archive_invalid", "The Node.js archive did not contain a usable node and npm executable.", 502);
      }
      fs.mkdirSync(this.toolchainRoot, { recursive: true, mode: 0o700 });
      const target = this.toolchainVersionRoot;
      fs.rmSync(target, { recursive: true, force: true });
      fs.renameSync(staging, target);
      const runtime: NodeRuntime = {
        state: "private",
        root: target,
        nodeExecutable: executableIn(path.join(target, "bin"), "node", this.platform)!,
        npmExecutable: executableIn(path.join(target, "bin"), "npm", this.platform)!,
        version: MANAGED_NODE_VERSION,
        npmVersion: "",
      };
      const probed = await this.probeRuntime(runtime);
      if (!probed || !nodeVersionAtLeast(probed.version, MINIMUM_NODE_VERSION)) {
        fs.rmSync(target, { recursive: true, force: true });
        throw new AppInstallEnvironmentError("node_toolchain_verification_failed", "The downloaded Node.js toolchain could not be verified.", 502);
      }
      atomicWriteJsonSync(this.toolchainManifestPath, {
        version: MANAGED_NODE_VERSION,
        root: target,
        sha256: artifact.sha256,
        sourceUrl: url,
        installedAt: this.now(),
      });
      this.cachedPrivateRuntime = { ...probed, root: target, state: "private" };
      this.cachedNodeStatus = undefined;
      this.notify();
      return this.cachedPrivateRuntime;
    } catch (error) {
      fs.rmSync(staging, { recursive: true, force: true });
      throw error;
    } finally {
      fs.rmSync(download, { force: true });
    }
  }

  aptSourceConfiguration(effective: AppInstallEffectiveSources = this.effectiveSources()): AptSourceConfiguration | undefined {
    if (this.stored.settings.profile === "environment") return undefined;
    if (this.platform !== "linux") {
      throw new AppInstallEnvironmentError("apt_source_unsupported", "Custom apt sources are only supported on Linux.", 409);
    }
    const distro = this.aptDistro();
    if (!distro?.codename) {
      throw new AppInstallEnvironmentError("apt_source_unsupported", "The Linux distribution and codename could not be determined for apt source selection.", 409);
    }
    const mainMirror = trimSourceUrl(effective.aptMainMirror);
    const securityMirror = trimSourceUrl(effective.aptSecurityMirror);
    if (!mainMirror || !securityMirror) {
      throw new AppInstallEnvironmentError("apt_source_unsupported", "Both apt main and security mirrors are required.", 409);
    }
    const sourcesFile = path.join(this.stateDir, "apt", "sources.list");
    const listsDir = path.join(this.stateDir, "apt", "lists");
    fs.mkdirSync(path.dirname(sourcesFile), { recursive: true, mode: 0o755 });
    fs.mkdirSync(listsDir, { recursive: true, mode: 0o755 });
    const components = distro.distro === "ubuntu" ? "main restricted universe multiverse" : "main contrib non-free";
    const lines = distro.distro === "ubuntu"
      ? [
          `deb ${mainMirror}/ ${distro.codename} ${components}`,
          `deb ${mainMirror}/ ${distro.codename}-updates ${components}`,
          `deb ${mainMirror}/ ${distro.codename}-backports ${components}`,
          `deb ${securityMirror}/ ${distro.codename}-security ${components}`,
        ]
      : [
          `deb ${mainMirror}/ ${distro.codename} ${components}`,
          `deb ${mainMirror}/ ${distro.codename}-updates ${components}`,
          `deb ${securityMirror}/ ${distro.codename}-security ${components}`,
        ];
    fs.writeFileSync(sourcesFile, `${lines.join("\n")}\n`, { mode: 0o644 });
    return {
      sourcesFile,
      listsDir,
      options: [
        "-o", `Dir::Etc::sourcelist=${sourcesFile}`,
        "-o", "Dir::Etc::sourceparts=-",
        "-o", `Dir::State::lists=${listsDir}`,
        "-o", "APT::Get::List-Cleanup=0",
      ],
      mainMirror,
      securityMirror,
      codename: distro.codename,
      distro: distro.distro,
    };
  }

  snapshot(node: AppInstallNodeToolchain = this.nodeStatus()): AppInstallEnvironment {
    return AppInstallEnvironmentSchema.parse({
      revision: this.stored.revision,
      settings: this.stored.settings,
      effective: this.effectiveSources(),
      node,
      observedAt: this.now(),
    });
  }

  createExecutionPolicy(): AppInstallExecutionPolicy {
    const effective = this.effectiveSources();
    const self = this;
    return {
      revision: this.stored.revision,
      effective,
      ...(effective.npmRegistry ? { npmRegistry: effective.npmRegistry } : {}),
      prepareNodeRuntime: () => self.prepareNodeRuntime(effective),
      nodeEnvironment(base: NodeJS.ProcessEnv) {
        const runtime = self.privateRuntime();
        let env = runtime ? withPath(base, path.dirname(runtime.nodeExecutable)) : { ...base };
        if (effective.npmRegistry) env = { ...env, npm_config_registry: effective.npmRegistry, NPM_CONFIG_REGISTRY: effective.npmRegistry };
        return env;
      },
      aptSourceConfiguration: () => self.aptSourceConfiguration(effective),
    };
  }

  async testSources(): Promise<AppInstallEnvironmentTestResponse> {
    const effective = this.effectiveSources();
    const artifact = nodeArchiveFor(this.platform, this.arch);
    const platformName = platformNodeName(this.platform);
    const apt = this.supportsAptSources() ? this.aptDistro() : undefined;
    const urls: Array<{ id: AppInstallEnvironmentTestCheck["id"]; url: string }> = [];
    if (effective.npmRegistry) urls.push({ id: "npm", url: `${trimSourceUrl(effective.npmRegistry)}/-/ping` });
    if (effective.nodeDistUrl && artifact && platformName) {
      urls.push({ id: "node", url: `${trimSourceUrl(effective.nodeDistUrl)}/v${MANAGED_NODE_VERSION}/node-v${MANAGED_NODE_VERSION}-${platformName}-${this.arch}.${artifact.extension}` });
    }
    if (apt?.codename) {
      if (effective.aptMainMirror) urls.push({ id: "apt-main", url: `${trimSourceUrl(effective.aptMainMirror)}/dists/${apt.codename}/Release` });
      if (effective.aptSecurityMirror) urls.push({ id: "apt-security", url: `${trimSourceUrl(effective.aptSecurityMirror)}/dists/${apt.codename}-security/Release` });
    }
    const checks = await Promise.all(urls.map(async ({ id, url }) => {
      try {
        let response = await this.fetcher(url, {
          method: "HEAD",
          redirect: "follow",
          signal: AbortSignal.timeout(SOURCE_TEST_MS),
        });
        if (!response.ok) {
          response = await this.fetcher(url, {
            method: "GET",
            headers: { range: "bytes=0-0" },
            redirect: "follow",
            signal: AbortSignal.timeout(SOURCE_TEST_MS),
          });
          await response.body?.cancel().catch(() => undefined);
        }
        return AppInstallEnvironmentTestCheckSchema.parse({
          id,
          url,
          ok: response.ok,
          statusCode: response.status,
          ...(!response.ok ? { message: `HTTP ${response.status}` } : {}),
        });
      } catch (error) {
        return AppInstallEnvironmentTestCheckSchema.parse({
          id,
          url,
          ok: false,
          message: error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500),
        });
      }
    }));
    return { checks, testedAt: this.now() };
  }
}
