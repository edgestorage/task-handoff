import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { schedulerExecutionKey } from "@task-handoff/core/core/scheduler-runtime";
import { nodeAgentStorePaths } from "../src/node-agent/persistence/paths.ts";
import { StoryAutomationStore } from "../src/node-agent/stories/automation-store.ts";
import { StoryScheduler } from "../src/node-agent/stories/scheduler.ts";

async function waitFor(predicate: () => boolean) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail("condition was not reached");
}

test("Story Scheduler retries an ambiguous dispatch with the same immutable request", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-story-scheduler-"));
  try {
    const store = new StoryAutomationStore(nodeAgentStorePaths(dataDir));
    store.init();
    const automation = store.create({
      storyId: "story_1", actionId: "action_1", schedule: { scheduleKind: "interval", intervalMs: 60_000 }, enabled: false,
      policy: { maxConcurrentRuns: 1, whenBusy: "queue" },
    });
    const run = store.createRun({
      automationId: automation.id,
      eventType: "manual",
      scheduledFor: "2026-09-05T00:00:00.000Z",
      executionKey: "stable_execution_key",
      requestFingerprint: "a".repeat(64),
      executionInput: { storyId: "story_1", actionId: "action_1", targetInstanceId: "instance_1", prompt: "Keep {{literal}}", cwd: "/workspace" },
    });
    store.transition(run.id, "dispatching");
    const instance = {
      id: "instance_1", registrationToken: "registration-token", runtime: { workspacePath: "/workspace" }, workspace: { path: "/workspace" }, aiSessions: { sessions: [] },
    };
    const state = {
      node: { id: "node_1" },
      requireInstance: () => instance,
      listInstances: () => [instance],
      localFolders: { get: () => undefined },
    };
    const stories = { get: () => ({
      id: "story_1", actions: [{ id: "action_1", title: "Action", promptTemplate: "Keep {{literal}}", targetInstanceId: "instance_1" }],
    }) };
    const requests: string[] = [];
    const first = new StoryScheduler(state as any, stories as any, store, async (_url, init) => {
      requests.push(String(init?.body));
      throw new Error("response lost");
    }, async () => "http://instance");
    first.start();
    await waitFor(() => requests.length === 1);
    await waitFor(() => store.run(run.id)?.status === "dispatching");
    first.stop();

    const second = new StoryScheduler(state as any, stories as any, store, async (_url, init) => {
      requests.push(String(init?.body));
      return new Response(JSON.stringify({ data: { disposition: "already-created", aiSessionId: "session_1" } }), { status: 200, headers: { "content-type": "application/json" } });
    }, async () => "http://instance");
    second.start();
    await waitFor(() => store.run(run.id)?.status === "running");
    assert.equal(requests.length, 2);
    assert.deepEqual(JSON.parse(requests[0]!), JSON.parse(requests[1]!));
    assert.equal(JSON.parse(requests[1]!).clientRequestId, "stable_execution_key");
    assert.equal(JSON.parse(requests[1]!).message, "Keep {{literal}}");

    instance.aiSessions.sessions.push({ id: "session_1", status: "idle" } as never);
    second.reconcileInstances();
    assert.equal(store.run(run.id)?.status, "completed");
    second.stop();
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("disabling an Automation skips runs still waiting in its queue", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-story-scheduler-disable-"));
  try {
    const store = new StoryAutomationStore(nodeAgentStorePaths(dataDir));
    store.init();
    const instance = {
      id: "instance_1", registrationToken: "registration-token", runtime: { workspacePath: "/workspace" }, workspace: { path: "/workspace" }, aiSessions: { sessions: [] },
    };
    const state = {
      node: { id: "node_1" },
      requireInstance: () => instance,
      listInstances: () => [instance],
      localFolders: { get: () => undefined },
    };
    const stories = { get: () => ({
      id: "story_1", actions: [{ id: "action_1", title: "Action", promptTemplate: "Run", targetInstanceId: "instance_1" }],
    }) };
    let sessionIndex = 0;
    const scheduler = new StoryScheduler(state as any, stories as any, store, async () => {
      sessionIndex += 1;
      return new Response(JSON.stringify({ data: { disposition: "created", aiSessionId: `session_${sessionIndex}` } }), { status: 200, headers: { "content-type": "application/json" } });
    }, async () => "http://instance");
    scheduler.start();
    const status = scheduler.create({
      storyId: "story_1", actionId: "action_1", schedule: { scheduleKind: "interval", intervalMs: 60_000 }, enabled: true,
      policy: { maxConcurrentRuns: 1, whenBusy: "queue" },
    });
    const first = scheduler.manualRun(status.automation.id, { clientRequestId: "manual_1" });
    await waitFor(() => store.run(first.id)?.status === "running");
    const second = scheduler.manualRun(status.automation.id, { clientRequestId: "manual_2" });
    assert.equal(store.run(second.id)?.status, "queued");

    scheduler.setEnabled(status.automation.id, false);

    assert.equal(store.run(first.id)?.status, "running");
    assert.equal(store.run(second.id)?.status, "skipped");
    assert.equal(store.run(second.id)?.error?.code, "STORY_AUTOMATION_JOB_DISABLED");
    scheduler.stop();
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("Story Scheduler releases concurrency on Session terminal state and drains FIFO", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-story-scheduler-fifo-"));
  try {
    const store = new StoryAutomationStore(nodeAgentStorePaths(dataDir));
    store.init();
    const instance = {
      id: "instance_1", registrationToken: "registration-token", runtime: { workspacePath: "/workspace" }, workspace: { path: "/workspace" }, aiSessions: { sessions: [] as Array<{ id: string; status: string }> },
    };
    const state = {
      node: { id: "node_1" }, requireInstance: () => instance, listInstances: () => [instance], localFolders: { get: () => undefined },
    };
    const stories = { get: () => ({
      id: "story_1", actions: [{ id: "action_1", title: "Action", promptTemplate: "Run", targetInstanceId: "instance_1" }],
    }) };
    const dispatched: string[] = [];
    const scheduler = new StoryScheduler(state as any, stories as any, store, async (_url, init) => {
      const request = JSON.parse(String(init?.body));
      dispatched.push(request.clientRequestId);
      return new Response(JSON.stringify({ data: { disposition: "created", aiSessionId: `session_${dispatched.length}` } }), { status: 200, headers: { "content-type": "application/json" } });
    }, async () => "http://instance");
    scheduler.start();
    const automation = scheduler.create({
      storyId: "story_1", actionId: "action_1", schedule: { scheduleKind: "interval", intervalMs: 60_000 }, enabled: false,
      policy: { maxConcurrentRuns: 1, whenBusy: "queue" },
    }).automation;
    const first = scheduler.manualRun(automation.id, { clientRequestId: "first" });
    await waitFor(() => store.run(first.id)?.status === "running");
    const second = scheduler.manualRun(automation.id, { clientRequestId: "second" });
    const third = scheduler.manualRun(automation.id, { clientRequestId: "third" });
    assert.equal(store.run(second.id)?.status, "queued");
    assert.equal(store.run(third.id)?.status, "queued");

    instance.aiSessions.sessions.push({ id: "session_1", status: "idle" });
    scheduler.reconcileInstances();
    await waitFor(() => store.run(second.id)?.status === "running");
    assert.equal(store.run(first.id)?.status, "completed");
    assert.equal(store.run(third.id)?.status, "queued");
    assert.deepEqual(dispatched, [
      schedulerExecutionKey(automation.id, "manual", "first"),
      schedulerExecutionKey(automation.id, "manual", "second"),
    ]);
    scheduler.stop();
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("Story Scheduler completes a run after an authoritative snapshot drops its closed AI Session", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-story-scheduler-closed-session-"));
  try {
    const store = new StoryAutomationStore(nodeAgentStorePaths(dataDir));
    store.init();
    const instance = {
      id: "instance_1", registrationToken: "registration-token", runtime: { workspacePath: "/workspace" }, workspace: { path: "/workspace" }, aiSessions: { sessions: [] as Array<{ id: string; status: string }> },
    };
    const state = {
      node: { id: "node_1" }, requireInstance: () => instance, listInstances: () => [instance], localFolders: { get: () => undefined },
    };
    const stories = { get: () => ({
      id: "story_1", actions: [{ id: "action_1", title: "Action", promptTemplate: "Run", targetInstanceId: "instance_1" }],
    }) };
    const scheduler = new StoryScheduler(state as any, stories as any, store, async () => new Response(JSON.stringify({
      data: { disposition: "created", aiSessionId: "session_1" },
    }), { status: 200, headers: { "content-type": "application/json" } }), async () => "http://instance");
    scheduler.start();
    const automation = scheduler.create({
      storyId: "story_1", actionId: "action_1", schedule: { scheduleKind: "interval", intervalMs: 60_000 }, enabled: false,
      policy: { maxConcurrentRuns: 1, whenBusy: "skip" },
    }).automation;
    const run = scheduler.manualRun(automation.id, { clientRequestId: "closed" });
    await waitFor(() => store.run(run.id)?.status === "running");

    scheduler.reconcileInstances();
    assert.equal(store.run(run.id)?.status, "running");

    scheduler.reconcileInstances(instance.id);
    assert.equal(store.run(run.id)?.status, "completed");
    scheduler.stop();
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("Story Scheduler records an explicit instance rejection as failed", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-story-scheduler-rejection-"));
  try {
    const store = new StoryAutomationStore(nodeAgentStorePaths(dataDir));
    store.init();
    const instance = { id: "instance_1", registrationToken: "registration-token", runtime: { workspacePath: "/workspace" }, workspace: { path: "/workspace" }, aiSessions: { sessions: [] } };
    const state = { node: { id: "node_1" }, requireInstance: () => instance, listInstances: () => [instance], localFolders: { get: () => undefined } };
    const stories = { get: () => ({ id: "story_1", actions: [{ id: "action_1", title: "Action", promptTemplate: "Run", targetInstanceId: "instance_1" }] }) };
    const scheduler = new StoryScheduler(state as any, stories as any, store, async () => new Response(JSON.stringify({
      error: { code: "INSTANCE_OFFLINE", message: "Target instance is offline." },
    }), { status: 503, headers: { "content-type": "application/json" } }), async () => "http://instance");
    scheduler.start();
    const automation = scheduler.create({
      storyId: "story_1", actionId: "action_1", schedule: { scheduleKind: "interval", intervalMs: 60_000 }, enabled: false,
      policy: { maxConcurrentRuns: 1, whenBusy: "skip" },
    }).automation;
    const run = scheduler.manualRun(automation.id, { clientRequestId: "offline" });

    await waitFor(() => store.run(run.id)?.status === "failed");
    assert.deepEqual(store.run(run.id)?.error, { code: "INSTANCE_OFFLINE", message: "Target instance is offline." });
    scheduler.stop();
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
