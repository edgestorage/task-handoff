import { computed, watch } from "vue";
import { useQueryClient } from "@tanstack/vue-query";
import { applyAiSessionStreamEvent, type AiSessionStreamEvent, type AiSessionsState } from "@task-handoff/protocol/ai-sessions";
import { getApiData } from "../../api/client";
import {
  AiSessionEventType,
  type AiSessionSummary,
  type AiSessionDeltaResponse,
  type AiSessionMessageDeltaEvent,
  type AiSessionPatchEvent,
  type AiSessionRemovedEvent,
  type AiSessionSnapshotEvent,
  type AiSessionUnreadState,
  type AiSessionsSnapshot,
  type ControlPlaneAiSessions,
  type InstanceBoardItem,
  type InstanceWithAiSessions,
} from "../../api/types";
import { appSessionBindingKeys, isVisibleAppSession } from "./appSessionVisibility.ts";
import { createSessionStreamRecovery, type SessionStreamRecoveryRetryOptions } from "./sessionStreamRecovery.ts";
import { useStreamingMessagesStore } from "./useStreamingMessagesStore.ts";

export function useAiSessionStore(input: {
  boardInstances: () => InstanceBoardItem[];
  aiSessions: () => ControlPlaneAiSessions | undefined;
  apiLoader?: typeof getApiData;
  recoveryRetry?: SessionStreamRecoveryRetryOptions;
}) {
  const queryClient = useQueryClient();
  const apiLoader = input.apiLoader || getApiData;
  const streamingMessages = useStreamingMessagesStore();
  const boardInstancesWithAiSessions = computed(() => mergeBoardAiSessions(input.boardInstances(), input.aiSessions()));
  const snapshotsByInstanceId = computed(() => {
    const snapshots = new Map<string, AiSessionsSnapshot>();
    for (const entry of input.aiSessions()?.instances || []) {
      snapshots.set(entry.instanceId, entry.aiSessions);
    }
    return snapshots;
  });
  let knownInstanceIds = new Set<string>();
  const streamRecovery = createSessionStreamRecovery({
    topic: "ai.sessions",
    getEntry: (instanceId) => queryClient.getQueryData<ControlPlaneAiSessions>(["control-plane-ai-sessions"])
      ?.instances.find((entry) => entry.instanceId === instanceId),
    refreshSnapshot: async (instanceId, signal) => (await apiLoader<ControlPlaneAiSessions>("ai-sessions?refresh=true", { signal }))
      .instances.find((entry) => entry.instanceId === instanceId),
    applySnapshot: applyRecoveredSnapshot,
    loadDelta: (entry, signal) => apiLoader<AiSessionDeltaResponse>(`ai-sessions?instanceId=${encodeURIComponent(entry.instanceId)}&streamId=${encodeURIComponent(entry.streamId)}&sinceRevision=${encodeURIComponent(String(entry.revision ?? 0))}`, { signal }),
    applyEvent: (event: AiSessionDeltaResponse["events"][number]) => { applyEvent(event, true); },
    onStreamChanged: (instanceId, streamId) => streamingMessages.replaceStream(instanceId, streamId),
    onError: (error, context) => console.warn("AI_SESSION_STREAM_RECOVERY_RETRY", {
      ...context,
      error: error instanceof Error ? error.message : String(error),
    }),
    retry: input.recoveryRetry,
  });

  watch(input.aiSessions, (current) => {
    if (!current) return;
    const nextInstanceIds = new Set(current.instances.map((entry) => entry.instanceId));
    for (const instanceId of knownInstanceIds) {
      if (!nextInstanceIds.has(instanceId)) cleanupInstance(instanceId);
    }
    knownInstanceIds = nextInstanceIds;
  }, { immediate: true });

  function instanceWithAiSessions(instance?: InstanceBoardItem): InstanceWithAiSessions | undefined {
    if (!instance) {
      return undefined;
    }
    const snapshot = snapshotsByInstanceId.value.get(instance.id);
    return snapshot ? { ...instance, aiSessions: visibleAiSessionSnapshot(instance, snapshot) } : { ...instance, aiSessions: emptyAiSessionsSnapshot(instance.aiSessions.updatedAt) };
  }

  function applySnapshotEvent(payload: AiSessionSnapshotEvent) {
    return applyEvent({ type: AiSessionEventType.Snapshot, payload });
  }

  function applyPatchEvent(payload: AiSessionPatchEvent) {
    return applyEvent({ type: AiSessionEventType.Patch, payload });
  }

  function applyRemovedEvent(payload: AiSessionRemovedEvent) {
    return applyEvent({ type: AiSessionEventType.Removed, payload });
  }

  function applyMessageDelta(payload: AiSessionMessageDeltaEvent) {
    if (!payload?.instanceId || !payload.sessionId || !payload.delta) return false;
    const instance = queryClient.getQueryData<ControlPlaneAiSessions>(["control-plane-ai-sessions"])
      ?.instances.find((entry) => entry.instanceId === payload.instanceId);
    const streamId = streamRecovery.streamId(payload.instanceId) || instance?.streamId;
    if (streamId) {
      streamingMessages.appendDelta({
        identity: {
          instanceId: payload.instanceId,
          sessionId: payload.sessionId,
          turnId: payload.turnId,
          itemId: payload.itemId,
        },
        streamId,
        delta: payload.delta,
        generatedAt: payload.generatedAt,
      });
      return true;
    }
    return false;
  }

  function applyEvent(event: AiSessionDeltaResponse["events"][number], fromRecovery = false) {
    const instanceId = event.payload.meta.instanceId;
    const observation = streamRecovery.observeEvent(event.payload.meta, event.type === AiSessionEventType.Snapshot, fromRecovery);
    if (!observation.apply) return true;
    streamingMessages.replaceStream(instanceId, event.payload.meta.streamId);
    let applied = false;
    queryClient.setQueryData<ControlPlaneAiSessions>(["control-plane-ai-sessions"], (current) => {
      const entry = current?.instances.find((candidate) => candidate.instanceId === instanceId);
      const projection: AiSessionsState | undefined = entry ? { streamId: entry.streamId, revision: entry.revision ?? 0, lastEventAt: entry.lastEventAt || entry.aiSessions.updatedAt, snapshot: entry.aiSessions } : undefined;
      const result = applyAiSessionStreamEvent(projection, event);
      if (result.kind !== "applied") return current;
      applied = true;
      const previousUnread = new Map(entry?.aiSessions.sessions.map((session) => [session.id, session.unread]) || []);
      const snapshot = {
        ...result.projection.snapshot,
        sessions: result.projection.snapshot.sessions.map((session) => ({
          ...session,
          unread: session.status === "running" || session.status === "waiting" ? false : previousUnread.get(session.id) || false,
        })),
      };
      return upsertInstanceAiSessions(current, instanceId, snapshot, { streamId: result.projection.streamId, revision: result.projection.revision, lastEventAt: result.projection.lastEventAt });
    });
    if (applied) {
      if (event.type === AiSessionEventType.Snapshot) streamingMessages.applySnapshot(event.payload);
      if (event.type === AiSessionEventType.Patch) streamingMessages.applyPatch(event.payload);
      if (event.type === AiSessionEventType.Removed) streamingMessages.applyRemoved(event.payload);
    }
    if (!applied && !fromRecovery) void streamRecovery.recoverDescriptor(observation.descriptor);
    return applied || Boolean(streamRecovery.streamId(instanceId));
  }

  function applyUnreadEvent(state: AiSessionUnreadState) {
    let applied = false;
    queryClient.setQueryData<ControlPlaneAiSessions>(["control-plane-ai-sessions"], (current) => {
      if (!current) return current;
      const instances = current.instances.map((entry) => {
        if (entry.instanceId !== state.instanceId) return entry;
        const sessions = entry.aiSessions.sessions.map((session) => {
          if (session.id !== state.sessionId || session.updatedAt !== state.sessionUpdatedAt) return session;
          applied = true;
          return { ...session, unread: state.unread };
        });
        return applied ? { ...entry, aiSessions: { ...entry.aiSessions, sessions } } : entry;
      });
      return applied ? { ...current, updatedAt: state.updatedAt, instances } : current;
    });
    return applied;
  }

  function cleanupInstance(instanceId: string) {
    streamingMessages.cleanupInstance(instanceId);
    streamRecovery.cleanupInstance(instanceId);
  }

  function applyRecoveredSnapshot(snapshot: ControlPlaneAiSessions["instances"][number]) {
    queryClient.setQueryData<ControlPlaneAiSessions>(["control-plane-ai-sessions"], (current) => (
      upsertInstanceAiSessions(current, snapshot.instanceId, snapshot.aiSessions, snapshot)
    ));
    streamingMessages.applyAuthoritativeSnapshot({
      instanceId: snapshot.instanceId,
      streamId: snapshot.streamId,
      snapshot: snapshot.aiSessions,
      generatedAt: snapshot.lastEventAt || snapshot.aiSessions.updatedAt,
    });
  }

  return {
    boardInstancesWithAiSessions,
    instanceWithAiSessions,
    applySnapshotEvent,
    applyMessageDelta,
    applyEvent,
    applyUnreadEvent,
    recoverDescriptor: streamRecovery.recoverDescriptor,
  };
}

