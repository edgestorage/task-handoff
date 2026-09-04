import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const storyView = fs.readFileSync(new URL("../src/apps/control-plane/story/StoryView.vue", import.meta.url), "utf8");
const workbench = fs.readFileSync(new URL("../src/apps/control-plane/ControlPlaneWorkbench.vue", import.meta.url), "utf8");

test("a preset action stays in Story and selects its newly created AI Session", () => {
  assert.match(storyView, /\$emit\('run-action', selectedResource\.story, action, storyActionCreationFinished\(selectedResource\.story\)\)/);
  assert.match(storyView, /"run-action": \[story: Story, action: StoryAction, onCreated: \(instanceId: string, sessionId: string\) => void\]/);
  assert.match(storyView, /function storyActionCreationFinished\(story: Story\)[\s\S]*const sourceResourceKey = resourceKey\(selectedResource\.value\);[\s\S]*queueCreatedStorySession\(story, instanceId, sessionId, sourceResourceKey\)/);

  const runStoryAction = workbench.slice(
    workbench.indexOf("async function runStoryAction"),
    workbench.indexOf("function setWorkbenchView", workbench.indexOf("async function runStoryAction")),
  );
  assert.ok(runStoryAction.indexOf('window.confirm(t("stories.run.confirm"') < runStoryAction.indexOf('const result = await createAiSession'));
  assert.match(runStoryAction, /showDelayedControlPlaneLoadingToast\(t\("stories\.run\.creating"\)\)/);
  assert.match(runStoryAction, /window\.confirm\(t\("stories\.run\.confirm", \{ name: action\.title \}\)\)/);
  assert.match(runStoryAction, /const result = await createAiSession/);
  assert.match(runStoryAction, /onCreated\(target\.id, result\.aiSessionId\)/);
  assert.match(runStoryAction, /finally \{ loadingToast\.dismiss\(\); \}/);
  assert.doesNotMatch(runStoryAction, /setActiveInstance|setWorkbenchView\("instance"\)/);
});
