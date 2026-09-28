import type { DatabaseSync } from "node:sqlite";

type TransactionJournal = {
  /** 当前打开的嵌套层数；最外层提交或回滚后归零。 */
  depth: number;
  afterCommit: Array<() => void>;
};

const journals = new WeakMap<DatabaseSync, TransactionJournal>();

function journalFor(client: DatabaseSync): TransactionJournal {
  const existing = journals.get(client);
  if (existing) return existing;
  const created: TransactionJournal = { depth: 0, afterCommit: [] };
  journals.set(client, created);
  return created;
}

/**
 * 以 BEGIN IMMEDIATE 打开最外层事务；已在事务里时只计数，由最外层收敛。
 * 提交之后才执行注册的副作用，保证外层回滚时不会发布未提交状态的事件。
 */
export function runInTransaction<T>(client: DatabaseSync, operation: () => T): T {
  const journal = journalFor(client);
  if ((client as DatabaseSync & { isTransaction?: boolean }).isTransaction) {
    journal.depth += 1;
    try {
      return operation();
    } finally {
      journal.depth -= 1;
    }
  }
  client.exec("BEGIN IMMEDIATE");
  journal.depth += 1;
  try {
    const result = operation();
    client.exec("COMMIT");
    journal.depth -= 1;
    if (journal.depth === 0) {
      const callbacks = journal.afterCommit.splice(0);
      for (const callback of callbacks) callback();
    }
    return result;
  } catch (error) {
    client.exec("ROLLBACK");
    journal.depth -= 1;
    if (journal.depth === 0) journal.afterCommit.length = 0;
    throw error;
  }
}

/** 在事务内注册提交后副作用；没有打开事务时立即执行。 */
export function registerAfterCommit(client: DatabaseSync, callback: () => void) {
  const journal = journals.get(client);
  if (!journal || journal.depth === 0) {
    callback();
    return;
  }
  journal.afterCommit.push(callback);
}
