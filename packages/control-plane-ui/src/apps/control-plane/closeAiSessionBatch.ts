import { closeAiSession } from "../../api/queries";
import { createBrowserUuid } from "../../lib/random-id";

export type CloseAiSessionTarget = { instanceId: string; sessionId: string };

export async function closeAiSessionBatch(targets: CloseAiSessionTarget[], concurrency = 6) {
  let next = 0;
  let failed = 0;
  const worker = async () => {
    while (next < targets.length) {
      const target = targets[next++];
      try {
        await closeAiSession(target.instanceId, target.sessionId, createBrowserUuid());
      } catch {
        failed += 1;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, targets.length) }, worker));
  return { total: targets.length, failed };
}
