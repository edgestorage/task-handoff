import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { createControlPlaneI18nForTest } from "../src/i18n/testing.ts";

const runtimeStep = fs.readFileSync(new URL("../src/apps/control-plane/new-instance/RuntimeStep.vue", import.meta.url), "utf8");

test("new instance runtime field explains the available runtimes", () => {
  assert.match(runtimeStep, /t\("instances\.create\.runtime"\)/);
  assert.match(runtimeStep, /t\("instances\.create\.runtimeHint"\)/);
  assert.match(runtimeStep, /:aria-label="t\('instances\.create\.runtime'\)"/);
  assert.match(runtimeStep, /class="field-label-hint"/);
  assert.match(runtimeStep, /class="field-hint-tooltip"/);

  const zh = createControlPlaneI18nForTest("zh-CN").global;
  const en = createControlPlaneI18nForTest("en-US").global;
  assert.equal(zh.t("instances.create.runtime"), "运行环境");
  assert.match(zh.t("instances.create.runtimeHint"), /Docker/);
  assert.match(zh.t("instances.create.runtimeHint"), /容器/);
  assert.match(zh.t("instances.create.runtimeHint"), /本机/);
  assert.equal(en.t("instances.create.runtime"), "Runtime");
  assert.match(en.t("instances.create.runtimeHint"), /Docker/);
  assert.match(en.t("instances.create.runtimeHint"), /container/);
  assert.match(en.t("instances.create.runtimeHint"), /local runtime/);
});
