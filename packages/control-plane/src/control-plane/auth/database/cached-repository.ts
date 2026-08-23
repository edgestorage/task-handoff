import type {
  ControlPlaneRawRecordCollection,
  ControlPlaneRawUserRepository,
  ControlPlaneRecordCollection,
  ControlPlaneUserRepository,
} from "./repository.ts";

type StoredRecord = { id: string };
type CacheState = Record<"users" | "identities" | "roles" | "grants" | "sessions" | "providers" | "approvals" | "audit", Map<string, StoredRecord>>;
const collectionNames = ["users", "identities", "roles", "grants", "sessions", "providers", "approvals", "audit"] as const;

class MutationQueue {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation, operation);
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }
}

function cloneState(state: CacheState): CacheState {
  return Object.fromEntries(collectionNames.map((name) => [name, new Map(state[name])])) as CacheState;
}

function cachedCollection<T extends StoredRecord>(
  raw: ControlPlaneRawRecordCollection<T>,
  records: Map<string, StoredRecord>,
  mutate: <R>(operation: () => Promise<R>) => Promise<R>,
): ControlPlaneRecordCollection<T> {
  return {
    list: () => [...records.values()] as T[],
    get: (id) => records.get(id) as T | undefined,
    async put(record) {
      return mutate(async () => {
        const persisted = await raw.put(record);
        records.set(record.id, persisted);
        return persisted;
      });
    },
    async delete(id) {
      return mutate(async () => {
        const deleted = await raw.delete(id);
        if (deleted) records.delete(id);
        return deleted;
      });
    },
  };
}

function repositoryFor(raw: ControlPlaneRawUserRepository, state: CacheState, queue: MutationQueue, inTransaction = false): ControlPlaneUserRepository {
  const mutate = <T>(operation: () => Promise<T>) => inTransaction ? operation() : queue.run(operation);
  const repository: ControlPlaneUserRepository = {
    dialect: raw.dialect,
    users: cachedCollection(raw.users, state.users, mutate),
    identities: cachedCollection(raw.identities, state.identities, mutate),
    roles: cachedCollection(raw.roles, state.roles, mutate),
    grants: cachedCollection(raw.grants, state.grants, mutate),
    sessions: cachedCollection(raw.sessions, state.sessions, mutate),
    providers: cachedCollection(raw.providers, state.providers, mutate),
    approvals: cachedCollection(raw.approvals, state.approvals, mutate),
    audit: cachedCollection(raw.audit, state.audit, mutate),
    metadata: () => raw.metadata(),
    putMetadata: (metadata) => raw.putMetadata(metadata),
    migration: (id) => raw.migration(id),
    putMigration: (record) => raw.putMigration(record),
    async transaction(operation) {
      if (inTransaction) return operation(repository);
      return queue.run(async () => {
      const transactionState = cloneState(state);
      const result = await raw.transaction((transaction) => operation(repositoryFor(transaction, transactionState, queue, true)));
      for (const name of collectionNames) {
        state[name].clear();
        for (const [id, record] of transactionState[name]) state[name].set(id, record);
      }
      return result;
      });
    },
    close: () => raw.close(),
  };
  return repository;
}

export async function createCachedUserRepository(raw: ControlPlaneRawUserRepository): Promise<ControlPlaneUserRepository> {
  const loaded = await Promise.all(collectionNames.map((name) => raw[name].list()));
  const state = Object.fromEntries(collectionNames.map((name, index) => [
    name,
    new Map(loaded[index].map((record) => [record.id, record] as const)),
  ])) as CacheState;
  return repositoryFor(raw, state, new MutationQueue());
}
