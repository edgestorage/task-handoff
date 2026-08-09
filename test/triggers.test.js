const assert = require("node:assert/strict");
const fs = require("node:fs");
const crypto = require("node:crypto");
const test = require("node:test");
const ts = require("typescript");

require.extensions[".ts"] = (module, filename) => {
  const output = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true, allowSyntheticDefaultImports: true },
    fileName: filename,
  });
  module._compile(output.outputText, filename);
};

const { eventTopic } = require("../packages/protocol/src/events.ts");
const {
  TriggerSourceSchema,
  TriggerTargetSchema,
  triggerConfigHash,
} = require("../packages/protocol/src/triggers.ts");
const { TriggerExecutor } = require("../packages/controlled-instance/src/triggers/executor.ts");
const { fileTriggerMatcher, nextScheduleTime } = require("../packages/controlled-instance/src/triggers/manager.ts");
const { sanitizeStoredTriggerIndex } = require("../packages/controlled-instance/src/triggers/store.ts");
const { ControlPlaneTriggerService } = require("../packages/control-plane/src/control-plane/triggers/service.ts");

test("file trigger globs support root files, recursive directories, and ignores", () => {
  const matches = fileTriggerMatcher(["**/*.ts"], ["generated/**"]);
  assert.equal(matches("index.ts"), true);
  assert.equal(matches("src/index.ts"), true);
  assert.equal(matches("src/deep/index.ts"), true);
  assert.equal(matches("src/index.js"), false);
  assert.equal(matches("generated/index.ts"), false);
  assert.equal(matches("node_modules/pkg/index.ts"), false);
});

test("scheduled trigger calculation observes timezone daylight-saving transitions", () => {
  const next = nextScheduleTime({
    type: "schedule",
    scheduleKind: "daily",
    timeOfDay: "02:30",
    timezone: "America/New_York",
  }, new Date("2026-03-08T06:00:00.000Z"));
  assert.equal(next.toISOString(), "2026-03-08T07:30:00.000Z");

  const weekly = nextScheduleTime({
    type: "schedule",
    scheduleKind: "weekly",
    weekdays: [1],
    timeOfDay: "09:15",
    timezone: "Asia/Shanghai",
  }, new Date("2026-07-19T00:00:00.000Z"));
  assert.equal(weekly.toISOString(), "2026-07-20T01:15:00.000Z");
});

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

test("trigger config hash stays byte-compatible with SHA-256 identities", () => {
  const canonical = JSON.stringify({
    action: { promptTemplate: "Hello" },
    policy: { maxConcurrentRuns: 1, whenBusy: "skip" },
    source: { intervalMs: 1000, type: "schedule" },
  });
  const expected = `trg_${crypto.createHash("sha256").update(canonical).digest("hex").slice(0, 24)}`;
  assert.equal(triggerConfigHash({
    source: { type: "schedule", intervalMs: 1000 },
    action: { promptTemplate: "Hello" },
    policy: { maxConcurrentRuns: 1, whenBusy: "skip" },
  }), expected);
});

test("editing a control-plane trigger replaces its behavior identity", async () => {
  const records = new Map();
  const collection = {
    list: () => [...records.values()],
    get: (id) => records.get(id),
    put: (record) => { records.set(record.id, record); return record; },
    delete: (id) => records.delete(id),
  };
  const requests = [];
  const service = new ControlPlaneTriggerService({
    triggers: collection,
    listInstances: async () => [{
      id: "inst_1",
      name: "Worker",
      triggers: { configs: [] },
    }],
    requireInstance: async () => { throw new Error("unused"); },
    instanceRequest: async (_instance, route, init) => { requests.push({ route, init }); return { ok: true }; },
  });
  const created = service.createTrigger({
    name: "Hourly",
    source: { type: "schedule", scheduleKind: "interval", intervalMs: 3_600_000 },
    action: { promptTemplate: "Continue" },
  });
  const result = await service.updateTrigger(created.configHash, {
    name: "Every two hours",
    source: { type: "schedule", scheduleKind: "interval", intervalMs: 7_200_000 },
    action: { promptTemplate: "Continue" },
  });

  assert.notEqual(result.trigger.configHash, created.configHash);
  assert.equal(records.has(created.configHash), false);
  assert.equal(records.get(result.trigger.configHash).name, "Every two hours");
  assert.deepEqual(requests, []);
});

