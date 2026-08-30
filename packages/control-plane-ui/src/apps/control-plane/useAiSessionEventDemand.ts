import { onScopeDispose, shallowRef, toValue, watch, type MaybeRefOrGetter } from "vue";

export type AiSessionTimelineDemand = { instanceId: string; sessionId: string };
export type AiSessionMessageDeltaDemand = { allInstances?: boolean; instanceIds: string[] };

const registrations = new Map<symbol, AiSessionTimelineDemand>();
export const aiSessionTimelineDemand = shallowRef<AiSessionTimelineDemand[]>([]);
const messageDeltaRegistrations = new Map<symbol, AiSessionMessageDeltaDemand>();
export const aiSessionTransientReplaySince = shallowRef<string>();
export const aiSessionMessageDeltaDemand = shallowRef<{ allInstances: boolean; instanceIds: string[] }>({
  allInstances: false,
  instanceIds: [],
});

function publish() {
  const unique = new Map<string, AiSessionTimelineDemand>();
  for (const entry of registrations.values()) unique.set(JSON.stringify([entry.instanceId, entry.sessionId]), entry);
  const next = [...unique.values()];
  const previous = aiSessionTimelineDemand.value;
  if (sameTimelineDemand(previous, next)) return;
  publishReplaySince(next.some((entry) => !previous.some((candidate) => sameTimelineEntry(candidate, entry))));
  aiSessionTimelineDemand.value = next;
}

function publishMessageDeltaDemand() {
  const instanceIds = new Set<string>();
  let allInstances = false;
  for (const entry of messageDeltaRegistrations.values()) {
    allInstances ||= entry.allInstances === true;
    for (const instanceId of entry.instanceIds) if (instanceId) instanceIds.add(instanceId);
  }
  const next = { allInstances, instanceIds: [...instanceIds] };
  const previous = aiSessionMessageDeltaDemand.value;
  if (sameMessageDeltaDemand(previous, next)) return;
  publishReplaySince(messageDeltaDemandExpanded(previous, next));
  aiSessionMessageDeltaDemand.value = next;
}

function publishReplaySince(expanded: boolean) {
  aiSessionTransientReplaySince.value = expanded ? new Date().toISOString() : undefined;
}

function sameTimelineEntry(left: AiSessionTimelineDemand, right: AiSessionTimelineDemand) {
  return left.instanceId === right.instanceId && left.sessionId === right.sessionId;
}

function sameTimelineDemand(left: AiSessionTimelineDemand[], right: AiSessionTimelineDemand[]) {
  return left.length === right.length
    && left.every((entry) => right.some((candidate) => sameTimelineEntry(entry, candidate)));
}

function sameMessageDeltaDemand(left: { allInstances: boolean; instanceIds: string[] }, right: { allInstances: boolean; instanceIds: string[] }) {
  if (left.allInstances !== right.allInstances) return false;
  if (left.allInstances) return true;
  return left.instanceIds.length === right.instanceIds.length
    && left.instanceIds.every((instanceId) => right.instanceIds.includes(instanceId));
}

function messageDeltaDemandExpanded(previous: { allInstances: boolean; instanceIds: string[] }, next: { allInstances: boolean; instanceIds: string[] }) {
  if (next.allInstances) return !previous.allInstances;
  if (previous.allInstances) return false;
  return next.instanceIds.some((instanceId) => !previous.instanceIds.includes(instanceId));
}

export function useAiSessionTimelineDemand(target: MaybeRefOrGetter<AiSessionTimelineDemand | undefined>) {
  const token = Symbol("ai-session-timeline-demand");
  watch(() => toValue(target), (next) => {
    if (next?.instanceId && next.sessionId) {
      registrations.set(token, next);
    } else {
      registrations.delete(token);
    }
    publish();
  }, { immediate: true });
  onScopeDispose(() => {
    registrations.delete(token);
    publish();
  });
}

export function useAiSessionMessageDeltaDemand(target: MaybeRefOrGetter<AiSessionMessageDeltaDemand | undefined>) {
  const token = Symbol("ai-session-message-delta-demand");
  watch(() => toValue(target), (next) => {
    if (next && (next.allInstances || next.instanceIds.length)) {
      messageDeltaRegistrations.set(token, next);
    } else {
      messageDeltaRegistrations.delete(token);
    }
    publishMessageDeltaDemand();
  }, { immediate: true });
  onScopeDispose(() => {
    messageDeltaRegistrations.delete(token);
    publishMessageDeltaDemand();
  });
}
