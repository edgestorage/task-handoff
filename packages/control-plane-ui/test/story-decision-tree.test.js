import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const view = fs.readFileSync(new URL("../src/apps/control-plane/story/StoryView.vue", import.meta.url), "utf8");

test("pending Story decisions render as tree leaves above the Story content documents", () => {
  const childrenBlock = view.slice(view.indexOf('<div class="story-tree-children">'), view.indexOf("</TransitionGroup>"));
  const decisionIndex = childrenBlock.indexOf("story-decision-tree-item");
  const documentIndex = childrenBlock.indexOf("treeDocumentsFor(story)");
  assert.ok(decisionIndex >= 0, "a pending decision leaf must exist in the story tree");
  assert.ok(documentIndex >= 0, "document leaves must exist in the story tree");
  assert.ok(decisionIndex < documentIndex, "decision leaves must render above the content documents");
  assert.match(childrenBlock, /v-for="decision in pendingDecisionsFor\(story\)"/);
  assert.match(childrenBlock, /@click="openStoryDecision\(story\)"/);
});

test("the tree only reads decisions for expanded Stories whose node declares the decisions capability", () => {
  assert.match(view, /nodeSupportsStoryDecisions\s*\(nodeId: string\)/);
  assert.match(view, /decisionTreeStories = computed\(\(\) => stories\.value\.filter\(\(story\) => isStoryOpen\(story\) && nodeSupportsStoryDecisions\(story\.ownerNodeId\)\)\)/);
  assert.match(view, /storyDecisionsQueryOptions\(story\.id, story\.ownerNodeId\)/);
  assert.match(view, /decision\.status === "pending"/);
});
