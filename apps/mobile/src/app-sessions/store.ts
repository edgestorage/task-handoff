import type { ControlPlaneAppSessions } from '@task-handoff/control-plane-client';
import { applyAppSessionStreamEvent, type AppSessionStreamApplyResult, type AppSessionStreamEvent } from '@task-handoff/protocol/app-sessions';

export type MobileAppSessionProfileState = {
  controlPlaneId: string;
  snapshot?: ControlPlaneAppSessions;
  sync: { phase: 'idle' | 'loading' | 'ready' | 'stale' | 'offline' | 'error'; lastSyncedAt?: string; error?: string };
};

type Listener = () => void;

export class MobileAppSessionStore {
  private readonly profiles = new Map<string, MobileAppSessionProfileState>();
  private readonly listeners = new Map<string, Set<Listener>>();
  private readonly generations = new Map<string, number>();

  generation(id: string) { return this.generations.get(id) ?? 0; }
  isGeneration(id: string, generation: number) { return this.generation(id) === generation; }
  profile(id: string) {
    const current = this.profiles.get(id);
    if (current) return current;
    const initial: MobileAppSessionProfileState = { controlPlaneId: id, sync: { phase: 'idle' } };
    this.profiles.set(id, initial);
    return initial;
  }
  replaceSnapshot(id: string, snapshot: ControlPlaneAppSessions) {
    this.profiles.set(id, { ...this.profile(id), snapshot, sync: { phase: 'ready', lastSyncedAt: snapshot.updatedAt } });
    this.emit(id);
  }
  setSyncState(id: string, sync: MobileAppSessionProfileState['sync']) {
    this.profiles.set(id, { ...this.profile(id), sync });
    this.emit(id);
  }
  applyStreamEvent(id: string, event: AppSessionStreamEvent): AppSessionStreamApplyResult {
    const current = this.profile(id);
    const instanceId = event.payload.meta.instanceId;
    const entry = current.snapshot?.instances.find((candidate) => candidate.instanceId === instanceId);
    const projection = entry ? {
      streamId: entry.streamId,
      revision: entry.revision ?? 0,
      lastEventAt: entry.lastEventAt || entry.appSessions.updatedAt,
      snapshot: entry.appSessions,
    } : undefined;
    const result = applyAppSessionStreamEvent(projection, event);
    if (result.kind !== 'applied') return result;
    const replacement = {
      instanceId,
      streamId: result.projection.streamId,
      revision: result.projection.revision,
      lastEventAt: result.projection.lastEventAt,
      appSessions: result.projection.snapshot,
    };
    const instances = current.snapshot?.instances ?? [];
    const index = instances.findIndex((candidate) => candidate.instanceId === instanceId);
    this.replaceSnapshot(id, {
      updatedAt: result.projection.lastEventAt,
      instances: index < 0 ? [...instances, replacement] : instances.map((candidate, candidateIndex) => candidateIndex === index ? replacement : candidate),
    });
    return result;
  }
  subscribe(id: string, listener: Listener) {
    const listeners = this.listeners.get(id) ?? new Set<Listener>();
    listeners.add(listener); this.listeners.set(id, listeners);
    return () => { listeners.delete(listener); };
  }
  private emit(id: string) { for (const listener of this.listeners.get(id) ?? []) listener(); }
}

export const mobileAppSessionStore = new MobileAppSessionStore();
