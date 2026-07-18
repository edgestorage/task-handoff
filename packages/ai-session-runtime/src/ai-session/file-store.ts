import fs from "node:fs";
import path from "node:path";
import writeFileAtomic from "write-file-atomic";
import type { AiSessionStatus } from "@task-handoff/protocol/ai-sessions";
import { AiSessionIdentityIndex, providerSessionIdentity } from "./identity-index";
import { sanitizePersistedAiSession } from "./persistence";

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
 * Owns all file and provider-index mutations for persisted AI sessions.
 * The index is deliberately self-healing and never authoritative: an index
 * miss scans disk, while every hit is re-read and identity-checked.
 */
export class AiSessionFileStore {
  readonly dir: string;
  private readonly index = new AiSessionIdentityIndex();
  private readonly selectProviderCandidate: (sessions: readonly AiSessionStatus[]) => AiSessionStatus | undefined;

  constructor(options: AiSessionFileStoreOptions) {
    this.dir = path.resolve(options.dir);
    this.selectProviderCandidate = options.selectProviderCandidate || newestSession;
  }

  sessionPath(id: string) {
    assertSafeSessionId(id);
    return path.join(this.dir, `${id}.json`);
  }

  get(id: string) {
    if (!isSafeSessionId(id)) {
      return undefined;
    }
    const session = sanitizePersistedAiSession(readJson(this.sessionPath(id)));
    if (!session || session.id !== id) {
      this.index.remove(id);
      return undefined;
    }
    return session;
  }

  list() {
    this.ensureDirectory();
    let files: string[];
    try {
      files = fs.readdirSync(this.dir).filter((name) => name.endsWith(".json"));
    } catch {
      return [];
    }
    const sessions = files
      .map((name) => ({
        expectedId: name.slice(0, -".json".length),
        session: sanitizePersistedAiSession(readJson(path.join(this.dir, name))),
      }))
      .filter(({ expectedId, session }) => session?.id === expectedId)
      .map(({ session }) => session)
      .filter((session): session is AiSessionStatus => Boolean(session))
      .sort((lhs, rhs) => Date.parse(rhs.updatedAt) - Date.parse(lhs.updatedAt));
    this.index.rebuild(sessions);
    return sessions;
  }

  save(session: AiSessionStatus) {
    assertSafeSessionId(session.id);
    this.ensureDirectory();
    writeFileAtomic.sync(this.sessionPath(session.id), `${JSON.stringify(session, null, 2)}\n`, { encoding: "utf8" });
    this.index.replace(session);
    return session;
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
    let removed = false;
    try {
      fs.rmSync(filePath);
      removed = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
    this.index.remove(id);
    return removed;
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
    const valid = indexed
      .map((id) => this.get(id))
      .filter((session): session is AiSessionStatus => Boolean(
        session
        && session.agent === identity.agent
        && session.providerSessionId === identity.providerSessionId,
      ));
    if (valid.length) {
      return this.selectProviderCandidate(valid);
    }

    // Do not negatively cache misses. A different process may have atomically
    // added a session since the last index build.
    const matches = this.list().filter((session) => (
      session.agent === identity.agent
      && session.providerSessionId === identity.providerSessionId
    ));
    return matches.length ? this.selectProviderCandidate(matches) : undefined;
  }

  private ensureDirectory() {
    fs.mkdirSync(this.dir, { recursive: true });
  }
}
