import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Readable } from "node:stream";
import test from "node:test";
import { nodeAgentStorePaths } from "../src/node-agent/persistence/paths.ts";
import { StoryAutomationStore } from "../src/node-agent/stories/automation-store.ts";
import { openNodeAgentDatabase } from "../src/node-agent/stories/database/database.ts";
import { NodeStoryStore } from "../src/node-agent/stories/store.ts";
import { createStoryDatabaseFixture, seedStoryAction } from "./story-database-fixture.ts";

test("Node Agent SQLite initializes identity, migrations, PRAGMAs, and private permissions", async () => {
  const fixture = await createStoryDatabaseFixture("task-handoff-story-database-");
  try {
    const scalar = (sql: string) => Object.values(fixture.database.client.prepare(sql).get() as Record<string, unknown>)[0];
    assert.equal(scalar("PRAGMA application_id"), 0x54484e41);
    assert.equal(scalar("PRAGMA foreign_keys"), 1);
    assert.equal(String(scalar("PRAGMA journal_mode")).toLowerCase(), "wal");
    assert.equal(scalar("PRAGMA busy_timeout"), 5000);
    assert.equal(scalar("PRAGMA synchronous"), 2);
    assert.equal(scalar("PRAGMA quick_check"), "ok");
    assert.equal(fixture.database.client.prepare("SELECT COUNT(*) AS count FROM na_migration_ledger").get().count, 1);
    assert.equal(fs.statSync(fixture.paths.databasePath).mode & 0o777, 0o600);
    for (const sidecar of [`${fixture.paths.databasePath}-wal`, `${fixture.paths.databasePath}-shm`]) {
      if (fs.existsSync(sidecar)) assert.equal(fs.statSync(sidecar).mode & 0o777, 0o600);
    }
    assert.equal(fs.statSync(path.dirname(fixture.paths.databasePath)).mode & 0o777, 0o700);
  } finally { await fixture.close(); }
});

test("Node Agent migration checksum mismatch fails without overwriting the ledger", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-story-migration-"));
  const paths = nodeAgentStorePaths(dataDir);
  try {
    const first = await openNodeAgentDatabase(paths);
    await first.close();
    const client = new DatabaseSync(paths.databasePath);
    client.prepare("UPDATE na_migration_ledger SET checksum = ? WHERE id = ?").run("invalid", "0001_story_domain");
    client.close();
    await assert.rejects(() => openNodeAgentDatabase(paths), (error: any) => error.code === "NODE_AGENT_DATABASE_STARTUP_FAILED" && error.details?.phase === "initialize");
    const verify = new DatabaseSync(paths.databasePath);
    assert.equal(verify.prepare("SELECT checksum FROM na_migration_ledger WHERE id = ?").get("0001_story_domain").checksum, "invalid");
    verify.close();
  } finally { fs.rmSync(dataDir, { recursive: true, force: true }); }
});

test("Node Agent SQLite reopens idempotently and repository close drains accepted mutations", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-story-reopen-"));
  const paths = nodeAgentStorePaths(dataDir);
  try {
    const first = await openNodeAgentDatabase(paths);
    await first.close();
    const second = await openNodeAgentDatabase(paths);
    const { createNodeAgentRepository } = await import("../src/node-agent/stories/database/repository.ts");
    const repository = createNodeAgentRepository(second);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let mutationStarted!: () => void;
    const started = new Promise<void>((resolve) => { mutationStarted = resolve; });
    const mutation = repository.transaction(async () => {
      mutationStarted();
      await gate;
    });
    await started;
    let closeCompleted = false;
    const closing = repository.close().then(() => { closeCompleted = true; });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(closeCompleted, false);
    await assert.rejects(
      () => repository.stories.insert({ id: "too_late", title: "Too late", createdAt: "2026-09-05T00:00:00.000Z", updatedAt: "2026-09-05T00:00:00.000Z", maxIdleAiSessions: 5, nextDocumentSequence: 1 }),
      (error: any) => error.code === "NODE_AGENT_REPOSITORY_QUIESCING",
    );
    release();
    await mutation;
    await closing;

    const verify = new DatabaseSync(paths.databasePath);
    assert.equal(verify.prepare("SELECT COUNT(*) AS count FROM na_migration_ledger").get().count, 1);
    verify.close();
  } finally { fs.rmSync(dataDir, { recursive: true, force: true }); }
});

