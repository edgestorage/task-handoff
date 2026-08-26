import { computed, onScopeDispose, ref, toValue, watch, type MaybeRefOrGetter } from "vue";
import type { AiSessionTurn } from "@task-handoff/protocol/ai-sessions";
import { AiSessionConversationCache, aiSessionDetailCacheRevision, aiSessionTurnsCacheRevision } from "@task-handoff/control-plane-client";
import type { AiSessionSummary } from "../../api/types";
import { getAiSessionDetail, getAiSessionTurnBody, getAiSessionTurnIndex } from "../../api/queries";

const conversations = new AiSessionConversationCache(80);
const activeLoads = new Map<string, Promise<unknown>>();

function conversationKey(instanceId: string, sessionId: string) {
  return JSON.stringify([instanceId, sessionId]);
}

async function deduplicated<T>(key: string, load: () => Promise<T>): Promise<T> {
  const existing = activeLoads.get(key) as Promise<T> | undefined;
  if (existing) return existing;
  const promise = load().finally(() => activeLoads.delete(key));
  activeLoads.set(key, promise);
  return promise;
}

export function useAiSessionConversationProjection(options: {
  instanceId: MaybeRefOrGetter<string>;
  summary: MaybeRefOrGetter<AiSessionSummary | undefined>;
}) {
  const cacheRevision = ref(0);
  const state = ref<"loading" | "ready" | "error">("loading");
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let retryAttempt = 0;
  const currentKey = computed(() => {
    const summary = toValue(options.summary);
    const instanceId = toValue(options.instanceId);
    return summary && instanceId ? conversationKey(instanceId, summary.id) : "";
  });
  const projection = computed(() => {
    cacheRevision.value;
    const summary = toValue(options.summary);
    const instanceId = toValue(options.instanceId);
    return summary && instanceId ? conversations.projection(instanceId, summary) : undefined;
  });
  const turns = computed<AiSessionTurn[]>(() => projection.value?.turns || []);
  const turnIndexKey = computed(() => {
    cacheRevision.value;
    const summary = toValue(options.summary);
    const instanceId = toValue(options.instanceId);
    return summary && instanceId
      ? conversations.turnIndex(instanceId, summary.id)?.turns.map((turn) => `${turn.id}:${turn.bodyRevision}`).join("|") || ""
      : "";
  });
  const conversation = computed<AiSessionSummary | undefined>(() => {
    return projection.value;
  });
  const allTurnsReady = computed(() => {
    cacheRevision.value;
    const summary = toValue(options.summary);
    const instanceId = toValue(options.instanceId);
    if (!summary || !instanceId) return false;
    const index = conversations.turnIndex(instanceId, summary.id);
    return Boolean(index && index.turns.every((turn) => conversations.hasCurrentTurn(instanceId, summary.id, turn.id)));
  });

  function changed() {
    cacheRevision.value += 1;
  }

  function clearRetry() {
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = undefined;
  }

  function scheduleRetry() {
    if (retryTimer) return;
    const delay = Math.min(4_000, 400 * (2 ** retryAttempt));
    retryAttempt = Math.min(retryAttempt + 1, 4);
    retryTimer = setTimeout(() => {
      retryTimer = undefined;
      void refresh({
        detail: !hasCurrentDetail(),
        index: !hasCurrentIndex(),
      });
    }, delay);
  }

  function hasCurrentDetail() {
    const summary = toValue(options.summary);
    const instanceId = toValue(options.instanceId);
    return Boolean(summary && instanceId && conversations.hasDetail(instanceId, summary));
  }

  function hasCurrentIndex() {
    const summary = toValue(options.summary);
    const instanceId = toValue(options.instanceId);
    return Boolean(summary && instanceId && conversations.hasTurnIndex(instanceId, summary));
  }

  function hasRenderableTurn(turnId: string) {
    cacheRevision.value;
    const summary = toValue(options.summary);
    const instanceId = toValue(options.instanceId);
    return Boolean(summary && instanceId && conversations.hasRenderableTurn(instanceId, summary.id, turnId));
  }

  function hasCurrentTurn(turnId: string) {
    cacheRevision.value;
    const summary = toValue(options.summary);
    const instanceId = toValue(options.instanceId);
    return Boolean(summary && instanceId && conversations.hasCurrentTurn(instanceId, summary.id, turnId));
  }

  async function loadTurn(turnId: string, validate = true, expectedRevision?: string): Promise<boolean> {
    const summary = toValue(options.summary);
    const instanceId = toValue(options.instanceId);
    const key = currentKey.value;
    if (!summary || !instanceId || !key || !turnId) return false;
    const index = conversations.turnEntry(instanceId, summary.id, turnId);
    if (!index) return false;
    const cachedRevision = conversations.turnRevision(instanceId, summary.id, index.id);
    const desiredRevision = expectedRevision || index.bodyRevision;
    if (!validate && cachedRevision === desiredRevision) return true;
    try {
      const read = await deduplicated(`${key}:turn:${index.id}:${cachedRevision || "none"}:${desiredRevision}`, () => (
        getAiSessionTurnBody(instanceId, summary.id, index.id, cachedRevision)
      ));
      if (currentKey.value !== key) return false;
      if (read.kind === "not-modified") return conversations.hasCurrentTurn(instanceId, summary.id, index.id);
      const currentSummary = toValue(options.summary);
      if (!currentSummary || read.body.sessionId !== currentSummary.id) return false;
      if (expectedRevision) {
        const currentRef = currentSummary.latestTurnRef;
        if (currentRef?.id !== index.id || currentRef.bodyRevision !== read.revision) return false;
      }
      if (conversations.setTurn(instanceId, currentSummary.id, read.revision, read.body.turn, expectedRevision)) changed();
      return conversations.hasCurrentTurn(instanceId, currentSummary.id, index.id);
    } catch {
      scheduleRetry();
      return false;
    }
  }

  async function loadAllTurns() {
    const summary = toValue(options.summary);
    const instanceId = toValue(options.instanceId);
    if (!summary || !instanceId) return;
    const index = conversations.turnIndex(instanceId, summary.id);
    await Promise.allSettled((index?.turns || []).map((turn) => loadTurn(turn.id, false)));
  }

  async function refresh(domains: { detail?: boolean; index?: boolean } = { detail: true, index: true }) {
    const summary = toValue(options.summary);
    const instanceId = toValue(options.instanceId);
    const key = currentKey.value;
    if (!summary || !instanceId || !key) {
      state.value = "loading";
      return;
    }
    // Revision changes refresh their own data domains in place. Only a session
    // with no cached projection enters the conversation-level loading state.
    const hadRenderableContent = conversations.hasRenderableProjection(instanceId, summary.id);
    if (!hadRenderableContent) state.value = "loading";
    const cachedDetailRevision = conversations.detailRevision(instanceId, summary.id);
    const cachedTurnsRevision = conversations.turnsRevision(instanceId, summary.id);
    const detailLoad = domains.detail ? deduplicated(`${key}:detail:${cachedDetailRevision || "none"}:${aiSessionDetailCacheRevision(summary)}`, () => (
        getAiSessionDetail(instanceId, summary.id, cachedDetailRevision)
      )) : undefined;
    const indexLoad = domains.index ? deduplicated(`${key}:index:${cachedTurnsRevision || "none"}:${aiSessionTurnsCacheRevision(summary)}`, () => (
        getAiSessionTurnIndex(instanceId, summary.id, cachedTurnsRevision)
      )) : undefined;
    const [detailResult, indexResult] = await Promise.allSettled([detailLoad, indexLoad]);
    if (currentKey.value !== key) return;
    const currentSummary = toValue(options.summary);
    if (!currentSummary || currentSummary.id !== summary.id) return;
    let updated = false;
    if (detailLoad && detailResult.status === "fulfilled" && detailResult.value?.kind === "updated"
      && detailResult.value.revision === aiSessionDetailCacheRevision(currentSummary)) {
      conversations.setDetail(instanceId, detailResult.value.revision, detailResult.value.detail);
      updated = true;
    }
    if (indexLoad && indexResult.status === "fulfilled" && indexResult.value?.kind === "updated"
      && indexResult.value.revision === aiSessionTurnsCacheRevision(currentSummary)) {
      conversations.setTurnIndex(instanceId, indexResult.value.revision, indexResult.value.index);
      updated = true;
    }
    if (updated) changed();
    const valid = conversations.hasProjection(instanceId, currentSummary);
    const renderable = conversations.hasRenderableProjection(instanceId, currentSummary.id);
    state.value = renderable ? "ready" : "error";
    if (valid) {
      clearRetry();
      retryAttempt = 0;
    } else {
      scheduleRetry();
    }
    const latest = currentSummary.latestTurnRef;
    if (latest) await loadTurn(latest.id, false, latest.bodyRevision);
  }

  watch(
    () => {
      const summary = toValue(options.summary);
      return [currentKey.value, summary?.detailRevision, summary?.turnsRevision, summary?.latestTurnRef?.id, summary?.latestTurnRef?.bodyRevision] as const;
    },
    (next, previous) => {
      const keyChanged = !previous || next[0] !== previous[0];
      if (keyChanged) {
        clearRetry();
        retryAttempt = 0;
        void refresh();
        return;
      }
      if (next[1] !== previous[1]) void refresh({ detail: true });
      if (next[2] !== previous[2]) void refresh({ index: true });
      if (next[3] && (next[3] !== previous[3] || next[4] !== previous[4])) {
        void loadTurn(next[3], false, next[4]);
      }
    },
    { immediate: true },
  );

  onScopeDispose(clearRetry);

  return { allTurnsReady, conversation, hasCurrentTurn, hasRenderableTurn, loadAllTurns, loadTurn, refresh, state, turnIndexKey, turns };
}
