import assert from "node:assert/strict";
import test from "node:test";
import { schedulerExecutionKey } from "@task-handoff/core/core/scheduler-runtime";
import { StoryAutomationStore } from "../src/node-agent/stories/automation-store.ts";
import { StoryScheduler } from "../src/node-agent/stories/scheduler.ts";
import { createStoryDatabaseFixture, seedStoryAction } from "./story-database-fixture.ts";

async function waitFor(predicate: () => boolean | Promise<boolean>) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail("condition was not reached");
}

async function fixture(fetchImpl: typeof fetch, whenBusy: "queue" | "skip" = "queue") {
  const database = await createStoryDatabaseFixture("task-handoff-story-scheduler-");
  await seedStoryAction(database.repository);
  const store = new StoryAutomationStore(database.repository);
  const instance = {
    id: "instance_1", registrationToken: "registration-token", runtimeId: "runtime_1",
    runtime: { workspacePath: "/workspace" }, workspace: { path: "/workspace" },
    source: { type: "local-folder", path: "/workspace" }, aiSessions: { sessions: [] as Array<{ id: string; status: string }> },
  };
  const state = {
    node: { id: "node_1" }, requireInstance: () => instance, listInstances: () => [instance],
    localFolders: { get: () => undefined }, requireRuntime: () => ({ type: "local" }),
  };
  const stories = { automationContext: async () => ({
    id: "story_1",
    actions: [{ id: "action_1", title: "Action", promptTemplate: "Keep {{literal}}", targetInstanceId: "instance_1" }],
  }) };
  const scheduler = new StoryScheduler(state as any, stories as any, store, fetchImpl, async () => "http://instance");
  const automation = await store.create({
    storyId: "story_1", actionId: "action_1", schedule: { scheduleKind: "interval", intervalMs: 60_000 }, enabled: false,
    policy: { maxConcurrentRuns: 1, whenBusy },
  });
  return { ...database, store, scheduler, automation, instance, state, stories };
}

test("Story Scheduler retries an ambiguous dispatch with the same immutable request", async () => {
  const requests: string[] = [];
  const first = await fixture(async (_url, init) => { requests.push(String(init?.body)); throw new Error("response lost"); });
  try {
    const run = await first.store.createRun({
      automationId: first.automation.id, eventType: "manual", scheduledFor: "2026-09-05T00:00:00.000Z",
      executionKey: "stable_execution_key", requestFingerprint: "a".repeat(64),
      executionInput: { storyId: "story_1", actionId: "action_1", targetInstanceId: "instance_1", prompt: "Keep {{literal}}", cwd: "/workspace" },
    });
    await first.store.transition(run.id, "dispatching");
    await first.scheduler.start();
    await waitFor(() => requests.length === 1);
    await first.scheduler.stop();
    const second = new StoryScheduler(first.state as any, first.stories as any, first.store, async (_url, init) => {
      requests.push(String(init?.body));
      return new Response(JSON.stringify({ data: { disposition: "already-created", aiSessionId: "session_1" } }), { status: 200, headers: { "content-type": "application/json" } });
    }, async () => "http://instance");
    await second.start();
    await waitFor(async () => (await first.store.run(run.id))?.status === "running");
    assert.deepEqual(JSON.parse(requests[0]!), JSON.parse(requests[1]!));
    assert.equal(JSON.parse(requests[1]!).clientRequestId, "stable_execution_key");
    await second.stop();
  } finally { await first.close(); }
});

test("disabling an Automation skips runs still waiting in its queue", async () => {
  let sessionIndex = 0;
  const context = await fixture(async () => new Response(JSON.stringify({ data: { disposition: "created", aiSessionId: `session_${++sessionIndex}` } }), { status: 200, headers: { "content-type": "application/json" } }));
  try {
    await context.scheduler.start();
    const first = await context.scheduler.manualRun(context.automation.id, { clientRequestId: "manual_1" });
    await waitFor(async () => (await context.store.run(first!.id))?.status === "running");
    const second = await context.scheduler.manualRun(context.automation.id, { clientRequestId: "manual_2" });
    assert.equal((await context.store.run(second!.id))?.status, "queued");
    await context.scheduler.setEnabled(context.automation.id, false);
    await waitFor(async () => (await context.store.run(second!.id))?.status === "skipped");
    assert.equal((await context.store.run(first!.id))?.status, "running");
    await context.scheduler.stop();
  } finally { await context.close(); }
});

test("Story Scheduler releases concurrency on Session terminal state and drains FIFO", async () => {
  const dispatched: string[] = [];
  const context = await fixture(async (_url, init) => {
    const request = JSON.parse(String(init?.body));
    dispatched.push(request.clientRequestId);
    return new Response(JSON.stringify({ data: { disposition: "created", aiSessionId: `session_${dispatched.length}` } }), { status: 200, headers: { "content-type": "application/json" } });
  });
  try {
    await context.scheduler.start();
    const first = await context.scheduler.manualRun(context.automation.id, { clientRequestId: "first" });
    await waitFor(async () => (await context.store.run(first!.id))?.status === "running");
    const second = await context.scheduler.manualRun(context.automation.id, { clientRequestId: "second" });
    const third = await context.scheduler.manualRun(context.automation.id, { clientRequestId: "third" });
    context.instance.aiSessions.sessions.push({ id: "session_1", status: "idle" });
    await context.scheduler.reconcileInstances();
    await waitFor(async () => (await context.store.run(second!.id))?.status === "running");
    assert.equal((await context.store.run(third!.id))?.status, "queued");
    assert.deepEqual(dispatched, [
      schedulerExecutionKey(context.automation.id, "manual", "first"),
      schedulerExecutionKey(context.automation.id, "manual", "second"),
    ]);
    await context.scheduler.stop();
  } finally { await context.close(); }
});

test("Story Scheduler completes a run after an authoritative snapshot drops its closed AI Session", async () => {
  const context = await fixture(async () => new Response(JSON.stringify({ data: { disposition: "created", aiSessionId: "session_1" } }), { status: 200, headers: { "content-type": "application/json" } }));
  try {
    await context.scheduler.start();
    const run = await context.scheduler.manualRun(context.automation.id, { clientRequestId: "closed" });
    await waitFor(async () => (await context.store.run(run!.id))?.status === "running");
    await context.scheduler.reconcileInstances(context.instance.id);
    assert.equal((await context.store.run(run!.id))?.status, "completed");
    await context.scheduler.stop();
  } finally { await context.close(); }
});

test("Story Scheduler records an explicit instance rejection as failed", async () => {
  const context = await fixture(async () => new Response(JSON.stringify({ error: { code: "INSTANCE_OFFLINE", message: "Target instance is offline." } }), { status: 503, headers: { "content-type": "application/json" } }));
  try {
    await context.scheduler.start();
    const run = await context.scheduler.manualRun(context.automation.id, { clientRequestId: "offline" });
    await waitFor(async () => (await context.store.run(run!.id))?.status === "failed");
    assert.deepEqual((await context.store.run(run!.id))?.error, { code: "INSTANCE_OFFLINE", message: "Target instance is offline." });
    await context.scheduler.stop();
  } finally { await context.close(); }
});
