import type { CodexAppServerClientLike } from "../client/contract";
import type { CodexThread } from "../protocol/types";

type SessionDiscoveryOptions = {
  applyThreadSnapshot: (thread: CodexThread) => void;
  ensureThreadSubscribed: (client: CodexAppServerClientLike, threadId: string) => Promise<CodexThread | undefined>;
  reconcileLoadedThreadIds?: (client: CodexAppServerClientLike, loadedThreadIds: readonly string[]) => void;
  recoverableThreadIds?: () => string[];
};

export class CodexAppServerSessionDiscovery {
  constructor(private readonly options: SessionDiscoveryOptions) {}

  async sync(client: CodexAppServerClientLike, isCurrent: () => boolean = () => true) {
    const loadedThreadIds = await client.listLoadedThreadIds();
    if (!isCurrent()) return;
    this.options.reconcileLoadedThreadIds?.(client, loadedThreadIds);
    const threadsById = new Map<string, CodexThread>();
    if (client.listThreads) {
      try {
        for (const thread of await client.listThreads()) {
          if (!isCurrent()) return;
          const id = typeof thread.id === "string" ? thread.id : undefined;
          if (id) {
            threadsById.set(id, thread);
          }
        }
      } catch {
        // The loaded-thread list is authoritative. Thread-list enrichment is
        // optional, so a failure here must not discard otherwise readable
        // loaded threads.
      }
    }
    for (const threadId of loadedThreadIds) {
      let thread = threadsById.get(threadId);
      if (client.readThread) {
        try {
          thread = {
            ...(thread || {}),
            ...await client.readThread(threadId, { includeTurns: true }),
          };
        } catch {
          thread ||= { id: threadId };
        }
      }
      if (!isCurrent()) return;
      this.options.applyThreadSnapshot(thread || { id: threadId });
      if (client.resumeThread) {
        try {
          const resumed = await this.options.ensureThreadSubscribed(client, threadId);
          if (!isCurrent()) return;
          if (resumed) {
            this.options.applyThreadSnapshot(resumed);
          }
        } catch {
          // A failed subscription is retried on the next discovery pass without
          // preventing other loaded threads from being synchronized.
        }
      }
    }
    const loadedThreadIdSet = new Set(loadedThreadIds);
    for (const threadId of this.options.recoverableThreadIds?.() || []) {
      if (loadedThreadIdSet.has(threadId) || !client.resumeThread) continue;
      try {
        const resumed = await this.options.ensureThreadSubscribed(client, threadId);
        if (!isCurrent()) return;
        if (resumed) {
          this.options.applyThreadSnapshot(resumed);
        }
      } catch {
        // A persisted AI session can outlive an app-server connection. Retry
        // only failed resumes on the next discovery pass; successful resumes
        // are deduplicated by the connection generation.
      }
    }
  }
}
