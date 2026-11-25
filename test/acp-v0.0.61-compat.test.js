const assert = require("node:assert/strict");
const { execFileSync, fork } = require("node:child_process");
const { once } = require("node:events");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const baseline = process.env.TASK_HANDOFF_TEST_ACP_V0061_CHECKOUT;
const native = ["claude", "codex", "opencode"];
const acp = ["commandcode", "dsh", "gemini"];

async function runtime(t, cwd, version) {
  const child = fork(path.join(__dirname, "fixtures/acp-v0.0.61-runtime.cjs"), [version], {
    cwd,
    execArgv: ["--import", path.join(cwd, "test/setup-isolated-runtime.mjs")],
  });
  const exited = once(child, "exit");
  t.after(async () => {
    if (child.connected) child.send({ operation: "stop" });
    const timeout = setTimeout(() => child.kill(), 3_000);
    try { await exited; } finally { clearTimeout(timeout); }
  });
  const ready = await Promise.race([once(child, "message").then(([message]) => message.ready), exited.then(() => false)]);
  assert.equal(ready, true, `${version} runtime started`);
  let sequence = 0;
  return async (operation, payload) => {
    const id = ++sequence;
    const response = once(child, "message");
    child.send({ id, operation, payload });
    const [message] = await Promise.race([response, exited.then(([code]) => { throw new Error(`${version} runtime exited: ${code}`); })]);
    assert.equal(message.id, id);
    assert.equal(message.error, undefined, message.error);
    return message.result;
  };
}

async function readHistory(runtime, agents) {
  const query = new URLSearchParams({ hierarchy: "subagents", agents });
  const response = await runtime("inject", { method: "GET", url: `/api/ai-sessions/history?${query}` });
  assert.equal(response.statusCode, 200, JSON.stringify(response.body));
  return [query.toString(), response.body];
}

async function waitForRevisionAbove(runtime, revision) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const response = await runtime("inject", { url: "/api/ai-sessions/state" });
    assert.equal(response.statusCode, 200, JSON.stringify(response.body));
    if (response.body.data.revision > revision) return response.body.data;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`AI session snapshot did not advance past revision ${revision}`);
}

