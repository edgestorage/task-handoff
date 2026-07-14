const assert = require("node:assert/strict");
const test = require("node:test");

const { eventTopic } = require("../packages/protocol/src/events.ts");
const {
  TriggerSourceSchema,
  TriggerTargetSchema,
  triggerConfigHash,
} = require("../packages/protocol/src/triggers.ts");
const { TriggerExecutor } = require("../packages/controlled-instance/src/triggers/executor.ts");
const { sanitizeStoredTriggerIndex } = require("../packages/controlled-instance/src/triggers/store.ts");

test("trigger config hash ignores display fields and object order", () => {
  const first = triggerConfigHash({
    source: { type: "schedule", intervalMs: 1000 },
    action: { promptTemplate: "Hello" },
    policy: { maxConcurrentRuns: 1, whenBusy: "skip" },
  });
  const second = triggerConfigHash({
    policy: { whenBusy: "skip", maxConcurrentRuns: 1 },
    action: { promptTemplate: "Hello" },
    source: { intervalMs: 1000, type: "schedule" },
  });
  assert.equal(first, second);
});

test("trigger config hash changes when behavior changes", () => {
  const first = triggerConfigHash({
    source: { type: "schedule", intervalMs: 1000 },
    action: { promptTemplate: "Hello" },
    policy: { maxConcurrentRuns: 1, whenBusy: "skip" },
  });
  const second = triggerConfigHash({
    source: { type: "schedule", intervalMs: 2000 },
    action: { promptTemplate: "Hello" },
    policy: { maxConcurrentRuns: 1, whenBusy: "skip" },
  });
  assert.notEqual(first, second);
});

test("trigger events use triggers topic", () => {
  assert.equal(eventTopic("trigger.run.completed"), "triggers");
});

test("trigger protocol only accepts strict AI session targets", () => {
  assert.deepEqual(TriggerTargetSchema.parse({ type: "ai-session", aiSessionId: "ai_1" }), {
    type: "ai-session",
    aiSessionId: "ai_1",
  });
  assert.equal(TriggerTargetSchema.safeParse({ type: "conversation", conversationId: 1 }).success, false);
  assert.equal(TriggerTargetSchema.safeParse({ type: "ai-session", aiSessionId: "ai_1", conversationId: 1 }).success, false);
});

test("AI session trigger sources reject legacy conversation filters", () => {
  assert.equal(TriggerSourceSchema.safeParse({ type: "ai-session", agent: "codex" }).success, true);
  assert.equal(TriggerSourceSchema.safeParse({ type: "ai-session", conversationId: 1 }).success, false);
});

test("stored trigger indexes retain valid AI session entries and remove conversation history", () => {
  const timestamp = "2026-07-14T00:00:00.000Z";
  const configHash = "trg_abcdefgh";
  const warnings = [];
  const index = sanitizeStoredTriggerIndex({
    schemaVersion: 1,
    futureIndexField: true,
    configs: [{
      configHash,
      name: "AI session trigger",
      source: { type: "ai-session", agent: "codex", conversationId: 7, futureSourceField: true },
      action: { promptTemplate: "Continue", futureActionField: true },
      policy: { maxConcurrentRuns: 1, whenBusy: "skip", futurePolicyField: true },
      createdAt: timestamp,
      updatedAt: timestamp,
      futureConfigField: true,
    }],
    deployments: [
      { configHash, deploymentId: "dep_ai", instanceId: "inst_1", target: { type: "ai-session", aiSessionId: "ai_1", futureTargetField: true }, enabled: true, createdAt: timestamp, updatedAt: timestamp, futureDeploymentField: true },
      { configHash, deploymentId: "dep_conversation", instanceId: "inst_1", target: { type: "conversation", conversationId: 7 }, enabled: true, createdAt: timestamp, updatedAt: timestamp },
    ],
    runtime: [
      { configHash, deploymentId: "dep_ai", instanceId: "inst_1", status: "idle", runCount: 1, skippedCount: 0, futureRuntimeField: true },
      { configHash, deploymentId: "dep_conversation", instanceId: "inst_1", status: "idle", runCount: 1, skippedCount: 0 },
    ],
    recentRuns: [
      { id: "run_ai", configHash, deploymentId: "dep_ai", instanceId: "inst_1", eventType: "manual", status: "completed", target: { type: "ai-session", aiSessionId: "ai_1" }, promptPreview: "Continue", startedAt: timestamp, completedAt: timestamp, futureRunField: true },
      { id: "run_conversation", configHash, deploymentId: "dep_conversation", instanceId: "inst_1", eventType: "manual", status: "completed", target: { type: "conversation", conversationId: 7 }, promptPreview: "Continue", startedAt: timestamp, completedAt: timestamp },
    ],
  }, (warning) => warnings.push(warning));

  assert.equal(index.configs.length, 1);
  assert.deepEqual(index.configs[0].source, { type: "ai-session", agent: "codex" });
  assert.deepEqual(index.deployments.map((entry) => entry.deploymentId), ["dep_ai"]);
  assert.deepEqual(index.runtime.map((entry) => entry.deploymentId), ["dep_ai"]);
  assert.deepEqual(index.recentRuns.map((entry) => entry.id), ["run_ai"]);
  assert.ok(warnings.some((warning) => warning.id === "dep_conversation" && warning.reason.includes("conversation")));
  assert.ok(warnings.some((warning) => warning.id === "run_conversation" && warning.reason.includes("conversation")));
  assert.ok(warnings.some((warning) => warning.reason.includes("unknown")));
});

test("trigger executor sends directly to the target AI session", async () => {
  const completed = [];
  const store = {
    startRun: () => ({ id: "run_1" }),
    completeRun: (run, error) => {
      completed.push({ run, error });
      return { ...run, status: error ? "failed" : "completed" };
    },
    deleteDeployment: () => true,
  };
  const sent = [];
  const executor = new TriggerExecutor(store, {
    sendMessage: async (id, message) => {
      sent.push({ id, message });
      return { accepted: true };
    },
  });
  const result = await executor.execute({
    config: { name: "Continue", configHash: "trg_abcdefgh", action: { promptTemplate: "Hello {{event.type}}" } },
    deployment: { configHash: "trg_abcdefgh", target: { type: "ai-session", aiSessionId: "ai_1" } },
    eventType: "manual",
  });
  assert.deepEqual(sent, [{ id: "ai_1", message: { message: "Hello manual" } }]);
  assert.equal(result.run.status, "completed");
  assert.equal(completed.length, 1);
});

test("trigger executor removes a deployment when its AI session no longer exists", async () => {
  const removed = [];
  const store = {
    startRun: () => ({ id: "run_missing" }),
    completeRun: (run, error) => ({ ...run, status: error ? "failed" : "completed" }),
    deleteDeployment: (configHash, deploymentId) => removed.push({ configHash, deploymentId }),
  };
  const missing = Object.assign(new Error("AI session not found"), { code: "AI_SESSION_NOT_FOUND" });
  const executor = new TriggerExecutor(store, { sendMessage: async () => { throw missing; } });
  await assert.rejects(() => executor.execute({
    config: { name: "Continue", configHash: "trg_abcdefgh", action: { promptTemplate: "Hello" } },
    deployment: { configHash: "trg_abcdefgh", deploymentId: "dep_missing", target: { type: "ai-session", aiSessionId: "ai_missing" } },
    eventType: "manual",
  }), /AI session not found/);
  assert.deepEqual(removed, [{ configHash: "trg_abcdefgh", deploymentId: "dep_missing" }]);
});
