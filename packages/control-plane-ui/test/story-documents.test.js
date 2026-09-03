import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { latestStoryDocuments, STORY_TREE_DOCUMENT_LIMIT } from "../src/apps/control-plane/story/storyDocuments.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const storyView = fs.readFileSync(path.join(root, "src/apps/control-plane/story/StoryView.vue"), "utf8");

test("Story tree shows only the latest five documents in their canonical order", () => {
  const documents = ["one", "two", "three", "four", "five", "six", "seven"];

  assert.equal(STORY_TREE_DOCUMENT_LIMIT, 5);
  assert.deepEqual(latestStoryDocuments(documents, false), ["three", "four", "five", "six", "seven"]);
  assert.deepEqual(latestStoryDocuments(documents, true), documents);
});

test("Story tree does not truncate document lists at or below the limit", () => {
  const documents = ["one", "two", "three", "four", "five"];

  assert.equal(latestStoryDocuments(documents, false), documents);
});

test("Story tree exposes an inline control that expands truncated documents", () => {
  assert.match(storyView, /v-for="document in treeDocumentsFor\(story\)"/);
  assert.match(storyView, /v-if="hasMoreTreeDocuments\(story\)"[^>]*@click="showAllTreeDocuments\(story\)"/);
  assert.match(storyView, /t\("stories\.moreDocuments"\)/);
});
