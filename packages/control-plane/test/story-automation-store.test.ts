import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { nodeAgentStorePaths } from "../src/node-agent/persistence/paths.ts";
import { StoryAutomationStore } from "../src/node-agent/stories/automation-store.ts";

function fixture() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-story-automation-"));
  let tick = 0;
  const store = new StoryAutomationStore(nodeAgentStorePaths(dataDir), () => new Date(Date.UTC(2026, 8, 5, 0, 0, tick++)));
  store.init();
  const automation = store.create({
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
  return { dataDir, store, automation, createRun };
}

test("Story Automation store enforces one-way run transitions and immutable idempotency input", () => {
  const { dataDir, store, automation, createRun } = fixture();
  try {
    const run = createRun("execution_1");
    assert.equal(createRun("execution_1").id, run.id);
    const dispatching = store.transition(run.id, "dispatching");
    const running = store.transition(dispatching.id, "running", { aiSessionId: "session_1" });
    const completed = store.transition(running.id, "completed");
    assert.equal(completed.executionInput.prompt, "Keep {{literal}} unchanged");
    assert.throws(() => store.transition(completed.id, "running"), (error: any) => error.code === "STORY_AUTOMATION_RUN_TRANSITION_INVALID");
    assert.equal(store.runsFor(automation.id)[0]?.aiSessionId, "session_1");
    assert.equal("executionInput" in store.runsFor(automation.id)[0]!, false);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("Story Automation store retains all active runs and only the newest 100 terminal runs", () => {
  const { dataDir, store, automation, createRun } = fixture();
  try {
    const active = createRun("active");
    for (let index = 0; index < 105; index += 1) {
      const run = createRun(`terminal_${index}`);
      store.transition(run.id, "skipped", { error: { code: "TEST", message: "test" } });
    }
    const runs = store.runsFor(automation.id);
    assert.equal(runs.filter((run) => run.status === "skipped").length, 100);
    assert.equal(runs.some((run) => run.id === active.id), true);
    assert.throws(() => store.delete(automation.id), (error: any) => error.code === "STORY_AUTOMATION_RUN_ACTIVE");
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("Story Automation store rejects unknown persisted fields", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-story-automation-strict-"));
  try {
    const paths = nodeAgentStorePaths(dataDir);
    fs.mkdirSync(paths.storyAutomationsDir, { recursive: true });
    fs.writeFileSync(path.join(paths.storyAutomationsDir, "index.json"), JSON.stringify({ schemaVersion: 1, automations: [], runs: [], legacy: true }));
    const store = new StoryAutomationStore(paths);
    assert.throws(() => store.init());
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
