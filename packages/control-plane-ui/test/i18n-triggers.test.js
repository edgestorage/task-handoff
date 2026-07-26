import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { createControlPlaneI18nForTest } from "../src/i18n/testing.ts";

const english = createControlPlaneI18nForTest("en-US").global.t;
const chinese = createControlPlaneI18nForTest("zh-CN").global.t;

test("trigger presentation strings render in English and Simplified Chinese", () => {
  assert.equal(english("triggers.libraryTitle", { count: 3 }), "Trigger Library · 3");
  assert.equal(chinese("triggers.libraryTitle", { count: 3 }), "触发器库 · 3");
  assert.equal(english("triggers.status.running"), "Running");
  assert.equal(chinese("triggers.status.running"), "运行中");
  assert.equal(english("triggers.sourceSummary.daily", { time: "09:00", timezone: "Asia/Shanghai" }), "daily at 09:00 · Asia/Shanghai");
  assert.equal(chinese("triggers.sourceSummary.daily", { time: "09:00", timezone: "Asia/Shanghai" }), "每天 09:00 · Asia/Shanghai");
  assert.equal(english("triggers.status.unknown", { value: "future-state" }), "Unknown (future-state)");
  assert.equal(chinese("triggers.status.unknown", { value: "future-state" }), "未知（future-state）");
});

test("trigger view localizes presentation while preserving authoritative values and diagnostics", async () => {
  const source = await readFile(new URL("../src/apps/control-plane/triggers/ControlPlaneTriggersView.vue", import.meta.url), "utf8");

  assert.match(source, /formatDateTime\(date, locale\.value as SupportedLocale\)/);
  assert.match(source, /source\.timezone/);
  assert.match(source, /source\.roots\.join\(", "\)/);
  assert.match(source, /source\.agent/);
  assert.match(source, /:title="entry\.runtime\?\.lastError"/);
  assert.match(source, /:title="run\.error"/);
  assert.match(source, /triggers\.error\.value instanceof Error \? triggers\.error\.value\.message/);
  assert.match(source, /promptTemplate: "Please review the current context and continue with the next useful step\."/);
  assert.doesNotMatch(source, /date\.toLocaleString\(\)/);
});
