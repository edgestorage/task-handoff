import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const storyView = fs.readFileSync(new URL("../src/apps/control-plane/story/StoryView.vue", import.meta.url), "utf8");

test("finishing a Story creation opens the created Story detail", () => {
  assert.match(storyView, /editorOpen\.value = false;\s*await load\(story\.ownerNodeId\);\s*if \(createdStory\) await focusStoryInSidebar\(createdStory\);/);
});

test("locating a created Story selects authoritative data and scrolls its tree row into view", () => {
  assert.match(storyView, /async function focusStoryInSidebar\(story: Story\) \{[\s\S]*?stories\.value\.find\(\(candidate\) => candidate\.id === story\.id && candidate\.ownerNodeId === story\.ownerNodeId\)/);
  assert.match(storyView, /if \(!target \|\| !storyIsOnline\(target\)\) return false;/);
  assert.match(storyView, /selectStory\(target\);\s*await nextTick\(\);\s*storyTreeRowElement\(target\)\?\.scrollIntoView\(\{ behavior: storyScrollBehavior\(\), block: "nearest" \}\);/);
  assert.match(storyView, /function storyScrollBehavior\(\): ScrollBehavior \{ return window\.matchMedia\("\(prefers-reduced-motion: reduce\)"\)\.matches \? "auto" : "smooth"; \}/);
  assert.match(storyView, /function storyTreeRowElement\(story: Story\) \{[\s\S]*?const viewport = storyScrollViewport\(\);[\s\S]*?element\.dataset\.storyKey === key[\s\S]*?\?\.querySelector<HTMLElement>\("\.story-tree-story-row"\)/);
});

test("a failed post-create settings save still locates the created Story", () => {
  assert.match(storyView, /async function adoptCreatedStory\(story: Story\) \{[\s\S]*?if \(!\(await focusStoryInSidebar\(story\)\)\) return false;/);
});
