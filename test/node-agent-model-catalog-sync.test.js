const assert = require("node:assert/strict");
const test = require("node:test");

const { createAssignedModelEnvironmentConvergence, syncAssignedModelEnvironment } = require("../packages/control-plane/src/node-agent/app.ts");

const catalog = {
  protocolVersion: "2026-08-27",
  instanceId: "inst_models",
  entities: [{
    id: "mdl_fresh",
    endpoint: "https://models.example/v1",
    key: "secret",
    protocols: ["openai-responses"],
    modelNames: [{ name: "gpt-5.6-sol", order: 0 }],
  }],
  updatedAt: "2026-09-24T00:00:00.000Z",
};

function instanceState(instance = {}) {
  const materialized = [];
  const resolved = {
    id: "inst_models",
    registrationToken: "registration-token",
    targetStatus: "unreachable",
    connectionStatus: "offline",
    target: { web: "http://127.0.0.1:19999" },
    capabilities: { features: { privateModelCatalog: true } },
    config: { codexSettings: {} },
    ...instance,
  };
  return {
    instance: resolved,
    materialized,
    requireInstance(id) {
      assert.equal(id, resolved.id);
      return resolved;
    },
    resolvedAssignedModelEnvironment: () => ({ TASK_HANDOFF_CODEX_MODEL: "gpt-5.6-sol" }),
    modelRegistry: { privateCatalog: () => catalog },
    instancePrivateConfigs: { materialize: (...args) => materialized.push(args) },
  };
}

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
}

const resolveLocalInstance = async () => "http://127.0.0.1:19999";

test("model catalog is pushed to the instance even while it is not marked reachable", async () => {
  const state = instanceState();
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push(`${init.method || "GET"} ${new URL(String(url)).pathname}`);
    return jsonResponse({ data: { applied: true } });
  };

  const synced = await syncAssignedModelEnvironment(fetchImpl, state, state.instance.id, undefined, resolveLocalInstance);

  assert.equal(synced, true);
  assert.deepEqual(calls, [
    "PUT /api/internal/model-environment",
    "PUT /api/internal/model-catalog",
  ]);
  // Materializing the private config on disk is not the convergence signal; the
  // running instance only accepts models it received through the live push.
  assert.equal(state.materialized.length, 1);
});

test("the live model environment is projected with the current schema", async () => {
  const state = instanceState();
  const openCodeConfig = JSON.stringify({ model: "task-handoff-mdl_fresh/gpt-5.6-sol", provider: {} });
  state.resolvedAssignedModelEnvironment = () => ({
    TASK_HANDOFF_CODEX_MODEL: "gpt-5.6-sol",
    TASK_HANDOFF_OPENCODE_CONFIG_CONTENT: openCodeConfig,
  });
  const bodies = [];
  const fetchImpl = async (url, init = {}) => {
    if (new URL(String(url)).pathname === "/api/internal/model-environment") bodies.push(JSON.parse(String(init.body)));
    return jsonResponse({ data: { applied: true } });
  };

  const synced = await syncAssignedModelEnvironment(fetchImpl, state, state.instance.id, undefined, resolveLocalInstance);

  assert.equal(synced, true);
  // node-agent treats the instance as the same internal version domain: the live
  // push, the materialized private config, and the launch environment all carry
  // the same current-schema environment.
  assert.deepEqual(bodies, [{
    TASK_HANDOFF_CODEX_MODEL: "gpt-5.6-sol",
    TASK_HANDOFF_OPENCODE_CONFIG_CONTENT: openCodeConfig,
  }]);
  assert.equal(state.materialized[0][2].TASK_HANDOFF_OPENCODE_CONFIG_CONTENT, openCodeConfig);
});

test("a failed catalog push reports the snapshot the instance actually holds", async () => {
  const state = instanceState();
  const warnings = [];
  const fetchImpl = async (url, init = {}) => {
    const path = new URL(String(url)).pathname;
    if (path === "/api/internal/model-environment") return jsonResponse({ data: {} });
    if (init.method === "PUT") return jsonResponse({ error: { code: "MANAGED_MODEL_CATALOG_INVALID" } }, 400);
    return jsonResponse({
      data: {
        source: "private-config-file",
        loadedAt: "2026-09-24T01:00:00.000Z",
        catalog: { entities: [{ id: "mdl_stale", protocols: ["openai-responses"], modelNames: [{ name: "old", order: 0 }] }] },
      },
    });
  };

  const synced = await syncAssignedModelEnvironment(
    fetchImpl,
    state,
    state.instance.id,
    (data, message) => warnings.push({ data, message }),
    resolveLocalInstance,
  );

  // The environment reached the instance, but the catalog it resolves models
  // against did not: convergence must stay unclaimed so the caller retries.
  assert.equal(synced, false);
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].message, "node instance model catalog live sync deferred");
  assert.equal(warnings[0].data.statusCode, 400);
  assert.deepEqual(warnings[0].data.assignedModelEntityIds, ["mdl_fresh"]);
  assert.deepEqual(warnings[0].data.instanceModelEntityIds, ["mdl_stale"]);
  assert.equal(warnings[0].data.instanceModelCatalogSource, "private-config-file");
  assert.equal(JSON.stringify(warnings).includes("secret"), false);
});

