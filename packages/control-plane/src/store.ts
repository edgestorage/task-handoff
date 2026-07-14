import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import writeFileAtomic from "write-file-atomic";
import type { z } from "zod";

export type StoredRecord = {
  id: string;
  createdAt: string;
  updatedAt: string;
};

export type ControlPlaneStorePaths = {
  dataDir: string;
  settingsPath: string;
  projectsDir: string;
  modelsDir: string;
  imagesDir: string;
  nodesDir: string;
  nodeRuntimesDir: string;
  controlledInstancesDir: string;
  chatSessionsDir: string;
  chatBridgesDir: string;
  triggersDir: string;
  nodeJoinInvitesDir: string;
  authUsersDir: string;
  authSessionsDir: string;
  logsDir: string;
};

export type NodeAgentStorePaths = {
  dataDir: string;
  identityPath: string;
  settingsPath: string;
  localFoldersDir: string;
  nodeRuntimesDir: string;
  controlledInstancesDir: string;
  updatesDir: string;
  logsDir: string;
};

export function defaultControlPlaneDataDir() {
  return process.env.TASK_HANDOFF_CONTROL_PLANE_DATA_DIR || path.join(os.homedir(), ".config", "task-handoff", "control-plane");
}

export function defaultNodeAgentDataDir() {
  return process.env.TASK_HANDOFF_NODE_AGENT_DATA_DIR || path.join(os.homedir(), ".config", "task-handoff", "node-agent");
}

export function controlPlaneStorePaths(dataDir = defaultControlPlaneDataDir()): ControlPlaneStorePaths {
  const root = path.resolve(dataDir);
  return {
    dataDir: root,
    settingsPath: path.join(root, "control-plane-settings.json"),
    projectsDir: path.join(root, "projects"),
    modelsDir: path.join(root, "models"),
    imagesDir: path.join(root, "images"),
    nodesDir: path.join(root, "nodes"),
    nodeRuntimesDir: path.join(root, "node-runtimes"),
    controlledInstancesDir: path.join(root, "controlled-instances"),
    chatSessionsDir: path.join(root, "chat-sessions"),
    chatBridgesDir: path.join(root, "chat-bridges"),
    triggersDir: path.join(root, "triggers"),
    nodeJoinInvitesDir: path.join(root, "node-join-invites"),
    authUsersDir: path.join(root, "auth-users"),
    authSessionsDir: path.join(root, "auth-sessions"),
    logsDir: path.join(root, "logs"),
  };
}

export function nodeAgentStorePaths(dataDir = defaultNodeAgentDataDir()): NodeAgentStorePaths {
  const root = path.resolve(dataDir);
  return {
    dataDir: root,
    identityPath: path.join(root, "identity.json"),
    settingsPath: path.join(root, "runtime-settings.json"),
    localFoldersDir: path.join(root, "local-folders"),
    nodeRuntimesDir: path.join(root, "node-runtimes"),
    controlledInstancesDir: path.join(root, "controlled-instances"),
    updatesDir: path.join(root, "updates"),
    logsDir: path.join(root, "logs"),
  };
}

function ensureDirectory(directory: string) {
  fs.mkdirSync(directory, { recursive: true });
}

function writeJsonAtomic(filePath: string, value: unknown) {
  ensureDirectory(path.dirname(filePath));
  writeFileAtomic.sync(filePath, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8" });
}

type StoreLogger = (message: string, details: Record<string, unknown>) => void;
type StoreOptions<T> = {
  schema?: z.ZodType<T>;
  sanitize?: (value: unknown) => unknown;
  logger?: StoreLogger;
};

function defaultStoreLogger(message: string, details: Record<string, unknown>) {
  console.warn(JSON.stringify({ message, ...details }));
}

function errorDetails(error: unknown) {
  if (error && typeof error === "object" && "issues" in error) return { issues: error.issues };
  return { error: error instanceof Error ? error.message : String(error) };
}

function parseStored<T>(filePath: string, options: StoreOptions<T>): T | undefined {
  const logger = options.logger || defaultStoreLogger;
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    logger("stored JSON could not be read", { filePath, ...errorDetails(error) });
    return undefined;
  }
  if (!options.schema) return raw as T;
  const sanitized = options.sanitize ? options.sanitize(raw) : raw;
  const parsed = options.schema.safeParse(sanitized);
  if (parsed.success) return parsed.data;

  const strip = "strip" in options.schema && typeof options.schema.strip === "function"
    ? options.schema.strip().safeParse(sanitized)
    : undefined;
  if (strip?.success) {
    logger("unknown stored fields were ignored", { filePath, issues: parsed.error.issues });
    return strip.data as T;
  }
  logger("stored record failed validation and was isolated", { filePath, issues: parsed.error.issues });
  return undefined;
}

export function createId(prefix: string) {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
}

export function createSecret() {
  return crypto.randomBytes(24).toString("base64url");
}

export class JsonCollection<T extends StoredRecord> {
  private readonly directory: string;
  private readonly options: StoreOptions<T>;

  constructor(directory: string, options: StoreOptions<T> = {}) {
    this.directory = directory;
    this.options = options;
  }

  init() {
    ensureDirectory(this.directory);
  }

  filePath(id: string) {
    return path.join(this.directory, `${id}.json`);
  }

  list() {
    this.init();
    return fs
      .readdirSync(this.directory)
      .filter((name) => name.endsWith(".json"))
      .sort()
      .flatMap((name) => {
        const record = parseStored(path.join(this.directory, name), this.options);
        return record ? [record] : [];
      });
  }

  get(id: string) {
    const filePath = this.filePath(id);
    return fs.existsSync(filePath) ? parseStored(filePath, this.options) : undefined;
  }

  put(record: T) {
    const candidate = this.options.sanitize ? this.options.sanitize(record) : record;
    const value = this.options.schema ? this.options.schema.parse(candidate) : candidate as T;
    writeJsonAtomic(this.filePath(value.id), value);
    return value;
  }

  patch(id: string, patch: Partial<T>) {
    const current = this.get(id);
    if (!current) {
      return undefined;
    }
    const updated = {
      ...current,
      ...patch,
      id: current.id,
      createdAt: current.createdAt,
      updatedAt: new Date().toISOString(),
    } as T;
    return this.put(updated);
  }

  delete(id: string) {
    const filePath = this.filePath(id);
    if (!fs.existsSync(filePath)) {
      return false;
    }
    fs.unlinkSync(filePath);
    return true;
  }
}

export class JsonFile<T> {
  private readonly filePathValue: string;
  private readonly defaults: () => T;
  private readonly options: StoreOptions<T>;

  constructor(filePath: string, defaults: () => T, options: StoreOptions<T> = {}) {
    this.filePathValue = filePath;
    this.defaults = defaults;
    this.options = options;
  }

  init() {
    ensureDirectory(path.dirname(this.filePathValue));
    if (!fs.existsSync(this.filePathValue)) {
      this.put(this.defaults());
    }
  }

  get() {
    this.init();
    return fs.existsSync(this.filePathValue) ? parseStored(this.filePathValue, this.options) ?? this.defaults() : this.defaults();
  }

  put(value: T) {
    const candidate = this.options.sanitize ? this.options.sanitize(value) : value;
    const parsed = this.options.schema ? this.options.schema.parse(candidate) : candidate as T;
    writeJsonAtomic(this.filePathValue, parsed);
    return parsed;
  }
}
