const assert = require("node:assert/strict");
const test = require("node:test");

const { syncAssignedModelEnvironment } = require("../packages/control-plane/src/node-agent/app.ts");

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

  assert.equal(synced, true);
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].message, "node instance model catalog live sync deferred");
  assert.equal(warnings[0].data.statusCode, 400);
  assert.deepEqual(warnings[0].data.assignedModelEntityIds, ["mdl_fresh"]);
  assert.deepEqual(warnings[0].data.instanceModelEntityIds, ["mdl_stale"]);
  assert.equal(warnings[0].data.instanceModelCatalogSource, "private-config-file");
  assert.equal(JSON.stringify(warnings).includes("secret"), false);
});

test("instances without the private catalog route are left on the environment sync", async () => {
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

  assert.equal(synced, true);
  assert.equal(warnings.length, 0);
  assert.equal(diagnosticReads, 0);
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
