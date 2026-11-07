import { useEffect, useState, useSyncExternalStore } from 'react';
import { useIsFocused } from 'expo-router/react-navigation';
import { resourcePresentations } from './resource-presentation';

/** Only one mounted surface may own a terminal grid or native browser context. */
export function useResourcePresentation(key: string, active: boolean) {
  const focused = useIsFocused();
  const [claim] = useState(() => Symbol(key));
  useEffect(() => {
    if (!active || !focused) return;
    return resourcePresentations.claim(key, claim);
  }, [active, claim, focused, key]);
  const owner = useSyncExternalStore(resourcePresentations.subscribe, () => resourcePresentations.owner(key), () => undefined);
  return active && focused && owner === claim;
}
