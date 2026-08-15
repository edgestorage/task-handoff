import { shallowRef } from "vue";
import type { AiSessionTimelineItemEvent } from "@task-handoff/protocol/ai-sessions";

const events = new Map<string, AiSessionTimelineItemEvent>();
const revision = shallowRef(0);
const recoveryRevision = shallowRef(0);
const sessionKey = (instanceId: string, sessionId: string) => JSON.stringify([instanceId, sessionId]);

function apply(event: AiSessionTimelineItemEvent) {
  events.set(`${sessionKey(event.instanceId, event.sessionId)}\u0000${event.item.id}`, event);
  revision.value += 1;
}

function items(instanceId: string, sessionId: string) {
  void revision.value;
  const prefix = `${sessionKey(instanceId, sessionId)}\u0000`;
  return [...events].filter(([key]) => key.startsWith(prefix)).map(([, event]) => event.item);
}

function cleanupInstance(instanceId: string) {
  for (const [key, event] of events) if (event.instanceId === instanceId) events.delete(key);
  revision.value += 1;
}

function recoverConnection() {
  events.clear();
  revision.value += 1;
  recoveryRevision.value += 1;
}

export function useAiSessionTimelineStore() {
  return { apply, items, cleanupInstance, recoverConnection, recoveryRevision, revision };
}
