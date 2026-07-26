export const LOCALE_PREFERENCE_STORAGE_KEY = "task-handoff.control-plane.locale";
export const supportedLocales = ["en-US", "zh-CN"] as const;

export type SupportedLocale = typeof supportedLocales[number];
export type LocalePreference = "system" | SupportedLocale;

type StorageLike = Pick<Storage, "getItem" | "setItem">;
type StorageHost = { readonly localStorage: StorageLike };

export function accessBrowserStorage(host?: StorageHost): StorageLike | undefined {
  if (!host) return undefined;
  try {
    return host.localStorage;
  } catch {
    return undefined;
  }
}

export function sanitizeLocalePreference(value: unknown): LocalePreference {
  return value === "en-US" || value === "zh-CN" || value === "system" ? value : "system";
}

export function matchSupportedLocale(language: string): SupportedLocale | undefined {
  const normalized = language.trim().replace(/_/g, "-").toLowerCase();
  if (normalized === "zh" || normalized.startsWith("zh-cn") || normalized.startsWith("zh-hans")) return "zh-CN";
  if (normalized === "en" || normalized.startsWith("en-")) return "en-US";
  return undefined;
}

export function resolveLocale(preference: LocalePreference, languages: readonly string[]): SupportedLocale {
  if (preference !== "system") return preference;
  for (const language of languages) {
    const matched = matchSupportedLocale(language);
    if (matched) return matched;
  }
  return "en-US";
}

export function readLocalePreference(storage?: StorageLike): LocalePreference {
  if (!storage) return "system";
  try {
    return sanitizeLocalePreference(storage.getItem(LOCALE_PREFERENCE_STORAGE_KEY));
  } catch {
    return "system";
  }
}

export function writeLocalePreference(storage: StorageLike | undefined, preference: LocalePreference) {
  if (!storage) return;
  try {
    storage.setItem(LOCALE_PREFERENCE_STORAGE_KEY, preference);
  } catch {
    // Browser privacy modes can reject storage writes. The active locale still changes for this page.
  }
}

export function localeDirection(_locale: SupportedLocale): "ltr" | "rtl" {
  return "ltr";
}
