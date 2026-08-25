import { shallowRef, type ShallowRef } from "vue";
import type {
  AiSessionPatchEvent,
  AiSessionRemovedEvent,
  AiSessionSnapshotEvent,
} from "../../api/types";
import type { AiSessionSummary, AiSessionsSnapshot } from "@task-handoff/protocol/ai-sessions";
import {
  aiSessionAuthoritativeMessageStatus,
  aiSessionMessageKey,
  appendAiSessionMessageDelta,
  type AiSessionStreamingMessageStatus,
} from "@task-handoff/control-plane-client";

export type StreamingMessageIdentity = {
  instanceId: string;
  sessionId: string;
  turnId: string;
  itemId: string;
};

export type StreamingMessageStatus = AiSessionStreamingMessageStatus;

export type StreamingMessageState = StreamingMessageIdentity & {
  key: string;
  streamId: string;
  receivedText: string;
  status: StreamingMessageStatus;
  createdAt: string;
  receivedAt?: string;
  settledAt?: string;
  updatedAt: string;
};

export type StreamingMessageRef = ShallowRef<StreamingMessageState>;

export type StreamingMessagesStore = ReturnType<typeof createStreamingMessagesStore>;

type AuthoritativeMessage = {
  identity: StreamingMessageIdentity;
  streamId: string;
  text: string;
  status: StreamingMessageStatus;
  generatedAt?: string;
};

type AppendDeltaInput = {
  identity: StreamingMessageIdentity;
  streamId: string;
  delta: string;
  generatedAt?: string;
  replay?: boolean;
};

type StreamingMessagesStoreOptions = {
  now?: () => string;
};

type AuthoritativeSnapshotInput = {
  instanceId: string;
  streamId: string;
  snapshot: AiSessionsSnapshot;
  generatedAt: string;
};

export function streamingMessageKey(identity: StreamingMessageIdentity) {
  return aiSessionMessageKey(identity);
}

