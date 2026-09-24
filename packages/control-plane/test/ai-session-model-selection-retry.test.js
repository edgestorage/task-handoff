import assert from "node:assert/strict";
import test from "node:test";
import { AiSessionActionService } from "../src/control-plane/sessions/ai-session-actions.ts";

function instanceFor(session) {
  return {
    id: "inst_models",
    nodeId: "node_models",
    config: {},
    capabilities: {
      features: {
        aiSessionProviders: [{
          agent: "codex",
          actions: { send: true },
          timeline: { sessionRead: true, turnRead: true, liveItems: true },
          modelSelection: { selectModelAtCreate: true, switchModelWithinProvider: true, switchProviderDuringSession: true },
        }],
      },
    },
    aiSessions: { sessions: [session] },
  };
}

const session = { id: "ais_switch", agent: "codex", status: "idle", actions: { send: true }, modelSelection: { modelEntityId: "mdl_a", modelName: "model-a" } };
const target = { modelEntityId: "mdl_b", modelName: "model-b" };

function staleCatalogError() {
  return Object.assign(new Error("The selected model is not available in this instance runtime."), {
    code: "AI_SESSION_MODEL_TARGET_UNAVAILABLE",
    statusCode: 409,
  });
}

test("a switch rejected for a stale instance catalog re-pushes the assignment and retries once", async () => {
  const instance = instanceFor(session);
  const requests = [];
  const syncs = [];
  const service = new AiSessionActionService({
    requireInstance: async () => instance,
    requireRuntime: async () => ({}),
    syncInstanceModels: async (instanceId) => { syncs.push(instanceId); },
    request: async (_instance, route, init) => {
      requests.push({ route, body: JSON.parse(String(init?.body || "{}")) });
      if (requests.length === 1) throw staleCatalogError();
      return { sessionId: session.id, accepted: true };
    },
  });

  assert.deepEqual(await service.updateModelSelection(instance.id, session.id, "switch-request", target), { sessionId: session.id, accepted: true });
  assert.deepEqual(syncs, [instance.id]);
  assert.deepEqual(requests.map((entry) => entry.route), ["/ai-sessions/ais_switch/model-selection", "/ai-sessions/ais_switch/model-selection"]);
  assert.deepEqual(requests[0].body, requests[1].body);
});

test("a retry that still fails surfaces the instance error instead of looping", async () => {
  const instance = instanceFor(session);
  const syncs = [];
  let calls = 0;
  const service = new AiSessionActionService({
    requireInstance: async () => instance,
    requireRuntime: async () => ({}),
    syncInstanceModels: async (instanceId) => { syncs.push(instanceId); },
    request: async () => { calls += 1; throw staleCatalogError(); },
  });

  await assert.rejects(
    service.updateModelSelection(instance.id, session.id, "switch-request", target),
    (error) => error.code === "AI_SESSION_MODEL_TARGET_UNAVAILABLE",
  );
  assert.equal(calls, 2);
  assert.deepEqual(syncs, [instance.id]);
});

test("switch failures unrelated to the instance catalog are not retried", async () => {
  const instance = instanceFor(session);
  const syncs = [];
  let calls = 0;
  const service = new AiSessionActionService({
    requireInstance: async () => instance,
    requireRuntime: async () => ({}),
    syncInstanceModels: async (instanceId) => { syncs.push(instanceId); },
    request: async () => {
      calls += 1;
      throw Object.assign(new Error("The model cannot be changed while a turn is active."), {
        code: "AI_SESSION_MODEL_SELECTION_CONFLICT",
        statusCode: 409,
      });
    },
  });

  await assert.rejects(
    service.updateModelSelection(instance.id, session.id, "switch-request", target),
    (error) => error.code === "AI_SESSION_MODEL_SELECTION_CONFLICT",
  );
  assert.equal(calls, 1);
  assert.deepEqual(syncs, []);
});
