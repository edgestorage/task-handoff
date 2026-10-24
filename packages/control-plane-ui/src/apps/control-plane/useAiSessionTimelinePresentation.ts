import { computed, ref, toValue, watch, type MaybeRefOrGetter } from "vue";
import { useI18n } from "vue-i18n";
import { supportsAiSessionTimelineCapability } from "@task-handoff/protocol/control-plane";
import type { AiSessionSummary, InstanceWithAiSessions } from "../../api/types";
import { getAiSessionTimeline, getAiSessionTurnTimeline, syncAiSessionTimeline, syncAiSessionTurnTimeline } from "../../api/queries";
import { translateApiError } from "../../i18n/apiError";
import { compactTimelineForTurn } from "../../components/ai-session/timelineActivities";
import { aiSessionTurns } from "./useInstanceSessions";
import { useAiSessionTimelineStore } from "./useAiSessionTimelineStore";

const activeTurnTimelineLoads = new Map<string, Promise<void>>();
const activeSessionTimelineLoads = new Map<string, Promise<void>>();
const latestTurnTimelineRequests = new Map<string, symbol>();
const latestSessionTimelineRequests = new Map<string, symbol>();
const timelineSyncUnsupportedInstances = new Set<string>();

function missingTimelineSyncRoute(error: unknown) {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { status?: unknown; statusCode?: unknown; code?: unknown };
  const status = candidate.statusCode ?? candidate.status;
  return status === 404
    || status === 405
    || candidate.code === "HTTP_404"
    || candidate.code === "ROUTE_NOT_FOUND";
}

function timelineLoadKey(instanceId: string, sessionId: string, turnId?: string, revision?: number | string) {
  return JSON.stringify([instanceId, sessionId, turnId || "", revision ?? ""]);
}

