import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import writeFileAtomic from "write-file-atomic";
import type { z } from "zod";

export type StoredRecord = {
  id: string;
  createdAt: string;
  updatedAt: string;
};

function ensureDirectory(directory: string, mode?: number) {
  fs.mkdirSync(directory, { recursive: true, ...(mode === undefined ? {} : { mode }) });
  if (mode !== undefined) fs.chmodSync(directory, mode);
}

function writeJsonAtomic(filePath: string, value: unknown, options: { directoryMode?: number; fileMode?: number } = {}) {
  ensureDirectory(path.dirname(filePath), options.directoryMode);
  writeFileAtomic.sync(filePath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    ...(options.fileMode === undefined ? {} : { mode: options.fileMode }),
  });
  if (options.fileMode !== undefined) fs.chmodSync(filePath, options.fileMode);
}

type StoreLogger = (message: string, details: Record<string, unknown>) => void;
type StoreOptions<T> = {
  schema?: z.ZodType<T>;
  sanitize?: (value: unknown) => unknown;
  logger?: StoreLogger;
  directoryMode?: number;
  fileMode?: number;
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
    ensureDirectory(this.directory, this.options.directoryMode);
    if (this.options.fileMode !== undefined) {
      for (const name of fs.readdirSync(this.directory).filter((entry) => entry.endsWith(".json"))) {
        fs.chmodSync(path.join(this.directory, name), this.options.fileMode);
      }
    }
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
    this.init();
    const filePath = this.filePath(id);
    return fs.existsSync(filePath) ? parseStored(filePath, this.options) : undefined;
  }

  put(record: T) {
    const candidate = this.options.sanitize ? this.options.sanitize(record) : record;
    const value = this.options.schema ? this.options.schema.parse(candidate) : candidate as T;
    writeJsonAtomic(this.filePath(value.id), value, this.options);
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
    ensureDirectory(path.dirname(this.filePathValue), this.options.directoryMode);
    if (!fs.existsSync(this.filePathValue)) {
      this.put(this.defaults());
    } else if (this.options.fileMode !== undefined) {
      fs.chmodSync(this.filePathValue, this.options.fileMode);
    }
  }

  get() {
    this.init();
    return fs.existsSync(this.filePathValue) ? parseStored(this.filePathValue, this.options) ?? this.defaults() : this.defaults();
  }

  put(value: T) {
    const candidate = this.options.sanitize ? this.options.sanitize(value) : value;
    const parsed = this.options.schema ? this.options.schema.parse(candidate) : candidate as T;
    writeJsonAtomic(this.filePathValue, parsed, this.options);
    return parsed;
  }
}
