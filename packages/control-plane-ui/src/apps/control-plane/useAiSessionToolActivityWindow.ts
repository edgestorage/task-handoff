import { computed, reactive, toValue, watch, type MaybeRefOrGetter } from "vue";
import { useI18n } from "vue-i18n";
import { supportsAiSessionTimelineCapability } from "@task-handoff/protocol/control-plane";
import {
  AI_SESSION_TOOL_ACTIVITY_WINDOW_MAX_ITEMS,
  type AiSessionTimelineActivity,
  type AiSessionTimelineItem,
  type AiSessionTurn,
} from "@task-handoff/protocol/ai-sessions";
import type { AiSessionSummary, InstanceWithAiSessions } from "../../api/types";
import { getAiSessionToolActivityWindow } from "../../api/queries";
import { translateApiError } from "../../i18n/apiError";
import { aiSessionTurns } from "./useInstanceSessions";
import { useAiSessionTimelineStore } from "./useAiSessionTimelineStore";

export type AiSessionToolActivityWindowStatus = "idle" | "loading" | "ready" | "error";

export type AiSessionToolActivityWindowState = {
  status: AiSessionToolActivityWindowStatus;
  items: AiSessionTimelineActivity[];
  total: number;
  truncated: boolean;
  error?: string;
  revision?: string;
  boundaryItemId?: string;
};

function emptyWindow(): AiSessionToolActivityWindowState {
  return { status: "idle", items: [], total: 0, truncated: false };
}

function latestAiMessageIndex(items: readonly AiSessionTimelineItem[]) {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (items[index].type === "ai-message") return index;
  }
  return -1;
}

function mergeLiveToolActivity(
  window: AiSessionToolActivityWindowState,
  liveItems: readonly AiSessionTimelineItem[],
): AiSessionToolActivityWindowState {
  const latestAiIndex = latestAiMessageIndex(liveItems);
  const latestAi = latestAiIndex >= 0 ? liveItems[latestAiIndex] : undefined;
  const baseBoundaryIndex = window.boundaryItemId
    ? liveItems.findIndex((item) => item.type === "ai-message" && item.id === window.boundaryItemId)
    : -1;
  const boundaryChanged = Boolean(latestAi && latestAi.id !== window.boundaryItemId);
  const liveActivities = liveItems
    .slice(boundaryChanged ? latestAiIndex + 1 : Math.max(0, baseBoundaryIndex + 1))
    .filter((item): item is AiSessionTimelineActivity => item.type === "activity");

  if (!liveActivities.length) {
    return {
      status: "ready",
      items: window.items,
      total: window.total,
      truncated: window.truncated,
      revision: window.revision,
      ...(window.boundaryItemId ? { boundaryItemId: window.boundaryItemId } : {}),
    };
  }

  const baseItems = boundaryChanged ? [] : window.items;
  const baseIds = new Set(baseItems.map((item) => item.id));
  const byId = new Map(baseItems.map((item) => [item.id, item]));
  const order = baseItems.map((item) => item.id);
  for (const item of liveActivities) {
    if (!byId.has(item.id)) {
      order.push(item.id);
    }
    byId.set(item.id, item);
  }
  const allItems = order
    .map((id) => byId.get(id))
    .filter((item): item is AiSessionTimelineActivity => Boolean(item));
  const items = allItems.slice(-AI_SESSION_TOOL_ACTIVITY_WINDOW_MAX_ITEMS);
  const total = boundaryChanged
    ? liveActivities.length
    : Math.max(window.total, window.items.length + liveActivities.filter((item) => !baseIds.has(item.id)).length);
  return {
    status: "ready",
    items,
    total,
    truncated: items.length < total,
    revision: window.revision,
    ...(latestAi ? { boundaryItemId: latestAi.id } : window.boundaryItemId ? { boundaryItemId: window.boundaryItemId } : {}),
  };
}

