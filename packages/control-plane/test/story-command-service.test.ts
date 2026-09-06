import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { StoryAutomationStore } from "../src/node-agent/stories/automation-store.ts";
import { StoryCommandService } from "../src/node-agent/stories/command-service.ts";
import { NodeStoryStore } from "../src/node-agent/stories/store.ts";
import { createStoryDatabaseFixture } from "./story-database-fixture.ts";

function schedulerStub() {
  return {
    clearStory: async () => undefined,
    refresh: async () => undefined,
    validateCreate: async () => undefined,
    activateCreated: async () => { throw new Error("not used"); },
  };
}

test("Story deletion recovery restores staged content when database deletion did not commit", async () => {
  const fixture = await createStoryDatabaseFixture("task-handoff-story-deletion-intent-");
  try {
    const stories = new NodeStoryStore(fixture.paths, "node_1", fixture.repository);
    await stories.init();
    const story = await stories.create({ title: "Delete me", actions: [] });
    await stories.writeContent(story.id, { storyPath: "content.txt", title: "Content", stream: Readable.from(["kept"]) });
    const root = path.join(fixture.paths.storyContentDir, story.id);
    const trashName = `${story.id}-staged`;
    const trash = path.join(fixture.paths.storyTrashDir, trashName);
    fs.renameSync(root, trash);
    const timestamp = "2026-09-05T00:00:00.000Z";
    await fixture.repository.deletionIntents.put({ storyId: story.id, phase: "files-staged", trashName, createdAt: timestamp, updatedAt: timestamp });
    const automations = new StoryAutomationStore(fixture.repository);
    const state = { paths: fixture.paths, listInstances: () => [] };
    const commands = new StoryCommandService(state as any, stories, automations, schedulerStub() as any, fixture.repository);

    await commands.init();

    assert.equal(fs.readFileSync(path.join(root, "content.txt"), "utf8"), "kept");
    assert.ok(await stories.get(story.id));
    assert.equal(await fixture.repository.deletionIntents.get(story.id), undefined);
  } finally {
    await fixture.close();
  }
});

test("creating an Automation with a new Action rolls the transaction back when Automation persistence fails", async () => {
  const fixture = await createStoryDatabaseFixture("task-handoff-story-automation-action-");
  try {
    const stories = new NodeStoryStore(fixture.paths, "node_1", fixture.repository);
    await stories.init();
    const story = await stories.create({ title: "Release", actions: [] });
    const automations = new StoryAutomationStore(fixture.repository);
    automations.create = async () => { throw Object.assign(new Error("Invalid target."), { code: "STORY_AUTOMATION_TARGET_INVALID" }); };
    const state = { paths: fixture.paths, listInstances: () => [] };
    const commands = new StoryCommandService(state as any, stories, automations, schedulerStub() as any, fixture.repository);

    await assert.rejects(() => commands.createAutomationWithAction(story.id, {
      action: { id: "action_1", title: "Deploy", promptTemplate: "Deploy", targetInstanceId: "instance_1" },
      automation: { schedule: { scheduleKind: "interval", intervalMs: 60_000 }, enabled: true, policy: { maxConcurrentRuns: 1, whenBusy: "skip" } },
    }), /Invalid target/);
    assert.deepEqual((await stories.require(story.id)).id, story.id);
    assert.deepEqual((await stories.get(story.id))?.actions, []);
  } finally {
    await fixture.close();
  }
});

test("Story deletion keeps committed trash staged when cleanup fails", async () => {
  const fixture = await createStoryDatabaseFixture("task-handoff-story-deletion-cleanup-");
  const originalRmSync = fs.rmSync;
  try {
    const stories = new NodeStoryStore(fixture.paths, "node_1", fixture.repository);
    await stories.init();
    const story = await stories.create({ title: "Delete committed", actions: [] });
    await stories.writeContent(story.id, { storyPath: "content.txt", title: "Content", stream: Readable.from(["committed"]) });
    const automations = new StoryAutomationStore(fixture.repository);
    const state = { paths: fixture.paths, listInstances: () => [] };
    const commands = new StoryCommandService(state as any, stories, automations, schedulerStub() as any, fixture.repository);
    const root = path.join(fixture.paths.storyContentDir, story.id);
    let stagedTrash = "";
    fs.rmSync = ((target: fs.PathLike, options?: fs.RmDirOptions) => {
      const candidate = String(target);
      if (candidate.startsWith(`${fixture.paths.storyTrashDir}${path.sep}`)) {
        stagedTrash = candidate;
        throw Object.assign(new Error("injected trash cleanup failure"), { code: "EIO" });
      }
      return originalRmSync(target, options);
    }) as typeof fs.rmSync;

    await assert.rejects(() => commands.delete(story.id), /injected trash cleanup failure/);
    fs.rmSync = originalRmSync;
    assert.equal(await fixture.repository.stories.get(story.id), undefined);
    assert.equal(fs.existsSync(root), false);
    assert.equal(fs.existsSync(stagedTrash), true);
    assert.equal((await fixture.repository.deletionIntents.get(story.id))?.phase, "database-committed");

    await commands.init();
    assert.equal(fs.existsSync(stagedTrash), false);
    assert.equal(await fixture.repository.deletionIntents.get(story.id), undefined);
  } finally {
    fs.rmSync = originalRmSync;
    await fixture.close();
  }
});