test("a missing catalog route is reported instead of being read as convergence", async () => {
  const state = instanceState();
  const warnings = [];
  let diagnosticReads = 0;
  const fetchImpl = async (url, init = {}) => {
    const path = new URL(String(url)).pathname;
    if (path === "/api/internal/model-environment") return jsonResponse({ data: {} });
    if (init.method === "PUT") return jsonResponse({ error: { code: "NOT_FOUND" } }, 404);
    diagnosticReads += 1;
    return jsonResponse({ data: {} });
  };

  const synced = await syncAssignedModelEnvironment(
    fetchImpl,
    state,
    state.instance.id,
    (data, message) => warnings.push({ data, message }),
    resolveLocalInstance,
  );

  // The instance and the node agent are one internal version domain, so a
  // missing catalog route is a real failure: it must stay unclaimed and visible.
  assert.equal(synced, false);
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].message, "node instance model catalog live sync deferred");
  assert.equal(warnings[0].data.statusCode, 404);
  assert.equal(diagnosticReads, 1);
});

test("an unreachable instance web endpoint is reported without claiming convergence", async () => {
  const state = instanceState();
  const warnings = [];
  const fetchImpl = async () => {
    throw new Error("connect ECONNREFUSED");
  };

  const synced = await syncAssignedModelEnvironment(
    fetchImpl,
    state,
    state.instance.id,
    (data, message) => warnings.push({ data, message }),
    resolveLocalInstance,
  );

  assert.equal(synced, false);
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].message, "node instance model environment live sync deferred");
  assert.equal(state.materialized.length, 1);
});

test("the live model environment is withheld while sessions are bound to the instance", async () => {
  for (const bound of [{ sessions: [{ id: "s1" }], runningCount: 0 }, { sessions: [], runningCount: 1 }]) {
    const state = instanceState({ aiSessions: bound });
    const warnings = [];
    let requests = 0;
    const fetchImpl = async () => {
      requests += 1;
      return jsonResponse({ data: {} });
    };

    const synced = await syncAssignedModelEnvironment(
      fetchImpl,
      state,
      state.instance.id,
      (data, message) => warnings.push({ data, message }),
      resolveLocalInstance,
    );

    // A model change on a busy instance applies on the next start, never by
    // tearing down the shared app-server other sessions run inside.
    assert.equal(synced, false);
    assert.equal(requests, 0);
    assert.equal(state.materialized.length, 1);
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0].message, "node instance model environment live sync deferred");
    assert.equal(warnings[0].data.reason, "sessions-bound");
  }
});

// The convergence helper heals the startup snapshot a freshly started process
// froze before it declared the capabilities the relay projection needs. It runs
// only for a process this node agent itself replaced, and only while nothing is
// bound to it.
function convergenceHarness(sync, onWarn = () => {}) {
  const converge = createAssignedModelEnvironmentConvergence(sync, onWarn);
  const before = { id: "inst_models", processIncarnationId: "incarnation-1" };
  const after = { ...before, processIncarnationId: "incarnation-2" };
  return { converge, before, after };
}

test("an armed start converges once, on the heartbeat that finds the replaced process idle", async () => {
  const pushed = [];
  const { converge, before, after } = convergenceHarness(async (id) => {
    pushed.push(id);
    return true;
  });

  converge.arm(before);
  // Registration carries no session snapshot, so the idle check waits a beat.
  await converge.converge(after, "register");
  await converge.converge(after, "heartbeat");
  await converge.converge(after, "heartbeat");

  assert.deepEqual(pushed, ["inst_models"]);
});

test("a start that keeps its process incarnation leaves the startup snapshot alone", async () => {
  const pushed = [];
  const { converge, before } = convergenceHarness(async (id) => {
    pushed.push(id);
    return true;
  });

  // No start armed this instance, and a report for the same incarnation means the
  // process was reused rather than restarted.
  await converge.converge(before, "heartbeat");
  converge.arm(before);
  await converge.converge(before, "heartbeat");

  assert.deepEqual(pushed, []);
});

test("a rejected model environment push stays armed for later reports", async () => {
  let attempts = 0;
  const { converge, before, after } = convergenceHarness(async () => {
    attempts += 1;
    return attempts > 1;
  });

  converge.arm(before);
  await converge.converge(after, "heartbeat");
  await converge.converge(after, "heartbeat");
  await converge.converge(after, "heartbeat");

  assert.equal(attempts, 2);
});

test("a model environment convergence failure is reported without claiming convergence", async () => {
  const warnings = [];
  let attempts = 0;
  const { converge, before, after } = convergenceHarness(async () => {
    attempts += 1;
    throw new Error("instance web is unreachable");
  }, (data, message) => warnings.push({ data, message }));

  converge.arm(before);
  await converge.converge(after, "heartbeat");
  await converge.converge(after, "heartbeat");

  assert.equal(attempts, 2);
  assert.equal(warnings.length, 2);
  assert.equal(warnings[0].message, "node instance model environment convergence deferred");
  assert.equal(warnings[0].data.instanceId, "inst_models");
});

test("convergence is abandoned when sessions are already bound to the replaced process", async () => {
  const warnings = [];
  let pushes = 0;
  const { converge, before, after } = convergenceHarness(async () => {
    pushes += 1;
    return true;
  }, (data, message) => warnings.push({ data, message }));
  const bound = { ...after, aiSessions: { sessions: [{ id: "s1" }], runningCount: 1 } };

  converge.arm(before);
  await converge.converge(bound, "heartbeat");
  await converge.converge(bound, "heartbeat");

  assert.equal(pushes, 0);
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].message, "node instance model environment convergence abandoned");
  assert.equal(warnings[0].data.reason, "sessions-bound");
});
