import { computed } from "vue";
import { useQueryClient } from "@tanstack/vue-query";
import { applyAppSessionStreamEvent, type AppSessionStreamEvent, type AppSessionsState } from "@task-handoff/protocol/app-sessions";
import type { SessionStreamDescriptor } from "@task-handoff/protocol/events";
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
} from "../../api/types";
import { isVisibleAppSession } from "./appSessionVisibility.ts";

export function useAppSessionStore(input: {
  boardInstances: () => InstanceBoardItem[];
  appSessions: () => ControlPlaneAppSessions | undefined;
  apiLoader?: typeof getApiData;
}) {
  const queryClient = useQueryClient();
  const apiLoader = input.apiLoader || getApiData;
  const advertised = new Map<string, SessionStreamDescriptor>();
  const recoveries = new Map<string, { promise: Promise<void>; highWater: number }>();
  const boardInstancesWithAppSessions = computed(() => mergeBoardAppSessions(input.boardInstances(), input.appSessions()));

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
    const advertisedStream = advertised.get(instanceId)?.streamId;
    if (advertisedStream && advertisedStream !== event.payload.meta.streamId) {
      const descriptor = descriptorThroughEvent(advertised.get(instanceId), event.payload.meta);
      advertised.set(instanceId, descriptor);
      if (event.type !== AppSessionEventType.Snapshot) {
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
    queryClient.setQueryData<ControlPlaneAppSessions>(["control-plane-app-sessions"], (current) => {
      const entry = current?.instances.find((candidate) => candidate.instanceId === instanceId);
      const projection = entry ? { streamId: entry.streamId, revision: entry.revision ?? 0, lastEventAt: entry.lastEventAt || entry.appSessions.updatedAt, snapshot: entry.appSessions } as unknown as AppSessionsState : undefined;
      const result = applyAppSessionStreamEvent(projection, event as unknown as AppSessionStreamEvent);
      if (result.kind !== "applied") return current;
      applied = true;
      return upsertInstanceAppSessions(current, instanceId, visibleAppSessionsSnapshot(result.projection.snapshot as unknown as AppSessionsSnapshot), { streamId: result.projection.streamId, revision: result.projection.revision, lastEventAt: result.projection.lastEventAt });
    });
    if (!applied && !fromRecovery) void recoverDescriptor(descriptorThroughEvent(advertised.get(instanceId), event.payload.meta));
    return applied || advertised.has(instanceId);
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
        const entry = queryClient.getQueryData<ControlPlaneAppSessions>(["control-plane-app-sessions"])?.instances.find((candidate) => candidate.instanceId === currentDescriptor.instanceId);
        const revisionBeforeRequest = entry?.revision ?? -1;
        const streamBeforeRequest = entry?.streamId;
        if (!entry || entry.streamId !== currentDescriptor.streamId) {
          const refreshed = await apiLoader<ControlPlaneAppSessions>("app-sessions?refresh=true");
          const latestDescriptor = advertised.get(descriptor.instanceId);
          const snapshot = refreshed.instances.find((candidate) => candidate.instanceId === descriptor.instanceId);
          if (!latestDescriptor || snapshot?.streamId !== latestDescriptor.streamId) return;
          queryClient.setQueryData<ControlPlaneAppSessions>(["control-plane-app-sessions"], (current) => upsertInstanceAppSessions(current, descriptor.instanceId, snapshot.appSessions, snapshot));
        } else if ((entry.revision ?? 0) < record.highWater) {
          const delta = await apiLoader<AppSessionDeltaResponse>(`app-sessions?instanceId=${encodeURIComponent(entry.instanceId)}&streamId=${encodeURIComponent(entry.streamId)}&sinceRevision=${encodeURIComponent(String(entry.revision ?? 0))}`);
          if (delta.syncRequired) {
            const refreshed = await apiLoader<ControlPlaneAppSessions>("app-sessions?refresh=true");
            const latestDescriptor = advertised.get(descriptor.instanceId);
            const snapshot = refreshed.instances.find((candidate) => candidate.instanceId === descriptor.instanceId);
            if (!latestDescriptor || snapshot?.streamId !== latestDescriptor.streamId) return;
            queryClient.setQueryData<ControlPlaneAppSessions>(["control-plane-app-sessions"], (current) => upsertInstanceAppSessions(current, descriptor.instanceId, snapshot.appSessions, snapshot));
          } else {
            for (const event of delta.events) applyEvent(event, true);
            record.highWater = Math.max(record.highWater, delta.latestRevision);
          }
        }
        const latestDescriptor = advertised.get(descriptor.instanceId);
        const latest = queryClient.getQueryData<ControlPlaneAppSessions>(["control-plane-app-sessions"])?.instances.find((candidate) => candidate.instanceId === descriptor.instanceId);
        if (latestDescriptor && latest?.streamId === latestDescriptor.streamId && (latest.revision ?? 0) >= record.highWater) return;
        if (latest?.streamId === streamBeforeRequest && (latest.revision ?? -1) === revisionBeforeRequest) return;
      }
    })().finally(() => recoveries.delete(descriptor.instanceId));
    recoveries.set(descriptor.instanceId, record);
    return record.promise;
  }

  return {
    boardInstancesWithAppSessions,
    applySnapshotEvent,
    applyEvent,
    recoverDescriptor,
  };
}

function descriptorThroughEvent(descriptor: SessionStreamDescriptor | undefined, meta: { instanceId: string; streamId: string; revision: number }) {
  return {
    topic: "app.sessions" as const,
    instanceId: meta.instanceId,
    streamId: meta.streamId,
    latestRevision: descriptor?.streamId === meta.streamId ? Math.max(descriptor.latestRevision, meta.revision) : meta.revision,
    earliestRetainedRevision: descriptor?.streamId === meta.streamId ? descriptor.earliestRetainedRevision : meta.revision,
  };
}

function mergeBoardAppSessions(instances: InstanceBoardItem[], appSessions?: ControlPlaneAppSessions): InstanceBoardItem[] {
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
        sessions: snapshot.sessions.filter(isVisibleAppSession),
      },
    };
  });
}

function visibleAppSessionsSnapshot(snapshot: AppSessionsSnapshot): AppSessionsSnapshot {
  return appSessionsSnapshot(snapshot.sessions.filter(isVisibleAppSession));
}

function appSessionsSnapshot(sessions: AppSessionsSnapshot["sessions"], updatedAt = new Date().toISOString()): AppSessionsSnapshot {
  return {
    runningCount: sessions.filter((session) => session.status === "running").length,
    problemCount: sessions.filter((session) => session.status === "failed").length,
    sessions,
    updatedAt,
  };
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
