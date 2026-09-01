import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { nodeAgentStorePaths } from "../src/node-agent/persistence/paths.ts";
import { NodeStoryStore } from "../src/node-agent/stories/store.ts";

function createStore() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-story-"));
  const store = new NodeStoryStore(nodeAgentStorePaths(dataDir), "node-test");
  store.init();
  return { store, dataDir };
}

test("Story content uses storyPath identity and hash revisions", async () => {
  const { store, dataDir } = createStore();
  try {
    const story = store.create({ title: "Release", actions: [] });
    const first = await store.writeContent(story.id, { storyPath: "notes/readme.md", title: "Readme", stream: Readable.from(["one"]) });
    assert.equal(store.listContent(story.id)[0]?.storyPath, "notes/readme.md");
    assert.equal(first.revision.length, 64);
    await assert.rejects(() => store.writeContent(story.id, { storyPath: "notes/readme.md", stream: Readable.from(["two"]), expectedRevision: "0".repeat(64) }), (error: any) => error.code === "STORY_REVISION_CONFLICT");
    const second = await store.writeContent(story.id, { storyPath: "notes/readme.md", stream: Readable.from(["two"]), expectedRevision: first.revision });
    assert.notEqual(second.revision, first.revision);
  } finally { fs.rmSync(dataDir, { recursive: true, force: true }); }
});

test("missing indexed files are removed but unindexed files are ignored", async () => {
  const { store, dataDir } = createStore();
  try {
    const story = store.create({ title: "Cleanup", actions: [] });
    await store.writeContent(story.id, { storyPath: "kept.txt", title: "Kept", stream: Readable.from(["x"]) });
    fs.writeFileSync(path.join(dataDir, "stories", story.id, "unindexed.txt"), "hidden");
    fs.rmSync(path.join(dataDir, "stories", story.id, "kept.txt"));
    assert.deepEqual(store.listContent(story.id), []);
    assert.equal(fs.existsSync(path.join(dataDir, "stories", story.id, "unindexed.txt")), true);
  } finally { fs.rmSync(dataDir, { recursive: true, force: true }); }
});
