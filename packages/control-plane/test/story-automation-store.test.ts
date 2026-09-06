import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { StoryAutomationStore } from "../src/node-agent/stories/automation-store.ts";
import { createStoryDatabaseFixture, seedStoryAction } from "./story-database-fixture.ts";

async function fixture() {
  const databaseFixture = await createStoryDatabaseFixture("task-handoff-story-automation-");
  await seedStoryAction(databaseFixture.repository);
  let tick = 0;
  const store = new StoryAutomationStore(databaseFixture.repository, () => new Date(Date.UTC(2026, 8, 5, 0, 0, tick++)));
  await store.init();
  const automation = await store.create({
    storyId: "story_1",
    actionId: "action_1",
    schedule: { scheduleKind: "interval", intervalMs: 60_000 },
    enabled: true,
    policy: { maxConcurrentRuns: 1, whenBusy: "queue" },
  });
  const createRun = (executionKey: string) => store.createRun({
    automationId: automation.id,
    eventType: "schedule",
    scheduledFor: new Date(Date.UTC(2026, 8, 5, 1, 0, tick)).toISOString(),
    executionKey,
    requestFingerprint: "a".repeat(64),
    executionInput: {
      storyId: "story_1",
      actionId: "action_1",
      targetInstanceId: "instance_1",
      prompt: "Keep {{literal}} unchanged",
      cwd: "/workspace",
    },
  });
  return { ...databaseFixture, store, automation, createRun };
}

test("Story Automation store enforces one-way run transitions and immutable idempotency input", async () => {
  const { close, store, automation, createRun } = await fixture();
  try {
    const run = await createRun("execution_1");
    assert.equal((await createRun("execution_1")).id, run.id);
    const dispatching = await store.transition(run.id, "dispatching");
    const running = await store.transition(dispatching.id, "running", { aiSessionId: "session_1" });
    const completed = await store.transition(running.id, "completed");
    assert.equal(completed.executionInput.prompt, "Keep {{literal}} unchanged");
    await assert.rejects(() => store.transition(completed.id, "running"), (error: any) => error.code === "STORY_AUTOMATION_RUN_TRANSITION_INVALID");
    assert.equal((await store.runsFor(automation.id))[0]?.aiSessionId, "session_1");
    assert.equal("executionInput" in (await store.runsFor(automation.id))[0]!, false);
  } finally {
    await close();
  }
});

test("Story Automation execution key remains idempotent under concurrent creation", async () => {
  const { close, createRun } = await fixture();
  try {
    const runs = await Promise.all(Array.from({ length: 8 }, () => createRun("execution_concurrent")));
    assert.equal(new Set(runs.map((run) => run.id)).size, 1);
  } finally {
    await close();
  }
});

test("Story Automation store retains all active runs and only the newest 100 terminal runs", async () => {
  const { close, store, automation, createRun } = await fixture();
  try {
    const active = await createRun("active");
    for (let index = 0; index < 105; index += 1) {
      const run = await createRun(`terminal_${index}`);
      await store.transition(run.id, "skipped", { error: { code: "TEST", message: "test" } });
    }
    const runs = await store.runsFor(automation.id);
    assert.equal(runs.filter((run) => run.status === "skipped").length, 100);
    assert.equal(runs.some((run) => run.id === active.id), true);
    await assert.rejects(() => store.delete(automation.id), (error: any) => error.code === "STORY_AUTOMATION_RUN_ACTIVE");
  } finally {
    await close();
  }
});

test("Story Automation store ignores experimental JSON instead of importing it", async () => {
  const fixture = await createStoryDatabaseFixture("task-handoff-story-automation-strict-");
  try {
    fs.mkdirSync(fixture.paths.storyAutomationsDir, { recursive: true });
    fs.writeFileSync(path.join(fixture.paths.storyAutomationsDir, "index.json"), JSON.stringify({ schemaVersion: 1, automations: [{ id: "legacy" }], runs: [] }));
    const store = new StoryAutomationStore(fixture.repository);
    await store.init();
    assert.deepEqual(await store.list(), []);
  } finally {
    await fixture.close();
  }
});
