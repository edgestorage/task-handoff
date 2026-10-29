import { useEffect, useRef } from 'react';
import { AppState, type AppStateStatus } from 'react-native';

type DrawerNavigation = {
  closeDrawer(): void;
};

export function shouldDismissInstanceDrawer(previous: AppStateStatus, next: AppStateStatus) {
  return next === 'background' || (next === 'active' && previous === 'background');
}

export function useDismissInstanceDrawerOnAppBackground(navigation: DrawerNavigation) {
  const previous = useRef<AppStateStatus>(AppState.currentState);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (next) => {
      if (shouldDismissInstanceDrawer(previous.current, next)) {
        navigation.closeDrawer();
      }
      previous.current = next;
    });
    return () => subscription.remove();
  }, [navigation]);
}