export function useAiSessionToolActivityWindow(options: {
  instance: MaybeRefOrGetter<InstanceWithAiSessions | undefined>;
  promptIndex: MaybeRefOrGetter<number>;
  session: MaybeRefOrGetter<AiSessionSummary | undefined>;
}) {
  const { t } = useI18n();
  const timelineStore = useAiSessionTimelineStore();
  const instance = computed(() => toValue(options.instance));
  const session = computed(() => toValue(options.session));
  const promptIndex = computed(() => toValue(options.promptIndex));
  const selectedTurn = computed(() => {
    const current = session.value;
    return current ? aiSessionTurns(current)[promptIndex.value] : undefined;
  });
  const windowStates = reactive(new Map<string, AiSessionToolActivityWindowState>());
  const activeLoads = new Map<string, Promise<void>>();
  const latestRequests = new Map<string, symbol>();

  const scopeKey = computed(() => {
    const currentInstance = instance.value;
    const currentSession = session.value;
    if (!currentInstance || !currentSession) return "";
    return JSON.stringify([currentInstance.id, currentSession.id, timelineStore.recoveryRevision.value]);
  });
  const supportsToolActivity = computed(() => {
    const currentInstance = instance.value;
    const currentSession = session.value;
    return Boolean(currentInstance && currentSession
      && supportsAiSessionTimelineCapability(currentInstance.capabilities, currentSession.agent, "tool-activity"));
  });

  watch(scopeKey, () => {
    windowStates.clear();
    latestRequests.clear();
  }, { flush: "sync" });

  function windowKey(turn: Pick<AiSessionTurn, "id">) {
    const currentInstance = instance.value;
    const currentSession = session.value;
    return currentInstance && currentSession ? JSON.stringify([currentInstance.id, currentSession.id, turn.id]) : "";
  }

  function turnWindow(turn: AiSessionTurn | undefined): AiSessionToolActivityWindowState {
    const state = turn ? windowStates.get(windowKey(turn)) || emptyWindow() : emptyWindow();
    const currentInstance = instance.value;
    const currentSession = session.value;
    if (state.status !== "ready" || !currentInstance || !currentSession || !turn) return state;
    const liveItems = timelineStore.realtimeTurnState(currentInstance.id, currentSession.id, turn).items;
    if (!liveItems.length) return state;
    return mergeLiveToolActivity(state, liveItems);
  }

  const selectedWindow = computed(() => turnWindow(selectedTurn.value));
  const conversationWindows = computed<Record<string, AiSessionToolActivityWindowState>>(() => {
    const current = session.value;
    if (!current) return {};
    return Object.fromEntries(aiSessionTurns(current).map((turn) => [turn.id, turnWindow(turn)]));
  });

  function matchesTurn(turn: AiSessionTurn, turnId: string) {
    return turn.id === turnId || turn.providerTurnId === turnId;
  }

  async function loadToolActivityWindow(turnId?: string) {
    const currentInstance = instance.value;
    const currentSession = session.value;
    if (!currentInstance || !currentSession || !turnId) return;
    const turn = aiSessionTurns(currentSession).find((candidate) => matchesTurn(candidate, turnId));
    if (!turn) return;
    if (!supportsToolActivity.value) return;
    const currentScopeKey = scopeKey.value;
    const currentKey = windowKey(turn);
    const activeLoadKey = `${currentScopeKey}\u0000${currentKey}`;
    const existing = activeLoads.get(activeLoadKey);
    if (existing) return existing;
    const state = windowStates.get(currentKey) || emptyWindow();
    if (state.status === "ready" || state.status === "loading") return;

    const requestToken = Symbol(currentKey);
    latestRequests.set(currentKey, requestToken);
    windowStates.set(currentKey, { ...emptyWindow(), status: "loading" });
    const load = getAiSessionToolActivityWindow(currentInstance.id, currentSession.id, turn.id)
      .then((window) => {
        if (scopeKey.value !== currentScopeKey || latestRequests.get(currentKey) !== requestToken) return;
        windowStates.set(currentKey, {
          status: "ready",
          items: window.items,
          total: window.total,
          truncated: window.truncated,
          revision: window.revision,
          ...(window.boundaryItemId ? { boundaryItemId: window.boundaryItemId } : {}),
        });
      })
      .catch((error) => {
        if (scopeKey.value !== currentScopeKey || latestRequests.get(currentKey) !== requestToken) return;
        windowStates.set(currentKey, {
          ...emptyWindow(),
          status: "error",
          error: translateApiError(error, t, t("sessions.timeline.activityLoadFailed")),
        });
      })
      .finally(() => {
        activeLoads.delete(activeLoadKey);
        if (latestRequests.get(currentKey) === requestToken) latestRequests.delete(currentKey);
      });
    activeLoads.set(activeLoadKey, load);
    return load;
  }

  return {
    conversationToolActivityWindows: conversationWindows,
    loadToolActivityWindow,
    selectedToolActivityWindow: selectedWindow,
    supportsToolActivity,
  };
}
