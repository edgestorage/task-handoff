import { computed, readonly, ref } from "vue";
import { createI18n } from "vue-i18n";
import { datetimeFormats, numberFormats } from "./formats.ts";
import {
  accessBrowserStorage,
  localeDirection,
  readLocalePreference,
  resolveLocale,
  writeLocalePreference,
  type LocalePreference,
  type SupportedLocale,
} from "./locale.ts";
import { enUS } from "./locales/en-US/index.ts";
import { zhCN } from "./locales/zh-CN/index.ts";

export const messages = {
  "en-US": enUS,
  "zh-CN": zhCN,
};

function browserStorage() {
  return accessBrowserStorage(typeof window === "undefined" ? undefined : window);
}

function browserLanguages() {
  return typeof navigator === "undefined" ? [] : navigator.languages;
}

const localePreference = ref<LocalePreference>(readLocalePreference(browserStorage()));
const initialLocale = resolveLocale(localePreference.value, browserLanguages());

export const i18n = createI18n({
  legacy: false,
  locale: initialLocale,
  fallbackLocale: "en-US",
  messages,
  datetimeFormats,
  numberFormats,
  missingWarn: import.meta.env?.DEV ?? false,
  fallbackWarn: import.meta.env?.DEV ?? false,
});

function syncDocumentLocale(locale: SupportedLocale) {
  if (typeof document === "undefined") return;
  document.documentElement.lang = locale;
  document.documentElement.dir = localeDirection(locale);
}

function applyLocalePreference(preference: LocalePreference) {
  const locale = resolveLocale(preference, browserLanguages());
  i18n.global.locale.value = locale;
  syncDocumentLocale(locale);
  return locale;
}

export function initializeControlPlaneI18n() {
  applyLocalePreference(localePreference.value);
  if (typeof window !== "undefined") {
    window.addEventListener("languagechange", () => {
      if (localePreference.value === "system") applyLocalePreference("system");
    });
  }
}

export function setLocalePreference(preference: LocalePreference) {
  localePreference.value = preference;
  writeLocalePreference(browserStorage(), preference);
  return applyLocalePreference(preference);
}

export function useControlPlaneLocale() {
  return {
    locale: computed(() => i18n.global.locale.value as SupportedLocale),
    preference: readonly(localePreference),
    setPreference: setLocalePreference,
  };
}

export { createControlPlaneI18nForTest } from "./testing.ts";
export type { LocalePreference, SupportedLocale } from "./locale.ts";
