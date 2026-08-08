import { I18nManager } from 'react-native';

export const supportedLocales = ['en-US', 'zh-CN'] as const;

export type SupportedLocale = typeof supportedLocales[number];
export type LocalePreference = 'system' | SupportedLocale;

export function matchSupportedLocale(language: string): SupportedLocale | undefined {
  const normalized = language.trim().replace(/_/g, '-').toLowerCase();
  if (normalized === 'zh' || normalized.startsWith('zh-cn') || normalized.startsWith('zh-hans')) return 'zh-CN';
  if (normalized === 'en' || normalized.startsWith('en-')) return 'en-US';
  return undefined;
}

export function resolveLocale(preference: LocalePreference, languages: readonly string[]): SupportedLocale {
  if (preference !== 'system') return preference;
  for (const language of languages) {
    const locale = matchSupportedLocale(language);
    if (locale) return locale;
  }
  return 'en-US';
}

export function sanitizeLocalePreference(value: unknown): LocalePreference {
  return value === 'en-US' || value === 'zh-CN' || value === 'system' ? value : 'system';
}

export function systemLanguages(): string[] {
  const nativeLocale = I18nManager.getConstants().localeIdentifier;
  try {
    return [nativeLocale, Intl.DateTimeFormat().resolvedOptions().locale].filter((locale): locale is string => Boolean(locale));
  } catch {
    return nativeLocale ? [nativeLocale] : [];
  }
}
