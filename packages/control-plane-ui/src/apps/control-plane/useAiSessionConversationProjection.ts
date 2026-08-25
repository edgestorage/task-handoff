import { computed, ref, toValue, watch, type MaybeRefOrGetter } from "vue";
import type { AiSessionTurn } from "@task-handoff/protocol/ai-sessions";
import { AiSessionConversationCache } from "@task-handoff/control-plane-client";
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

  function changed() {
    cacheRevision.value += 1;
  }

  async function loadTurn(turnId: string) {
    const summary = toValue(options.summary);
    const instanceId = toValue(options.instanceId);
    const key = currentKey.value;
    if (!summary || !instanceId || !key || !turnId) return;
    const index = conversations.needsTurn(instanceId, summary.id, turnId);
    if (!index) return;
    const body = await deduplicated(`${key}:turn:${index.id}:${index.bodyRevision}`, () => getAiSessionTurnBody(instanceId, summary.id, index.id));
    if (currentKey.value !== key || body.sessionId !== summary.id) return;
    conversations.setTurn(instanceId, summary.id, body.revision, body.turn);
    changed();
  }

  async function loadAllTurns() {
    const summary = toValue(options.summary);
    const instanceId = toValue(options.instanceId);
    if (!summary || !instanceId) return;
    await Promise.all((conversations.turnIndex(instanceId, summary.id)?.turns || []).map((turn) => loadTurn(turn.id)));
  }

  async function refresh() {
    const summary = toValue(options.summary);
    const instanceId = toValue(options.instanceId);
    const key = currentKey.value;
    if (!summary || !instanceId || !key) {
      state.value = "loading";
      return;
    }
    // Revision changes refresh their own data domains in place. Only a session
    // with no cached projection enters the conversation-level loading state.
    const hadRenderableContent = conversations.hasProjection(instanceId, summary.id);
    if (!hadRenderableContent) state.value = "loading";
    try {
      const [detail, index] = await Promise.all([
        conversations.hasDetail(instanceId, summary)
          ? undefined
          : deduplicated(`${key}:detail:${summary.detailRevision || "legacy"}`, () => getAiSessionDetail(instanceId, summary.id)),
        conversations.hasTurnIndex(instanceId, summary)
          ? undefined
          : deduplicated(`${key}:index:${summary.turnsRevision || "legacy"}`, () => getAiSessionTurnIndex(instanceId, summary.id)),
      ]);
      if (currentKey.value !== key) return;
      if (detail) conversations.setDetail(instanceId, summary, detail);
      if (index) conversations.setTurnIndex(instanceId, summary, index);
      changed();
      const latest = conversations.turnIndex(instanceId, summary.id)?.turns.at(-1);
      if (latest) await loadTurn(latest.id);
      if (currentKey.value === key) state.value = "ready";
    } catch {
      if (currentKey.value === key && !hadRenderableContent) state.value = "error";
    }
  }

  watch(
    () => [currentKey.value, toValue(options.summary)?.detailRevision, toValue(options.summary)?.turnsRevision],
    () => void refresh(),
    { immediate: true },
  );

  return { conversation, loadAllTurns, loadTurn, refresh, state, turnIndexKey, turns };
}