export function createStreamingMessagesStore(options: StreamingMessagesStoreOptions = {}) {
  const now = options.now || (() => new Date().toISOString());
  const messages = new Map<string, StreamingMessageRef>();
  const keysByInstance = new Map<string, Set<string>>();
  const keysBySession = new Map<string, Set<string>>();
  const activeMessages = new Map<string, ShallowRef<StreamingMessageRef | undefined>>();
  const activeSessionKeysByInstance = new Map<string, Set<string>>();
  const activeStreams = new Map<string, string>();

  function message(identity: StreamingMessageIdentity) {
    return messages.get(streamingMessageKey(identity));
  }

  function activeMessage(instanceId: string, sessionId: string) {
    const sessionKey = streamingSessionKey(instanceId, sessionId);
    let active = activeMessages.get(sessionKey);
    if (!active) {
      active = shallowRef<StreamingMessageRef>();
      activeMessages.set(sessionKey, active);
      addIndex(activeSessionKeysByInstance, instanceId, sessionKey);
    }
    return active;
  }

  function appendDelta(input: AppendDeltaInput) {
    if (!input.delta) return message(input.identity);
    activateStream(input.identity.instanceId, input.streamId);
    const at = input.generatedAt || now();
    const entry = ensureMessage(input.identity, input.streamId, at);
    const current = entry.value;
    // A demand transition loads an authoritative snapshot while the source
    // replays transient events after its cursor. Do not append replay that the
    // snapshot already incorporates.
    if (input.replay && current.receivedAt && at <= current.receivedAt) return entry;
    entry.value = appendAiSessionMessageDelta(current, input.delta, at);
    return entry;
  }

  function settleAuthoritative(input: AuthoritativeMessage) {
    activateStream(input.identity.instanceId, input.streamId);
    const at = input.generatedAt || now();
    const entry = ensureMessage(input.identity, input.streamId, at);
    const current = entry.value;
    entry.value = {
      ...current,
      receivedText: input.text,
      status: input.status,
      receivedAt: at,
      settledAt: input.status === "streaming" ? undefined : at,
      updatedAt: at,
    };
    return entry;
  }

  function settleProjectedStatus(entry: StreamingMessageRef, status: StreamingMessageStatus, generatedAt: string) {
    const current = entry.value;
    entry.value = {
      ...current,
      status,
      settledAt: status === "streaming" ? undefined : generatedAt,
      updatedAt: generatedAt,
    };
  }

  function applySnapshot(payload: AiSessionSnapshotEvent) {
    applyAuthoritativeSnapshot({
      instanceId: payload.meta.instanceId,
      streamId: payload.meta.streamId,
      snapshot: payload.snapshot,
      generatedAt: payload.meta.generatedAt,
    });
  }

  function applyAuthoritativeSnapshot(input: AuthoritativeSnapshotInput) {
    activateStream(input.instanceId, input.streamId);
    const presentSessions = new Set(input.snapshot.sessions.map((session) => session.id));
    const missingSessions = new Set<string>();
    for (const key of keysByInstance.get(input.instanceId) || []) {
      const current = messages.get(key)?.value;
      if (current && !presentSessions.has(current.sessionId)) missingSessions.add(current.sessionId);
    }
    for (const sessionId of missingSessions) cleanupSession(input.instanceId, sessionId);
    for (const session of input.snapshot.sessions) {
      reconcileSession(input.instanceId, input.streamId, session, input.generatedAt);
    }
  }

  function applyPatch(payload: AiSessionPatchEvent) {
    activateStream(payload.meta.instanceId, payload.meta.streamId);
    for (const sessionId of payload.removed) cleanupSession(payload.meta.instanceId, sessionId);
    for (const session of payload.upserted) {
      reconcileSession(payload.meta.instanceId, payload.meta.streamId, session, payload.meta.generatedAt);
    }
  }

  function applyRemoved(payload: AiSessionRemovedEvent) {
    activateStream(payload.meta.instanceId, payload.meta.streamId);
    for (const sessionId of payload.sessionIds) cleanupSession(payload.meta.instanceId, sessionId);
  }

  function replaceStream(instanceId: string, streamId: string) {
    return activateStream(instanceId, streamId);
  }

  function cleanupSession(instanceId: string, sessionId: string) {
    const sessionKey = streamingSessionKey(instanceId, sessionId);
    const keys = keysBySession.get(sessionKey);
    if (!keys) {
      dropActiveMessage(instanceId, sessionKey);
      return false;
    }
    for (const key of [...keys]) deleteMessage(key, false);
    dropActiveMessage(instanceId, sessionKey);
    return true;
  }

  function cleanupInstance(instanceId: string) {
    const keys = keysByInstance.get(instanceId);
    if (keys) {
      for (const key of [...keys]) deleteMessage(key, false);
    }
    for (const sessionKey of [...(activeSessionKeysByInstance.get(instanceId) || [])]) {
      dropActiveMessage(instanceId, sessionKey);
    }
    activeSessionKeysByInstance.delete(instanceId);
    activeStreams.delete(instanceId);
  }

  function clear() {
    for (const active of activeMessages.values()) active.value = undefined;
    messages.clear();
    keysByInstance.clear();
    keysBySession.clear();
    activeMessages.clear();
    activeSessionKeysByInstance.clear();
    activeStreams.clear();
  }

  function size() {
    return messages.size;
  }

  function ensureMessage(identity: StreamingMessageIdentity, streamId: string, at: string) {
    const key = streamingMessageKey(identity);
    const existing = messages.get(key);
    if (existing) return existing;
    const entry = shallowRef<StreamingMessageState>({
      ...identity,
      key,
      streamId,
      receivedText: "",
      status: "streaming",
      createdAt: at,
      updatedAt: at,
    });
    messages.set(key, entry);
    addIndex(keysByInstance, identity.instanceId, key);
    addIndex(keysBySession, streamingSessionKey(identity.instanceId, identity.sessionId), key);
    const active = activeMessage(identity.instanceId, identity.sessionId);
    if (active.value !== entry) active.value = entry;
    return entry;
  }

  function activateStream(instanceId: string, streamId: string) {
    const current = activeStreams.get(instanceId);
    if (current === streamId) return false;
    if (current !== undefined) {
      for (const key of [...(keysByInstance.get(instanceId) || [])]) deleteMessage(key, false);
      clearActiveMessagesForInstance(instanceId);
    }
    activeStreams.set(instanceId, streamId);
    return current !== undefined;
  }

  function reconcileSession(instanceId: string, streamId: string, session: AiSessionSummary, generatedAt: string) {
    let target = reconciliationTarget(instanceId, session);
    const activeTurn = session.turns?.find((candidate) => candidate.id === session.activeTurnId)
      || session.turns?.at(-1);
    const turn = target
      ? session.turns?.find((candidate) =>
          candidate.id === target.value.turnId || candidate.providerTurnId === target.value.turnId,
        )
      : activeTurn;
    const authoritativeItemId = turn?.lastMessageItemId || session.lastMessageItemId;
    const status = aiSessionAuthoritativeMessageStatus(session, turn?.status);
    // The current list projection deliberately omits turns and compacts the
    // top-level lastMessage for previews. It may advance lifecycle state, but
    // it is not authoritative conversation content and must never replace the
    // complete text accumulated from message-delta events.
    if (session.turns === undefined) {
      if (target) settleProjectedStatus(target, status, generatedAt);
      return;
    }
    const text = turn?.lastMessage ?? (activeTurn ? undefined : session.lastMessage);
    if (target?.value.itemId && authoritativeItemId && target.value.itemId !== authoritativeItemId) {
      if (status === "streaming") return;
      target = ensureMessage({
        instanceId,
        sessionId: session.id,
        turnId: target.value.turnId,
        itemId: authoritativeItemId,
      }, streamId, generatedAt);
      activeMessage(instanceId, session.id).value = target;
    }
    if (target?.value.itemId && !authoritativeItemId && status === "streaming") {
      return;
    }
    if (text === undefined) {
      if (!target) clearActiveMessage(streamingSessionKey(instanceId, session.id));
      return;
    }
    if (!target) {
      target = ensureMessage({
        instanceId,
        sessionId: session.id,
        turnId: activeTurn?.id || session.activeTurnId || "",
        itemId: authoritativeItemId || "",
      }, streamId, generatedAt);
    }
    settleAuthoritative({
      identity: target.value,
      streamId,
      text,
      status,
      generatedAt,
    });
  }

  function reconciliationTarget(instanceId: string, session: AiSessionSummary) {
    const keys = keysBySession.get(streamingSessionKey(instanceId, session.id));
    if (!keys?.size) return undefined;
    const candidates = [...keys]
      .map((key) => messages.get(key))
      .filter((entry): entry is StreamingMessageRef => Boolean(entry));
    const turnId = session.activeTurnId || session.turns?.at(-1)?.id;
    const matching = turnId
      ? candidates.filter((entry) => {
          const turn = session.turns?.find((candidate) => candidate.id === turnId);
          return entry.value.turnId === turnId || entry.value.turnId === turn?.providerTurnId;
        })
      : candidates;
    if (turnId && !matching.length) return undefined;
    return (matching.length ? matching : candidates).sort((left, right) =>
      right.value.updatedAt.localeCompare(left.value.updatedAt),
    )[0];
  }

  function deleteMessage(key: string, updateActive = true) {
    const entry = messages.get(key);
    const current = entry?.value;
    if (!current) return;
    messages.delete(key);
    removeIndex(keysByInstance, current.instanceId, key);
    const sessionKey = streamingSessionKey(current.instanceId, current.sessionId);
    removeIndex(keysBySession, sessionKey, key);
    const active = activeMessages.get(sessionKey);
    if (updateActive && active?.value === entry) {
      const replacementKey = [...(keysBySession.get(sessionKey) || [])].at(-1);
      active.value = replacementKey ? messages.get(replacementKey) : undefined;
    }
  }

  function clearActiveMessagesForInstance(instanceId: string) {
    for (const sessionKey of activeSessionKeysByInstance.get(instanceId) || []) {
      clearActiveMessage(sessionKey);
    }
  }

  function clearActiveMessage(sessionKey: string) {
    const active = activeMessages.get(sessionKey);
    if (active?.value) active.value = undefined;
  }

  function dropActiveMessage(instanceId: string, sessionKey: string) {
    clearActiveMessage(sessionKey);
    activeMessages.delete(sessionKey);
    removeIndex(activeSessionKeysByInstance, instanceId, sessionKey);
  }

  return {
    message,
    activeMessage,
    appendDelta,
    settleAuthoritative,
    applySnapshot,
    applyAuthoritativeSnapshot,
    applyPatch,
    applyRemoved,
    replaceStream,
    cleanupSession,
    cleanupInstance,
    clear,
    size,
  };
}

function streamingSessionKey(instanceId: string, sessionId: string) {
  return JSON.stringify([instanceId, sessionId]);
}

function addIndex(index: Map<string, Set<string>>, owner: string, key: string) {
  const keys = index.get(owner) || new Set<string>();
  keys.add(key);
  index.set(owner, keys);
}

function removeIndex(index: Map<string, Set<string>>, owner: string, key: string) {
  const keys = index.get(owner);
  if (!keys) return;
  keys.delete(key);
  if (!keys.size) index.delete(owner);
}

const streamingMessagesStore = createStreamingMessagesStore();

export function useStreamingMessagesStore() {
  return streamingMessagesStore;
}
