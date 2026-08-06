import * as SecureStore from 'expo-secure-store';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

import { enUS, type MessageKey, zhCN } from './messages';
import { resolveLocale, sanitizeLocalePreference, systemLanguages, type LocalePreference, type SupportedLocale } from './locale';

const LOCALE_PREFERENCE_KEY = 'task-handoff.mobile.locale';
type MessageParams = Readonly<Record<string, string | number>>;
export type Translate = (key: MessageKey, params?: MessageParams) => string;
type I18nContextValue = {
  locale: SupportedLocale;
  preference: LocalePreference;
  setPreference(preference: LocalePreference): Promise<void>;
  t: Translate;
};

function formatMessage(message: string, params?: MessageParams) {
  if (!params) return message;
  return message
    .replace(/\{(\w+), plural, one \{([^{}]*)\} other \{([^{}]*)\}\}/g, (_match, name: string, one: string, other: string) => Number(params[name]) === 1 ? one : other)
    .replace(/\{(\w+)\}/g, (_match, name: string) => String(params[name] ?? `{${name}}`));
}

export function translate(locale: SupportedLocale, key: MessageKey, params?: MessageParams) {
  return formatMessage((locale === 'zh-CN' ? zhCN : enUS)[key], params);
}

const defaultLocale = resolveLocale('system', systemLanguages());
const I18nContext = createContext<I18nContextValue>({
  locale: defaultLocale,
  preference: 'system',
  setPreference: async () => undefined,
  t: (key, params) => translate(defaultLocale, key, params),
});

export function MobileI18nProvider({ children }: { children: ReactNode }) {
  const [preference, setPreferenceState] = useState<LocalePreference>('system');
  useEffect(() => {
    let live = true;
    void SecureStore.getItemAsync(LOCALE_PREFERENCE_KEY).then((stored) => {
      if (live) setPreferenceState(sanitizeLocalePreference(stored));
    }).catch(() => undefined);
    return () => { live = false; };
  }, []);
  const setPreference = useCallback(async (next: LocalePreference) => {
    setPreferenceState(next);
    try {
      await SecureStore.setItemAsync(LOCALE_PREFERENCE_KEY, next);
    } catch {
      // Keep the selected language active even when device storage is unavailable.
    }
  }, []);
  const locale = resolveLocale(preference, systemLanguages());
  const value = useMemo<I18nContextValue>(() => ({
    locale,
    preference,
    setPreference,
    t: (key, params) => translate(locale, key, params),
  }), [locale, preference, setPreference]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n() {
  return useContext(I18nContext);
}

export type { LocalePreference, SupportedLocale } from './locale';
