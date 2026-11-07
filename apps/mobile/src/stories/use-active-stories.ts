import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react';
import { useMobileControlPlaneRuntime } from '../control-plane/use-mobile-control-plane-runtime';
import { mobileStoryListFor, type MobileStoryListState } from './list-controller';

const EMPTY: MobileStoryListState = { stories: [], unavailableNodeIds: [], phase: 'idle' };
export function useActiveStories() {
  const runtime = useMobileControlPlaneRuntime();
  const controller = useMemo(() => runtime.api ? mobileStoryListFor(runtime.api) : undefined,
    [runtime.api]);
  useEffect(() => runtime.storyCapability === false ? undefined : controller?.acquire(runtime.coordinator), [controller, runtime.coordinator, runtime.storyCapability]);
  const subscribe = useCallback((listener: () => void) => controller?.subscribe(listener) ?? (() => undefined), [controller]);
  const snapshot = useCallback(() => controller?.snapshot() ?? EMPTY, [controller]);
  const state = useSyncExternalStore(subscribe, snapshot, snapshot);
  return { controller, state };
}
