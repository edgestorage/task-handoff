import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import writeFileAtomic from "write-file-atomic";
import { createEntityId } from "@task-handoff/protocol";
import { DEFAULT_APP_PROFILE_NAME } from "@task-handoff/protocol/app-profiles";

const PROFILE_REGISTRY_VERSION = 1;
const PROFILE_NAME_MAX_LENGTH = 60;
const PROFILE_USAGE_CACHE_TTL_MS = 60_000;

export type ChromiumProfileRecord = {
  id: string;
  name: string;
  directory: string;
  createdAt: string;
  updatedAt: string;
};

type ChromiumProfileRegistry = {
  version: number;
  defaultProfileId?: string;
  profiles: ChromiumProfileRecord[];
};

export type ChromiumProfileStoreOptions = {
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  onWarning?: (message: string, details?: Record<string, unknown>) => void;
};

function emptyRegistry(): ChromiumProfileRegistry {
  return { version: PROFILE_REGISTRY_VERSION, profiles: [] };
}

function profileError(code: string, message: string, details?: Record<string, unknown>) {
  return Object.assign(new Error(message), { code, ...(details ? { details } : {}) });
}

function normalizeProfileName(name: unknown) {
  if (typeof name !== "string") {
    throw profileError("BROWSER_PROFILE_NAME_INVALID", "Browser profile name must be a string.");
  }
  const trimmed = name.trim();
  // eslint-disable-next-line no-control-regex
  if (!trimmed || trimmed.length > PROFILE_NAME_MAX_LENGTH || /[\u0000-\u001f\u007f]/.test(trimmed)) {
    throw profileError("BROWSER_PROFILE_NAME_INVALID", `Browser profile name must contain between 1 and ${PROFILE_NAME_MAX_LENGTH} visible characters.`);
  }
  return trimmed;
}

/**
 * Persistent browser profiles owned by the controlled instance.
 *
 * The registry lives outside app session directories so stopping, deleting or
 * garbage collecting a browser session never touches profile data. Chromium
 * locks one user-data-dir to a single browser process, which is why the
 * runtime allows at most one running session per profile.
 */
export class ChromiumProfileStore {
  readonly root: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly now: () => Date;
  private readonly onWarning?: (message: string, details?: Record<string, unknown>) => void;
  private readonly usageCache = new Map<string, { bytes: number; measuredAt: number }>();
  private warmedEnvOverride?: string;

  constructor(dataDir: string, options: ChromiumProfileStoreOptions = {}) {
    this.root = path.join(dataDir, "chromium-profiles");
    this.env = options.env || process.env;
    this.now = options.now || (() => new Date());
    this.onWarning = options.onWarning;
  }

  private registryPath() {
    return path.join(this.root, "index.json");
  }

  private warn(message: string, details?: Record<string, unknown>) {
    this.onWarning?.(message, details);
  }

