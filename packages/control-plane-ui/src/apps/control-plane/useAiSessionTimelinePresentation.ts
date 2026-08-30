import { computed, toValue, watch, type MaybeRefOrGetter } from "vue";
import { useI18n } from "vue-i18n";
import { supportsAiSessionTimelineCapability } from "@task-handoff/protocol/control-plane";
import type { AiSessionSummary, InstanceWithAiSessions } from "../../api/types";
import { getAiSessionTimeline, getAiSessionTurnTimeline } from "../../api/queries";
import { translateApiError } from "../../i18n/apiError";
import { compactTimelineForTurn } from "../../components/ai-session/timelineActivities";
import { aiSessionTurns } from "./useInstanceSessions";
import { useAiSessionTimelineStore } from "./useAiSessionTimelineStore";

const activeTurnTimelineLoads = new Map<string, Promise<void>>();
const activeSessionTimelineLoads = new Map<string, Promise<void>>();

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
    const key = timelineLoadKey(instanceId, current.id, undefined, turns.map((turn) => `${turn.id}:${turn.revision}`).join("|"));
    const existing = activeSessionTimelineLoads.get(key);
    if (existing) return existing;
    const state = timelineStore.sessionState(instanceId, current.id);
    if (!force && state.status === "ready") return;
    timelineStore.beginSessionLoad(instanceId, current.id);
    for (const turn of turns) timelineStore.beginTurnLoad(instanceId, current.id, turn);
    const load = getAiSessionTimeline(instanceId, current.id)
      .then((result) => timelineStore.resolveSession(instanceId, current.id, turns, result))
      .catch((error) => {
        const message = translateApiError(error, t, t("sessions.timeline.loadFailed"));
        timelineStore.rejectSession(instanceId, current.id, message);
        for (const turn of turns) timelineStore.rejectTurn(instanceId, current.id, turn, message);
      })
      .finally(() => activeSessionTimelineLoads.delete(key));
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
    if (!supportsTurnRead.value) {
      if (!force && (state.status === "ready" || state.status === "loading")) return;
      return loadFullTimeline(current, true);
    }
    if (!force && (state.status === "ready" || state.status === "loading")) return;
    const key = timelineLoadKey(instanceId, current.id, turn.id, turn.revision);
    const existing = activeTurnTimelineLoads.get(key);
    if (existing) return existing;
    timelineStore.beginTurnLoad(instanceId, current.id, turn);
    const load = getAiSessionTurnTimeline(instanceId, current.id, turn.id)
      .then((result) => {
        timelineStore.resolveTurn(instanceId, current.id, turn, result.items);
      })
      .catch((error) => timelineStore.rejectTurn(
        instanceId,
        current.id,
        turn,
        translateApiError(error, t, t("sessions.timeline.loadFailed")),
      ))
      .finally(() => activeTurnTimelineLoads.delete(key));
    activeTurnTimelineLoads.set(key, load);
    return load;
  }

  function loadSelectedTurnTimeline(force = false) {
    const turn = selectedTurn.value;
    return turn ? loadTurnTimeline(turn.id, force) : undefined;
  }

  watch(timelineStore.recoveryRevision, () => void loadSelectedTurnTimeline(true));
  watch(
    () => {
      const currentInstance = instance.value;
      const current = session.value;
      const turn = selectedTurn.value;
      return [currentInstance?.id, current?.id, turn?.id, turn?.revision] as const;
    },
    () => void loadSelectedTurnTimeline(),
    { immediate: true },
  );

  return {
    conversationTurnTimelines,
    loadFullTimeline,
    loadSelectedTurnTimeline,
    loadTurnTimeline,
    selectedTurn,
    selectedTurnState,
    selectedTurnTimeline,
    supportsTimeline,
    supportsTimelineReads,
  };
}
