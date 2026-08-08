import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

test("AI session composer shows action-specific loading feedback", () => {
  const composer = fs.readFileSync(new URL("../src/components/ai-session/AiSessionComposer.vue", import.meta.url), "utf8");
  const english = fs.readFileSync(new URL("../src/i18n/locales/en-US/sessions.ts", import.meta.url), "utf8");
  const chinese = fs.readFileSync(new URL("../src/i18n/locales/zh-CN/sessions.ts", import.meta.url), "utf8");

  assert.match(composer, /<LoaderCircle v-if="busy" class="animate-spin motion-reduce:animate-none"/);
  assert.match(composer, /:aria-label="actionTitle"/);
  assert.match(composer, /t\("sessions\.composer\.sending"\)/);
  assert.match(composer, /t\("sessions\.composer\.saving"\)/);
  assert.match(composer, /t\("sessions\.composer\.stopping"\)/);
  assert.match(english, /sending: "Sending…"/);
  assert.match(english, /saving: "Saving…"/);
  assert.match(english, /stopping: "Stopping…"/);
  assert.match(chinese, /sending: "正在发送…"/);
  assert.match(chinese, /saving: "正在保存…"/);
  assert.match(chinese, /stopping: "正在停止…"/);
});

test("new instance creation shows a spinner and locks mutable controls", () => {
  const modal = fs.readFileSync(new URL("../src/apps/control-plane/NewInstanceModal.vue", import.meta.url), "utf8");

  assert.match(modal, /<LoaderCircle v-if="creating" class="animate-spin motion-reduce:animate-none"/);
  assert.match(modal, /<Dialog :open="true" @update:open="requestClose">/);
  assert.match(modal, /if \(!open && !creating\.value\)/);
  assert.match(modal, /:aria-busy="creating"/);
  assert.match(modal, /<fieldset class="new-instance-fields" :disabled="creating">/);
  assert.match(modal, /class="panel-close"[^>]+:disabled="creating"/);
  assert.match(modal, /variant="outline" size="sm" :disabled="creating"/);
});
