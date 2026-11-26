import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const storyView = fs.readFileSync(new URL("../src/apps/control-plane/story/StoryView.vue", import.meta.url), "utf8");
const scrollArea = fs.readFileSync(new URL("../src/components/ui/scroll-area/ScrollArea.vue", import.meta.url), "utf8");
const projectField = fs.readFileSync(new URL("../src/apps/control-plane/story/StoryProjectField.vue", import.meta.url), "utf8");

test("Story editor keeps secondary fields inside a collapsed advanced section", () => {
  const advancedStart = storyView.indexOf('<CollapsibleContent class="story-advanced-motion">');
  const title = storyView.indexOf('{{ t("stories.editor.title") }}');
  const description = storyView.indexOf('{{ t("stories.editor.descriptionLabel") }}');
  const maxIdleAiSessions = storyView.indexOf('{{ t("stories.editor.maxIdleAiSessions") }}');
  assert.ok(advancedStart > 0);
  assert.ok(title > 0 && title < advancedStart);
  assert.ok(description > title && description < advancedStart);
  assert.ok(maxIdleAiSessions > advancedStart);
  assert.match(storyView, /<Collapsible v-model:open="editorAdvancedOpen">\s*<CollapsibleTrigger as-child>/);
  const advanced = storyView.slice(advancedStart, storyView.indexOf('</CollapsibleContent>', advancedStart));
  assert.match(advanced, /stories\.editor\.maxIdleAiSessions[\s\S]*?agentToolSettingsState[\s\S]*?storyAgentEntriesState/);
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

test("Story editor scroll fade targets the rendered viewport", () => {
  assert.match(storyView, /<ScrollArea class="story-editor-scroll" :horizontal="false" fade-top>/);
  assert.match(scrollArea, /fadeTop\?: boolean/);
  assert.match(scrollArea, /'fade-top': fadeTop/);
  assert.match(scrollArea, /\.fade-top > :deep\(\[data-task-handoff-scroll-viewport\]\) \{ mask-image:linear-gradient/);
});

test("advanced settings leave room for focused control rings", () => {
  assert.match(storyView, /\.story-advanced-motion \{ margin-inline:-2px; padding-inline:2px; \}/);
});

test("the related projects row extends its hover surface without moving its text", () => {
  assert.match(projectField, /\.project-field \{ --row-inset:10px;[\s\S]*margin-inline:calc\(0px - var\(--row-inset\)\)/);
  assert.match(projectField, /\.project-trigger \{[^}]*padding:6px var\(--row-inset\)/);
});

test("related projects use the shared command selector pattern", () => {
  assert.match(projectField, /<Command class="project-command">/);
  assert.match(projectField, /<CommandInput class="project-search-input"/);
  assert.match(projectField, /<CommandItem class="project-option"/);
  assert.match(projectField, /<Check[^>]+class="project-check"/);
  assert.match(projectField, /<span class="project-copy">\s*<span class="project-name"[^>]*>[\s\S]*<span class="project-path"/);
  assert.match(projectField, /<Tabs[\s\S]*<TabsList class="project-tabs"/);
  assert.doesNotMatch(projectField, /<Checkbox|<Input\b|picker-filters/);
  assert.match(projectField, /\.project-option-row \{[^}]*grid-template-columns:minmax\(0,1fr\) auto/);
  assert.match(projectField, /\.project-copy \{[^}]*display:grid/);
  assert.match(projectField, /:global\(\.story-project-popover\.story-project-popover\) \{[^}]*padding:4px/);
});
