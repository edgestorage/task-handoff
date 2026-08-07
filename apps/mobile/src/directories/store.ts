import type { ControlPlaneInstanceResourceEntry } from '@task-handoff/control-plane-client';
import type { ControlPlaneNodeDirectoryEntry } from '@task-handoff/protocol/control-plane-directory';

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
  private readonly generations = new Map<string, number>();
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
    const next = { ...this.profile(controlPlaneId), ...patch, controlPlaneId };
    this.profiles.set(controlPlaneId, next);
    for (const listener of this.listeners.get(controlPlaneId) ?? []) listener();
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
  clearProfile(controlPlaneId: string) {
    const deleted = this.profiles.delete(controlPlaneId);
    this.generations.set(controlPlaneId, this.generation(controlPlaneId) + 1);
    if (deleted) for (const listener of this.listeners.get(controlPlaneId) ?? []) listener();
    return deleted;
  }
  subscribe(controlPlaneId: string, listener: Listener) {
    const listeners = this.listeners.get(controlPlaneId) ?? new Set<Listener>();
    listeners.add(listener); this.listeners.set(controlPlaneId, listeners);
    return () => { listeners.delete(listener); };
  }
}

export const mobileDirectoryStore = new MobileDirectoryStore();
