import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { PassThrough, Readable } from "node:stream";
import test from "node:test";
import { NodeStoryStore } from "../src/node-agent/stories/store.ts";
import { StoryOperationCoordinator } from "../src/node-agent/stories/operation-coordinator.ts";
import { createStoryDatabaseFixture } from "./story-database-fixture.ts";

async function createStore() {
  const fixture = await createStoryDatabaseFixture("task-handoff-story-");
  const store = new NodeStoryStore(fixture.paths, "node-test", fixture.repository);
  await store.init();
  return { store, ...fixture };
}

test("Story content uses storyPath identity and hash revisions", async () => {
  const { store, close } = await createStore();
  try {
    const story = await store.create({ title: "Release", actions: [] });
    const first = await store.writeContent(story.id, { storyPath: "notes/readme.md", title: "Readme", stream: Readable.from(["one"]) });
    assert.equal((await store.listContent(story.id))[0]?.storyPath, "notes/readme.md");
    assert.equal(first.revision.length, 64);
    await assert.rejects(() => store.writeContent(story.id, { storyPath: "notes/readme.md", stream: Readable.from(["two"]), expectedRevision: "0".repeat(64) }), (error: any) => error.code === "STORY_REVISION_CONFLICT");
    const second = await store.writeContent(story.id, { storyPath: "notes/readme.md", stream: Readable.from(["two"]), expectedRevision: first.revision });
    assert.notEqual(second.revision, first.revision);
  } finally { await close(); }
});

test("missing indexed files are removed but unindexed files are ignored", async () => {
  const { store, dataDir, close } = await createStore();
  try {
    const story = await store.create({ title: "Cleanup", actions: [] });
    await store.writeContent(story.id, { storyPath: "kept.txt", title: "Kept", stream: Readable.from(["x"]) });
    fs.writeFileSync(path.join(dataDir, "stories", story.id, "unindexed.txt"), "hidden");
    fs.rmSync(path.join(dataDir, "stories", story.id, "kept.txt"));
    assert.deepEqual(await store.listContent(story.id), []);
    assert.equal(fs.existsSync(path.join(dataDir, "stories", story.id, "unindexed.txt")), true);
  } finally { await close(); }
});

test("Story idle Session retention settings default and persist", async () => {
  const { store, close } = await createStore();
  try {
    const story = await store.create({ title: "Retention", actions: [] });
    assert.equal((await store.retentionSettings(story.id)).maxIdleAiSessions, 5);
    await store.update(story.id, { maxIdleAiSessions: 7 });
    assert.equal((await store.retentionSettings(story.id)).maxIdleAiSessions, 7);
    await assert.rejects(() => store.update(story.id, { maxIdleAiSessions: 0 }));
    await assert.rejects(() => store.update(story.id, { maxIdleAiSessions: 51 }));
  } finally { await close(); }
});

test("slow uploads serialize per Story without occupying the SQLite mutation queue", async () => {
  const { store, repository, close } = await createStore();
  try {
    const first = await store.create({ title: "First", actions: [] });
    const second = await store.create({ title: "Second", actions: [] });
    const firstStream = new PassThrough();
    const sameStoryStream = new PassThrough();
    const otherStoryStream = new PassThrough();
    const firstWrite = store.writeContent(first.id, { storyPath: "first.txt", title: "First", stream: firstStream });
    firstStream.write("first");
    await waitFor(async () => (await repository.fileMutations.list()).length === 1);

    const sameStoryWrite = store.writeContent(first.id, { storyPath: "second.txt", title: "Second", stream: sameStoryStream });
    const otherStoryWrite = store.writeContent(second.id, { storyPath: "other.txt", title: "Other", stream: otherStoryStream });
    otherStoryStream.write("other");
    await waitFor(async () => (await repository.fileMutations.list()).length === 2);
    assert.equal((await repository.fileMutations.list()).some((intent) => intent.storyPath === "second.txt"), false);

    const third = await store.create({ title: "Database remains available", actions: [] });
    assert.equal(third.title, "Database remains available");

    firstStream.end();
    await firstWrite;
    sameStoryStream.end("second");
    otherStoryStream.end();
    await Promise.all([sameStoryWrite, otherStoryWrite]);
  } finally { await close(); }
});

test("content reads and deletes do not observe a staged write", async () => {
  const { store, close } = await createStore();
  try {
    const story = await store.create({ title: "Coordinated", actions: [] });
    const initial = await store.writeContent(story.id, { storyPath: "content.txt", title: "Content", stream: Readable.from(["old"]) });
    const replacement = new PassThrough();
    const write = store.writeContent(story.id, {
      storyPath: "content.txt",
      expectedRevision: initial.revision,
      stream: replacement,
    });
    replacement.write("new");
    await new Promise((resolve) => setImmediate(resolve));

    let readCompleted = false;
    const read = store.readContent(story.id, "content.txt").then(async (opened) => {
      let content = "";
      for await (const chunk of opened.stream as AsyncIterable<Buffer>) content += chunk.toString();
      readCompleted = true;
      return content;
    });
    const deletion = store.deleteDocument(story.id, "content.txt");
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(readCompleted, false);

    replacement.end(" content");
    await write;
    assert.equal(await read, "new content");
    assert.equal(await deletion, true);
    assert.deepEqual(await store.pageContent(story.id, 1, 20), {
      storyCreatedAt: story.createdAt,
      documents: [],
      pagination: { page: 1, pageSize: 20, totalItems: 0, totalPages: 0, hasMore: false },
    });
  } finally { await close(); }
});

