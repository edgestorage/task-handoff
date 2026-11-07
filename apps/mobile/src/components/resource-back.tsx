import { createContext, useContext, useEffect } from 'react';
import { BackHandler, Platform } from 'react-native';

export type ResourceBackHandlers = Map<symbol, () => boolean>;
export const ResourceBackContext = createContext<ResourceBackHandlers | undefined>(undefined);

/** Route resource-internal Back before the enclosing overlay, regardless of effect order. */
export function useResourceBack(active: boolean, goBack: () => boolean) {
  const handlers = useContext(ResourceBackContext);
  useEffect(() => {
    if (!active || Platform.OS !== 'android') return;
    if (!handlers) {
      const subscription = BackHandler.addEventListener('hardwareBackPress', goBack);
      return () => subscription.remove();
    }
    const id = Symbol('resource-back');
    handlers.set(id, goBack);
    return () => { handlers.delete(id); };
  }, [active, goBack, handlers]);
}
