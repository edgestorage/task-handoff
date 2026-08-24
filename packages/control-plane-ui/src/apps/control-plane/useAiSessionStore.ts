import { computed, watch } from "vue";
import { useQueryClient } from "@tanstack/vue-query";
import type { AiSessionStreamEvent, AiSessionTimelineItemEvent } from "@task-handoff/protocol/ai-sessions";
import { applyAiSessionUnreadState, applyControlPlaneAiSessionStreamEvent } from "@task-handoff/control-plane-client";
import { sharedAiSessionsApi } from "../../api/sharedClient";
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
  type InstanceBoardItemWithAppSessions,
  type InstanceWithAiSessions,
} from "../../api/types";
import { createSessionStreamRecovery, type SessionStreamRecoveryRetryOptions } from "./sessionStreamRecovery.ts";
import { useStreamingMessagesStore } from "./useStreamingMessagesStore.ts";
import { useAiSessionTimelineStore } from "./useAiSessionTimelineStore.ts";

export function useAiSessionStore(input: {
  boardInstances: () => InstanceBoardItemWithAppSessions[];
  aiSessions: () => ControlPlaneAiSessions | undefined;
  queryKey: () => readonly unknown[];
  aiSessionsApi?: Pick<typeof sharedAiSessionsApi, "refresh" | "delta">;
  recoveryRetry?: SessionStreamRecoveryRetryOptions;
}) {
  const queryClient = useQueryClient();
  const aiSessionsApi = input.aiSessionsApi || sharedAiSessionsApi;
  const streamingMessages = useStreamingMessagesStore();
  const timelineItems = useAiSessionTimelineStore();
  const acceptsInstance = (instanceId: string) => {
    const scope = input.queryKey()[1];
    return scope === "*" || scope === instanceId;
  };
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
    getEntry: (instanceId) => queryClient.getQueryData<ControlPlaneAiSessions>(input.queryKey())
      ?.instances.find((entry) => entry.instanceId === instanceId),
    refreshSnapshot: async (instanceId, signal) => (await aiSessionsApi.refresh(signal, instanceId))
      .instances.find((entry) => entry.instanceId === instanceId),
    applySnapshot: applyRecoveredSnapshot,
    loadDelta: (entry, signal) => aiSessionsApi.delta(entry.instanceId, entry.streamId, entry.revision ?? 0, signal),
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

  function instanceWithAiSessions(instance?: InstanceBoardItemWithAppSessions): InstanceWithAiSessions | undefined {
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

  function applyMessageDelta(payload: AiSessionMessageDeltaEvent, options: { replay?: boolean } = {}) {
    if (!payload?.instanceId || !payload.sessionId || !payload.delta || !acceptsInstance(payload.instanceId)) return false;
    const instance = queryClient.getQueryData<ControlPlaneAiSessions>(input.queryKey())
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
        replay: options.replay,
      });
      return true;
    }
    return false;
  }

  function applyTimelineItem(payload: AiSessionTimelineItemEvent) {
    if (!payload?.instanceId || !payload.sessionId || !acceptsInstance(payload.instanceId)) return false;
    timelineItems.apply(payload);
    return true;
  }

  function applyEvent(event: AiSessionDeltaResponse["events"][number], fromRecovery = false) {
    const instanceId = event.payload.meta.instanceId;
    if (!acceptsInstance(instanceId)) return false;
    const observation = streamRecovery.observeEvent(event.payload.meta, event.type === AiSessionEventType.Snapshot, fromRecovery);
    if (!observation.apply) return true;
    streamingMessages.replaceStream(instanceId, event.payload.meta.streamId);
    let applied = false;
    queryClient.setQueryData<ControlPlaneAiSessions>(input.queryKey(), (current) => {
      const entry = current?.instances.find((candidate) => candidate.instanceId === instanceId);
      const { result, entry: nextEntry } = applyControlPlaneAiSessionStreamEvent(entry, event);
      if (result.kind !== "applied") return current;
      applied = true;
      return upsertInstanceAiSessions(current, instanceId, nextEntry!.aiSessions, nextEntry!);
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
    if (!acceptsInstance(state.instanceId)) return false;
    let applied = false;
    queryClient.setQueryData<ControlPlaneAiSessions>(input.queryKey(), (current) => {
      if (!current) return current;
      const instances = current.instances.map((entry) => {
        if (entry.instanceId !== state.instanceId) return entry;
        const sessions = entry.aiSessions.sessions.map((session) => {
          if (session.id !== state.sessionId || session.updatedAt !== state.sessionUpdatedAt) return session;
          applied = true;
          return applyAiSessionUnreadState(session, state);
        });
        return applied ? { ...entry, aiSessions: { ...entry.aiSessions, sessions } } : entry;
      });
      return applied ? { ...current, updatedAt: state.updatedAt, instances } : current;
    });
    return applied;
  }

  function cleanupInstance(instanceId: string) {
    streamingMessages.cleanupInstance(instanceId);
    timelineItems.cleanupInstance(instanceId);
    streamRecovery.cleanupInstance(instanceId);
  }

  function applyRecoveredSnapshot(snapshot: ControlPlaneAiSessions["instances"][number]) {
    if (!acceptsInstance(snapshot.instanceId)) return;
    queryClient.setQueryData<ControlPlaneAiSessions>(input.queryKey(), (current) => (
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
    applyTimelineItem,
    recoverTimelineItems: timelineItems.recoverConnection,
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

function mergeBoardAiSessions(instances: InstanceBoardItemWithAppSessions[], aiSessions?: ControlPlaneAiSessions): InstanceWithAiSessions[] {
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

function visibleAiSessionSnapshot(instance: InstanceBoardItemWithAppSessions, snapshot: AiSessionsSnapshot) {
  return aiSessionSnapshotWithSummary(snapshot, instance.aiSessions);
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
