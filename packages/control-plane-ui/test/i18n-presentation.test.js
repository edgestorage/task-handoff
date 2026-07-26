import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import {
  compareNaturalText,
  compareTechnicalIdentifiers,
  formatBytes,
  formatDate,
  formatDateTime,
  formatNumber,
  formatPercent,
  formatRelativeTime,
  formatTime,
  naturalTextCollator,
} from "../src/i18n/presentation.ts";
import {
  aiSessionStatusKeys,
  connectionStatusKeys,
  imagePullStatusKeys,
  instanceStatusKeys,
  translateStatus,
} from "../src/i18n/status.ts";
import { createControlPlaneI18nForTest } from "../src/i18n/testing.ts";

test("date number relative-time and byte formatters honor the selected locale", () => {
  const date = new Date("2026-07-26T08:30:15.000Z");
  assert.notEqual(formatDate(date, "en-US"), formatDate(date, "zh-CN"));
  assert.notEqual(formatDateTime(date, "en-US"), formatDateTime(date, "zh-CN"));
  assert.ok(formatTime(date, "en-US"));
  assert.ok(formatNumber(1234.5, "zh-CN"));
  assert.equal(formatPercent(0.42, "en-US"), "42%");
  assert.equal(formatBytes(1536, "en-US"), "1.5 KiB");
  assert.match(formatRelativeTime(date, new Date("2026-07-26T08:31:15.000Z"), "en-US"), /minute/);
});

test("natural text uses locale collators while technical identifiers stay code-point stable", () => {
  assert.strictEqual(naturalTextCollator("zh-CN"), naturalTextCollator("zh-CN"));
  assert.ok(compareNaturalText("节点2", "节点10", "zh-CN") < 0);
  assert.ok(compareTechnicalIdentifiers("node_10", "node_2") < 0);
});

test("central status mappings localize known values and preserve unknown values", () => {
  const english = createControlPlaneI18nForTest("en-US").global.t;
  const chinese = createControlPlaneI18nForTest("zh-CN").global.t;
  assert.equal(translateStatus(instanceStatusKeys, "running", english), "Running");
  assert.equal(translateStatus(connectionStatusKeys, "offline", chinese), "离线");
  assert.equal(translateStatus(aiSessionStatusKeys, "waiting", chinese), "等待中");
  assert.equal(translateStatus(imagePullStatusKeys, "extracting", chinese), "正在解压镜像");
  assert.match(translateStatus(instanceStatusKeys, "future-state", english), /future-state/);
});

test("authoritative state modules do not import translation runtime", () => {
  const files = [
    "../src/apps/control-plane/useAiSessionStore.ts",
    "../src/apps/control-plane/useAppSessionStore.ts",
    "../src/apps/control-plane/useControlPlaneEvents.ts",
    "../src/apps/control-plane/instanceLifecycleCache.ts",
  ];
  for (const relative of files) {
    const source = fs.readFileSync(new URL(relative, import.meta.url), "utf8");
    assert.doesNotMatch(source, /from ["'][^"']*i18n|useI18n\s*\(/);
  }
});
