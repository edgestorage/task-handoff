import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import {
  accessBrowserStorage,
  LOCALE_PREFERENCE_STORAGE_KEY,
  matchSupportedLocale,
  readLocalePreference,
  resolveLocale,
  sanitizeLocalePreference,
  writeLocalePreference,
} from "../src/i18n/locale.ts";
import { enUS } from "../src/i18n/locales/en-US/index.ts";
import { zhCN } from "../src/i18n/locales/zh-CN/index.ts";
import { createControlPlaneI18nForTest } from "../src/i18n/testing.ts";

function leafKeys(value, prefix = "") {
  return Object.entries(value).flatMap(([key, child]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    return typeof child === "string" ? [path] : leafKeys(child, path);
  });
}

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    value: (key) => values.get(key),
  };
}

test("localized resources expose the same semantic keys", () => {
  assert.deepEqual(leafKeys(zhCN).sort(), leafKeys(enUS).sort());
});

test("locale matching normalizes supported English and simplified Chinese tags", () => {
  assert.equal(matchSupportedLocale("zh-Hans-CN"), "zh-CN");
  assert.equal(matchSupportedLocale("zh_CN"), "zh-CN");
  assert.equal(matchSupportedLocale("en-GB"), "en-US");
  assert.equal(matchSupportedLocale("ja-JP"), undefined);
  assert.equal(resolveLocale("system", ["ja-JP", "zh-Hans"]), "zh-CN");
  assert.equal(resolveLocale("system", ["ja-JP"]), "en-US");
  assert.equal(resolveLocale("en-US", ["zh-CN"]), "en-US");
});

test("locale preferences sanitize and persist independently of server settings", () => {
  const storage = memoryStorage({ [LOCALE_PREFERENCE_STORAGE_KEY]: "future" });
  assert.equal(sanitizeLocalePreference("future"), "system");
  assert.equal(readLocalePreference(storage), "system");
  writeLocalePreference(storage, "zh-CN");
  assert.equal(storage.value(LOCALE_PREFERENCE_STORAGE_KEY), "zh-CN");
  assert.equal(readLocalePreference(storage), "zh-CN");
});

test("locale initialization tolerates blocked browser storage access", () => {
  const blockedHost = {};
  Object.defineProperty(blockedHost, "localStorage", {
    get() {
      throw new DOMException("Storage access is blocked.", "SecurityError");
    },
  });

  assert.equal(accessBrowserStorage(blockedHost), undefined);
  assert.equal(readLocalePreference(accessBrowserStorage(blockedHost)), "system");
});

test("test i18n instances do not share active locale state", () => {
  const english = createControlPlaneI18nForTest("en-US");
  const chinese = createControlPlaneI18nForTest("zh-CN");
  assert.equal(english.global.t("common.actions.save"), "Save");
  assert.equal(chinese.global.t("common.actions.save"), "保存");
  english.global.locale.value = "zh-CN";
  assert.equal(chinese.global.locale.value, "zh-CN");
  chinese.global.locale.value = "en-US";
  assert.equal(english.global.locale.value, "zh-CN");
});

test("appearance language selection is browser-local and does not emit server settings updates", () => {
  const source = fs.readFileSync(new URL("../src/apps/control-plane/settings/AppearanceSettingsSection.vue", import.meta.url), "utf8");
  assert.match(source, /common\.language\.label/);
  assert.match(source, /value="system"/);
  assert.match(source, /value="en-US"/);
  assert.match(source, /value="zh-CN"/);
  assert.match(source, /setPreference/);
  assert.doesNotMatch(source, /update:locale|saveLocale|ControlPlaneSettings.*locale/);
});

test("desktop update capability reasons are localized from structured codes", () => {
  const source = fs.readFileSync(new URL("../src/apps/control-plane/settings/AppearanceSettingsSection.vue", import.meta.url), "utf8");
  assert.match(source, /capabilities\.reasonCode/);
  assert.match(source, /settings\.appearance\.updateReason/);
  assert.doesNotMatch(source, /\{\{\s*desktopUpdateState\?\.capabilities\.reason\s*\}\}/);
});

test("shared select values are recreated when the active locale changes", () => {
  const source = fs.readFileSync(new URL("../src/apps/control-plane/shared/ControlPlaneSelect.vue", import.meta.url), "utf8");
  assert.match(source, /<Select :key="locale"/);
  assert.match(source, /const \{ locale \} = useI18n\(\)/);
});
