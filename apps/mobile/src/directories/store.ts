import type { ControlPlaneInstanceResourceEntry } from '@task-handoff/control-plane-client';
import type { ControlPlaneNodeDirectoryEntry } from '@task-handoff/protocol/control-plane-directory';
import type { ControlPlaneInstanceLifecycleDirectoryEvent, ControlPlaneNodeConnectionPhase } from '@task-handoff/protocol/control-plane-directory';

export type MobileDirectoryProfileState = {
  controlPlaneId: string;
  nodes: readonly ControlPlaneNodeDirectoryEntry[];
  instances: readonly ControlPlaneInstanceResourceEntry[];
  phase: 'idle' | 'loading' | 'ready' | 'stale' | 'offline' | 'error';
  updatedAt?: string;
  error?: string;
};

type Listener = () => void;
export class MobileDirectoryStore {
  private readonly profiles = new Map<string, MobileDirectoryProfileState>();
  private readonly listeners = new Map<string, Set<Listener>>();
  private readonly instanceListeners = new Map<string, Set<Listener>>();
  private readonly generations = new Map<string, number>();
  private readonly lifecycleRevisions = new Map<string, number>();
  private readonly nodeConnectionChangedAt = new Map<string, string>();
  generation(controlPlaneId: string) { return this.generations.get(controlPlaneId) ?? 0; }
  isGeneration(controlPlaneId: string, generation: number) { return this.generation(controlPlaneId) === generation; }
  hasProfile(controlPlaneId: string) { return this.profiles.has(controlPlaneId); }
  profile(controlPlaneId: string) {
    const existing = this.profiles.get(controlPlaneId);
    if (existing) return existing;
    const initial: MobileDirectoryProfileState = { controlPlaneId, nodes: [], instances: [], phase: 'idle' };
    this.profiles.set(controlPlaneId, initial);
    return initial;
  }
  set(controlPlaneId: string, patch: Partial<Omit<MobileDirectoryProfileState, 'controlPlaneId'>>) {
    const current = this.profile(controlPlaneId);
    const next = { ...current, ...patch, controlPlaneId };
    this.profiles.set(controlPlaneId, next);
    for (const listener of this.listeners.get(controlPlaneId) ?? []) listener();
    if (next.instances !== current.instances) {
      for (const listener of this.instanceListeners.get(controlPlaneId) ?? []) listener();
    }
    return next;
  }
  setInstanceDefaultPermissionMode(controlPlaneId: string, instanceId: string, defaultCodexPermissionMode: ControlPlaneInstanceResourceEntry['config']['defaultCodexPermissionMode']) {
    const current = this.profile(controlPlaneId);
    return this.set(controlPlaneId, {
      instances: current.instances.map((instance) => instance.id === instanceId
        ? { ...instance, config: { ...instance.config, defaultCodexPermissionMode } }
        : instance),
    });
  }
  setInstanceName(controlPlaneId: string, instanceId: string, name: string) {
    const current = this.profile(controlPlaneId);
    return this.set(controlPlaneId, {
      instances: current.instances.map((instance) => instance.id === instanceId ? { ...instance, name } : instance),
    });
  }
  setNodeName(controlPlaneId: string, nodeId: string, name: string) {
    const current = this.profile(controlPlaneId);
    return this.set(controlPlaneId, {
      nodes: current.nodes.map((node) => node.id === nodeId ? { ...node, name } : node),
    });
  }
  setNodeConnection(controlPlaneId: string, nodeId: string, connectionPhase: ControlPlaneNodeConnectionPhase, changedAt: string, lastSeenAt?: string) {
    const observationKey = `${controlPlaneId}\u0000${nodeId}`;
    const previousChangedAt = this.nodeConnectionChangedAt.get(observationKey);
    const current = this.profile(controlPlaneId);
    const target = current.nodes.find((node) => node.id === nodeId);
    if (!target || changedAt < target.observedAt || (previousChangedAt && changedAt <= previousChangedAt)) return false;
    this.nodeConnectionChangedAt.set(observationKey, changedAt);
    return this.set(controlPlaneId, {
      nodes: current.nodes.map((node) => node.id === nodeId
        ? { ...node, connectionPhase, ...(lastSeenAt ? { lastSeenAt } : {}) }
        : node),
    });
  }
  applyInstanceLifecycle(controlPlaneId: string, snapshot: ControlPlaneInstanceLifecycleDirectoryEvent) {
    const revisionKey = `${controlPlaneId}\u0000${snapshot.instanceId}`;
    if ((this.lifecycleRevisions.get(revisionKey) ?? -1) >= snapshot.revision) return false;
    const current = this.profile(controlPlaneId);
    const target = current.instances.find((instance) => instance.id === snapshot.instanceId);
    if (!target || snapshot.updatedAt < target.observedAt) return false;
    this.lifecycleRevisions.set(revisionKey, snapshot.revision);
    this.set(controlPlaneId, {
      instances: current.instances.map((instance) => instance.id === snapshot.instanceId ? {
        ...instance,
        status: snapshot.status,
        health: snapshot.health,
        connectionStatus: snapshot.connectionStatus,
        ready: snapshot.ready,
        observedAt: snapshot.updatedAt,
        lastHeartbeatAt: snapshot.lastHeartbeatAt,
        availableActions: [],
      } : instance),
    });
    return true;
  }
  clearProfile(controlPlaneId: string) {
    const deleted = this.profiles.delete(controlPlaneId);
    this.generations.set(controlPlaneId, this.generation(controlPlaneId) + 1);
    for (const key of this.lifecycleRevisions.keys()) {
      if (key.startsWith(`${controlPlaneId}\u0000`)) this.lifecycleRevisions.delete(key);
    }
    for (const key of this.nodeConnectionChangedAt.keys()) {
      if (key.startsWith(`${controlPlaneId}\u0000`)) this.nodeConnectionChangedAt.delete(key);
    }
    if (deleted) {
      for (const listener of this.listeners.get(controlPlaneId) ?? []) listener();
      for (const listener of this.instanceListeners.get(controlPlaneId) ?? []) listener();
    }
    return deleted;
  }
  subscribe(controlPlaneId: string, listener: Listener) {
    const listeners = this.listeners.get(controlPlaneId) ?? new Set<Listener>();
    listeners.add(listener); this.listeners.set(controlPlaneId, listeners);
    return () => { listeners.delete(listener); };
  }
  subscribeInstances(controlPlaneId: string, listener: Listener) {
    const listeners = this.instanceListeners.get(controlPlaneId) ?? new Set<Listener>();
    listeners.add(listener); this.instanceListeners.set(controlPlaneId, listeners);
    return () => {
      listeners.delete(listener);
      if (!listeners.size) this.instanceListeners.delete(controlPlaneId);
    };
  }
}

export const mobileDirectoryStore = new MobileDirectoryStore();
