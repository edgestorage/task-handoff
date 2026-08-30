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
    this.ensureDirectory();
    const persisted = encodePersistedAiSession(session);
    writeFileAtomic.sync(this.sessionPath(session.id), `${JSON.stringify(persisted, null, 2)}\n`, { encoding: "utf8" });
    const committed = decodePersistedAiSession(persisted);
    if (!committed) {
      throw new Error(`Failed to decode persisted AI session ${JSON.stringify(session.id)}`);
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