test("nested repository transaction rolls back the complete Story aggregate", async () => {
  const fixture = await createStoryDatabaseFixture("task-handoff-story-transaction-");
  try {
    const timestamp = "2026-09-05T00:00:00.000Z";
    await assert.rejects(() => fixture.repository.transaction(async (repository) => {
      await repository.stories.insert({ id: "story_rollback", title: "Rollback", createdAt: timestamp, updatedAt: timestamp, maxIdleAiSessions: 5, nextDocumentSequence: 1 });
      await repository.transaction(async (nested) => {
        await nested.actions.replace("story_rollback", [{ storyId: "story_rollback", id: "action_1", title: "Action", promptTemplate: "Run", displayOrder: 0 }]);
      });
      throw new Error("rollback");
    }), /rollback/);
    assert.equal(await fixture.repository.stories.get("story_rollback"), undefined);
  } finally { await fixture.close(); }
});

test("repository reads wait for the preceding transaction to commit", async () => {
  const fixture = await createStoryDatabaseFixture("task-handoff-story-read-barrier-");
  try {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let inserted!: () => void;
    const insertedGate = new Promise<void>((resolve) => { inserted = resolve; });
    const timestamp = "2026-09-05T00:00:00.000Z";
    const transaction = fixture.repository.transaction(async (repository) => {
      await repository.stories.insert({ id: "story_isolated", title: "Isolated", createdAt: timestamp, updatedAt: timestamp, maxIdleAiSessions: 5, nextDocumentSequence: 1 });
      inserted();
      await gate;
    });
    await insertedGate;
    let readCompleted = false;
    const read = fixture.repository.stories.get("story_isolated").then((value) => {
      readCompleted = true;
      return value;
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(readCompleted, false);
    release();
    await transaction;
    assert.equal((await read)?.id, "story_isolated");
  } finally { await fixture.close(); }
});

test("Automation composite foreign key prevents deleting a referenced Story Action", async () => {
  const fixture = await createStoryDatabaseFixture("task-handoff-story-foreign-key-");
  try {
    await seedStoryAction(fixture.repository);
    const automations = new StoryAutomationStore(fixture.repository);
    await automations.create({ storyId: "story_1", actionId: "action_1", schedule: { scheduleKind: "interval", intervalMs: 60_000 }, enabled: false, policy: { maxConcurrentRuns: 1, whenBusy: "skip" } });
    await assert.rejects(() => fixture.repository.transaction((repository) => repository.actions.replace("story_1", [])));
    assert.equal((await fixture.repository.actions.list("story_1"))[0]?.id, "action_1");
  } finally { await fixture.close(); }
});

test("Story directory is lazy and pagination remains database-only until content load", async () => {
  const fixture = await createStoryDatabaseFixture("task-handoff-story-page-");
  try {
    const stories = new NodeStoryStore(fixture.paths, "node_1", fixture.repository);
    await stories.init();
    const story = await stories.create({ title: "Page", actions: [] });
    assert.equal(fs.existsSync(path.join(fixture.paths.storyContentDir, story.id)), false);
    for (const name of ["a", "b", "c"]) {
      await stories.writeContent(story.id, { storyPath: `${name}.md`, title: name.toUpperCase(), stream: Readable.from([name]) });
    }
    const first = await stories.pageContent(story.id, 1, 2);
    assert.equal(first.storyCreatedAt, story.createdAt);
    assert.deepEqual(first.documents.map((document) => document.storyPath), ["c.md", "b.md"]);
    assert.deepEqual(first.pagination, { page: 1, pageSize: 2, totalItems: 3, totalPages: 2, hasMore: true });
    assert.deepEqual(await stories.pageContent(story.id, 3, 2), {
      storyCreatedAt: story.createdAt,
      documents: [],
      pagination: { page: 3, pageSize: 2, totalItems: 3, totalPages: 2, hasMore: false },
    });
    await stories.reorderDocuments(story.id, { storyPaths: ["c.md", "a.md", "b.md"] });
    assert.deepEqual((await stories.pageContent(story.id, 1, 3)).documents.map((document) => document.storyPath), ["c.md", "b.md", "a.md"]);
    fs.rmSync(path.join(fixture.paths.storyContentDir, story.id, "c.md"));
    assert.deepEqual((await stories.pageContent(story.id, 1, 3)).documents.map((document) => document.storyPath), ["c.md", "b.md", "a.md"]);
    await assert.rejects(
      () => stories.readContent(story.id, "c.md"),
      (error: any) => error.code === "STORY_CONTENT_NOT_FOUND" && error.statusCode === 404,
    );
    assert.deepEqual((await stories.pageContent(story.id, 1, 3)).documents.map((document) => document.storyPath), ["b.md", "a.md"]);
    const read = await stories.readContent(story.id, "b.md");
    read.stream.resume();
    await new Promise((resolve, reject) => read.stream.once("close", resolve).once("error", reject));
    assert.equal((await stories.pageContent(story.id, 1, 3)).storyCreatedAt, story.createdAt);
  } finally { await fixture.close(); }
});

test("Story content rejects parent and final symlinks", async (context) => {
  if (process.platform === "win32") return context.skip("symlink semantics differ on Windows");
  const fixture = await createStoryDatabaseFixture("task-handoff-story-symlink-");
  try {
    const stories = new NodeStoryStore(fixture.paths, "node_1", fixture.repository);
    await stories.init();
    const story = await stories.create({ title: "Links", actions: [] });
    const outside = path.join(fixture.dataDir, "outside");
    fs.mkdirSync(outside);
    fs.mkdirSync(path.join(fixture.paths.storyContentDir, story.id), { recursive: true });
    fs.symlinkSync(outside, path.join(fixture.paths.storyContentDir, story.id, "linked"));
    await assert.rejects(() => stories.writeContent(story.id, { storyPath: "linked/file.md", title: "Unsafe", stream: Readable.from(["x"]) }), (error: any) => error.code === "STORY_PATH_UNSAFE");
    await stories.writeContent(story.id, { storyPath: "final.md", title: "Final", stream: Readable.from(["safe"]) });
    fs.rmSync(path.join(fixture.paths.storyContentDir, story.id, "final.md"));
    fs.symlinkSync(path.join(outside, "target.md"), path.join(fixture.paths.storyContentDir, story.id, "final.md"));
    await assert.rejects(() => stories.readContent(story.id, "final.md"), (error: any) => error.code === "ELOOP");
    assert.equal((await stories.pageContent(story.id, 1, 20)).documents[0]?.storyPath, "final.md");
  } finally { await fixture.close(); }
});

test("Story content streams and hashes one descriptor while non-regular errors retain the index", async () => {
  const fixture = await createStoryDatabaseFixture("task-handoff-story-descriptor-");
  try {
    const stories = new NodeStoryStore(fixture.paths, "node_1", fixture.repository);
    await stories.init();
    const story = await stories.create({ title: "Descriptor", actions: [] });
    const written = await stories.writeContent(story.id, { storyPath: "content.txt", title: "Content", stream: Readable.from(["original"]) });
    const target = path.join(fixture.paths.storyContentDir, story.id, "content.txt");
    const opened = await stories.readContent(story.id, "content.txt");
    fs.renameSync(target, `${target}.old`);
    fs.writeFileSync(target, "replacement");
    let streamed = "";
    for await (const chunk of opened.stream as AsyncIterable<Buffer>) streamed += chunk.toString();
    assert.equal(streamed, "original");
    assert.equal(opened.revision, written.revision);

    fs.rmSync(target);
    fs.mkdirSync(target);
    await assert.rejects(() => stories.readContent(story.id, "content.txt"), (error: any) => error.code === "STORY_CONTENT_NOT_FILE");
    assert.equal((await stories.pageContent(story.id, 1, 20)).documents[0]?.storyPath, "content.txt");
  } finally { await fixture.close(); }
});

test("Story pagination uses storyPath as a deterministic sequence tie-breaker", async () => {
  const fixture = await createStoryDatabaseFixture("task-handoff-story-page-tie-");
  try {
    const stories = new NodeStoryStore(fixture.paths, "node_1", fixture.repository);
    await stories.init();
    const story = await stories.create({ title: "Tie", actions: [] });
    fixture.database.client.exec("DROP INDEX na_story_documents_sequence_uq");
    for (const storyPath of ["b.md", "a.md"]) {
      await fixture.repository.documents.insert({ storyId: story.id, storyPath, title: storyPath, indexedSequence: 1, displayOrder: 0 });
    }
    assert.deepEqual((await stories.pageContent(story.id, 1, 20)).documents.map((document) => document.storyPath), ["a.md", "b.md"]);
  } finally { await fixture.close(); }
});

test("file mutation recovery converges write, rename, and delete phases without losing committed content", async () => {
  const fixture = await createStoryDatabaseFixture("task-handoff-story-file-recovery-");
  try {
    const timestamp = "2026-09-05T00:00:00.000Z";
    const seedStory = async (id: string) => {
      await fixture.repository.stories.insert({ id, title: id, createdAt: timestamp, updatedAt: timestamp, maxIdleAiSessions: 5, nextDocumentSequence: 2 });
      const root = path.join(fixture.paths.storyContentDir, id);
      fs.mkdirSync(root, { recursive: true, mode: 0o700 });
      return root;
    };

    const receivingRoot = await seedStory("story_receiving");
    const receivingTarget = path.join(receivingRoot, "document.txt");
    const receivingTemp = `${receivingTarget}.tmp`;
    fs.writeFileSync(receivingTarget, "external");
    fs.writeFileSync(receivingTemp, "partial");
    await fixture.repository.fileMutations.insert({ id: "mutation_receiving", storyId: "story_receiving", operation: "write", storyPath: "document.txt", temporaryName: receivingTemp, phase: "receiving", createdAt: timestamp, updatedAt: timestamp });

    for (const phase of ["prepared", "files-staged"] as const) {
      const storyId = `story_${phase}`;
      const root = await seedStory(storyId);
      const target = path.join(root, "document.txt");
      fs.writeFileSync(target, "staged");
      await fixture.repository.fileMutations.insert({ id: `mutation_${phase}`, storyId, operation: "write", storyPath: "document.txt", temporaryName: `${target}.missing.tmp`, phase, createdAt: timestamp, updatedAt: timestamp });
    }

    const committedRoot = await seedStory("story_committed");
    const committedTarget = path.join(committedRoot, "new.txt");
    const committedBackup = `${committedTarget}.bak`;
    fs.writeFileSync(committedTarget, "new");
    fs.writeFileSync(committedBackup, "old");
    await fixture.repository.transaction(async (repository) => {
      await repository.documents.insert({ storyId: "story_committed", storyPath: "new.txt", title: "New", indexedSequence: 1, displayOrder: 0 });
      await repository.fileMutations.insert({ id: "mutation_committed", storyId: "story_committed", operation: "write", storyPath: "new.txt", temporaryName: `${committedTarget}.tmp`, backupName: committedBackup, phase: "database-committed", createdAt: timestamp, updatedAt: timestamp });
    });

    const renameRollbackRoot = await seedStory("story_rename_rollback");
    const renameSource = path.join(renameRollbackRoot, "old.txt");
    const renameTarget = path.join(renameRollbackRoot, "new.txt");
    fs.writeFileSync(renameTarget, "rename rollback");
    await fixture.repository.documents.insert({ storyId: "story_rename_rollback", storyPath: "old.txt", title: "Old", indexedSequence: 1, displayOrder: 0 });
    await fixture.repository.fileMutations.insert({ id: "mutation_rename_rollback", storyId: "story_rename_rollback", operation: "rename", storyPath: "old.txt", nextStoryPath: "new.txt", temporaryName: renameSource, backupName: renameTarget, phase: "files-staged", createdAt: timestamp, updatedAt: timestamp });

    const renameCommitRoot = await seedStory("story_rename_commit");
    const renameCommittedSource = path.join(renameCommitRoot, "old.txt");
    const renameCommittedTarget = path.join(renameCommitRoot, "new.txt");
    fs.writeFileSync(renameCommittedTarget, "rename committed");
    await fixture.repository.documents.insert({ storyId: "story_rename_commit", storyPath: "new.txt", title: "New", indexedSequence: 1, displayOrder: 0 });
    await fixture.repository.fileMutations.insert({ id: "mutation_rename_commit", storyId: "story_rename_commit", operation: "rename", storyPath: "old.txt", nextStoryPath: "new.txt", temporaryName: renameCommittedSource, backupName: renameCommittedTarget, phase: "database-committed", createdAt: timestamp, updatedAt: timestamp });

    const deleteRollbackRoot = await seedStory("story_delete_rollback");
    const deleteTarget = path.join(deleteRollbackRoot, "document.txt");
    const deleteBackup = `${deleteTarget}.deleted`;
    fs.writeFileSync(deleteBackup, "delete rollback");
    await fixture.repository.documents.insert({ storyId: "story_delete_rollback", storyPath: "document.txt", title: "Document", indexedSequence: 1, displayOrder: 0 });
    await fixture.repository.fileMutations.insert({ id: "mutation_delete_rollback", storyId: "story_delete_rollback", operation: "delete", storyPath: "document.txt", backupName: deleteBackup, phase: "files-staged", createdAt: timestamp, updatedAt: timestamp });

    const deleteCommitRoot = await seedStory("story_delete_commit");
    const deleteCommittedBackup = path.join(deleteCommitRoot, "document.txt.deleted");
    fs.writeFileSync(deleteCommittedBackup, "delete committed");
    await fixture.repository.fileMutations.insert({ id: "mutation_delete_commit", storyId: "story_delete_commit", operation: "delete", storyPath: "document.txt", backupName: deleteCommittedBackup, phase: "cleanup", createdAt: timestamp, updatedAt: timestamp });

    const stories = new NodeStoryStore(fixture.paths, "node_1", fixture.repository);
    await stories.init();

    assert.equal(fs.readFileSync(receivingTarget, "utf8"), "external");
    assert.equal(fs.existsSync(receivingTemp), false);
    assert.equal(fs.existsSync(path.join(fixture.paths.storyContentDir, "story_prepared", "document.txt")), false);
    assert.equal(fs.existsSync(path.join(fixture.paths.storyContentDir, "story_files-staged", "document.txt")), false);
    assert.equal(fs.readFileSync(committedTarget, "utf8"), "new");
    assert.equal(fs.existsSync(committedBackup), false);
    assert.equal(fs.readFileSync(renameSource, "utf8"), "rename rollback");
    assert.equal(fs.existsSync(renameTarget), false);
    assert.equal(fs.readFileSync(renameCommittedTarget, "utf8"), "rename committed");
    assert.equal(fs.readFileSync(deleteTarget, "utf8"), "delete rollback");
    assert.equal(fs.existsSync(deleteBackup), false);
    assert.equal(fs.existsSync(deleteCommittedBackup), false);
    assert.deepEqual(await fixture.repository.fileMutations.list(), []);
  } finally { await fixture.close(); }
});
