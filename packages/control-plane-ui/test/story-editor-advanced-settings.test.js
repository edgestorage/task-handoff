import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const storyView = fs.readFileSync(new URL("../src/apps/control-plane/story/StoryView.vue", import.meta.url), "utf8");

test("Story editor keeps secondary fields inside a collapsed advanced section", () => {
  assert.match(storyView, /<div class="story-editor-fields"><label>\{\{ t\("stories\.editor\.title"\) \}\}[\s\S]*?class="story-editor-advanced-toggle"/);
  assert.match(storyView, /class="story-editor-advanced-toggle" :aria-expanded="editorAdvancedOpen" aria-controls="story-editor-advanced-settings" @click="editorAdvancedOpen = !editorAdvancedOpen"/);
  assert.match(storyView, /<div id="story-editor-advanced-settings" v-show="editorAdvancedOpen" class="story-editor-advanced-settings">[\s\S]*?stories\.editor\.descriptionLabel[\s\S]*?stories\.editor\.maxIdleAiSessions[\s\S]*?<fieldset v-if="agentToolSettingsState !== 'hidden'"[\s\S]*?<fieldset v-if="storyAgentEntriesState !== 'hidden'"[\s\S]*?<\/fieldset>\s*<\/div>\s*<div v-if="storyEditorError"/);
  assert.match(storyView, /\.story-editor-advanced-toggle\[aria-expanded="true"\] svg \{ transform:rotate\(90deg\); \}/);
});

test("Story editor opens the advanced section collapsed and keeps default values", () => {
  assert.match(storyView, /const editorOpen = ref\(false\); const editing = ref\(false\); const editorAdvancedOpen = ref\(false\);/);
  assert.equal((storyView.match(/editorAdvancedOpen\.value = false;/g) || []).length, 2);
  assert.match(storyView, /editorAdvancedOpen\.value = false;\s*draftTitle\.value = "";/);
  assert.match(storyView, /editorAdvancedOpen\.value = false;\s*draftTitle\.value = story\.title;/);
  assert.match(storyView, /const draftMaxIdleAiSessions = ref\(STORY_DEFAULT_MAX_IDLE_AI_SESSIONS\)/);
  assert.match(storyView, /const draftAgentToolPolicy = ref<StoryAgentToolPolicy>\(\{ \.\.\.DEFAULT_STORY_AGENT_TOOL_POLICY \}\)/);
});
