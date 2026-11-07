import { createPersistedPreferenceStore } from '../platform/persisted-preferences';

type AppLaunchPreferences = { appByScope: Record<string, string> };
export const APP_LAUNCH_PREFERENCES_KEY = 'task-handoff.mobile.app-launch-preferences';

export function parseAppLaunchPreferences(raw: string | null | undefined): AppLaunchPreferences | undefined {
  if (!raw) return undefined;
  try {
    const value = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value) || value.version !== 1) return undefined;
    const entries = value.appByScope;
    return { appByScope: entries && typeof entries === 'object' && !Array.isArray(entries)
      ? Object.fromEntries(Object.entries(entries).filter((entry): entry is [string, string] => {
        if (typeof entry[1] !== 'string' || !entry[1]) return false;
        try {
          const scope = JSON.parse(entry[0]);
          return Array.isArray(scope) && scope.length === 2 && scope.every((id) => typeof id === 'string' && id.length > 0);
        } catch { return false; }
      }).slice(-100))
      : {} };
  } catch {
    return undefined;
  }
}

const store = createPersistedPreferenceStore<AppLaunchPreferences>({
  storageKey: APP_LAUNCH_PREFERENCES_KEY,
  version: 1,
  defaults: { appByScope: {} },
  parse: parseAppLaunchPreferences,
});

export const getAppLaunchPreferences = store.get;
export const subscribeAppLaunchPreferences = store.subscribe;

export function appLaunchPreferenceScope(controlPlaneId: string | undefined, instanceId: string | undefined) {
  return JSON.stringify([controlPlaneId, instanceId]);
}

export function rememberAppLaunchChoice(controlPlaneId: string | undefined, instanceId: string | undefined, appId: string) {
  if (!controlPlaneId || !instanceId || !appId) return;
  const key = appLaunchPreferenceScope(controlPlaneId, instanceId);
  const current = store.get().appByScope;
  if (current[key] === appId) return;
  // Keep recent scopes last so the persisted preference remains small.
  const { [key]: _previous, ...others } = current;
  store.update({ appByScope: Object.fromEntries([...Object.entries(others), [key, appId]].slice(-100)) });
}

export function clearAppLaunchPreferences(controlPlaneId: string) {
  const current = store.get().appByScope;
  const entries = Object.entries(current).filter(([scope]) => JSON.parse(scope)[0] !== controlPlaneId);
  if (entries.length !== Object.keys(current).length) store.update({ appByScope: Object.fromEntries(entries) });
}
