import { computed } from "vue";
import { useQueryClient } from "@tanstack/vue-query";
import { applyAiSessionStreamEvent, type AiSessionStreamEvent, type AiSessionsState } from "@task-handoff/protocol/ai-sessions";
import type { SessionStreamDescriptor } from "@task-handoff/protocol/events";
import { getApiData } from "../../api/client";
import {
  AiSessionEventType,
  type AiSessionSummary,
  type AiSessionDeltaResponse,
  type AiSessionEventMeta,
  type AiSessionMessageDeltaEvent,
  type AiSessionPatchEvent,
  type AiSessionRemovedEvent,
  type AiSessionSnapshotEvent,
  type AiSessionsSnapshot,
  type ControlPlaneAiSessions,
  type InstanceBoardItem,
  type InstanceWithAiSessions,
} from "../../api/types";
import { appSessionBindingKeys, isVisibleAppSession } from "./appSessionVisibility.ts";

export function useAiSessionStore(input: {
  boardInstances: () => InstanceBoardItem[];
  aiSessions: () => ControlPlaneAiSessions | undefined;
  apiLoader?: typeof getApiData;
}) {
  const queryClient = useQueryClient();
  const apiLoader = input.apiLoader || getApiData;
  const advertised = new Map<string, SessionStreamDescriptor>();
  const recoveries = new Map<string, { promise: Promise<void>; highWater: number }>();
  const messageDeltaBuffers = new Map<string, string>();
  const boardInstancesWithAiSessions = computed(() => mergeBoardAiSessions(input.boardInstances(), input.aiSessions()));
  const snapshotsByInstanceId = computed(() => {
    const snapshots = new Map<string, AiSessionsSnapshot>();
    for (const entry of input.aiSessions()?.instances || []) {
      snapshots.set(entry.instanceId, entry.aiSessions);
    }
    return snapshots;
  });

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
    const key = [payload.instanceId, payload.sessionId, payload.turnId || "", payload.itemId || ""].join("\u0000");
    const text = `${messageDeltaBuffers.get(key) || ""}${payload.delta}`;
    const phase: AiSessionSummary["phase"] = "responding";
    messageDeltaBuffers.set(key, text);
    let applied = false;
    queryClient.setQueryData<ControlPlaneAiSessions>(["control-plane-ai-sessions"], (current) => {
      if (!current) return current;
      const instances = current.instances.map((entry) => {
        if (entry.instanceId !== payload.instanceId) return entry;
        const sessions = entry.aiSessions.sessions.map((session) => {
          if (session.id !== payload.sessionId) return session;
          applied = true;
          const turns = [...(session.turns || [])];
          const turnIndex = payload.turnId
            ? turns.findIndex((turn) => turn.id === payload.turnId || turn.providerTurnId === payload.turnId)
            : turns.length - 1;
          if (turnIndex >= 0) {
            turns[turnIndex] = { ...turns[turnIndex], lastMessage: text, summary: text, phase, updatedAt: payload.generatedAt };
          }
          return { ...session, lastMessage: text, summary: text, phase, updatedAt: payload.generatedAt, turns };
        });
        return { ...entry, aiSessions: { ...entry.aiSessions, sessions } };
      });
      return applied ? { ...current, instances } : current;
    });
    return applied;
  }

  function applyEvent(event: AiSessionDeltaResponse["events"][number], fromRecovery = false) {
    const instanceId = event.payload.meta.instanceId;
    const advertisedStream = advertised.get(instanceId)?.streamId;
    if (advertisedStream && advertisedStream !== event.payload.meta.streamId) {
      const descriptor = descriptorThroughEvent(advertised.get(instanceId), event.payload.meta);
      advertised.set(instanceId, descriptor);
      if (event.type !== AiSessionEventType.Snapshot) {
        if (!fromRecovery) void recoverDescriptor(descriptor);
        return true;
      }
    } else {
      advertised.set(instanceId, descriptorThroughEvent(advertised.get(instanceId), event.payload.meta));
    }
    const recovery = recoveries.get(instanceId);
    if (recovery && !fromRecovery) {
      recovery.highWater = Math.max(recovery.highWater, event.payload.meta.revision);
    }
    let applied = false;
    queryClient.setQueryData<ControlPlaneAiSessions>(["control-plane-ai-sessions"], (current) => {
      const entry = current?.instances.find((candidate) => candidate.instanceId === instanceId);
      const projection = entry ? { streamId: entry.streamId, revision: entry.revision ?? 0, lastEventAt: entry.lastEventAt || entry.aiSessions.updatedAt, snapshot: entry.aiSessions } as AiSessionsState : undefined;
      const result = applyAiSessionStreamEvent(projection, event as unknown as AiSessionStreamEvent);
      if (result.kind !== "applied") return current;
      applied = true;
      clearSettledMessageDeltaBuffers(instanceId, result.projection.snapshot);
      return upsertInstanceAiSessions(current, instanceId, result.projection.snapshot, { streamId: result.projection.streamId, revision: result.projection.revision, lastEventAt: result.projection.lastEventAt });
    });
    if (!applied && !fromRecovery) void recoverDescriptor(descriptorThroughEvent(advertised.get(instanceId), event.payload.meta));
    return applied || advertised.has(instanceId);
  }

  function clearSettledMessageDeltaBuffers(instanceId: string, snapshot: AiSessionsSnapshot) {
    for (const session of snapshot.sessions) {
      if (session.status === "running") continue;
      const prefix = `${instanceId}\u0000${session.id}\u0000`;
      for (const key of messageDeltaBuffers.keys()) {
        if (key.startsWith(prefix)) messageDeltaBuffers.delete(key);
      }
    }
  }

  function recoverDescriptor(descriptor?: SessionStreamDescriptor) {
    if (!descriptor) return Promise.resolve();
    const previous = advertised.get(descriptor.instanceId);
    advertised.set(descriptor.instanceId, descriptor);
    const existing = recoveries.get(descriptor.instanceId);
    if (existing) {
      existing.highWater = previous?.streamId === descriptor.streamId
        ? Math.max(existing.highWater, descriptor.latestRevision)
        : descriptor.latestRevision;
      return existing.promise;
    }
    const record = { promise: Promise.resolve(), highWater: descriptor.latestRevision };
    record.promise = (async () => {
      while (true) {
        const currentDescriptor = advertised.get(descriptor.instanceId);
        if (!currentDescriptor) return;
        const entry = queryClient.getQueryData<ControlPlaneAiSessions>(["control-plane-ai-sessions"])?.instances.find((candidate) => candidate.instanceId === currentDescriptor.instanceId);
        const revisionBeforeRequest = entry?.revision ?? -1;
        const streamBeforeRequest = entry?.streamId;
        if (!entry || entry.streamId !== currentDescriptor.streamId) {
          const refreshed = await apiLoader<ControlPlaneAiSessions>("ai-sessions?refresh=true");
          const latestDescriptor = advertised.get(descriptor.instanceId);
          const snapshot = refreshed.instances.find((candidate) => candidate.instanceId === descriptor.instanceId);
          if (!latestDescriptor || snapshot?.streamId !== latestDescriptor.streamId) return;
          queryClient.setQueryData<ControlPlaneAiSessions>(["control-plane-ai-sessions"], (current) => upsertInstanceAiSessions(current, descriptor.instanceId, snapshot.aiSessions, snapshot));
        } else if ((entry.revision ?? 0) < record.highWater) {
          const delta = await apiLoader<AiSessionDeltaResponse>(`ai-sessions?instanceId=${encodeURIComponent(entry.instanceId)}&streamId=${encodeURIComponent(entry.streamId)}&sinceRevision=${encodeURIComponent(String(entry.revision ?? 0))}`);
          if (delta.syncRequired) {
            const refreshed = await apiLoader<ControlPlaneAiSessions>("ai-sessions?refresh=true");
            const latestDescriptor = advertised.get(descriptor.instanceId);
            const snapshot = refreshed.instances.find((candidate) => candidate.instanceId === descriptor.instanceId);
            if (!latestDescriptor || snapshot?.streamId !== latestDescriptor.streamId) return;
            queryClient.setQueryData<ControlPlaneAiSessions>(["control-plane-ai-sessions"], (current) => upsertInstanceAiSessions(current, descriptor.instanceId, snapshot.aiSessions, snapshot));
          } else {
            for (const event of delta.events) applyEvent(event, true);
            record.highWater = Math.max(record.highWater, delta.latestRevision);
          }
        }
        const latestDescriptor = advertised.get(descriptor.instanceId);
        const latest = queryClient.getQueryData<ControlPlaneAiSessions>(["control-plane-ai-sessions"])?.instances.find((candidate) => candidate.instanceId === descriptor.instanceId);
        if (latestDescriptor && latest?.streamId === latestDescriptor.streamId && (latest.revision ?? 0) >= record.highWater) return;
        if (latest?.streamId === streamBeforeRequest && (latest.revision ?? -1) === revisionBeforeRequest) return;
      }
    })().finally(() => recoveries.delete(descriptor.instanceId));
    recoveries.set(descriptor.instanceId, record);
    return record.promise;
  }

  return {
    boardInstancesWithAiSessions,
    instanceWithAiSessions,
    applySnapshotEvent,
    applyMessageDelta,
    applyEvent,
    recoverDescriptor,
  };
}

function descriptorThroughEvent(descriptor: SessionStreamDescriptor | undefined, meta: AiSessionEventMeta) {
  return {
    topic: "ai.sessions" as const,
    instanceId: meta.instanceId,
    streamId: meta.streamId,
    latestRevision: descriptor?.streamId === meta.streamId ? Math.max(descriptor.latestRevision, meta.revision) : meta.revision,
    earliestRetainedRevision: descriptor?.streamId === meta.streamId ? descriptor.earliestRetainedRevision : meta.revision,
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
