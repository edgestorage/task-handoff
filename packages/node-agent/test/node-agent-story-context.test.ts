import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { NodeLocalFolderSchema } from "@task-handoff/protocol/control-plane";
import { nodeAgentStorePaths } from "../src/persistence/paths.ts";
import { openNodeAgentDatabase } from "../src/persistence/database.ts";
import { createNodeAgentRepository, type NodeAgentRepository } from "../src/persistence/repository.ts";
import { StoryContextSettingsService, type StoryContextFolderSource } from "../src/stories/context-settings-service.ts";
import { createStoryDatabaseFixture } from "./story-database-fixture.ts";

const NOW = "2026-11-26T00:00:00.000Z";

function folder(id: string, nodeId = "node_1", name = id) {
  return NodeLocalFolderSchema.parse({
    id,
    nodeId,
    name,
    path: `/work/${name}`,
    labels: {},
    createdAt: NOW,
    updatedAt: NOW,
  });
}

function folderSource(initial: ReturnType<typeof folder>[]): StoryContextFolderSource & { set(folders: ReturnType<typeof folder>[]): void } {
  let folders = [...initial];
  return {
    listLocalFolders: () => folders,
    resolveLocalFolder: (id) => folders.find((candidate) => candidate.id === id),
    set(next) { folders = [...next]; },
  };
}

async function seedStory(repository: Pick<NodeAgentRepository, "stories">, id = "story_1") {
  await repository.stories.insert({ id, title: "Story", createdAt: NOW, updatedAt: NOW, maxIdleAiSessions: 5, nextDocumentSequence: 1 });
}

test("Story context settings normalize historical Stories to an empty deterministic snapshot", async () => {
  const fixture = await createStoryDatabaseFixture("task-handoff-story-context-default-");
  try {
    await seedStory(fixture.repository);
    const service = new StoryContextSettingsService(fixture.repository, "node_1", folderSource([]));
    assert.deepEqual(await service.get("story_1"), {
      storyId: "story_1",
      revision: 0,
      projectFolderIds: [],
      appendedPrompt: "",
      updatedAt: NOW,
    });
    await assert.rejects(() => service.get("story_missing"), (error: any) => error.code === "STORY_NOT_FOUND" && error.statusCode === 404);
  } finally { await fixture.close(); }
});

test("Story context settings atomically persist ordered project IDs, prompt, revision, and Story updatedAt", async () => {
  const fixture = await createStoryDatabaseFixture("task-handoff-story-context-save-");
  try {
    await seedStory(fixture.repository);
    const changed: string[] = [];
    const service = new StoryContextSettingsService(
      fixture.repository,
      "node_1",
      folderSource([folder("folder_a"), folder("folder_b"), folder("folder_c")]),
      (storyId) => { changed.push(storyId); },
    );
    const saved = await service.update("story_1", {
      expectedRevision: 0,
      projectFolderIds: ["folder_c", "folder_a", "folder_b"],
      appendedPrompt: "Line one\nLine two",
    });
    assert.deepEqual(saved.projectFolderIds, ["folder_c", "folder_a", "folder_b"]);
    assert.equal(saved.appendedPrompt, "Line one\nLine two");
    assert.equal(saved.revision, 1);
    assert.equal(changed[0], "story_1");
    const story = await fixture.repository.stories.get("story_1");
    assert.equal(story?.updatedAt, saved.updatedAt);
    const projectRows = fixture.database.client.prepare("SELECT folder_id, display_order FROM na_story_context_projects WHERE story_id = ? ORDER BY display_order").all("story_1").map((row) => ({ ...row }));
    assert.deepEqual(projectRows, [
      { folder_id: "folder_c", display_order: 0 },
      { folder_id: "folder_a", display_order: 1 },
      { folder_id: "folder_b", display_order: 2 },
    ]);
  } finally { await fixture.close(); }
});