export function useAiSessionTimelinePresentation(options: {
  instance: MaybeRefOrGetter<InstanceWithAiSessions | undefined>;
  promptIndex: MaybeRefOrGetter<number>;
  session: MaybeRefOrGetter<AiSessionSummary | undefined>;
}) {
  const { t } = useI18n();
  const timelineStore = useAiSessionTimelineStore();
  const instance = computed(() => toValue(options.instance));
  const session = computed(() => toValue(options.session));
  const promptIndex = computed(() => toValue(options.promptIndex));
  const timelineRefreshEpoch = ref(0);
  const supportsSessionRead = computed(() => {
    const current = session.value;
    return Boolean(current && supportsAiSessionTimelineCapability(instance.value?.capabilities, current.agent, "session-read"));
  });
  const supportsTurnRead = computed(() => {
    const current = session.value;
    return Boolean(current && supportsAiSessionTimelineCapability(instance.value?.capabilities, current.agent, "turn-read"));
  });
  const supportsLiveItems = computed(() => {
    const current = session.value;
    return Boolean(current && supportsAiSessionTimelineCapability(instance.value?.capabilities, current.agent, "live-items"));
  });
  const supportsTimeline = computed(() => supportsSessionRead.value || supportsTurnRead.value || supportsLiveItems.value);
  const supportsTimelineReads = computed(() => supportsSessionRead.value || supportsTurnRead.value);
  const selectedTurn = computed(() => {
    const current = session.value;
    return current ? aiSessionTurns(current)[promptIndex.value] : undefined;
  });
  const selectedTurnState = computed(() => {
    const current = session.value;
    const turn = selectedTurn.value;
    const currentInstance = instance.value;
    if (!currentInstance || !current || !turn) return { status: "ready" as const, items: [] };
    if (supportsTimelineReads.value) return timelineStore.turnState(currentInstance.id, current.id, turn);
    return supportsLiveItems.value
      ? timelineStore.realtimeTurnState(currentInstance.id, current.id, turn)
      : { status: "ready" as const, items: [] };
  });
  const selectedTurnTimeline = computed(() => compactTimelineForTurn(selectedTurnState.value.items, selectedTurn.value));
  const conversationTurnTimelines = computed(() => {
    const current = session.value;
    const currentInstance = instance.value;
    if (!currentInstance || !current) return {};
    return Object.fromEntries(aiSessionTurns(current).map((turn) => [
      turn.id,
      supportsTimelineReads.value
        ? timelineStore.turnState(currentInstance.id, current.id, turn)
        : supportsLiveItems.value
          ? timelineStore.realtimeTurnState(currentInstance.id, current.id, turn)
          : { status: "ready" as const, items: [] },
    ]));
  });

  async function loadFullTimeline(current: AiSessionSummary, force = false) {
    const currentInstance = instance.value;
    if (!currentInstance || !supportsSessionRead.value) return;
    const instanceId = currentInstance.id;
    const turns = aiSessionTurns(current);
    const state = timelineStore.sessionState(instanceId, current.id);
    const cachedRevision = state.revision;
    const requestRevision = cachedRevision && turns.every((turn) => (
      timelineStore.turnState(instanceId, current.id, turn).revision === cachedRevision
    )) ? cachedRevision : undefined;
    const requestKey = timelineLoadKey(instanceId, current.id);
    const key = timelineLoadKey(instanceId, current.id, undefined, `${force ? timelineRefreshEpoch.value : ""}:${turns.map((turn) => `${turn.id}:${turn.revision}`).join("|")}:${requestRevision || ""}`);
    const existing = activeSessionTimelineLoads.get(key);
    if (existing) return existing;
    if (!force && state.status === "ready") return;
    const requestToken = Symbol(requestKey);
    latestSessionTimelineRequests.set(requestKey, requestToken);
    timelineStore.beginSessionLoad(instanceId, current.id);
    const knownItems = timelineStore.knownSessionTimelineItems(instanceId, current.id, turns);
    const syncSupported = typeof syncAiSessionTimeline === "function" && !timelineSyncUnsupportedInstances.has(instanceId);
    const load = (syncSupported
      ? syncAiSessionTimeline(instanceId, current.id, knownItems).catch((error) => {
        if (!missingTimelineSyncRoute(error)) throw error;
        timelineSyncUnsupportedInstances.add(instanceId);
        return getAiSessionTimeline(instanceId, current.id, requestRevision);
      })
      : getAiSessionTimeline(instanceId, current.id, requestRevision))
      .then((read) => {
        if (latestSessionTimelineRequests.get(requestKey) !== requestToken) return;
        if (read.kind === "not-modified") {
          timelineStore.resolveSessionNotModified(instanceId, current.id, turns, read.revision);
          return;
        }
        if (read.kind === "snapshot") {
          timelineStore.resolveSessionSyncSnapshot(instanceId, current.id, turns, read.items, read.revision);
          return;
        }
        if (read.kind === "delta") {
          timelineStore.applySessionSyncDelta(instanceId, current.id, turns, read);
          return;
        }
        timelineStore.resolveSession(instanceId, current.id, turns, read.timeline, read.revision);
      })
      .catch((error) => {
        if (latestSessionTimelineRequests.get(requestKey) !== requestToken) return;
        const message = translateApiError(error, t, t("sessions.timeline.loadFailed"));
        timelineStore.rejectSession(instanceId, current.id, message);
        for (const turn of turns) timelineStore.rejectTurn(instanceId, current.id, turn, message);
      })
      .finally(() => {
        activeSessionTimelineLoads.delete(key);
        if (latestSessionTimelineRequests.get(requestKey) === requestToken) latestSessionTimelineRequests.delete(requestKey);
      });
    activeSessionTimelineLoads.set(key, load);
    return load;
  }

  async function loadTurnTimeline(turnId: string, force = false) {
    const current = session.value;
    const currentInstance = instance.value;
    if (!currentInstance || !current || (!supportsSessionRead.value && !supportsTurnRead.value)) return;
    const instanceId = currentInstance.id;
    const turns = aiSessionTurns(current);
    const turn = turns.find((candidate) => candidate.id === turnId || candidate.providerTurnId === turnId);
    if (!turn) return;
    const state = timelineStore.turnState(instanceId, current.id, turn);
    const cachedRevision = state.revision;
    if (!supportsTurnRead.value) {
      if (!force && (state.status === "ready" || state.status === "loading")) return;
      return loadFullTimeline(current, true);
    }
    if (!force && (state.status === "ready" || state.status === "loading")) return;
    const requestKey = timelineLoadKey(instanceId, current.id, turn.id);
    const key = timelineLoadKey(instanceId, current.id, turn.id, `${force ? timelineRefreshEpoch.value : ""}:${turn.revision}:${cachedRevision || ""}`);
    const existing = activeTurnTimelineLoads.get(key);
    if (existing) return existing;
    const requestToken = Symbol(requestKey);
    latestTurnTimelineRequests.set(requestKey, requestToken);
    timelineStore.beginTurnLoad(instanceId, current.id, turn);
    const knownItems = timelineStore.knownTurnTimelineItems(instanceId, current.id, turn);
    const syncSupported = typeof syncAiSessionTurnTimeline === "function" && !timelineSyncUnsupportedInstances.has(instanceId);
    const load = (syncSupported
      ? syncAiSessionTurnTimeline(instanceId, current.id, turn.id, knownItems).catch((error) => {
        if (!missingTimelineSyncRoute(error)) throw error;
        timelineSyncUnsupportedInstances.add(instanceId);
        return getAiSessionTurnTimeline(instanceId, current.id, turn.id, cachedRevision);
      })
      : getAiSessionTurnTimeline(instanceId, current.id, turn.id, cachedRevision))
      .then((read) => {
        if (latestTurnTimelineRequests.get(requestKey) !== requestToken) return;
        if (read.kind === "not-modified") {
          timelineStore.resolveTurnNotModified(instanceId, current.id, turn, read.revision);
          return;
        }
        if (read.kind === "snapshot") {
          timelineStore.resolveTurnSyncSnapshot(instanceId, current.id, turn, read.items, read.revision);
          return;
        }
        if (read.kind === "delta") {
          timelineStore.applyTurnSyncDelta(instanceId, current.id, turn, read);
          return;
        }
        timelineStore.resolveTurn(instanceId, current.id, turn, read.timeline.items, read.revision);
      })
      .catch((error) => {
        if (latestTurnTimelineRequests.get(requestKey) !== requestToken) return;
        timelineStore.rejectTurn(
          instanceId,
          current.id,
          turn,
          translateApiError(error, t, t("sessions.timeline.loadFailed")),
        );
      })
      .finally(() => {
        activeTurnTimelineLoads.delete(key);
        if (latestTurnTimelineRequests.get(requestKey) === requestToken) latestTurnTimelineRequests.delete(requestKey);
      });
    activeTurnTimelineLoads.set(key, load);
    return load;
  }

  function refreshCachedTimeline() {
    const current = session.value;
    const currentInstance = instance.value;
    if (!currentInstance || !current || !supportsTimelineReads.value) return;
    const turns = aiSessionTurns(current);
    if (supportsSessionRead.value) {
      const state = timelineStore.sessionState(currentInstance.id, current.id);
      if (state.status !== "idle") {
        void loadFullTimeline(current, true);
        return;
      }
    }
    if (!supportsTurnRead.value) return;
    for (const turn of turns) {
      const state = timelineStore.turnState(currentInstance.id, current.id, turn);
      if (state.status !== "idle") void loadTurnTimeline(turn.id, true);
    }
  }

  watch(
    () => {
      const current = session.value;
      const currentInstance = instance.value;
      if (!currentInstance || !current) return "";
      const turns = aiSessionTurns(current).map((turn) => turn.id).join(",");
      return `${currentInstance.id}\u0000${current.id}\u0000${turns}\u0000${timelineStore.recoveryRevision.value}`;
    },
    () => {
      timelineRefreshEpoch.value += 1;
      refreshCachedTimeline();
    },
    { immediate: true, flush: "post" },
  );

  return {
    conversationTurnTimelines,
    loadFullTimeline,
    loadTurnTimeline,
    selectedTurn,
    selectedTurnState,
    selectedTurnTimeline,
    supportsTimeline,
    supportsTimelineReads,
  };
}