test("Story Action reference preflight rejects the complete update transaction", async () => {
  const fixture = await createStoryDatabaseFixture("task-handoff-story-action-reference-");
  try {
    const stories = new NodeStoryStore(fixture.paths, "node_1", fixture.repository);
    await stories.init();
    const story = await stories.create({
      title: "Referenced",
      actions: [{ title: "Deploy", promptTemplate: "Deploy", targetInstanceId: "instance_1" }],
    });
    const action = story.actions[0]!;
    const automations = new StoryAutomationStore(fixture.repository);
    const automation = await automations.create({
      storyId: story.id,
      actionId: action.id,
      schedule: { scheduleKind: "interval", intervalMs: 60_000 },
      enabled: false,
      policy: { maxConcurrentRuns: 1, whenBusy: "skip" },
    });

    await assert.rejects(
      () => stories.update(story.id, { title: "Must roll back", actions: [] }),
      (error: any) => error.code === "STORY_ACTION_AUTOMATION_IN_USE"
        && error.details?.automationIds?.[0] === automation.id,
    );
    const unchanged = await stories.get(story.id);
    assert.equal(unchanged?.title, "Referenced");
    assert.equal(unchanged?.actions[0]?.id, action.id);
  } finally {
    await fixture.close();
  }
});

test("Story deletion accepts a lazy directory and rejects authoritative Session references", async () => {
  const fixture = await createStoryDatabaseFixture("task-handoff-story-delete-preflight-");
  try {
    const stories = new NodeStoryStore(fixture.paths, "node_1", fixture.repository);
    await stories.init();
    const lazy = await stories.create({ title: "Lazy", actions: [] });
    const automations = new StoryAutomationStore(fixture.repository);
    const state = { paths: fixture.paths, listInstances: () => [] };
    const commands = new StoryCommandService(state as any, stories, automations, schedulerStub() as any, fixture.repository);
    assert.equal(await commands.delete(lazy.id), true);
    assert.equal(fs.existsSync(path.join(fixture.paths.storyContentDir, lazy.id)), false);
    assert.equal(await fixture.repository.deletionIntents.get(lazy.id), undefined);

    const referenced = await stories.create({ title: "Referenced", actions: [] });
    const referencedState = {
      paths: fixture.paths,
      listInstances: () => [{ id: "instance_1", aiSessions: { sessions: [{ id: "session_1", storyId: referenced.id }] } }],
    };
    const referencedCommands = new StoryCommandService(referencedState as any, stories, automations, schedulerStub() as any, fixture.repository);
    await assert.rejects(
      () => referencedCommands.delete(referenced.id),
      (error: any) => error.code === "STORY_IN_USE" && error.details?.sessions?.[0]?.aiSessionId === "session_1",
    );
    assert.ok(await fixture.repository.stories.get(referenced.id));

    const active = await stories.create({ title: "Active run", actions: [{ title: "Run", promptTemplate: "Run", targetInstanceId: "instance_1" }] });
    const automation = await automations.create({
      storyId: active.id,
      actionId: active.actions[0]!.id,
      schedule: { scheduleKind: "interval", intervalMs: 60_000 },
      enabled: false,
      policy: { maxConcurrentRuns: 1, whenBusy: "skip" },
    });
    await automations.createRun({
      automationId: automation.id,
      eventType: "manual",
      scheduledFor: "2026-09-05T00:00:00.000Z",
      executionKey: "active_run",
      requestFingerprint: "a".repeat(64),
      executionInput: { storyId: active.id, actionId: active.actions[0]!.id, targetInstanceId: "instance_1", prompt: "Run", cwd: "/workspace" },
    });
    await assert.rejects(() => commands.delete(active.id), (error: any) => error.code === "STORY_AUTOMATION_RUN_ACTIVE");
    assert.ok(await fixture.repository.stories.get(active.id));
  } finally { await fixture.close(); }
});

test("Story deletion restores staged content after trash or database failures", async () => {
  for (const failure of ["trash", "database"] as const) {
    const fixture = await createStoryDatabaseFixture(`task-handoff-story-delete-${failure}-`);
    const originalRenameSync = fs.renameSync;
    const originalDelete = fixture.repository.stories.delete;
    try {
      const stories = new NodeStoryStore(fixture.paths, "node_1", fixture.repository);
      await stories.init();
      const story = await stories.create({ title: failure, actions: [] });
      await stories.writeContent(story.id, { storyPath: "content.txt", title: "Content", stream: Readable.from(["preserved"]) });
      const root = path.join(fixture.paths.storyContentDir, story.id);
      const automations = new StoryAutomationStore(fixture.repository);
      const state = { paths: fixture.paths, listInstances: () => [] };
      const commands = new StoryCommandService(state as any, stories, automations, schedulerStub() as any, fixture.repository);
      if (failure === "trash") {
        fs.renameSync = ((source: fs.PathLike, destination: fs.PathLike) => {
          if (String(source) === root && String(destination).startsWith(`${fixture.paths.storyTrashDir}${path.sep}`)) {
            throw Object.assign(new Error("injected trash rename failure"), { code: "EIO" });
          }
          return originalRenameSync(source, destination);
        }) as typeof fs.renameSync;
      } else {
        fixture.repository.stories.delete = (async () => { throw new Error("injected Story transaction failure"); }) as typeof fixture.repository.stories.delete;
      }

      await assert.rejects(() => commands.delete(story.id));
      fs.renameSync = originalRenameSync;
      fixture.repository.stories.delete = originalDelete;
      assert.equal(fs.readFileSync(path.join(root, "content.txt"), "utf8"), "preserved");
      assert.ok(await fixture.repository.stories.get(story.id));
      assert.equal(await fixture.repository.deletionIntents.get(story.id), undefined);
    } finally {
      fs.renameSync = originalRenameSync;
      fixture.repository.stories.delete = originalDelete;
      await fixture.close();
    }
  }
});
