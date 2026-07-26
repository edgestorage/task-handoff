import { createI18n } from "vue-i18n";
import { datetimeFormats, numberFormats } from "./formats.ts";
import type { SupportedLocale } from "./locale.ts";
import { enUS } from "./locales/en-US/index.ts";
import { zhCN } from "./locales/zh-CN/index.ts";

const testMessages = {
  "en-US": enUS,
  "zh-CN": zhCN,
};

export function createControlPlaneI18nForTest(locale: SupportedLocale = "en-US") {
  return createI18n({
    legacy: false,
    locale,
    fallbackLocale: "en-US",
    messages: testMessages,
    datetimeFormats,
    numberFormats,
    missingWarn: false,
    fallbackWarn: false,
  });
}
