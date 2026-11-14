import fs from "node:fs";
import path from "node:path";
import writeFileAtomic from "write-file-atomic";
import type { AiSessionStatus } from "@task-handoff/protocol/ai-sessions";
import { AiSessionIdentityIndex, providerSessionIdentity } from "./identity-index";
import { decodePersistedAiSession, encodePersistedAiSession } from "./persistence";

export type AiSessionFileStoreOptions = {
  dir: string;
  selectProviderCandidate?: (sessions: readonly AiSessionStatus[]) => AiSessionStatus | undefined;
};

const STORAGE_FULL_CODES = new Set(["ENOSPC", "EDQUOT", "SQLITE_FULL"]);
const STORAGE_UNAVAILABLE_CODES = new Set(["EIO", "EROFS"]);
const STORAGE_FAILURE_CODES = new Set([...STORAGE_FULL_CODES, ...STORAGE_UNAVAILABLE_CODES]);
const SQLITE_FULL_ERRCODE = 13;

function normalizedCode(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim().toUpperCase() : undefined;
}

function isSqliteFullError(record: Record<string, unknown>) {
  if (Number(record.errcode) === SQLITE_FULL_ERRCODE) return true;
  return typeof record.errstr === "string" && /database or disk is full/i.test(record.errstr);
}

function errorCode(error: unknown, seen = new Set<unknown>()): string | undefined {
  if (!error || typeof error !== "object" || seen.has(error)) return undefined;
  seen.add(error);
  const record = error as Record<string, unknown>;
  const code = normalizedCode(record.code) ?? normalizedCode(record.sqliteCode) ?? normalizedCode(record.storageCode);
  // node:sqlite reports SQLITE_FULL as ERR_SQLITE_ERROR with errcode 13.
  if (code === "ERR_SQLITE_ERROR" && isSqliteFullError(record)) return "SQLITE_FULL";
  if (code) return code;
  if (isSqliteFullError(record)) return "SQLITE_FULL";
  const errno = normalizedCode(record.errno);
  if (errno) return errno;
  return errorCode(record.cause, seen);
}

export type AiSessionStorageFailureClass = {
  storageCode: string;
  code: "AI_SESSION_STORAGE_FULL" | "AI_SESSION_STORAGE_UNAVAILABLE";
  statusCode: 507 | 503;
  message: string;
};

function classifyStorageCode(storageCode: string | undefined): AiSessionStorageFailureClass | undefined {
  if (!storageCode) return undefined;
  if (STORAGE_FULL_CODES.has(storageCode)) {
    return {
      storageCode,
      code: "AI_SESSION_STORAGE_FULL",
      statusCode: 507,
      message: "AI Session storage is full.",
    };
  }
  if (STORAGE_UNAVAILABLE_CODES.has(storageCode)) {
    return {
      storageCode,
      code: "AI_SESSION_STORAGE_UNAVAILABLE",
      statusCode: 503,
      message: "AI Session storage is unavailable.",
    };
  }
  return undefined;
}

/**
 * Storage failures can surface from any AI Session persistence backend, not only
 * AiSessionFileStore. Keep the classification shared so event degradation and the
 * HTTP boundary agree on which errors are storage outages.
 */
export function classifyAiSessionStorageFailure(error: unknown): AiSessionStorageFailureClass | undefined {
  if (error instanceof AiSessionPersistenceError) {
    return error.storageFailure ? classifyStorageCode(error.storageCode) : undefined;
  }
  return classifyStorageCode(errorCode(error));
}

export class AiSessionPersistenceError extends Error {
  readonly code: string;
  readonly statusCode: number;
  readonly sessionId: string;
  readonly storageCode?: string;
  readonly storageFailure: boolean;

  constructor(input: { sessionId: string; storageCode?: string; message: string; statusCode: number; code: string; cause?: unknown }) {
    super(input.message, input.cause === undefined ? undefined : { cause: input.cause });
    this.name = "AiSessionPersistenceError";
    this.sessionId = input.sessionId;
    this.storageCode = input.storageCode;
    this.storageFailure = Boolean(input.storageCode && STORAGE_FAILURE_CODES.has(input.storageCode));
    this.statusCode = input.statusCode;
    this.code = input.code;
  }

  static from(error: unknown, sessionId: string) {
    const storage = classifyAiSessionStorageFailure(error);
    if (storage) {
      return new AiSessionPersistenceError({
        sessionId,
        storageCode: storage.storageCode,
        code: storage.code,
        statusCode: storage.statusCode,
        message: storage.message,
        cause: error,
      });
    }
    return new AiSessionPersistenceError({
      sessionId,
      storageCode: errorCode(error),
      code: "AI_SESSION_PERSISTENCE_FAILED",
      statusCode: 500,
      message: error instanceof Error ? error.message : String(error),
      cause: error,
    });
  }
}

