import * as SecureStore from 'expo-secure-store';
import { createContext, createElement, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Appearance, useColorScheme, type ColorSchemeName } from 'react-native';

export const mobileLightColors = {
  background: '#f2f2f7', surface: '#ffffff', surfaceMuted: '#e9e9ef', text: '#000000', textMuted: '#636366', textPlaceholder: 'rgba(60, 60, 67, 0.30)', border: '#c6c6c8',
  primary: '#007aff', primaryButton: '#007aff', destructiveButton: '#c9342f', primarySoft: '#e5f1ff', notice: '#fff4ce', noticeText: '#7a4b00', error: '#c9342f', errorSoft: '#ffe9e7', code: '#1c1c1e', codeText: '#f2f2f7',
  sessionActive: '#0f9f8f', sessionActiveSoft: '#dff7f3', sessionWaiting: '#b76e00', sessionWaitingSoft: '#fff4ce', sessionIdle: '#7c7c80', sessionIdleSoft: '#eeeef2',
  syntaxComment: '#6e7781', syntaxKeyword: '#cf222e', syntaxString: '#116329', syntaxNumber: '#9a6700', syntaxTitle: '#0969da', syntaxType: '#8250df', tableStripe: '#f8f8fa',
} as const;

export const mobileDarkColors = {
  background: '#000000', surface: '#1c1c1e', surfaceMuted: '#2c2c2e', text: '#f2f2f7', textMuted: '#aeaeb2', textPlaceholder: 'rgba(235, 235, 245, 0.30)', border: '#38383a',
  primary: '#0a84ff', primaryButton: '#0a84ff', destructiveButton: '#b3261e', primarySoft: '#0c3158', notice: '#3b2f05', noticeText: '#ffd76a', error: '#ff6961', errorSoft: '#3f1715', code: '#1c1c1e', codeText: '#f2f2f7',
  sessionActive: '#2dd4bf', sessionActiveSoft: '#123b38', sessionWaiting: '#f59e0b', sessionWaitingSoft: '#3b2f05', sessionIdle: '#94a3b8', sessionIdleSoft: '#283038',
  syntaxComment: '#8b949e', syntaxKeyword: '#ff7b72', syntaxString: '#7ee787', syntaxNumber: '#e3b341', syntaxTitle: '#79c0ff', syntaxType: '#d2a8ff', tableStripe: '#242426',
} as const;

export type MobileThemeColors = typeof mobileLightColors | typeof mobileDarkColors;

export type AppearancePreference = 'system' | 'light' | 'dark';
const APPEARANCE_PREFERENCE_KEY = 'task-handoff.mobile.appearance';

type MobileThemeContextValue = {
  preference: AppearancePreference;
  setPreference(preference: AppearancePreference): Promise<void>;
  dark: boolean;
  colors: MobileThemeColors;
};

const MobileThemeContext = createContext<MobileThemeContextValue | undefined>(undefined);

export function sanitizeAppearancePreference(value: unknown): AppearancePreference {
  return value === 'light' || value === 'dark' ? value : 'system';
}

export function resolveThemeDark(preference: AppearancePreference, systemScheme: ColorSchemeName | null) {
  return preference === 'dark' || (preference === 'system' && systemScheme === 'dark');
}

export function MobileThemeProvider({ children }: { children: ReactNode }) {
  const systemScheme = useColorScheme();
  const [preference, setPreferenceState] = useState<AppearancePreference>('system');

  useEffect(() => {
    let live = true;
    void SecureStore.getItemAsync(APPEARANCE_PREFERENCE_KEY).then((stored) => {
      if (live) setPreferenceState(sanitizeAppearancePreference(stored));
    }).catch(() => undefined);
    return () => { live = false; };
  }, []);

  useEffect(() => {
    // React Native accepts null to clear an app override even though its current type omits null.
    Appearance.setColorScheme((preference === 'system' ? null : preference) as ColorSchemeName);
  }, [preference]);

  const setPreference = useCallback(async (next: AppearancePreference) => {
    setPreferenceState(next);
    try {
      await SecureStore.setItemAsync(APPEARANCE_PREFERENCE_KEY, next);
    } catch {
      // Keep the selected appearance active even when device storage is unavailable.
    }
  }, []);
  const dark = resolveThemeDark(preference, systemScheme);
  const value = useMemo<MobileThemeContextValue>(() => ({
    preference,
    setPreference,
    dark,
    colors: dark ? mobileDarkColors : mobileLightColors,
  }), [dark, preference, setPreference]);

  return createElement(MobileThemeContext.Provider, { value }, children);
}

export function useMobileTheme() {
  const context = useContext(MobileThemeContext);
  const systemScheme = useColorScheme();
  if (context) return context;
  const dark = systemScheme === 'dark';
  return { preference: 'system' as const, setPreference: async () => undefined, dark, colors: dark ? mobileDarkColors : mobileLightColors };
}
