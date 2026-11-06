import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import { QueryClient, QueryObserver } from "@tanstack/vue-query";
import { controlPlaneQueryKeys as keys } from "../src/api/queryKeys.ts";
import { applyNodeStateProjection } from "../src/apps/control-plane/instanceLifecycleCache.ts";
import { storyNodeLoadState } from "../src/apps/control-plane/story/storyNodeLoad.ts";

const nodeId = "node_target";
const unavailable = { stories: [], unavailableNodeIds: [nodeId] };
const ready = { stories: [{ id: "story_target", ownerNodeId: nodeId }], unavailableNodeIds: [] };
const projection = (overrides = {}) => ({
  nodeId,
  connectionEnabled: true,
  status: "online",
  health: "ok",
  connectionPhase: "healthy",
  lastSeenAt: null,
  connectionDiagnostics: null,
  proxyState: null,
  ...overrides,
});

function setup(t, node = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { gcTime: Infinity, retry: false } } });
  client.setQueryData(keys.nodes, [{ id: nodeId, status: "offline", connectionEnabled: true, ...node }]);
  t.after(() => client.clear());
  return client;
}

function observe(t, client, queryKey, queryFn, options = {}) {
  const observer = new QueryObserver(client, { queryKey, queryFn, staleTime: Infinity, ...options });
  const unsubscribe = observer.subscribe(() => {});
  t.after(unsubscribe);
  return observer;
}

test("an online node event recovers the unavailable Story snapshot without a page reload", async (t) => {
  const client = setup(t);
  let requests = 0;
  observe(t, client, keys.stories(nodeId), async () => { requests += 1; return ready; }, { initialData: unavailable });
  assert.equal(storyNodeLoadState(nodeId, { data: client.getQueryData(keys.stories(nodeId)), isError: false }), "unavailable");

  applyNodeStateProjection(client, projection());
  await setImmediate();

  assert.equal(requests, 1, "node recovery must read a new authoritative Story snapshot");
  assert.deepEqual(client.getQueryData(keys.stories(nodeId)), ready);
  assert.equal(storyNodeLoadState(nodeId, { data: client.getQueryData(keys.stories(nodeId)), isError: false }), "ready");
  applyNodeStateProjection(client, projection({ connectionDiagnostics: { consecutiveReconnects: 0, pingRttMs: 12 } }));
  await setImmediate();
  assert.equal(requests, 1, "healthy diagnostic events must not repeatedly refetch Story data");
});

test("recovery includes failed decisions and retained Story data while isolating other nodes", async (t) => {
  const client = setup(t);
  const requests = [];
  const decisionKey = keys.storyDecisions(nodeId, "story_target");
  let decisionsOnline = false;
  observe(t, client, decisionKey, async () => {
    requests.push("decisions");
    if (!decisionsOnline) throw new Error("Node offline");
    return { decisions: [{ id: "decision_target" }] };
  });
  observe(t, client, keys.stories(nodeId), async () => { requests.push("stories"); return ready; }, { initialData: ready });
  observe(t, client, keys.stories(), async () => { requests.push("aggregate"); return ready; }, { initialData: unavailable });
  observe(t, client, keys.stories("node_other"), async () => { requests.push("other"); return ready; }, { initialData: ready });
  observe(t, client, keys.storyDecisions("node_other", "story_other"), async () => { requests.push("other-decisions"); return {}; }, { initialData: {} });
  await setImmediate();
  assert.equal(client.getQueryState(decisionKey).status, "error");
  requests.length = 0;
  decisionsOnline = true;

  applyNodeStateProjection(client, projection());
  await setImmediate();

  assert.deepEqual(requests.sort(), ["aggregate", "decisions", "stories"]);
  assert.equal(client.getQueryState(decisionKey).status, "success");
  assert.equal(client.getQueryState(keys.nodes).isInvalidated, false);
});

test("inactive snapshots become stale and disabled snapshots do not request until enabled", async (t) => {
  const client = setup(t);
  client.setQueryData(keys.stories(nodeId), unavailable);
  let requests = 0;
  const observer = observe(t, client, keys.storyDecisions(nodeId, "story_target"), async () => {
    requests += 1;
    return { decisions: [] };
  }, { enabled: false, initialData: { decisions: [] } });

  applyNodeStateProjection(client, projection());
  await setImmediate();

  assert.equal(client.getQueryState(keys.stories(nodeId)).isInvalidated, true);
  assert.equal(client.getQueryState(keys.storyDecisions(nodeId, "story_target")).isInvalidated, true);
  assert.equal(requests, 0);
  observer.setOptions({ ...observer.options, enabled: true });
  await setImmediate();
  assert.equal(requests, 1);
});

test("pausing and resuming consumes the authoritative connection switch", async (t) => {
  const client = setup(t, { status: "online" });
  let requests = 0;
  observe(t, client, keys.stories(nodeId), async () => { requests += 1; return ready; }, { initialData: unavailable });
  applyNodeStateProjection(client, projection({ connectionEnabled: false, status: "offline" }));
  await setImmediate();
  assert.equal(client.getQueryData(keys.nodes)[0].connectionEnabled, false);
  assert.equal(requests, 0, "an unavailable node must not trigger recovery requests");

  applyNodeStateProjection(client, projection());
  await setImmediate();
  assert.equal(client.getQueryData(keys.nodes)[0].connectionEnabled, true);
  assert.equal(requests, 1);
});

test("older producers omitting the connection switch preserve the known configuration", async (t) => {
  const client = setup(t, { connectionEnabled: false });
  client.setQueryData(keys.stories(nodeId), unavailable);
  const event = projection();
  delete event.connectionEnabled;
  applyNodeStateProjection(client, event);
  await setImmediate();
  assert.equal(client.getQueryData(keys.nodes)[0].connectionEnabled, false);
  assert.equal(client.getQueryState(keys.stories(nodeId)).isInvalidated, false);
});

test("an initial request started offline cannot overwrite recovery when it finishes late", async (t) => {
  const client = setup(t);
  let finishOfflineRequest;
  const pending = new Promise((resolve) => { finishOfflineRequest = resolve; });
  let requests = 0;
  observe(t, client, keys.stories(nodeId), () => {
    requests += 1;
    return requests === 1 ? pending : Promise.resolve(ready);
  });
  assert.equal(requests, 1);

  applyNodeStateProjection(client, projection());
  await setImmediate();
  assert.equal(requests, 2, "recovery must restart even an initial request without cached data");
  assert.deepEqual(client.getQueryData(keys.stories(nodeId)), ready);

  finishOfflineRequest(unavailable);
  await setImmediate();
  assert.deepEqual(client.getQueryData(keys.stories(nodeId)), ready);
});