function aiSessionSnapshot(sessions: AiSessionSummary[], updatedAt: string, staleCount: number): AiSessionsSnapshot {
  return {
    runningCount: sessions.filter((session) => session.status === "running").length,
    waitingCount: sessions.filter((session) => session.status === "waiting").length,
    staleCount,
    sessions,
    updatedAt,
  };
}

function mergeBoardAiSessions(instances: InstanceBoardItem[], aiSessions?: ControlPlaneAiSessions): InstanceWithAiSessions[] {
  if (!aiSessions?.instances?.length) {
    return instances.map((instance) => ({ ...instance, aiSessions: emptyAiSessionsSnapshot(instance.aiSessions.updatedAt) }));
  }
  const byInstance = new Map(aiSessions.instances.map((entry) => [entry.instanceId, entry.aiSessions]));
  return instances.map((instance) => {
    const snapshot = byInstance.get(instance.id);
    return snapshot ? { ...instance, aiSessions: visibleAiSessionSnapshot(instance, snapshot) } : { ...instance, aiSessions: emptyAiSessionsSnapshot(instance.aiSessions.updatedAt) };
  });
}

function emptyAiSessionsSnapshot(updatedAt: string) {
  return {
    runningCount: 0,
    waitingCount: 0,
    staleCount: 0,
    idleCount: 0,
    problemCount: 0,
    sessions: [],
    updatedAt,
  };
}

