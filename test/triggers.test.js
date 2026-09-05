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
  ControlPlaneAiSessionTriggerBoundEventSchema,
  ControlPlaneAiSessionTriggerUnboundEventSchema,
  TriggerSourceSchema,
  TriggerTargetSchema,
  triggerConfigHash,
} = require("../packages/protocol/src/triggers.ts");
const { TriggerExecutor } = require("../packages/controlled-instance/src/triggers/executor.ts");
const { fileTriggerMatcher, nextScheduleTime } = require("../packages/controlled-instance/src/triggers/manager.ts");
const { SchedulerExecutionRuntime, nextSchedulerTime, schedulerExecutionKey } = require("../packages/core/src/core/scheduler-runtime.ts");
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

test("shared scheduler preserves interval anchors and skips repeated DST wall time", () => {
  const anchor = new Date("2026-01-01T00:00:00.000Z");
  assert.equal(
    nextSchedulerTime({ type: "interval", intervalMs: 60_000 }, new Date("2026-01-01T00:03:12.000Z"), anchor).toISOString(),
    "2026-01-01T00:04:00.000Z",
  );
  const firstFallBack = nextSchedulerTime(
    { type: "daily", timeOfDay: "01:30", timezone: "America/New_York" },
    new Date("2026-11-01T04:00:00.000Z"),
  );
  assert.equal(firstFallBack.toISOString(), "2026-11-01T05:30:00.000Z");
  assert.equal(
    nextSchedulerTime(
      { type: "daily", timeOfDay: "01:30", timezone: "America/New_York" },
      firstFallBack,
    ).toISOString(),
    "2026-11-02T06:30:00.000Z",
  );
});

test("shared scheduler enforces concurrency and drains queued events in FIFO order", async () => {
  const started = [];
  const resolvers = [];
  const runtime = new SchedulerExecutionRuntime({
    execute: (event) => new Promise((resolve) => {
      started.push(event);
      resolvers.push(resolve);
    }),
    skipped: () => assert.fail("event should not be skipped"),
  });
  const policy = { maxConcurrentRuns: 2, whenBusy: "queue" };
  for (const event of [1, 2, 3, 4]) runtime.submit("job", event, policy);
  assert.deepEqual(started, [1, 2]);
  resolvers.shift()();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(started, [1, 2, 3]);
  resolvers.shift()();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(started, [1, 2, 3, 4]);
  resolvers.forEach((resolve) => resolve());
});

