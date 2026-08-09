import type { ControlPlaneTriggers } from '@task-handoff/protocol/triggers';

export type MobileTriggerState = {
  controlPlaneId: string;
  snapshot: ControlPlaneTriggers;
  phase: 'idle' | 'loading' | 'ready' | 'stale' | 'offline' | 'error';
  canMutate: boolean;
  error?: string;
};

const emptySnapshot = (): ControlPlaneTriggers => ({ updatedAt: new Date(0).toISOString(), triggers: [] });
type Listener = () => void;

export class MobileTriggerStore {
  private readonly states = new Map<string, MobileTriggerState>();
  private readonly listeners = new Map<string, Set<Listener>>();
  private readonly generations = new Map<string, number>();

  generation(controlPlaneId: string) { return this.generations.get(controlPlaneId) ?? 0; }
  isGeneration(controlPlaneId: string, generation: number) { return this.generation(controlPlaneId) === generation; }
  state(controlPlaneId: string) {
    const existing = this.states.get(controlPlaneId);
    if (existing) return existing;
    const initial: MobileTriggerState = { controlPlaneId, snapshot: emptySnapshot(), phase: 'idle', canMutate: false };
    this.states.set(controlPlaneId, initial);
    return initial;
  }
  set(controlPlaneId: string, patch: Partial<Omit<MobileTriggerState, 'controlPlaneId'>>) {
    const next = { ...this.state(controlPlaneId), ...patch, controlPlaneId };
    this.states.set(controlPlaneId, next);
    for (const listener of this.listeners.get(controlPlaneId) ?? []) listener();
    return next;
  }
  subscribe(controlPlaneId: string, listener: Listener) {
    const listeners = this.listeners.get(controlPlaneId) ?? new Set<Listener>();
    listeners.add(listener);
    this.listeners.set(controlPlaneId, listeners);
    return () => { listeners.delete(listener); };
  }
  clearProfile(controlPlaneId: string) {
    const deleted = this.states.delete(controlPlaneId);
    this.generations.set(controlPlaneId, this.generation(controlPlaneId) + 1);
    if (deleted) for (const listener of this.listeners.get(controlPlaneId) ?? []) listener();
  }
}

export const mobileTriggerStore = new MobileTriggerStore();
