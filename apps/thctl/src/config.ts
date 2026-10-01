import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { ThctlError, usageError } from "./errors.ts";

export const CLI_CONFIG_DIR_ENV = "TASK_HANDOFF_CLI_CONFIG_DIR";
export const CLI_PROFILE_ENV = "TASK_HANDOFF_CLI_PROFILE";

const PROFILE_FILE_VERSION = 1;

/** profile 只保存连接元数据；session token 永远不进入这个文件。 */
export const CliProfileSchema = z.object({
  label: z.string().trim().min(1).max(120),
  origin: z.string().trim().url().max(2048),
  controlPlaneId: z.string().trim().min(1).max(160),
  fingerprint: z.string().regex(/^sha256:[A-Za-z0-9_-]{43}$/),
  protocolVersion: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  capabilities: z.unknown().optional(),
  loginMode: z.enum(["browser", "device"]).optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  trustedAt: z.string().datetime(),
  lastUsedAt: z.string().datetime().optional(),
  identityChangedAt: z.string().datetime().optional(),
  replacedFingerprint: z.string().regex(/^sha256:[A-Za-z0-9_-]{43}$/).optional(),
});
export type CliProfile = z.infer<typeof CliProfileSchema>;

const ProfileFileSchema = z.object({
  version: z.number().int().positive(),
  defaultProfile: z.string().trim().min(1).max(120).optional(),
  profiles: z.array(CliProfileSchema).default([]),
});

const CredentialFileSchema = z.object({
  version: z.number().int().positive(),
  credentials: z.record(z.string(), z.object({
    sessionToken: z.string().trim().min(32),
    sessionId: z.string().trim().min(1).optional(),
    expiresAt: z.string().datetime().optional(),
    savedAt: z.string().datetime(),
  })).default({}),
});

export type CliCredential = {
  sessionToken: string;
  sessionId?: string;
  expiresAt?: string;
  savedAt: string;
};

export interface CliSecretStore {
  read(label: string): CliCredential | undefined;
  write(label: string, credential: CliCredential): void;
  remove(label: string): void;
}

export function resolveCliConfigDir(env: Record<string, string | undefined> = process.env) {
  const override = env[CLI_CONFIG_DIR_ENV]?.trim();
  if (override) return path.resolve(override);
  const xdg = env.XDG_CONFIG_HOME?.trim();
  return path.join(xdg && path.isAbsolute(xdg) ? xdg : path.join(os.homedir(), ".config"), "task-handoff", "cli");
}

function ensurePrivateDirectory(directory: string) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(directory, 0o700);
  } catch {
    // 目录属主之外的挂载点可能拒绝 chmod；权限收紧失败不阻断读取。
  }
}

function writePrivateFile(file: string, value: unknown) {
  ensurePrivateDirectory(path.dirname(file));
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, file);
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // 同上：无法收紧权限时交给操作系统默认值，读取仍可继续。
  }
}

function readJsonFile(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    return undefined;
  }
}

export class CliProfileStore {
  readonly file: string;
  readonly credentialFile: string;
  readonly warnings: string[] = [];
  readonly directory: string;

  constructor(directory: string) {
    this.directory = directory;
    this.file = path.join(directory, "profiles.json");
    this.credentialFile = path.join(directory, "credentials.json");
  }

  list() {
    return this.#read().profiles;
  }

  defaultProfile() {
    return this.#read().defaultProfile;
  }

  get(label: string) {
    return this.#read().profiles.find((profile) => profile.label === label);
  }

  findByOrigin(origin: string) {
    return this.#read().profiles.find((profile) => profile.origin === origin);
  }

  findByControlPlane(controlPlaneId: string, fingerprint: string) {
    return this.#read().profiles.find((profile) => profile.controlPlaneId === controlPlaneId && profile.fingerprint === fingerprint);
  }

  save(profile: CliProfile) {
    const parsed = CliProfileSchema.parse(profile);
    const current = this.#read();
    const profiles = [...current.profiles.filter((entry) => entry.label !== parsed.label), parsed];
    this.#write({ ...current, profiles });
    return parsed;
  }

