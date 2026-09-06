import { AsyncLocalStorage } from "node:async_hooks";
import { and, asc, count, desc, eq, inArray, notInArray } from "drizzle-orm";
import type { NodeSQLiteDatabase } from "drizzle-orm/node-sqlite";
import type { NodeAgentDatabase } from "./database.ts";
import * as schema from "./schema.ts";

export type StoryRecord = typeof schema.stories.$inferSelect;
export type StoryActionRecord = typeof schema.actions.$inferSelect;
export type StoryDocumentRecord = typeof schema.documents.$inferSelect;
export type StoryAutomationRecord = typeof schema.automations.$inferSelect;
export type StoryAutomationRunRecord = typeof schema.automationRuns.$inferSelect;
export type StoryFileMutationRecord = typeof schema.fileMutations.$inferSelect;
export type StoryDeletionIntentRecord = typeof schema.deletionIntents.$inferSelect;

type NewStoryRecord = typeof schema.stories.$inferInsert;
type NewStoryActionRecord = typeof schema.actions.$inferInsert;
type NewStoryDocumentRecord = typeof schema.documents.$inferInsert;
type NewStoryAutomationRecord = typeof schema.automations.$inferInsert;
type NewStoryAutomationRunRecord = typeof schema.automationRuns.$inferInsert;
type NewStoryFileMutationRecord = typeof schema.fileMutations.$inferInsert;
type NewStoryDeletionIntentRecord = typeof schema.deletionIntents.$inferInsert;

class MutationQueue {
  private tail: Promise<void> = Promise.resolve();
  private accepting = true;

  run<T>(operation: () => Promise<T>): Promise<T> {
    if (!this.accepting) return Promise.reject(repositoryError("NODE_AGENT_REPOSITORY_QUIESCING", "Node Agent storage is shutting down.", 503));
    const result = this.tail.then(operation, operation);
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }

  async barrier() {
    await this.tail;
  }

  stopAccepting() {
    this.accepting = false;
  }
}

export type NodeAgentRepository = ReturnType<typeof createNodeAgentRepository>;

export function createNodeAgentRepository(database: NodeAgentDatabase) {
  const db: NodeSQLiteDatabase = database.db;
  const queue = new MutationQueue();
  const transactionContext = new AsyncLocalStorage<boolean>();
  let closed = false;

  const assertOpen = () => {
    if (closed) throw repositoryError("NODE_AGENT_REPOSITORY_CLOSED", "Node Agent storage is closed.", 503);
  };
  const read = async <T>(operation: () => Promise<T>): Promise<T> => {
    assertOpen();
    if (!transactionContext.getStore()) await queue.barrier();
    return operation();
  };
  const mutate = async <T>(operation: () => Promise<T>): Promise<T> => {
    assertOpen();
    return transactionContext.getStore() ? operation() : queue.run(operation);
  };

  let repository: {
    stories: ReturnType<typeof storyRepository>;
    actions: ReturnType<typeof actionRepository>;
    documents: ReturnType<typeof documentRepository>;
    automations: ReturnType<typeof automationRepository>;
    runs: ReturnType<typeof runRepository>;
    fileMutations: ReturnType<typeof fileMutationRepository>;
    deletionIntents: ReturnType<typeof deletionIntentRepository>;
    transaction<T>(operation: (repository: NodeAgentRepository) => Promise<T>): Promise<T>;
    stopAccepting(): void;
    drain(): Promise<void>;
    checkpoint(): Promise<void>;
    close(): Promise<void>;
  };

  const transaction = async <T>(operation: (repository: NodeAgentRepository) => Promise<T>): Promise<T> => {
    if (transactionContext.getStore()) return operation(repository as NodeAgentRepository);
    return mutate(async () => {
      database.client.exec("BEGIN IMMEDIATE");
      try {
        const result = await transactionContext.run(true, () => operation(repository as NodeAgentRepository));
        database.client.exec("COMMIT");
        return result;
      } catch (error) {
        database.client.exec("ROLLBACK");
        throw error;
      }
    });
  };

  repository = {
    stories: storyRepository(db, read, mutate),
    actions: actionRepository(db, read, mutate),
    documents: documentRepository(db, read, mutate),
    automations: automationRepository(db, read, mutate),
    runs: runRepository(db, read, mutate),
    fileMutations: fileMutationRepository(db, read, mutate),
    deletionIntents: deletionIntentRepository(db, read, mutate),
    transaction,
    stopAccepting() { queue.stopAccepting(); },
    async drain() { await queue.barrier(); },
    async checkpoint() { await queue.barrier(); await database.checkpoint(); },
    async close() {
      if (closed) return;
      queue.stopAccepting();
      await queue.barrier();
      await database.checkpoint();
      closed = true;
      await database.close();
    },
  };
  return repository;
}