  private sanitizeRegistry(value: unknown): ChromiumProfileRegistry {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return emptyRegistry();
    }
    const record = value as Record<string, unknown>;
    if (Object.keys(record).some((key) => !["version", "defaultProfileId", "profiles"].includes(key))) {
      this.warn("browser profile registry contained unknown fields");
    }
    const profiles: ChromiumProfileRecord[] = [];
    if (Array.isArray(record.profiles)) {
      for (const entry of record.profiles) {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
        const item = entry as Record<string, unknown>;
        const id = typeof item.id === "string" ? item.id.trim() : "";
        const name = typeof item.name === "string" ? item.name.trim() : "";
        const directory = typeof item.directory === "string" ? item.directory.trim() : "";
        const createdAt = typeof item.createdAt === "string" ? item.createdAt : "";
        const updatedAt = typeof item.updatedAt === "string" ? item.updatedAt : "";
        if (!id || !name || !directory || !path.isAbsolute(directory) || !createdAt || !updatedAt) {
          this.warn("skipped an invalid browser profile registry entry", { id: id || undefined });
          continue;
        }
        profiles.push({ id, name, directory, createdAt, updatedAt });
      }
    }
    const defaultProfileId = typeof record.defaultProfileId === "string" && record.defaultProfileId.trim()
      ? record.defaultProfileId.trim()
      : undefined;
    return {
      version: typeof record.version === "number" ? record.version : PROFILE_REGISTRY_VERSION,
      ...(defaultProfileId && profiles.some((profile) => profile.id === defaultProfileId) ? { defaultProfileId } : {}),
      profiles,
    };
  }

  private read(): ChromiumProfileRegistry {
    const registryPath = this.registryPath();
    if (!fs.existsSync(registryPath)) return emptyRegistry();
    try {
      return this.sanitizeRegistry(JSON.parse(fs.readFileSync(registryPath, "utf8")));
    } catch (error) {
      this.warn("browser profile registry could not be parsed", { error: error instanceof Error ? error.message : String(error) });
      return emptyRegistry();
    }
  }

  private write(registry: ChromiumProfileRegistry) {
    fs.mkdirSync(this.root, { recursive: true, mode: 0o700 });
    writeFileAtomic.sync(this.registryPath(), `${JSON.stringify({
      version: PROFILE_REGISTRY_VERSION,
      ...(registry.defaultProfileId ? { defaultProfileId: registry.defaultProfileId } : {}),
      profiles: registry.profiles,
    }, null, 2)}\n`, { mode: 0o600 });
  }

  private touch(registry: ChromiumProfileRegistry, profileId: string) {
    const profile = registry.profiles.find((candidate) => candidate.id === profileId);
    if (!profile) throw profileError("BROWSER_PROFILE_NOT_FOUND", `Browser profile ${profileId} was not found.`);
    profile.updatedAt = this.now().toISOString();
    this.write(registry);
    return profile;
  }

  private envOverrideDirectory() {
    const configured = this.env.TASK_HANDOFF_CHROMIUM_USER_DATA_DIR?.trim();
    return configured ? path.resolve(configured) : undefined;
  }

  private ensureDirectory(directory: string) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    return directory;
  }

  /**
   * Idempotently ensure the instance default profile exists. Deployments that
   * configured TASK_HANDOFF_CHROMIUM_USER_DATA_DIR bind the default profile to
   * that directory; changing the override later is reported but never moves
   * existing profile data.
   */
  ensureDefault() {
    const registry = this.read();
    const current = registry.profiles.find((profile) => profile.id === registry.defaultProfileId);
    const override = this.envOverrideDirectory();
    if (current) {
      if (override && override !== current.directory && this.warmedEnvOverride !== override) {
        this.warmedEnvOverride = override;
        this.warn("TASK_HANDOFF_CHROMIUM_USER_DATA_DIR changed after the default browser profile was created; existing profile directory is kept", {
          profileId: current.id,
          directory: current.directory,
        });
      }
      return current;
    }
    const id = createEntityId("brp");
    const timestamp = this.now().toISOString();
    const directory = this.ensureDirectory(override || path.join(this.root, id));
    const profile: ChromiumProfileRecord = { id, name: DEFAULT_APP_PROFILE_NAME, directory, createdAt: timestamp, updatedAt: timestamp };
    registry.profiles.push(profile);
    registry.defaultProfileId = id;
    this.write(registry);
    return profile;
  }

  list(): ChromiumProfileRecord[] {
    const registry = this.read();
    return registry.profiles.slice().sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  }

  defaultProfileId(): string {
    return this.ensureDefault().id;
  }

  create(name: string): ChromiumProfileRecord {
    const normalized = normalizeProfileName(name);
    const registry = this.read();
    if (registry.profiles.some((profile) => profile.name.toLowerCase() === normalized.toLowerCase())) {
      throw profileError("BROWSER_PROFILE_NAME_CONFLICT", `Browser profile name "${normalized}" already exists.`);
    }
    const timestamp = this.now().toISOString();
    let id = createEntityId("brp");
    while (registry.profiles.some((profile) => profile.id === id) || fs.existsSync(path.join(this.root, id))) {
      id = createEntityId("brp");
    }
    const directory = this.ensureDirectory(path.join(this.root, id));
    const profile: ChromiumProfileRecord = { id, name: normalized, directory, createdAt: timestamp, updatedAt: timestamp };
    registry.profiles.push(profile);
    this.write(registry);
    return profile;
  }

  rename(profileId: string, name: string): ChromiumProfileRecord {
    const normalized = normalizeProfileName(name);
    const registry = this.read();
    if (registry.profiles.some((profile) => profile.id !== profileId && profile.name.toLowerCase() === normalized.toLowerCase())) {
      throw profileError("BROWSER_PROFILE_NAME_CONFLICT", `Browser profile name "${normalized}" already exists.`);
    }
    const profile = registry.profiles.find((candidate) => candidate.id === profileId);
    if (!profile) throw profileError("BROWSER_PROFILE_NOT_FOUND", `Browser profile ${profileId} was not found.`);
    profile.name = normalized;
    profile.updatedAt = this.now().toISOString();
    this.write(registry);
    return profile;
  }

  remove(profileId: string): void {
    const registry = this.read();
    const profile = registry.profiles.find((candidate) => candidate.id === profileId);
    if (!profile) throw profileError("BROWSER_PROFILE_NOT_FOUND", `Browser profile ${profileId} was not found.`);
    if (registry.defaultProfileId === profileId) {
      throw profileError("BROWSER_PROFILE_DEFAULT_PROTECTED", "The default browser profile cannot be removed; change the default profile first.", { profileId });
    }
    registry.profiles = registry.profiles.filter((candidate) => candidate.id !== profileId);
    if (registry.defaultProfileId && !registry.profiles.some((candidate) => candidate.id === registry.defaultProfileId)) {
      registry.defaultProfileId = undefined;
    }
    this.write(registry);
    fs.rmSync(profile.directory, { recursive: true, force: true });
    this.usageCache.delete(profileId);
  }

  setDefault(profileId: string): ChromiumProfileRecord {
    const registry = this.read();
    const profile = registry.profiles.find((candidate) => candidate.id === profileId);
    if (!profile) throw profileError("BROWSER_PROFILE_NOT_FOUND", `Browser profile ${profileId} was not found.`);
    registry.defaultProfileId = profileId;
    this.write(registry);
    return profile;
  }

  find(profileId: string): ChromiumProfileRecord | undefined {
    return this.read().profiles.find((profile) => profile.id === profileId);
  }

  resolveLaunchProfile(profileId: string): ChromiumProfileRecord {
    const normalized = typeof profileId === "string" ? profileId.trim() : "";
    if (!normalized || normalized.includes("/") || normalized.includes("\\") || normalized.includes("\u0000")) {
      throw profileError("BROWSER_PROFILE_NOT_FOUND", "Browser profile id is invalid.", { profileId: normalized });
    }
    const profile = this.find(normalized);
    if (!profile) throw profileError("BROWSER_PROFILE_NOT_FOUND", `Browser profile ${normalized} was not found.`, { profileId: normalized });
    this.ensureDirectory(profile.directory);
    return profile;
  }

  async usageBytes(profileId: string): Promise<number> {
    const cached = this.usageCache.get(profileId);
    const measuredAt = this.now().getTime();
    if (cached && measuredAt - cached.measuredAt < PROFILE_USAGE_CACHE_TTL_MS) {
      return cached.bytes;
    }
    const profile = this.find(profileId);
    if (!profile) throw profileError("BROWSER_PROFILE_NOT_FOUND", `Browser profile ${profileId} was not found.`);
    const bytes = await directorySize(profile.directory);
    this.usageCache.set(profileId, { bytes, measuredAt });
    return bytes;
  }
}

async function directorySize(directory: string): Promise<number> {
  let total = 0;
  let entries: fs.Dirent[];
  try {
    entries = await fsp.readdir(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return 0;
    throw error;
  }
  for (const entry of entries) {
    const target = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      total += await directorySize(target);
      continue;
    }
    if (!entry.isFile()) continue;
    try {
      total += (await fsp.stat(target)).size;
    } catch {
      // A browser may rotate cache files while the directory is measured.
    }
  }
  return total;
}
