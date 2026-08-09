import { createContext, createElement, useCallback, useContext, useEffect, useMemo, useSyncExternalStore, type ReactNode } from 'react';
import type { ControlPlaneTriggerTemplateInput } from '@task-handoff/protocol/triggers';

import { useMobileControlPlaneRuntime } from '../control-plane/use-mobile-control-plane-runtime';
import { MobileTriggerController } from './controller';
import { mobileTriggerStore } from './store';

type ActiveTriggers = {
  available: boolean;
  state: ReturnType<typeof mobileTriggerStore.state>;
  create(input: ControlPlaneTriggerTemplateInput): Promise<unknown>;
  update(configHash: string, input: ControlPlaneTriggerTemplateInput): Promise<unknown>;
  remove(configHash: string): Promise<unknown>;
  bindSession(instanceId: string, sessionId: string, configHash: string): Promise<unknown>;
  unbindSession(instanceId: string, sessionId: string, configHash: string): Promise<unknown>;
  run(instanceId: string, configHash: string, deploymentId?: string): Promise<unknown>;
  refresh(): Promise<void>;
};

const Context = createContext<ActiveTriggers | undefined>(undefined);

export function ActiveTriggersProvider({ children }: { children: ReactNode }) {
  const runtime = useMobileControlPlaneRuntime();
  const available = runtime.triggerCapability;
  const controller = useMemo(() => available && runtime.api && runtime.controlPlaneId
    ? new MobileTriggerController(runtime.controlPlaneId, runtime.api, mobileTriggerStore)
    : undefined, [available, runtime.api, runtime.controlPlaneId]);
  useEffect(() => {
    if (!controller || !runtime.coordinator) return;
    return runtime.coordinator.register({
      key: 'triggers',
      topics: ['triggers'],
      start: (signal) => controller.start(signal),
      stop: () => controller.stop(),
      offline: () => controller.offline(),
      onEvent: (event) => { controller.applyEvent(event); },
      onConnectionError: (error) => controller.onConnectionError(error),
    });
  }, [controller, runtime.coordinator]);
  const fallbackId = runtime.controlPlaneId || '__booting__';
  const state = useSyncExternalStore(
    (listener) => mobileTriggerStore.subscribe(fallbackId, listener),
    () => mobileTriggerStore.state(fallbackId),
    () => mobileTriggerStore.state(fallbackId),
  );
  const invoke = useCallback(<T,>(action: (target: MobileTriggerController) => Promise<T>) => {
    if (!controller) return Promise.reject(new Error('Triggers are unavailable on this Control Plane.'));
    return action(controller);
  }, [controller]);
  const value = useMemo<ActiveTriggers>(() => ({
    available,
    state,
    create: (input) => invoke((target) => target.create(input)),
    update: (hash, input) => invoke((target) => target.update(hash, input)),
    remove: (hash) => invoke((target) => target.remove(hash)),
    bindSession: (instanceId, sessionId, hash) => invoke((target) => target.bindSession(instanceId, sessionId, hash)),
    unbindSession: (instanceId, sessionId, hash) => invoke((target) => target.unbindSession(instanceId, sessionId, hash)),
    run: (instanceId, hash, deploymentId) => invoke((target) => target.run(instanceId, hash, deploymentId)),
    refresh: () => invoke((target) => target.refresh()),
  }), [available, invoke, state]);
  return createElement(Context.Provider, { value }, children);
}

export function useActiveTriggers() {
  const value = useContext(Context);
  if (!value) throw new Error('useActiveTriggers must be used inside ActiveTriggersProvider.');
  return value;
}
