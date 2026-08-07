import * as SecureStore from 'expo-secure-store';
import Constants from 'expo-constants';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Platform } from 'react-native';

const STORAGE_KEY = 'task-handoff.mobile.task-status';
const STORAGE_VERSION = 1;

export type TrackedAiSession = {
  controlPlaneId: string;
  instanceId: string;
  sessionId: string;
};

type StoredSettings = {
  version: typeof STORAGE_VERSION;
  autoStart: boolean;
  trackedSession?: TrackedAiSession;
};

type TaskStatusSettings = {
  autoStart: boolean;
  available: boolean;
  loaded: boolean;
  setAutoStart(value: boolean): Promise<void>;
  startTracking(target: TrackedAiSession): Promise<void>;
  stopTracking(): Promise<void>;
  trackedSession?: TrackedAiSession;
};

const DEFAULT_SETTINGS: StoredSettings = { version: STORAGE_VERSION, autoStart: false };
const Context = createContext<TaskStatusSettings>({
  ...DEFAULT_SETTINGS,
  available: false,
  loaded: false,
  setAutoStart: async () => undefined,
  startTracking: async () => undefined,
  stopTracking: async () => undefined,
});

export function TaskStatusSettingsProvider({ children }: { children: ReactNode }) {
  const available = Platform.OS === 'ios' && Constants.expoConfig?.extra?.taskStatusWidgetsEnabled === true;
  const [settings, setSettings] = useState<StoredSettings>(DEFAULT_SETTINGS);
  const [loaded, setLoaded] = useState(!available);

  useEffect(() => {
    let live = true;
    if (!available) return () => { live = false; };
    void SecureStore.getItemAsync(STORAGE_KEY).then((raw) => {
      if (live) setSettings(parseTaskStatusSettings(raw));
    }).catch(() => undefined).finally(() => {
      if (live) setLoaded(true);
    });
    return () => { live = false; };
  }, [available]);

  const write = useCallback(async (next: StoredSettings) => {
    setSettings(next);
    try {
      await SecureStore.setItemAsync(STORAGE_KEY, JSON.stringify(next));
    } catch {
      // Keep the selected behavior active even when device storage is unavailable.
    }
  }, []);
  const value = useMemo<TaskStatusSettings>(() => ({
    autoStart: settings.autoStart,
    available,
    loaded,
    setAutoStart: (autoStart) => write({ version: STORAGE_VERSION, autoStart }),
    startTracking: (trackedSession) => write({ version: STORAGE_VERSION, autoStart: false, trackedSession }),
    stopTracking: () => write({ version: STORAGE_VERSION, autoStart: false }),
    trackedSession: settings.trackedSession,
  }), [available, loaded, settings, write]);

  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function useTaskStatusSettings() {
  return useContext(Context);
}

export function parseTaskStatusSettings(raw: string | null | undefined): StoredSettings {
  if (!raw) return DEFAULT_SETTINGS;
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    if (value.version !== STORAGE_VERSION || typeof value.autoStart !== 'boolean') return DEFAULT_SETTINGS;
    const target = sanitizeTrackedSession(value.trackedSession);
    return {
      version: STORAGE_VERSION,
      autoStart: value.autoStart,
      ...(value.autoStart || !target ? {} : { trackedSession: target }),
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

function sanitizeTrackedSession(value: unknown): TrackedAiSession | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const target = value as Record<string, unknown>;
  if (typeof target.controlPlaneId !== 'string' || typeof target.instanceId !== 'string' || typeof target.sessionId !== 'string') return undefined;
  return {
    controlPlaneId: target.controlPlaneId,
    instanceId: target.instanceId,
    sessionId: target.sessionId,
  };
}