test("Story operation coordinator quiesces new work and exposes pending drain diagnostics", async () => {
  const coordinator = new StoryOperationCoordinator();
  const release = await coordinator.acquire("story_pending");
  coordinator.stopAccepting();
  assert.deepEqual(coordinator.pendingStoryIds(), ["story_pending"]);
  await assert.rejects(() => coordinator.acquire("story_late"), (error: any) => error.code === "STORY_STORAGE_QUIESCING");
  let drained = false;
  const drain = coordinator.drain().then(() => { drained = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(drained, false);
  release();
  await drain;
  assert.deepEqual(coordinator.pendingStoryIds(), []);
});

test("Story writes roll back receiving, fsync, rename, and database failures", async () => {
  for (const failure of ["receiving", "fsync", "rename", "database"] as const) {
    const { store, repository, paths, close } = await createStore();
    const originalFsyncSync = fs.fsyncSync;
    const originalRenameSync = fs.renameSync;
    const originalInsert = repository.documents.insert;
    try {
      const story = await store.create({ title: failure, actions: [] });
      if (failure === "fsync") {
        fs.fsyncSync = (() => { throw Object.assign(new Error("injected fsync failure"), { code: "EIO" }); }) as typeof fs.fsyncSync;
      } else if (failure === "rename") {
        fs.renameSync = ((source: fs.PathLike, destination: fs.PathLike) => {
          if (String(source).endsWith(".tmp")) throw Object.assign(new Error("injected rename failure"), { code: "EIO" });
          return originalRenameSync(source, destination);
        }) as typeof fs.renameSync;
      } else if (failure === "database") {
        repository.documents.insert = (async () => { throw new Error("injected database failure"); }) as typeof repository.documents.insert;
      }
      const stream = failure === "receiving"
        ? Readable.from((async function* () { yield "partial"; throw new Error("injected stream failure"); })())
        : Readable.from(["content"]);
      await assert.rejects(() => store.writeContent(story.id, { storyPath: "content.txt", title: "Content", stream }));
      fs.fsyncSync = originalFsyncSync;
      fs.renameSync = originalRenameSync;
      repository.documents.insert = originalInsert;
      assert.equal(fs.existsSync(path.join(paths.storyContentDir, story.id, "content.txt")), false);
      assert.deepEqual(await repository.documents.list(story.id), []);
      assert.deepEqual(await repository.fileMutations.list(), []);
    } finally {
      fs.fsyncSync = originalFsyncSync;
      fs.renameSync = originalRenameSync;
      repository.documents.insert = originalInsert;
      await close();
    }
  }
});

test("overwrite, path rename, and Document delete restore files when their database transaction fails", async () => {
  const { store, repository, paths, close } = await createStore();
  const originalUpdate = repository.documents.update;
  const originalReplacePath = repository.documents.replacePath;
  const originalDelete = repository.documents.delete;
  try {
    const story = await store.create({ title: "Rollback files", actions: [] });
    const initial = await store.writeContent(story.id, { storyPath: "content.txt", title: "Content", stream: Readable.from(["original"]) });
    const target = path.join(paths.storyContentDir, story.id, "content.txt");

    repository.documents.update = (async () => { throw new Error("injected overwrite transaction failure"); }) as typeof repository.documents.update;
    await assert.rejects(() => store.writeContent(story.id, { storyPath: "content.txt", expectedRevision: initial.revision, stream: Readable.from(["replacement"]) }));
    repository.documents.update = originalUpdate;
    assert.equal(fs.readFileSync(target, "utf8"), "original");

    repository.documents.replacePath = (async () => { throw new Error("injected rename transaction failure"); }) as typeof repository.documents.replacePath;
    await assert.rejects(() => store.updateDocument(story.id, "content.txt", { storyPath: "renamed.txt" }));
    repository.documents.replacePath = originalReplacePath;
    assert.equal(fs.readFileSync(target, "utf8"), "original");
    assert.equal(fs.existsSync(path.join(paths.storyContentDir, story.id, "renamed.txt")), false);

    repository.documents.delete = (async () => { throw new Error("injected delete transaction failure"); }) as typeof repository.documents.delete;
    await assert.rejects(() => store.deleteDocument(story.id, "content.txt"));
    repository.documents.delete = originalDelete;
    assert.equal(fs.readFileSync(target, "utf8"), "original");
    assert.equal((await repository.documents.list(story.id))[0]?.storyPath, "content.txt");
    assert.deepEqual(await repository.fileMutations.list(), []);
  } finally {
    repository.documents.update = originalUpdate;
    repository.documents.replacePath = originalReplacePath;
    repository.documents.delete = originalDelete;
    await close();
  }
});

async function waitFor(predicate: () => boolean | Promise<boolean>) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  assert.fail("condition was not reached");
}