test("v0.0.61 and current shared clients interoperate with opposite Node history routes", {
  skip: baseline ? false : "set TASK_HANDOFF_TEST_ACP_V0061_CHECKOUT to the installed v0.0.61 checkout",
  timeout: 30_000,
}, async (t) => {
  const git = (...args) => execFileSync("git", args, { cwd: baseline, encoding: "utf8" }).trim();
  assert.equal(git("rev-parse", "HEAD"), git("rev-parse", "v0.0.61^{commit}"));
  assert.equal(git(
    "status", "--porcelain", "--untracked-files=all", "--",
    "packages/ai-session-runtime", "packages/app-runtime", "packages/control-plane-client",
    "packages/controlled-instance", "packages/protocol",
  ), "");
  const [legacy, current] = await Promise.all([runtime(t, baseline, "legacy"), runtime(t, root, "current")]);
  for (const [server, client, filter] of [
    [current, legacy, "codex,claude,opencode"],
    [legacy, current, "*,codex,claude,opencode"],
    [current, current, "*,codex,claude,opencode"],
  ]) {
    const [query, body] = await readHistory(server, filter);
    const { items } = await client("client-history", { [`?${query}`]: body });
    assert.deepEqual(items.map(({ agent }) => agent).sort(), server === current && client === current ? [...acp, ...native].sort() : native);
    assert.equal(new Set(items.map(({ id }) => id)).size, items.length);
  }
  const statuses = new Map();
  for (const server of [legacy, current]) {
    const { statusCode, body } = await server("inject", { url: "/api/instance/status" });
    assert.equal(statusCode, 200);
    statuses.set(server, body.data);
    const contract = await server("contract");
    assert.equal(body.data.protocolVersion, contract.protocolVersion);
    const capabilities = await (server === legacy ? current : legacy)("parse-capabilities", body.data.capabilities);
    assert.equal(capabilities.features.appRuntime, true);
    assert.equal(capabilities.features.nodeAgentConnectionUpdate, true);
    const providers = capabilities.features.aiSessionProviders.map(({ agent }) => agent);
    assert.ok(native.every((agent) => providers.includes(agent)));
    assert.deepEqual(providers.filter((agent) => acp.includes(agent)).sort(), server === current ? acp : []);
  }
  const legacyContract = await legacy("contract");
  const currentContract = await current("contract");
  assert.equal(currentContract.protocolVersion, legacyContract.protocolVersion, "instance connectivity protocol is unchanged");
  const nativeCapabilities = (server) => Object.fromEntries(
    statuses.get(server).capabilities.features.aiSessionProviders
      .filter(({ agent }) => native.includes(agent))
      .map((provider) => [provider.agent, provider]),
  );
  assert.deepEqual(nativeCapabilities(current), nativeCapabilities(legacy), "native provider behavior is unchanged");

  const futureDocument = {
    ...statuses.get(current).capabilities,
    futureRoot: { ignored: true },
    features: {
      ...statuses.get(current).capabilities.features,
      futureFeature: { ignored: true },
      aiSessionProviders: [
        ...statuses.get(current).capabilities.features.aiSessionProviders,
        {
          agent: "future-agent",
          actions: { create: true, send: true, historyResume: true, futureAction: "ignored" },
          permissionModes: [],
          timeline: { sessionRead: true, turnRead: true, liveItems: true, futureTimelineField: true },
          futureCapability: { ignored: true },
        },
      ],
    },
  };
  for (const client of [legacy, current]) {
    const parsed = await client("parse-capabilities", futureDocument);
    const providers = Object.fromEntries(parsed.features.aiSessionProviders.map((provider) => [provider.agent, provider]));
    for (const agent of native) assert.deepEqual(providers[agent], nativeCapabilities(current)[agent]);
    assert.equal(providers["future-agent"].actions.create, true);
    assert.equal(providers["future-agent"].actions.historyResume, true);
    assert.equal(parsed.features.futureFeature.ignored, true);
  }
  const futureAgent = "future-agent";
  const timestamp = new Date().toISOString();
  await current("seed-history", { agent: futureAgent, timestamp });
  const [futureQuery, futureBody] = await readHistory(current, futureAgent);
  const futureItems = await legacy("client-history", { [`?${futureQuery}`]: futureBody, agents: [futureAgent] });
  assert.deepEqual(futureItems.items.map(({ agent }) => agent), [futureAgent]);

  const original = await current("inject", { url: "/api/ai-sessions?hierarchy=subagents" });
  const { streamId, revision } = original.body.data;
  const sessionId = await current("seed-approval");
  await waitForRevisionAbove(current, revision);
  const query = new URLSearchParams({ streamId, sinceRevision: revision, hierarchy: "subagents" });
  const delta = await current("inject", { url: `/api/ai-sessions?${query}` });
  assert.equal(delta.statusCode, 200, JSON.stringify(delta.body));
  assert.equal(delta.body.data.syncRequired, false, JSON.stringify(delta.body.data));
  const patch = delta.body.data.events.findLast(({ payload }) => payload.upserted?.some(({ id }) => id === sessionId));
  assert.ok(patch, JSON.stringify(delta.body.data));
  const active = patch.payload.upserted.find(({ id }) => id === sessionId);
  assert.deepEqual(active.actions.approvalRequest, { id: "test-request", decisions: ["allow"] });
  const oldPatch = await legacy("parse-patch", patch.payload);
  const oldActive = oldPatch.upserted.find(({ id }) => id === sessionId);
  assert.equal(oldActive.agent, "gemini");
  assert.equal(oldActive.actions.approvalRequest, undefined);
});
