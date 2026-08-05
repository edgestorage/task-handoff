import { AppState, type AppStateStatus } from 'react-native';

export type MobileAppPhase = 'active' | 'background' | 'inactive' | 'unknown';

export function normalizeAppPhase(status: AppStateStatus): MobileAppPhase {
  return status === 'active' || status === 'background' || status === 'inactive'
    ? status
    : 'unknown';
}

export function subscribeToAppLifecycle(listener: (phase: MobileAppPhase) => void) {
  listener(normalizeAppPhase(AppState.currentState));
  const subscription = AppState.addEventListener('change', (status) => {
    listener(normalizeAppPhase(status));
  });
  return () => subscription.remove();
}