test("shared scheduler reports cooldown, queue-full, stop, and isolates failures", async () => {
  let now = 1_000;
  const started = [];
  const skipped = [];
  const resolvers = [];
  const runtime = new SchedulerExecutionRuntime({
    execute: (event) => {
      started.push(event);
      if (event === "failure") return Promise.reject(new Error("expected"));
      return new Promise((resolve) => resolvers.push(resolve));
    },
    skipped: (event, reason) => skipped.push([event, reason]),
  }, 2, () => now);
  runtime.submit("cooldown", "first", { cooldownMs: 100, maxConcurrentRuns: 1, whenBusy: "skip" });
  runtime.submit("cooldown", "second", { cooldownMs: 100, maxConcurrentRuns: 1, whenBusy: "skip" });
  assert.deepEqual(skipped, [["second", "cooldown"]]);

  runtime.submit("queue", "active", { maxConcurrentRuns: 1, whenBusy: "queue" });
  runtime.submit("queue", "queued-1", { maxConcurrentRuns: 1, whenBusy: "queue" });
  runtime.submit("queue", "queued-2", { maxConcurrentRuns: 1, whenBusy: "queue" });
  runtime.submit("queue", "overflow", { maxConcurrentRuns: 1, whenBusy: "queue" });
  assert.deepEqual(skipped.at(-1), ["overflow", "queue-full"]);
  runtime.stop();
  assert.deepEqual(skipped.slice(-3), [
    ["overflow", "queue-full"],
    ["queued-1", "scheduler-stopped"],
    ["queued-2", "scheduler-stopped"],
  ]);

  resolvers.forEach((resolve) => resolve());
  await new Promise((resolve) => setImmediate(resolve));
  runtime.start();
  runtime.submit("failure", "failure", { maxConcurrentRuns: 1, whenBusy: "skip" });
  runtime.submit("other", "other", { maxConcurrentRuns: 1, whenBusy: "skip" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(started.includes("other"), true);
  assert.equal(schedulerExecutionKey("job", "schedule", "2026-01-01T00:00:00.000Z"), schedulerExecutionKey("job", "schedule", "2026-01-01T00:00:00.000Z"));
  resolvers.forEach((resolve) => resolve());
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

test("applying a trigger fans out across instances without serial blocking", async () => {
  const records = new Map();
  const collection = {
    list: () => [...records.values()],
    get: (id) => records.get(id),
    put: (record) => { records.set(record.id, record); return record; },
    delete: (id) => records.delete(id),
  };
  const pending = [];
  const started = [];
  const service = new ControlPlaneTriggerService({
    triggers: collection,
    listInstances: async () => [],
    requireInstance: async (id) => ({ id, name: id }),
    instanceRequest: async (instance) => new Promise((resolve) => {
      started.push(instance.id);
      pending.push(() => resolve({ ok: true }));
    }),
  });
  const trigger = service.createTrigger({
    name: "Concurrent",
    source: { type: "schedule", scheduleKind: "interval", intervalMs: 60_000 },
    action: { promptTemplate: "Continue" },
  });

  const applying = service.applyTrigger(trigger.configHash, {
    instanceIds: ["inst_1", "inst_2", "inst_3"],
    target: { type: "ai-session", aiSessionId: "session_1" },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(started, ["inst_1", "inst_2", "inst_3"]);
  pending.forEach((resolve) => resolve());
  const result = await applying;
  assert.deepEqual(result.results.map((entry) => entry.instanceId), ["inst_1", "inst_2", "inst_3"]);
});

test("trigger fan-out stops scheduling after failure and waits for active mutations", async () => {
  const records = new Map();
  const collection = {
    list: () => [...records.values()],
    get: (id) => records.get(id),
    put: (record) => { records.set(record.id, record); return record; },
    delete: (id) => records.delete(id),
  };
  const started = [];
  const activeResolvers = [];
  const failure = Object.assign(new Error("deployment failed"), { code: "DEPLOYMENT_FAILED" });
  const service = new ControlPlaneTriggerService({
    triggers: collection,
    listInstances: async () => [],
    requireInstance: async (id) => ({ id, name: id }),
    instanceRequest: async (instance) => {
      started.push(instance.id);
      if (instance.id === "inst_1") throw failure;
      return new Promise((resolve) => activeResolvers.push(resolve));
    },
  });
  const trigger = service.createTrigger({
    name: "Concurrent failure",
    source: { type: "schedule", scheduleKind: "interval", intervalMs: 60_000 },
    action: { promptTemplate: "Continue" },
  });
  let settled = false;
  const applying = service.applyTrigger(trigger.configHash, {
    instanceIds: Array.from({ length: 10 }, (_, index) => `inst_${index + 1}`),
    target: { type: "ai-session", aiSessionId: "session_1" },
  }).finally(() => { settled = true; });

  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(started, Array.from({ length: 8 }, (_, index) => `inst_${index + 1}`));
  assert.equal(settled, false);
  activeResolvers.forEach((resolve) => resolve({ ok: true }));
  await assert.rejects(applying, (error) => error === failure);
  assert.equal(settled, true);
  assert.equal(started.includes("inst_9"), false);
  assert.equal(started.includes("inst_10"), false);
});

test("trigger deletion mutates ready instances and reports unavailable nodes", async () => {
  const records = new Map();
  const collection = {
    list: () => [...records.values()],
    get: (id) => records.get(id),
    put: (record) => { records.set(record.id, record); return record; },
    delete: (id) => records.delete(id),
  };
  let trigger;
  const requests = [];
  const service = new ControlPlaneTriggerService({
    triggers: collection,
    listInstances: async () => [],
    listMutationInstances: async () => ({
      items: [{
        id: "inst_online",
        name: "Online instance",
        nodeId: "node_online",
        triggers: { configs: [{
          configHash: trigger.configHash,
          deployments: [{
            configHash: trigger.configHash,
            deploymentId: "deployment_online",
            origin: "control-plane",
            enabled: true,
            target: { type: "ai-session", aiSessionId: "session_online" },
          }],
        }] },
      }],
      partialFailures: [{
        scope: "node",
        nodeId: "node_offline",
        code: "ECONNREFUSED",
        message: "Node node_offline is offline; trigger deployment changes were skipped.",
      }],
    }),
    requireInstance: async () => { throw new Error("unused"); },
    instanceRequest: async (instance, route) => { requests.push({ instanceId: instance.id, route }); return { deleted: true }; },
  });
  trigger = service.createTrigger({
    name: "Best effort template",
    source: { type: "schedule", scheduleKind: "interval", intervalMs: 60_000 },
    action: { promptTemplate: "Continue" },
  });

  const result = await service.deleteTrigger(trigger.configHash);
  assert.equal(records.has(trigger.configHash), false);
  assert.deepEqual(requests, [{
    instanceId: "inst_online",
    route: `/triggers/${trigger.configHash}/deployments/deployment_online`,
  }]);
  assert.equal(result.results[0].deleted, true);
  assert.deepEqual(result.partialFailures, [{
    scope: "node",
    nodeId: "node_offline",
    code: "ECONNREFUSED",
    message: "Node node_offline is offline; trigger deployment changes were skipped.",
  }]);
});

test("trigger editing continues after an instance mutation fails", async () => {
  const records = new Map();
  const collection = {
    list: () => [...records.values()],
    get: (id) => records.get(id),
    put: (record) => { records.set(record.id, record); return record; },
    delete: (id) => records.delete(id),
  };
  let trigger;
  const requests = [];
  const instances = ["inst_failed", "inst_ready"].map((id) => ({
    id,
    name: id,
    nodeId: `node_${id}`,
    triggers: { configs: [{
      configHash: "pending",
      deployments: [{
        configHash: "pending",
        deploymentId: `deployment_${id}`,
        origin: "control-plane",
        enabled: true,
        target: { type: "ai-session", aiSessionId: `session_${id}` },
      }],
    }] },
  }));
  const service = new ControlPlaneTriggerService({
    triggers: collection,
    listInstances: async () => [],
    listMutationInstances: async () => ({ items: instances, partialFailures: [] }),
    requireInstance: async () => { throw new Error("unused"); },
    instanceRequest: async (instance, route) => {
      requests.push({ instanceId: instance.id, route });
      if (instance.id === "inst_failed") throw Object.assign(new Error("instance offline"), { code: "ECONNREFUSED" });
      return { ok: true };
    },
  });
  trigger = service.createTrigger({
    name: "Best effort edit",
    source: { type: "schedule", scheduleKind: "interval", intervalMs: 60_000 },
    action: { promptTemplate: "Continue" },
  });
  for (const instance of instances) {
    instance.triggers.configs[0].configHash = trigger.configHash;
    instance.triggers.configs[0].deployments[0].configHash = trigger.configHash;
  }

  const result = await service.updateTrigger(trigger.configHash, {
    name: "Best effort edit",
    source: { type: "schedule", scheduleKind: "interval", intervalMs: 120_000 },
    action: { promptTemplate: "Continue" },
  });

  assert.equal(result.partialFailures.length, 1);
  assert.deepEqual(result.partialFailures[0], {
    scope: "instance",
    nodeId: "node_inst_failed",
    instanceId: "inst_failed",
    code: "ECONNREFUSED",
    message: "instance offline",
  });
  assert.equal(requests.some((entry) => entry.instanceId === "inst_ready" && entry.route === "/triggers"), true);
  assert.equal(requests.some((entry) => entry.instanceId === "inst_ready" && entry.route.includes("/deployments/")), true);
  assert.equal(records.has(trigger.configHash), false);
  assert.equal(records.has(result.trigger.configHash), true);
});

test("trigger migration runs instances concurrently but preserves create-before-delete per deployment", async () => {
  const records = new Map();
  const collection = {
    list: () => [...records.values()],
    get: (id) => records.get(id),
    put: (record) => { records.set(record.id, record); return record; },
    delete: (id) => records.delete(id),
  };
  const calls = [];
  const pendingCreates = [];
  let created;
  const service = new ControlPlaneTriggerService({
    triggers: collection,
    listInstances: async () => ["inst_1", "inst_2"].map((id) => ({
      id,
      name: id,
      triggers: { configs: [{
        configHash: created.configHash,
        deployments: [{
          configHash: created.configHash,
          deploymentId: `deployment_${id}`,
          origin: "control-plane",
          enabled: true,
          target: { type: "ai-session", aiSessionId: `session_${id}` },
        }],
      }] },
    })),
    requireInstance: async () => { throw new Error("unused"); },
    instanceRequest: async (instance, route) => {
      calls.push({ instanceId: instance.id, route });
      if (route === "/triggers") return new Promise((resolve) => pendingCreates.push(resolve));
      return { deleted: true };
    },
  });
  created = service.createTrigger({
    name: "Concurrent migration",
    source: { type: "schedule", scheduleKind: "interval", intervalMs: 60_000 },
    action: { promptTemplate: "Continue" },
  });

  const updating = service.updateTrigger(created.configHash, {
    name: "Concurrent migration",
    source: { type: "schedule", scheduleKind: "interval", intervalMs: 120_000 },
    action: { promptTemplate: "Continue" },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls.map((entry) => entry.instanceId), ["inst_1", "inst_2"]);
  assert.ok(calls.every((entry) => entry.route === "/triggers"));
  pendingCreates.forEach((resolve) => resolve({ created: true }));
  await updating;
  for (const instanceId of ["inst_1", "inst_2"]) {
    const routes = calls.filter((entry) => entry.instanceId === instanceId).map((entry) => entry.route);
    assert.equal(routes[0], "/triggers");
    assert.match(routes[1], /\/deployments\/deployment_/);
  }
});

test("trigger events use triggers topic", () => {
  assert.equal(eventTopic("trigger.run.completed"), "triggers");
});

test("trigger deployment event schemas accept v0.0.23 bound and current unbound payloads", () => {
  assert.deepEqual(ControlPlaneAiSessionTriggerBoundEventSchema.parse({
    instanceId: "inst_1",
    sessionId: "ais_1",
  }), {
    instanceId: "inst_1",
    sessionId: "ais_1",
  });
  assert.deepEqual(ControlPlaneAiSessionTriggerUnboundEventSchema.parse({
    instanceId: "inst_1",
    sessionId: "ais_1",
    configHash: "trg_abcdefgh",
  }), {
    instanceId: "inst_1",
    sessionId: "ais_1",
    configHash: "trg_abcdefgh",
  });
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
