import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { nodeAgentStorePaths } from "../src/node-agent/persistence/paths.ts";
import { StoryAutomationStore } from "../src/node-agent/stories/automation-store.ts";
import { StoryCommandService } from "../src/node-agent/stories/command-service.ts";
import { NodeStoryStore } from "../src/node-agent/stories/store.ts";

test("Story deletion intent resumes idempotent Automation and Story cleanup", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-story-deletion-intent-"));
  try {
    const paths = nodeAgentStorePaths(dataDir);
    const stories = new NodeStoryStore(paths, "node_1");
    stories.init();
    const story = stories.create({ title: "Delete me", actions: [] });
    const automations = new StoryAutomationStore(paths);
    automations.init();
    automations.create({ storyId: story.id, actionId: "removed_action", schedule: { scheduleKind: "interval", intervalMs: 60_000 }, enabled: false, policy: { maxConcurrentRuns: 1, whenBusy: "skip" } });
    fs.writeFileSync(path.join(paths.storyAutomationsDir, "deletion-intents.json"), `${JSON.stringify({ schemaVersion: 1, intents: [{ storyId: story.id, createdAt: "2026-09-05T00:00:00.000Z" }] })}\n`);
    const cleared: string[] = [];
    const state = { paths, listInstances: () => [] };
    const scheduler = { clearStory: (storyId: string) => cleared.push(storyId), refresh: () => undefined };
    const commands = new StoryCommandService(state as any, stories, automations, scheduler as any);
    commands.init();
    assert.deepEqual(cleared, [story.id]);
    assert.equal(stories.get(story.id), undefined);
    assert.deepEqual(automations.list(story.id), []);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(paths.storyAutomationsDir, "deletion-intents.json"), "utf8")).intents, []);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("creating an Automation with a new Action rolls the Action back when Automation creation fails", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-story-automation-action-"));
  try {
    const paths = nodeAgentStorePaths(dataDir);
    const stories = new NodeStoryStore(paths, "node_1");
    stories.init();
    const story = stories.create({ title: "Release", actions: [] });
    const automations = new StoryAutomationStore(paths);
    automations.init();
    const state = { paths, listInstances: () => [] };
    const scheduler = {
      clearStory: () => undefined,
      refresh: () => undefined,
      create: () => { throw Object.assign(new Error("Invalid target."), { code: "STORY_AUTOMATION_TARGET_INVALID" }); },
    };
    const commands = new StoryCommandService(state as any, stories, automations, scheduler as any);
    assert.throws(() => commands.createAutomationWithAction(story.id, {
      action: { id: "action_1", title: "Deploy", promptTemplate: "Deploy", targetInstanceId: "instance_1" },
      automation: { schedule: { scheduleKind: "interval", intervalMs: 60_000 }, enabled: true, policy: { maxConcurrentRuns: 1, whenBusy: "skip" } },
    }), /Invalid target/);
    assert.deepEqual(stories.require(story.id).actions, []);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
