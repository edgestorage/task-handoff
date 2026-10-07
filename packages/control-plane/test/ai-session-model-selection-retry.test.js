import assert from "node:assert/strict";
import test from "node:test";
import { AiSessionActionService } from "../src/control-plane/sessions/ai-session-actions.ts";

const CODEX_PROVIDER = {
  agent: "codex",
  actions: { send: true },
  timeline: { sessionRead: true, turnRead: true, liveItems: true },
  modelSelection: {
    selectModelAtCreate: true,
    selectModelAtResume: true,
    switchModelWithinProvider: true,
    switchProviderDuringSession: true,
  },
};

function instanceFor({ sessions = [], runningCount = 0 } = {}) {
  return {
    id: "inst_models",
    nodeId: "node_models",
    config: {},
    capabilities: { features: { aiSessionProviders: [CODEX_PROVIDER] } },
    aiSessions: { sessions, runningCount },
  };
}

const session = { id: "ais_switch", agent: "codex", status: "idle", actions: { send: true }, modelSelection: { modelEntityId: "mdl_a", modelName: "model-a" } };
const target = { modelEntityId: "mdl_b", modelName: "model-b" };

function staleCatalogError() {
  return Object.assign(new Error("The selected model has not taken effect in this running instance."), {
    code: "AI_SESSION_MODEL_TARGET_UNAVAILABLE",
    statusCode: 409,
  });
}

function serviceFor(instance, request, syncs) {
  return new AiSessionActionService({
    requireInstance: async () => instance,
    requireRuntime: async () => ({}),
    syncInstanceModels: async (instanceId) => { syncs.push(instanceId); },
    request,
  });
}

const createInput = {
  agent: "codex",
  cwd: { type: "runtime-path", path: "/workspace" },
  message: "hello",
  clientRequestId: "request-create",
  modelSelection: target,
};

test("a create rejected for a stale instance catalog re-pushes the assignment and retries once", async () => {
  const instance = instanceFor();
  const requests = [];
  const syncs = [];
  const service = serviceFor(instance, async (_instance, route, init) => {
    requests.push({ route, body: JSON.parse(String(init?.body || "{}")) });
    if (requests.length === 1) throw staleCatalogError();
    return { disposition: "created", aiSessionId: "ais_new", providerSessionId: "thread", creationSource: "ai-session" };
  }, syncs);

  const result = await service.create(instance.id, createInput);

  assert.equal(result.aiSessionId, "ais_new");
  assert.deepEqual(syncs, [instance.id]);
  assert.deepEqual(requests.map((entry) => entry.route), ["/ai-sessions", "/ai-sessions"]);
  // The replayed request must stay byte-identical so the instance treats it as
  // the same create rather than a second one.
  assert.deepEqual(requests[0].body, requests[1].body);
});

test("a resume rejected for a stale instance catalog re-pushes the assignment and retries once", async () => {
  const instance = instanceFor();
  const requests = [];
  const syncs = [];
  const service = serviceFor(instance, async (_instance, route, init) => {
    requests.push({ route, body: JSON.parse(String(init?.body || "{}")) });
    if (requests.length === 1) throw staleCatalogError();
    return { disposition: "resumed", aiSessionId: "ais_switch", providerSessionId: "thread", creationSource: "ai-session" };
  }, syncs);

  const result = await service.resume(instance.id, session.id, { modelSelection: target });

  assert.equal(result.disposition, "resumed");
  assert.deepEqual(syncs, [instance.id]);
  assert.deepEqual(requests.map((entry) => entry.route), [`/ai-sessions/${session.id}/resume`, `/ai-sessions/${session.id}/resume`]);
  assert.deepEqual(requests[0].body, requests[1].body);
});

test("a create on an instance that already holds sessions keeps them and surfaces the instance error", async () => {
  const instance = instanceFor({ sessions: [session] });
  const syncs = [];
  let calls = 0;
  const service = serviceFor(instance, async () => {
    calls += 1;
    throw staleCatalogError();
  }, syncs);

  await assert.rejects(
    service.create(instance.id, createInput),
    (error) => error.code === "AI_SESSION_MODEL_TARGET_UNAVAILABLE",
  );
  // Re-pushing would rebuild the shared app-server every bound session runs in.
  assert.equal(calls, 1);
  assert.deepEqual(syncs, []);
});

test("a resume on an instance that holds the session keeps it running and surfaces the instance error", async () => {
  const instance = instanceFor({ sessions: [session], runningCount: 1 });
  const syncs = [];
  let calls = 0;
  const service = serviceFor(instance, async () => {
    calls += 1;
    throw staleCatalogError();
  }, syncs);

  await assert.rejects(
    service.resume(instance.id, session.id, { modelSelection: target }),
    (error) => error.code === "AI_SESSION_MODEL_TARGET_UNAVAILABLE",
  );
  assert.equal(calls, 1);
  assert.deepEqual(syncs, []);
});

test("a switch on a bound session never re-pushes the assignment underneath it", async () => {
  const instance = instanceFor({ sessions: [session] });
  const syncs = [];
  let calls = 0;
  const service = serviceFor(instance, async () => {
    calls += 1;
    throw staleCatalogError();
  }, syncs);

  await assert.rejects(
    service.updateModelSelection(instance.id, session.id, "switch-request", target),
    (error) => error.code === "AI_SESSION_MODEL_TARGET_UNAVAILABLE",
  );
  // A switch always has its own session bound, so the product answer is an
  // instance restart rather than a teardown of the shared app-server.
  assert.equal(calls, 1);
  assert.deepEqual(syncs, []);
});

test("a re-pushed catalog that still rejects the target surfaces the instance error instead of looping", async () => {
  const instance = instanceFor();
  const syncs = [];
  let calls = 0;
  const service = serviceFor(instance, async () => {
    calls += 1;
    throw staleCatalogError();
  }, syncs);

  await assert.rejects(
    service.create(instance.id, createInput),
    (error) => error.code === "AI_SESSION_MODEL_TARGET_UNAVAILABLE",
  );
  assert.equal(calls, 2);
  assert.deepEqual(syncs, [instance.id]);
});

test("failures unrelated to the instance catalog are not retried", async () => {
  const instance = instanceFor();
  const syncs = [];
  let calls = 0;
  const service = serviceFor(instance, async () => {
    calls += 1;
    throw Object.assign(new Error("The model cannot be changed while a turn is active."), {
      code: "AI_SESSION_MODEL_SELECTION_CONFLICT",
      statusCode: 409,
    });
  }, syncs);

  await assert.rejects(
    service.create(instance.id, createInput),
    (error) => error.code === "AI_SESSION_MODEL_SELECTION_CONFLICT",
  );
  assert.equal(calls, 1);
  assert.deepEqual(syncs, []);
});

test("a stale catalog is surfaced as-is when the service cannot re-push the assignment", async () => {
  const instance = instanceFor();
  let calls = 0;
  const service = new AiSessionActionService({
    requireInstance: async () => instance,
    requireRuntime: async () => ({}),
    request: async () => {
      calls += 1;
      throw staleCatalogError();
    },
  });

  await assert.rejects(
    service.create(instance.id, createInput),
    (error) => error.code === "AI_SESSION_MODEL_TARGET_UNAVAILABLE",
  );
  assert.equal(calls, 1);
});