export function isAiSessionStorageFailure(error: unknown) {
  return classifyAiSessionStorageFailure(error) !== undefined;
}

function newestSession(sessions: readonly AiSessionStatus[]) {
  return [...sessions].sort((lhs, rhs) => {
    const timeDifference = Date.parse(rhs.updatedAt) - Date.parse(lhs.updatedAt);
    return timeDifference || rhs.id.localeCompare(lhs.id);
  })[0];
}

function isSafeSessionId(id: string) {
  return Boolean(id && id !== "." && id !== ".." && !id.includes("/") && !id.includes("\\") && !id.includes("\0"));
}

function assertSafeSessionId(id: string) {
  if (!isSafeSessionId(id)) {
    throw new Error(`Invalid AI session id: ${JSON.stringify(id)}`);
  }
}

function readJson(filePath: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return undefined;
  }
}

/**
 * Owns the process-local AI Session authority and its restart persistence.
 * Disk is read once during construction; all runtime reads use the in-memory
 * map, and successful writes update the map and provider index together.
 */
export class AiSessionFileStore {
  readonly dir: string;
  private readonly sessions = new Map<string, AiSessionStatus>();
  private readonly index = new AiSessionIdentityIndex();
  private readonly selectProviderCandidate: (sessions: readonly AiSessionStatus[]) => AiSessionStatus | undefined;

  constructor(options: AiSessionFileStoreOptions) {
    this.dir = path.resolve(options.dir);
    this.selectProviderCandidate = options.selectProviderCandidate || newestSession;
    this.load();
  }

  sessionPath(id: string) {
    assertSafeSessionId(id);
    return path.join(this.dir, `${id}.json`);
  }

  get(id: string) {
    if (!isSafeSessionId(id)) {
      return undefined;
    }
    return this.sessions.get(id);
  }

  list() {
    return [...this.sessions.values()]
      .sort((lhs, rhs) => Date.parse(rhs.updatedAt) - Date.parse(lhs.updatedAt));
  }

  save(session: AiSessionStatus) {
    assertSafeSessionId(session.id);
    let committed: AiSessionStatus | undefined;
    try {
      this.ensureDirectory();
      const persisted = encodePersistedAiSession(session);
      writeFileAtomic.sync(this.sessionPath(session.id), `${JSON.stringify(persisted, null, 2)}\n`, { encoding: "utf8" });
      committed = decodePersistedAiSession(persisted);
      if (!committed) {
        throw new Error(`Failed to decode persisted AI session ${JSON.stringify(session.id)}`);
      }
    } catch (error) {
      throw error instanceof AiSessionPersistenceError ? error : AiSessionPersistenceError.from(error, session.id);
    }
    this.sessions.set(committed.id, committed);
    this.index.replace(committed);
    return committed;
  }

  update(id: string, mutate: (current: AiSessionStatus) => AiSessionStatus) {
    const current = this.get(id);
    if (!current) {
      return undefined;
    }
    const next = mutate(current);
    if (next.id !== id) {
      throw new Error(`AI session update cannot change id from ${JSON.stringify(id)} to ${JSON.stringify(next.id)}`);
    }
    return this.save(next);
  }

  remove(id: string) {
    const filePath = this.sessionPath(id);
    const existed = this.sessions.has(id);
    try {
      fs.rmSync(filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
    this.sessions.delete(id);
    this.index.remove(id);
    return existed;
  }

  removeMany(ids: Iterable<string>) {
    let removed = 0;
    for (const id of new Set(ids)) {
      removed += Number(this.remove(id));
    }
    return removed;
  }

  findByProviderSession(agent: string, providerSessionId: string) {
    const identity = providerSessionIdentity(agent, providerSessionId);
    if (!identity) {
      return undefined;
    }

    const indexed = this.index.candidates(identity.agent, identity.providerSessionId);
    const matches = indexed
      .map((id) => this.sessions.get(id))
      .filter((session): session is AiSessionStatus => Boolean(
        session
        && session.agent === identity.agent
        && session.providerSessionId === identity.providerSessionId,
      ));
    return matches.length ? this.selectProviderCandidate(matches) : undefined;
  }

  private load() {
    this.ensureDirectory();
    let files: string[];
    try {
      files = fs.readdirSync(this.dir).filter((name) => name.endsWith(".json"));
    } catch {
      files = [];
    }
    for (const name of files) {
      const expectedId = name.slice(0, -".json".length);
      const session = decodePersistedAiSession(readJson(path.join(this.dir, name)));
      if (session?.id === expectedId) {
        this.sessions.set(session.id, session);
      }
    }
    this.index.rebuild([...this.sessions.values()]);
  }

  private ensureDirectory() {
    fs.mkdirSync(this.dir, { recursive: true });
  }
}