test("Story context settings reject duplicate, cross-node, and newly missing projects without partial writes", async () => {
  const fixture = await createStoryDatabaseFixture("task-handoff-story-context-validation-");
  try {
    await seedStory(fixture.repository);
    const folders = folderSource([folder("folder_a"), folder("folder_other", "node_2")]);
    const service = new StoryContextSettingsService(fixture.repository, "node_1", folders);
    await assert.rejects(
      () => service.update("story_1", { expectedRevision: 0, projectFolderIds: ["folder_a", "folder_a"], appendedPrompt: "x" }),
      (error: any) => error.code === "STORY_CONTEXT_DUPLICATE_PROJECT",
    );
    await assert.rejects(
      () => service.update("story_1", { expectedRevision: 0, projectFolderIds: ["folder_other"], appendedPrompt: "x" }),
      (error: any) => error.code === "STORY_CONTEXT_PROJECT_UNAVAILABLE",
    );
    await assert.rejects(
      () => service.update("story_1", { expectedRevision: 0, projectFolderIds: ["folder_missing"], appendedPrompt: "x" }),
      (error: any) => error.code === "STORY_CONTEXT_PROJECT_UNAVAILABLE",
    );
    assert.deepEqual(await service.get("story_1"), {
      storyId: "story_1",
      revision: 0,
      projectFolderIds: [],
      appendedPrompt: "",
      updatedAt: NOW,
    });
  } finally { await fixture.close(); }
});

test("Story context settings retain a persisted dangling project but reject re-addition after removal", async () => {
  const fixture = await createStoryDatabaseFixture("task-handoff-story-context-dangling-");
  try {
    await seedStory(fixture.repository);
    const folders = folderSource([folder("folder_a"), folder("folder_b")]);
    const service = new StoryContextSettingsService(fixture.repository, "node_1", folders);
    await service.update("story_1", { expectedRevision: 0, projectFolderIds: ["folder_a", "folder_b"], appendedPrompt: "v1" });
    folders.set([folder("folder_b")]);
    const retained = await service.update("story_1", { expectedRevision: 1, projectFolderIds: ["folder_a", "folder_b"], appendedPrompt: "v2" });
    assert.deepEqual(retained.projectFolderIds, ["folder_a", "folder_b"]);
    const removed = await service.update("story_1", { expectedRevision: 2, projectFolderIds: ["folder_b"], appendedPrompt: "v3" });
    assert.deepEqual(removed.projectFolderIds, ["folder_b"]);
    await assert.rejects(
      () => service.update("story_1", { expectedRevision: 3, projectFolderIds: ["folder_b", "folder_a"], appendedPrompt: "v4" }),
      (error: any) => error.code === "STORY_CONTEXT_PROJECT_UNAVAILABLE",
    );
  } finally { await fixture.close(); }
});

test("Story context revision conflicts and Story deletion remain atomic", async () => {
  const fixture = await createStoryDatabaseFixture("task-handoff-story-context-cas-");
  try {
    await seedStory(fixture.repository);
    const service = new StoryContextSettingsService(fixture.repository, "node_1", folderSource([folder("folder_a")]));
    await service.update("story_1", { expectedRevision: 0, projectFolderIds: ["folder_a"], appendedPrompt: "saved" });
    await assert.rejects(
      () => service.update("story_1", { expectedRevision: 0, projectFolderIds: [], appendedPrompt: "stale" }),
      (error: any) => error.code === "STORY_CONTEXT_REVISION_CONFLICT" && error.statusCode === 409,
    );
    const persisted = await service.get("story_1");
    assert.deepEqual(persisted, {
      storyId: "story_1",
      revision: 1,
      projectFolderIds: ["folder_a"],
      appendedPrompt: "saved",
      updatedAt: persisted.updatedAt,
    });
    assert.equal(await fixture.repository.stories.delete("story_1"), true);
    assert.equal(fixture.database.client.prepare("SELECT COUNT(*) AS count FROM na_story_context_settings WHERE story_id = ?").get("story_1").count, 0);
    assert.equal(fixture.database.client.prepare("SELECT COUNT(*) AS count FROM na_story_context_projects WHERE story_id = ?").get("story_1").count, 0);
  } finally { await fixture.close(); }
});

test("Story context settings survive a Node Agent restart with the current folder metadata outside the settings record", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-story-context-restart-"));
  const paths = nodeAgentStorePaths(dataDir);
  try {
    const first = await openNodeAgentDatabase(paths);
    const firstRepository = createNodeAgentRepository(first);
    await seedStory(firstRepository);
    const service = new StoryContextSettingsService(firstRepository, "node_1", folderSource([folder("folder_a", "node_1", "Original")]));
    await service.update("story_1", { expectedRevision: 0, projectFolderIds: ["folder_a"], appendedPrompt: "persisted" });
    await firstRepository.close();
    const second = await openNodeAgentDatabase(paths);
    const secondRepository = createNodeAgentRepository(second);
    const reopened = await new StoryContextSettingsService(secondRepository, "node_1", folderSource([folder("folder_a", "node_1", "Renamed")])).get("story_1");
    assert.equal(reopened.appendedPrompt, "persisted");
    assert.deepEqual(reopened.projectFolderIds, ["folder_a"]);
    await secondRepository.close();
  } finally { fs.rmSync(dataDir, { recursive: true, force: true }); }
});