  remove(label: string) {
    const current = this.#read();
    const profiles = current.profiles.filter((entry) => entry.label !== label);
    if (profiles.length === current.profiles.length) return false;
    this.#write({
      ...current,
      profiles,
      defaultProfile: current.defaultProfile === label ? profiles[0]?.label : current.defaultProfile,
    });
    this.secrets().remove(label);
    return true;
  }

  setDefault(label: string) {
    const current = this.#read();
    if (!current.profiles.some((profile) => profile.label === label)) {
      throw new ThctlError("CLI_PROFILE_UNKNOWN", `Unknown profile \`${label}\`. Run \`thctl profile list\` to see configured profiles.`, 7, { profile: label });
    }
    this.#write({ ...current, defaultProfile: label });
  }

  /**
   * 选择生效 profile：--profile 参数 > TASK_HANDOFF_CLI_PROFILE > 默认 profile > 唯一 profile。
   * 选择失败时不发起任何网络请求。
   */
  select(requested?: string, env: Record<string, string | undefined> = process.env) {
    const current = this.#read();
    const label = requested?.trim() || env[CLI_PROFILE_ENV]?.trim() || current.defaultProfile;
    if (label) {
      const profile = current.profiles.find((entry) => entry.label === label);
      if (!profile) {
        throw new ThctlError("CLI_PROFILE_UNKNOWN", `Unknown profile \`${label}\`. Run \`thctl profile list\` to see configured profiles.`, 7, { profile: label });
      }
      return profile;
    }
    if (current.profiles.length === 1) return current.profiles[0];
    if (current.profiles.length === 0) {
      throw new ThctlError("CLI_PROFILE_MISSING", "No Control Plane profile configured. Run `thctl profile add <origin>` first.", 7);
    }
    throw usageError("CLI_PROFILE_REQUIRED", "Multiple profiles are configured. Select one with `--profile <label>` or `thctl profile use <label>`.");
  }

  markUsed(profile: CliProfile) {
    return this.save({ ...profile, lastUsedAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  }

  secrets(): CliSecretStore {
    return new FileSecretStore(this.credentialFile, this.warnings);
  }

  #read() {
    const raw = readJsonFile(this.file);
    if (raw === undefined) return { version: PROFILE_FILE_VERSION, profiles: [] as CliProfile[] };
    const parsed = ProfileFileSchema.safeParse(raw);
    if (!parsed.success) {
      this.warnings.push(`Ignoring unreadable profile file ${this.file}; run \`thctl profile add\` to recreate it.`);
      return { version: PROFILE_FILE_VERSION, profiles: [] as CliProfile[] };
    }
    return { ...parsed.data, profiles: parsed.data.profiles.filter((profile) => profile.label !== "") };
  }

  #write(value: { version: number; defaultProfile?: string; profiles: CliProfile[] }) {
    writePrivateFile(this.file, {
      version: PROFILE_FILE_VERSION,
      ...(value.defaultProfile ? { defaultProfile: value.defaultProfile } : {}),
      profiles: value.profiles,
    });
  }
}

class FileSecretStore implements CliSecretStore {
  private readonly file: string;
  private readonly warnings: string[];

  constructor(file: string, warnings: string[]) {
    this.file = file;
    this.warnings = warnings;
  }

  read(label: string) {
    const parsed = this.#read();
    return parsed.credentials[label];
  }

  write(label: string, credential: CliCredential) {
    const parsed = this.#read();
    parsed.credentials[label] = credential;
    this.#write(parsed);
  }

  remove(label: string) {
    const parsed = this.#read();
    if (!(label in parsed.credentials)) return;
    delete parsed.credentials[label];
    this.#write(parsed);
  }

  #read() {
    const raw = readJsonFile(this.file);
    if (raw === undefined) return { version: PROFILE_FILE_VERSION, credentials: {} as Record<string, CliCredential> };
    const parsed = CredentialFileSchema.safeParse(raw);
    if (!parsed.success) {
      this.warnings.push(`Ignoring unreadable credential file ${this.file}; sign in again with \`thctl login\`.`);
      return { version: PROFILE_FILE_VERSION, credentials: {} as Record<string, CliCredential> };
    }
    return parsed.data;
  }

  #write(value: { version: number; credentials: Record<string, CliCredential> }) {
    writePrivateFile(this.file, value);
  }
}

export function normalizeControlPlaneOrigin(input: string) {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw usageError("CLI_ORIGIN_INVALID", "Enter a Control Plane URL such as `https://control.example.com`.");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw usageError("CLI_ORIGIN_INVALID", "The Control Plane address cannot contain credentials, query parameters, or a fragment.");
  }
  if (url.pathname !== "/" && url.pathname !== "") {
    throw usageError("CLI_ORIGIN_INVALID", "Enter the Control Plane origin without a page or API path.");
  }
  return url.origin;
}

export function profileLabelFromOrigin(origin: string) {
  const url = new URL(origin);
  const host = url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "::1" ? "local" : url.hostname;
  const base = `${host}${url.port ? `-${url.port}` : ""}`.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return (base || "control-plane").slice(0, 64);
}
