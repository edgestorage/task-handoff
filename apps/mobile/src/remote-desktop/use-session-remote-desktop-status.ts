import { useCallback, useSyncExternalStore } from 'react';

import { remoteDesktopControllerFor, subscribeRemoteDesktopControllers, type RemoteDesktopControllerScope } from './controller-registry';
import { emptyRemoteDesktopSnapshot, type RemoteDesktopSnapshot } from './types';

export function useSessionRemoteDesktopStatus(scope: RemoteDesktopControllerScope): RemoteDesktopSnapshot {
  const { controlPlaneId, instanceId, sessionId } = scope;
  const getSnapshot = useCallback(
    () => remoteDesktopControllerFor({ controlPlaneId, instanceId, sessionId })?.getSnapshot() ?? emptyRemoteDesktopSnapshot,
    [controlPlaneId, instanceId, sessionId],
  );
  const subscribe = useCallback((listener: () => void) => {
    const currentScope = { controlPlaneId, instanceId, sessionId };
    let controller = remoteDesktopControllerFor(currentScope);
    let unsubscribeController = controller?.subscribe(listener);
    const unsubscribeRegistry = subscribeRemoteDesktopControllers(() => {
      const next = remoteDesktopControllerFor(currentScope);
      if (next !== controller) {
        unsubscribeController?.();
        controller = next;
        unsubscribeController = next?.subscribe(listener);
      }
      listener();
    });
    return () => {
      unsubscribeController?.();
      unsubscribeRegistry();
    };
  }, [controlPlaneId, instanceId, sessionId]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