test("pre-context Story databases upgrade without prewriting context settings rows", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-story-context-upgrade-"));
  const paths = nodeAgentStorePaths(dataDir);
  try {
    const first = await openNodeAgentDatabase(paths);
    await first.close();
    const legacy = new DatabaseSync(paths.databasePath);
    legacy.exec("DROP TABLE na_agent_run_story_context");
    legacy.exec("DROP TABLE na_story_context_projects");
    legacy.exec("DROP TABLE na_story_context_settings");
    legacy.prepare("DELETE FROM na_migration_ledger WHERE id = ?").run("0022_story_context_domain");
    legacy.prepare("INSERT INTO na_stories (id, title, created_at, updated_at, max_idle_ai_sessions, next_document_sequence) VALUES (?, ?, ?, ?, 5, 1)").run("story_legacy", "Legacy", NOW, NOW);
    legacy.close();
    const upgraded = await openNodeAgentDatabase(paths);
    const repository = createNodeAgentRepository(upgraded);
    assert.deepEqual(await new StoryContextSettingsService(repository, "node_1", folderSource([])).get("story_legacy"), {
      storyId: "story_legacy",
      revision: 0,
      projectFolderIds: [],
      appendedPrompt: "",
      updatedAt: NOW,
    });
    assert.equal(upgraded.client.prepare("SELECT COUNT(*) AS count FROM na_story_context_settings").get().count, 0);
    await repository.close();
  } finally { fs.rmSync(dataDir, { recursive: true, force: true }); }
});

test("concurrent Story context saves with one expected revision keep exactly one winner", async () => {
  const fixture = await createStoryDatabaseFixture("task-handoff-story-context-concurrent-");
  try {
    await seedStory(fixture.repository);
    const service = new StoryContextSettingsService(fixture.repository, "node_1", folderSource([folder("folder_a"), folder("folder_b")]));
    const results = await Promise.allSettled([
      service.update("story_1", { expectedRevision: 0, projectFolderIds: ["folder_a"], appendedPrompt: "first" }),
      service.update("story_1", { expectedRevision: 0, projectFolderIds: ["folder_b"], appendedPrompt: "second" }),
    ]);
    const fulfilled = results.filter((result) => result.status === "fulfilled");
    const rejected = results.filter((result) => result.status === "rejected") as PromiseRejectedResult[];
    assert.equal(fulfilled.length, 1);
    assert.equal(rejected.length, 1);
    assert.equal(rejected[0]!.reason.code, "STORY_CONTEXT_REVISION_CONFLICT");
    const persisted = await service.get("story_1");
    assert.equal(persisted.revision, 1);
    assert.equal(persisted.appendedPrompt, "first");
    assert.deepEqual(persisted.projectFolderIds, ["folder_a"]);
  } finally { await fixture.close(); }
});

test("Story context commits survive a changed-event delivery failure and report a diagnostic", async () => {
  const fixture = await createStoryDatabaseFixture("task-handoff-story-context-event-failure-");
  try {
    await seedStory(fixture.repository);
    const failures: Array<{ storyId: string; error: unknown }> = [];
    const service = new StoryContextSettingsService(
      fixture.repository,
      "node_1",
      folderSource([folder("folder_a")]),
      () => { throw new Error("Control Plane tunnel unavailable"); },
      (storyId, error) => { failures.push({ storyId, error }); },
    );
    const saved = await service.update("story_1", {
      expectedRevision: 0,
      projectFolderIds: ["folder_a"],
      appendedPrompt: "committed",
    });
    assert.equal(saved.revision, 1);
    assert.equal(failures.length, 1);
    assert.equal(failures[0]!.storyId, "story_1");
    assert.deepEqual((await service.get("story_1")).projectFolderIds, ["folder_a"]);
    assert.equal((await service.get("story_1")).appendedPrompt, "committed");
  } finally { await fixture.close(); }
});
