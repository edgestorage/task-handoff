import type { CodexAppServerClientLike } from "../client/contract";
import type { CodexThread } from "../protocol/types";

type SessionDiscoveryOptions = {
  applyThreadSnapshot: (thread: CodexThread) => void;
  ensureThreadSubscribed: (client: CodexAppServerClientLike, threadId: string) => Promise<CodexThread | undefined>;
  recoverableThreadIds: () => string[];
};

export class CodexAppServerSessionDiscovery {
  constructor(private readonly options: SessionDiscoveryOptions) {}

  /**
   * Reconciles sessions that have explicit runtime demand. Enumerating loaded
   * threads and reading them with turns re-parses complete rollout histories
   * and can keep the app-server busy with otherwise idle sessions. User-driven
   * access goes through ensureThreadReady instead.
   */
  async sync(client: CodexAppServerClientLike, isCurrent: () => boolean = () => true) {
    const threadIds = new Set(this.options.recoverableThreadIds());
    for (const threadId of threadIds) {
      if (!isCurrent() || !client.resumeThread) return;
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