function aiSessionSnapshotWithSummary(snapshot: AiSessionsSnapshot, summary: InstanceBoardItem["aiSessions"]) {
  return {
    ...summary,
    ...snapshot,
    idleCount: snapshot.sessions.filter((session) => session.status === "idle").length,
    problemCount: snapshot.sessions.filter((session) => session.status === "failed").length,
  };
}

function visibleAiSessionSnapshot(instance: InstanceBoardItem, snapshot: AiSessionsSnapshot) {
  const sessions = snapshot.sessions.filter((session) => hasBoundVisibleAppSession(instance.apps.sessions || [], session));
  return aiSessionSnapshotWithSummary({ ...snapshot, sessions }, instance.aiSessions);
}

function hasBoundVisibleAppSession(appSessions: Array<Record<string, unknown>>, session: AiSessionSummary) {
  if (session.appSessionId && appSessions.some((entry) => entry.id === session.appSessionId && isVisibleAppSession(entry))) {
    return true;
  }
  const bindingKeys = new Set(session.appBindingKeys || []);
  return Boolean(bindingKeys.size && appSessions.some((entry) => isVisibleAppSession(entry) && appSessionBindingKeys(entry).some((key) => bindingKeys.has(key))));
}

function upsertInstanceAiSessions(current: ControlPlaneAiSessions | undefined, instanceId: string, snapshot: AiSessionsSnapshot, meta: { streamId: string; revision?: number; lastEventAt?: string }): ControlPlaneAiSessions {
  const updatedAt = new Date().toISOString();
  const existing = current?.instances || [];
  const index = existing.findIndex((entry) => entry.instanceId === instanceId);
  if (index < 0) {
    return {
      updatedAt,
      instances: [...existing, { instanceId, aiSessions: snapshot, ...meta }],
    };
  }
  const instances = [...existing];
  instances[index] = { instanceId, aiSessions: snapshot, ...meta };
  return { updatedAt, instances };
}
