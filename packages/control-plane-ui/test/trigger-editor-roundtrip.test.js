import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const view = fs.readFileSync(new URL("../src/apps/control-plane/triggers/ControlPlaneTriggersView.vue", import.meta.url), "utf8");

test("trigger editor round-trips every optional behavior and display field", () => {
  assert.match(view, /createForm\.description = config\.description \|\| "";/);
  assert.match(view, /description: createForm\.description\.trim\(\) \|\| undefined/);
  assert.match(view, /createForm\.maxConcurrentRuns = String\(config\.policy\.maxConcurrentRuns\);/);
  assert.match(view, /maxConcurrentRuns: boundedInteger\(createForm\.maxConcurrentRuns, 1, 1, 20\)/);
  assert.match(view, /createForm\.agent = config\.source\.agent \|\| "";/);
  assert.match(view, /agent: createForm\.agent\.trim\(\) \|\| undefined/);
});

test("trigger editor exposes the round-tripped fields instead of hiding preserved state", () => {
  assert.match(view, /<Textarea v-model="createForm\.description"/);
  assert.match(view, /<Input v-model="createForm\.agent"/);
  assert.match(view, /<Input v-model="createForm\.maxConcurrentRuns"[^>]*max="20"/);
  assert.match(view, /<ControlPlaneTimePicker[^>]+v-model="createForm\.timeOfDay"/);
  assert.doesNotMatch(view, /type="time"/);
});

test("editing a different source starts from clean defaults before populating its config", () => {
  assert.match(view, /function beginEdit\(trigger: ControlPlaneTrigger\)[\s\S]*?resetCreateForm\(\);\s*populateForm\(trigger\.config\);/);
});
