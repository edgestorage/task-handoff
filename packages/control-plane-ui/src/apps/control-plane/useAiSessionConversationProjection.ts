import { computed, onScopeDispose, ref, toValue, watch, type MaybeRefOrGetter } from "vue";
import type { AiSessionTurn } from "@task-handoff/protocol/ai-sessions";
import { AiSessionConversationCache, aiSessionDetailCacheRevision, aiSessionTurnsCacheRevision } from "@task-handoff/control-plane-client";
import type { AiSessionSummary } from "../../api/types";
import { getAiSessionDetail, getAiSessionTurnBody, getAiSessionTurnIndex } from "../../api/queries";
import { useStreamingMessagesStore } from "./useStreamingMessagesStore";
import { recordAiSessionRead } from "./aiSessionReadDiagnostics";

const conversations = new AiSessionConversationCache(80);
const activeLoads = new Map<string, Promise<unknown>>();
let consumerSequence = 0;

function conversationKey(instanceId: string, sessionId: string) {
  return JSON.stringify([instanceId, sessionId]);
}

async function deduplicated<T>(key: string, load: () => Promise<T>): Promise<T> {
  const existing = activeLoads.get(key) as Promise<T> | undefined;
  recordAiSessionRead("deduplicate", { key, reused: Boolean(existing) });
  if (existing) return existing;
  const promise = load().finally(() => activeLoads.delete(key));
  activeLoads.set(key, promise);
  return promise;
}

export function useAiSessionConversationProjection(options: {
  instanceId: MaybeRefOrGetter<string>;
  summary: MaybeRefOrGetter<AiSessionSummary | undefined>;
  consumer?: string;
}) {
  const consumerId = String(++consumerSequence);
  const streamingMessages = useStreamingMessagesStore();
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

  async function loadTurn(turnId: string, validate = true, expectedRevision?: string, source = "consumer"): Promise<boolean> {
    const summary = toValue(options.summary);
    const instanceId = toValue(options.instanceId);
    const key = currentKey.value;
    if (!summary || !instanceId || !key || !turnId) return false;
    const index = conversations.turnEntry(instanceId, summary.id, turnId);
    if (!index) return false;
    const cachedRevision = conversations.turnRevision(instanceId, summary.id, index.id);
    const desiredRevision = expectedRevision || index.bodyRevision;
    const diagnostic = {
      consumerId, consumer: options.consumer, source, instanceId, sessionId: summary.id,
      turnId: index.id, cachedRevision, desiredRevision, expectedRevision, validate,
      summaryRevision: summary.latestTurnRef?.bodyRevision,
    };
    recordAiSessionRead("turn.requested", diagnostic);
    if (!validate && cachedRevision === desiredRevision) {
      recordAiSessionRead("turn.cache-hit", diagnostic);
      return true;
    }
    const startedAt = performance.now();
    try {
      const read = await deduplicated(`${key}:turn:${index.id}:${cachedRevision || "none"}:${desiredRevision}`, () => (
        getAiSessionTurnBody(instanceId, summary.id, index.id, cachedRevision)
      ));
      recordAiSessionRead("turn.response", { ...diagnostic, kind: read.kind, responseRevision: read.revision, durationMs: performance.now() - startedAt });
      if (currentKey.value !== key) {
        recordAiSessionRead("turn.discarded", { ...diagnostic, reason: "selection-changed" });
        return false;
      }
      if (read.kind === "not-modified") {
        const current = conversations.hasCurrentTurn(instanceId, summary.id, index.id);
        recordAiSessionRead("turn.not-modified", { ...diagnostic, current });
        return current;
      }
      const currentSummary = toValue(options.summary);
      if (!currentSummary || read.body.sessionId !== currentSummary.id) {
        recordAiSessionRead("turn.discarded", { ...diagnostic, reason: "session-mismatch" });
        return false;
      }
      if (expectedRevision) {
        const currentRef = currentSummary.latestTurnRef;
        if (currentRef?.id !== index.id || currentRef.bodyRevision !== read.revision) {
          recordAiSessionRead("turn.discarded", { ...diagnostic, reason: "revision-changed", responseRevision: read.revision, currentRevision: currentRef?.bodyRevision });
          return false;
        }
      }
      const accepted = conversations.setTurn(instanceId, currentSummary.id, read.revision, read.body.turn, expectedRevision);
      recordAiSessionRead("turn.applied", { ...diagnostic, accepted, responseRevision: read.revision });
      if (accepted) {
        streamingMessages.applyAuthoritativeTurnBody(instanceId, currentSummary.id, read.body.turn);
        changed();
      }
      return conversations.hasCurrentTurn(instanceId, currentSummary.id, index.id);
    } catch {
      recordAiSessionRead("turn.failed", { ...diagnostic, durationMs: performance.now() - startedAt, retry: true });
      scheduleRetry();
      return false;
    }
  }

  async function loadAllTurns() {
    const summary = toValue(options.summary);
    const instanceId = toValue(options.instanceId);
    if (!summary || !instanceId) return;
    const index = conversations.turnIndex(instanceId, summary.id);
    await Promise.allSettled((index?.turns || []).map((turn) => loadTurn(turn.id, false, undefined, "all-turns")));
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
    recordAiSessionRead("projection.refresh", {
      consumerId, consumer: options.consumer, instanceId, sessionId: summary.id,
      detail: Boolean(domains.detail), index: Boolean(domains.index), cachedDetailRevision, cachedTurnsRevision,
      detailRevision: aiSessionDetailCacheRevision(summary), turnsRevision: aiSessionTurnsCacheRevision(summary),
    });
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
    if (latest) await loadTurn(latest.id, false, latest.bodyRevision, "refresh-completed");
  }

  watch(
    () => {
      const summary = toValue(options.summary);
      return [currentKey.value, summary?.detailRevision, summary?.turnsRevision, summary?.latestTurnRef?.id, summary?.latestTurnRef?.bodyRevision] as const;
    },
    (next, previous) => {
      recordAiSessionRead("summary.changed", {
        consumerId, consumer: options.consumer, instanceId: toValue(options.instanceId),
        sessionId: toValue(options.summary)?.id, detailRevision: next[1], turnsRevision: next[2],
        turnId: next[3], revision: next[4], previousRevision: previous?.[4],
      });
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
        void loadTurn(next[3], false, next[4], "summary-watcher");
      }
    },
    { immediate: true },
  );

  onScopeDispose(clearRetry);

  return { allTurnsReady, conversation, hasCurrentTurn, hasRenderableTurn, loadAllTurns, loadTurn, refresh, state, turnIndexKey, turns };
}
