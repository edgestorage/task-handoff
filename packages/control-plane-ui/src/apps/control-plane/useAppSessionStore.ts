import { computed, watch } from "vue";
import { useQueryClient } from "@tanstack/vue-query";
import { applyAppSessionStreamEvent, type AppSessionStreamEvent, type AppSessionsState } from "@task-handoff/protocol/app-sessions";
import { getApiData } from "../../api/client";
import {
  AppSessionEventType,
  type AppSessionDeltaResponse,
  type AppSessionPatchEvent,
  type AppSessionRemovedEvent,
  type AppSessionSnapshotEvent,
  type AppSessionsSnapshot,
  type ControlPlaneAppSessions,
  type InstanceBoardItem,
  type InstanceBoardItemWithAppSessions,
} from "../../api/types";
import { createSessionStreamRecovery, type SessionStreamRecoveryRetryOptions } from "./sessionStreamRecovery.ts";

export function useAppSessionStore(input: {
  boardInstances: () => InstanceBoardItem[];
  appSessions: () => ControlPlaneAppSessions | undefined;
  queryKey: () => readonly unknown[];
  apiLoader?: typeof getApiData;
  recoveryRetry?: SessionStreamRecoveryRetryOptions;
}) {
  const queryClient = useQueryClient();
  const apiLoader = input.apiLoader || getApiData;
  const boardInstancesWithAppSessions = computed(() => mergeBoardAppSessions(input.boardInstances(), input.appSessions()));
  const acceptsInstance = (instanceId: string) => {
    const scope = input.queryKey()[1];
    return scope === "*" || scope === instanceId;
  };
  const streamRecovery = createSessionStreamRecovery({
    topic: "app.sessions",
    getEntry: (instanceId) => queryClient.getQueryData<ControlPlaneAppSessions>(input.queryKey())
      ?.instances.find((entry) => entry.instanceId === instanceId),
    refreshSnapshot: async (instanceId, signal) => (await apiLoader<ControlPlaneAppSessions>("app-sessions?refresh=true", { signal }))
      .instances.find((entry) => entry.instanceId === instanceId),
    applySnapshot: applyRecoveredSnapshot,
    loadDelta: (entry, signal) => apiLoader<AppSessionDeltaResponse>(`app-sessions?instanceId=${encodeURIComponent(entry.instanceId)}&streamId=${encodeURIComponent(entry.streamId)}&sinceRevision=${encodeURIComponent(String(entry.revision ?? 0))}`, { signal }),
    applyEvent: (event: AppSessionDeltaResponse["events"][number]) => { applyEvent(event, true); },
    onError: (error, context) => console.warn("APP_SESSION_STREAM_RECOVERY_RETRY", {
      ...context,
      error: error instanceof Error ? error.message : String(error),
    }),
    retry: input.recoveryRetry,
  });
  let knownInstanceIds = new Set<string>();

  watch(input.appSessions, (current) => {
    if (!current) return;
    const nextInstanceIds = new Set(current.instances.map((entry) => entry.instanceId));
    for (const instanceId of knownInstanceIds) {
      if (!nextInstanceIds.has(instanceId)) streamRecovery.cleanupInstance(instanceId);
    }
    knownInstanceIds = nextInstanceIds;
  }, { immediate: true });

  function applySnapshotEvent(payload: AppSessionSnapshotEvent) {
    return applyEvent({ type: AppSessionEventType.Snapshot, payload });
  }

  function applyPatchEvent(payload: AppSessionPatchEvent) {
    return applyEvent({ type: AppSessionEventType.Patch, payload });
  }

  function applyRemovedEvent(payload: AppSessionRemovedEvent) {
    return applyEvent({ type: AppSessionEventType.Removed, payload });
  }

  function applyEvent(event: AppSessionDeltaResponse["events"][number], fromRecovery = false) {
    const instanceId = event.payload.meta.instanceId;
    if (!acceptsInstance(instanceId)) return false;
    const observation = streamRecovery.observeEvent(event.payload.meta, event.type === AppSessionEventType.Snapshot, fromRecovery);
    if (!observation.apply) return true;
    let applied = false;
    queryClient.setQueryData<ControlPlaneAppSessions>(input.queryKey(), (current) => {
      const entry = current?.instances.find((candidate) => candidate.instanceId === instanceId);
      const projection: AppSessionsState | undefined = entry ? { streamId: entry.streamId, revision: entry.revision ?? 0, lastEventAt: entry.lastEventAt || entry.appSessions.updatedAt, snapshot: entry.appSessions } : undefined;
      const result = applyAppSessionStreamEvent(projection, event);
      if (result.kind !== "applied") return current;
      applied = true;
      return upsertInstanceAppSessions(current, instanceId, result.projection.snapshot, { streamId: result.projection.streamId, revision: result.projection.revision, lastEventAt: result.projection.lastEventAt });
    });
    if (!applied && !fromRecovery) void streamRecovery.recoverDescriptor(observation.descriptor);
    return applied || Boolean(streamRecovery.streamId(instanceId));
  }

  function applyRecoveredSnapshot(snapshot: ControlPlaneAppSessions["instances"][number]) {
    if (!acceptsInstance(snapshot.instanceId)) return;
    queryClient.setQueryData<ControlPlaneAppSessions>(input.queryKey(), (current) => (
      upsertInstanceAppSessions(current, snapshot.instanceId, snapshot.appSessions, snapshot)
    ));
  }

  return {
    boardInstancesWithAppSessions,
    applySnapshotEvent,
    applyEvent,
    recoverDescriptor: streamRecovery.recoverDescriptor,
  };
}

function mergeBoardAppSessions(instances: InstanceBoardItem[], appSessions?: ControlPlaneAppSessions): InstanceBoardItemWithAppSessions[] {
  const byInstance = new Map((appSessions?.instances || []).map((entry) => [entry.instanceId, entry.appSessions]));
  return instances.map((instance) => {
    const snapshot = byInstance.get(instance.id);
    if (!snapshot) {
      return { ...instance, apps: { ...instance.apps, sessions: [] } };
    }
    return {
      ...instance,
      apps: {
        ...instance.apps,
        runningCount: snapshot.runningCount,
        sessions: snapshot.sessions,
      },
    };
  });
}

function upsertInstanceAppSessions(current: ControlPlaneAppSessions | undefined, instanceId: string, snapshot: AppSessionsSnapshot, meta: { streamId: string; revision?: number; lastEventAt?: string }): ControlPlaneAppSessions {
  const updatedAt = new Date().toISOString();
  const existing = current?.instances || [];
  const index = existing.findIndex((entry) => entry.instanceId === instanceId);
  if (index < 0) {
    return {
      updatedAt,
      instances: [...existing, { instanceId, appSessions: snapshot, ...meta }],
    };
  }
  const instances = [...existing];
  instances[index] = { instanceId, appSessions: snapshot, ...meta };
  return { updatedAt, instances };
}