type Read = <T>(operation: () => Promise<T>) => Promise<T>;
type Mutate = <T>(operation: () => Promise<T>) => Promise<T>;

function storyRepository(db: NodeSQLiteDatabase, read: Read, mutate: Mutate) {
  return {
    list: () => read(() => db.select().from(schema.stories).orderBy(desc(schema.stories.createdAt), asc(schema.stories.id))),
    async get(id: string) {
      return read(async () => (await db.select().from(schema.stories).where(eq(schema.stories.id, id)).limit(1))[0]);
    },
    async insert(value: NewStoryRecord) {
      return mutate(async () => { await db.insert(schema.stories).values(value); return value as StoryRecord; });
    },
    async update(id: string, patch: Partial<Omit<NewStoryRecord, "id" | "createdAt">>) {
      return mutate(async () => {
        await db.update(schema.stories).set(patch).where(eq(schema.stories.id, id));
        return (await db.select().from(schema.stories).where(eq(schema.stories.id, id)).limit(1))[0];
      });
    },
    async delete(id: string) {
      return mutate(async () => Number((await db.delete(schema.stories).where(eq(schema.stories.id, id))).changes) > 0);
    },
  };
}

function actionRepository(db: NodeSQLiteDatabase, read: Read, mutate: Mutate) {
  return {
    list(storyId: string) {
      return read(() => db.select().from(schema.actions).where(eq(schema.actions.storyId, storyId)).orderBy(asc(schema.actions.displayOrder), asc(schema.actions.id)));
    },
    async replace(storyId: string, values: NewStoryActionRecord[]) {
      return mutate(async () => {
        const ids = values.map((value) => value.id);
        if (ids.length) await db.delete(schema.actions).where(and(eq(schema.actions.storyId, storyId), notInArray(schema.actions.id, ids)));
        else await db.delete(schema.actions).where(eq(schema.actions.storyId, storyId));
        for (const value of values) {
          await db.insert(schema.actions).values(value).onConflictDoUpdate({
            target: [schema.actions.storyId, schema.actions.id],
            set: {
              title: value.title,
              promptTemplate: value.promptTemplate,
              targetInstanceId: value.targetInstanceId,
              sessionPreset: value.sessionPreset,
              displayOrder: value.displayOrder,
            },
          });
        }
        return values as StoryActionRecord[];
      });
    },
  };
}