test("listing control-plane triggers excludes persistence identity from public config", async () => {
  const records = new Map();
  const collection = {
    list: () => [...records.values()],
    get: (id) => records.get(id),
    put: (record) => { records.set(record.id, record); return record; },
    delete: (id) => records.delete(id),
  };
  const service = new ControlPlaneTriggerService({
    triggers: collection,
    listInstances: async () => [],
    requireInstance: async () => { throw new Error("unused"); },
    instanceRequest: async () => { throw new Error("unused"); },
  });
  const created = service.createTrigger({
    name: "Hourly",
    source: { type: "schedule", scheduleKind: "interval", intervalMs: 3_600_000 },
    action: { promptTemplate: "Continue" },
  });

  const result = await service.listTriggers();

  assert.equal(result.triggers.length, 1);
  assert.equal(result.triggers[0].configHash, created.configHash);
  assert.equal(result.triggers[0].config.configHash, created.configHash);
  assert.equal("id" in result.triggers[0].config, false);
});

test("editing a deployed trigger migrates control-plane session deployments", async () => {
  const records = new Map();
  const collection = {
    list: () => [...records.values()],
    get: (id) => records.get(id),
    put: (record) => { records.set(record.id, record); return record; },
    delete: (id) => records.delete(id),
  };
  const requests = [];
  const service = new ControlPlaneTriggerService({
    triggers: collection,
    listInstances: async () => [{
      id: "inst_1",
      name: "Worker",
      triggers: { configs: [{
        configHash: created.configHash,
        deployments: [{
          configHash: created.configHash,
          deploymentId: "old_deployment",
          origin: "control-plane",
          enabled: false,
          target: { type: "ai-session", aiSessionId: "session_1" },
        }],
      }] },
    }],
    requireInstance: async () => { throw new Error("unused"); },
    instanceRequest: async (_instance, route, init) => { requests.push({ route, init }); return { ok: true }; },
  });
  const created = service.createTrigger({
    name: "Hourly",
    source: { type: "schedule", scheduleKind: "interval", intervalMs: 3_600_000 },
    action: { promptTemplate: "Continue" },
  });
  const result = await service.updateTrigger(created.configHash, {
    name: "Hourly",
    source: { type: "schedule", scheduleKind: "interval", intervalMs: 7_200_000 },
    action: { promptTemplate: "Continue" },
  });

  assert.equal(requests.length, 2);
  assert.equal(requests[0].route, "/triggers");
  const replacement = JSON.parse(requests[0].init.body);
  assert.equal(replacement.deployment.enabled, false);
  assert.equal(replacement.deployment.target.aiSessionId, "session_1");
  assert.ok(replacement.deployment.deploymentId.endsWith(result.trigger.configHash));
  assert.equal(requests[1].route, `/triggers/${created.configHash}/deployments/old_deployment`);
  assert.equal(requests[1].init.method, "DELETE");
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

test("trigger executor rejects new work while runtime convergence is draining", async () => {
  let started = 0;
  let sent = 0;
  const executor = new TriggerExecutor({
    startRun: () => { started += 1; return { id: "run_drain" }; },
    completeRun: (run) => run,
    deleteDeployment: () => true,
  }, {
    sendMessage: async () => { sent += 1; },
  });
  const input = {
    config: { name: "Continue", configHash: "trg_abcdefgh", action: { promptTemplate: "Hello" } },
    deployment: { configHash: "trg_abcdefgh", target: { type: "ai-session", aiSessionId: "ai_1" } },
    eventType: "manual",
  };

  executor.beginDrain();
  await assert.rejects(
    () => executor.execute(input),
    (error) => error?.code === "TRIGGER_RUNTIME_DRAINING",
  );
  assert.deepEqual({ started, sent }, { started: 0, sent: 0 });

  executor.endDrain();
  await executor.execute(input);
  assert.deepEqual({ started, sent }, { started: 1, sent: 1 });
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
