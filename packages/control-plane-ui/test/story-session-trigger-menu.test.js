import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const storyView = fs.readFileSync(new URL("../src/apps/control-plane/story/StoryView.vue", import.meta.url), "utf8");
const triggerActions = fs.readFileSync(new URL("../src/apps/control-plane/useAiSessionTriggers.ts", import.meta.url), "utf8");

test("Story AI session menus expose the shared trigger bindings", () => {
  assert.match(storyView, /const \{ boundTriggers, isTriggerBound, toggleTrigger, triggerActionKey, triggerBusyKey, triggerTemplates \} = useAiSessionTriggers\(\);/);
  assert.match(storyView, /<AiSessionCardContextMenu[\s\S]*:bound-trigger-count="boundTriggers\(entry\)\.length"[\s\S]*:is-trigger-bound="\(configHash\) => isTriggerBound\(entry, configHash\)"/);
  assert.match(storyView, /<AiSessionCardContextMenu[\s\S]*:is-trigger-busy="\(configHash\) => triggerBusyKey === triggerActionKey\(entry, configHash\)"[\s\S]*:trigger-templates="triggerTemplates"/);
  assert.match(storyView, /<AiSessionCardContextMenu[\s\S]*@toggle-trigger="toggleTrigger\(entry, \$event\)"/);
  assert.doesNotMatch(storyView, /:show-trigger-actions="false"/);
});

test("shared trigger actions accept any AI session target", () => {
  assert.match(triggerActions, /type AiSessionTriggerTarget = \{[\s\S]*instance: InstanceWithAiSessions;[\s\S]*session: AiSessionSummary;/);
  assert.match(triggerActions, /function boundTriggers\(target: AiSessionTriggerTarget\)/);
  assert.match(triggerActions, /async function toggleTrigger\(target: AiSessionTriggerTarget, configHash: string\)/);
});