function documentRepository(db: NodeSQLiteDatabase, read: Read, mutate: Mutate) {
  return {
    list(storyId: string) {
      return read(() => db.select().from(schema.documents).where(eq(schema.documents.storyId, storyId)).orderBy(asc(schema.documents.displayOrder), asc(schema.documents.storyPath)));
    },
    async get(storyId: string, storyPath: string) {
      return read(async () => (await db.select().from(schema.documents).where(and(eq(schema.documents.storyId, storyId), eq(schema.documents.storyPath, storyPath))).limit(1))[0]);
    },
    async page(storyId: string, page: number, pageSize: number) {
      return read(async () => {
        const totalItems = Number((await db.select({ value: count() }).from(schema.documents).where(eq(schema.documents.storyId, storyId)))[0]?.value ?? 0);
        const items = await db.select({ title: schema.documents.title, storyPath: schema.documents.storyPath })
          .from(schema.documents).where(eq(schema.documents.storyId, storyId))
          .orderBy(desc(schema.documents.indexedSequence), asc(schema.documents.storyPath))
          .limit(pageSize).offset((page - 1) * pageSize);
        return { items, totalItems };
      });
    },
    async insert(value: NewStoryDocumentRecord) {
      return mutate(async () => { await db.insert(schema.documents).values(value); return value as StoryDocumentRecord; });
    },
    async update(storyId: string, storyPath: string, patch: Partial<Omit<NewStoryDocumentRecord, "storyId" | "storyPath" | "indexedSequence">>) {
      return mutate(async () => {
        await db.update(schema.documents).set(patch).where(and(eq(schema.documents.storyId, storyId), eq(schema.documents.storyPath, storyPath)));
      });
    },
    async replacePath(storyId: string, storyPath: string, value: NewStoryDocumentRecord) {
      return mutate(async () => {
        await db.delete(schema.documents).where(and(eq(schema.documents.storyId, storyId), eq(schema.documents.storyPath, storyPath)));
        await db.insert(schema.documents).values(value);
      });
    },
    async reorder(storyId: string, storyPaths: string[]) {
      return mutate(async () => {
        for (const [displayOrder, storyPath] of storyPaths.entries()) {
          await db.update(schema.documents).set({ displayOrder }).where(and(eq(schema.documents.storyId, storyId), eq(schema.documents.storyPath, storyPath)));
        }
      });
    },
    async delete(storyId: string, storyPath: string) {
      return mutate(async () => Number((await db.delete(schema.documents).where(and(eq(schema.documents.storyId, storyId), eq(schema.documents.storyPath, storyPath)))).changes) > 0);
    },
  };
}

function automationRepository(db: NodeSQLiteDatabase, read: Read, mutate: Mutate) {
  return {
    list(storyId?: string) {
      return read(() => storyId
        ? db.select().from(schema.automations).where(eq(schema.automations.storyId, storyId)).orderBy(asc(schema.automations.createdAt), asc(schema.automations.id))
        : db.select().from(schema.automations).orderBy(asc(schema.automations.createdAt), asc(schema.automations.id)));
    },
    async get(id: string) {
      return read(async () => (await db.select().from(schema.automations).where(eq(schema.automations.id, id)).limit(1))[0]);
    },
    async insert(value: NewStoryAutomationRecord) {
      return mutate(async () => { await db.insert(schema.automations).values(value); return value as StoryAutomationRecord; });
    },
    async update(id: string, patch: Partial<Omit<NewStoryAutomationRecord, "id" | "storyId" | "createdAt">>) {
      return mutate(async () => {
        await db.update(schema.automations).set(patch).where(eq(schema.automations.id, id));
        return (await db.select().from(schema.automations).where(eq(schema.automations.id, id)).limit(1))[0];
      });
    },
    async referencingActions(storyId: string, actionIds: string[]) {
      if (!actionIds.length) return [];
      return read(() => db.select().from(schema.automations).where(and(eq(schema.automations.storyId, storyId), inArray(schema.automations.actionId, actionIds))));
    },
    async delete(id: string) {
      return mutate(async () => Number((await db.delete(schema.automations).where(eq(schema.automations.id, id))).changes) > 0);
    },
    async deleteForStory(storyId: string) {
      return mutate(async () => { await db.delete(schema.automations).where(eq(schema.automations.storyId, storyId)); });
    },
  };
}

function runRepository(db: NodeSQLiteDatabase, read: Read, mutate: Mutate) {
  const activeStatuses = ["queued", "dispatching", "running"] as const;
  return {
    list(automationId: string) {
      return read(() => db.select().from(schema.automationRuns).where(eq(schema.automationRuns.automationId, automationId)).orderBy(desc(schema.automationRuns.queuedAt)));
    },
    async get(id: string) {
      return read(async () => (await db.select().from(schema.automationRuns).where(eq(schema.automationRuns.id, id)).limit(1))[0]);
    },
    async byExecutionKey(executionKey: string) {
      return read(async () => (await db.select().from(schema.automationRuns).where(eq(schema.automationRuns.executionKey, executionKey)).limit(1))[0]);
    },
    pending() {
      return read(() => db.select().from(schema.automationRuns).where(inArray(schema.automationRuns.status, [...activeStatuses])).orderBy(asc(schema.automationRuns.queuedAt)));
    },
    async activeForStory(storyId: string) {
      return read(() => db.select({ run: schema.automationRuns }).from(schema.automationRuns)
        .innerJoin(schema.automations, eq(schema.automationRuns.automationId, schema.automations.id))
        .where(and(eq(schema.automations.storyId, storyId), inArray(schema.automationRuns.status, [...activeStatuses])))
        .then((rows) => rows.map((row) => row.run)));
    },
    async insert(value: NewStoryAutomationRunRecord) {
      return mutate(async () => { await db.insert(schema.automationRuns).values(value); return value as StoryAutomationRunRecord; });
    },
    async update(id: string, patch: Partial<Omit<NewStoryAutomationRunRecord, "id" | "automationId" | "executionKey" | "requestFingerprint" | "executionInput" | "queuedAt">>) {
      return mutate(async () => {
        await db.update(schema.automationRuns).set(patch).where(eq(schema.automationRuns.id, id));
        return (await db.select().from(schema.automationRuns).where(eq(schema.automationRuns.id, id)).limit(1))[0];
      });
    },
    async trimTerminal(automationId: string, retain: number) {
      return mutate(async () => {
        const terminal = await db.select({ id: schema.automationRuns.id }).from(schema.automationRuns)
          .where(and(eq(schema.automationRuns.automationId, automationId), inArray(schema.automationRuns.status, ["completed", "failed", "skipped"])))
          .orderBy(desc(schema.automationRuns.queuedAt)).limit(2_147_483_647).offset(retain);
        if (terminal.length) await db.delete(schema.automationRuns).where(inArray(schema.automationRuns.id, terminal.map((row) => row.id)));
      });
    },
  };
}

function fileMutationRepository(db: NodeSQLiteDatabase, read: Read, mutate: Mutate) {
  return {
    list: () => read(() => db.select().from(schema.fileMutations).orderBy(asc(schema.fileMutations.createdAt))),
    async get(id: string) { return read(async () => (await db.select().from(schema.fileMutations).where(eq(schema.fileMutations.id, id)).limit(1))[0]); },
    async insert(value: NewStoryFileMutationRecord) { return mutate(async () => { await db.insert(schema.fileMutations).values(value); return value as StoryFileMutationRecord; }); },
    async update(id: string, patch: Partial<Omit<NewStoryFileMutationRecord, "id" | "storyId" | "createdAt">>) { return mutate(async () => { await db.update(schema.fileMutations).set(patch).where(eq(schema.fileMutations.id, id)); }); },
    async delete(id: string) { return mutate(async () => { await db.delete(schema.fileMutations).where(eq(schema.fileMutations.id, id)); }); },
  };
}

function deletionIntentRepository(db: NodeSQLiteDatabase, read: Read, mutate: Mutate) {
  return {
    list: () => read(() => db.select().from(schema.deletionIntents).orderBy(asc(schema.deletionIntents.createdAt))),
    async get(storyId: string) { return read(async () => (await db.select().from(schema.deletionIntents).where(eq(schema.deletionIntents.storyId, storyId)).limit(1))[0]); },
    async put(value: NewStoryDeletionIntentRecord) {
      return mutate(async () => {
        await db.insert(schema.deletionIntents).values(value).onConflictDoUpdate({
          target: schema.deletionIntents.storyId,
          set: { phase: value.phase, trashName: value.trashName, updatedAt: value.updatedAt },
        });
        return value as StoryDeletionIntentRecord;
      });
    },
    async delete(storyId: string) { return mutate(async () => { await db.delete(schema.deletionIntents).where(eq(schema.deletionIntents.storyId, storyId)); }); },
  };
}

function repositoryError(code: string, message: string, statusCode: number) {
  return Object.assign(new Error(message), { code, statusCode });
}
