import assert from "node:assert/strict";
import test from "node:test";
import { proxyStateProjectionSignature } from "../src/control-plane/proxy/state-projection.ts";

const projection = (overrides = {}) => ({
  nodeId: "node_a",
  status: "online",
  health: "ok",
  lastSeenAt: "2026-10-14T17:18:28.744Z",
  connectionPhase: null,
  connectionDiagnostics: null,
  proxyState: {
    reachability: "reachable",
    bindingStatus: "active",
    bindingRevision: 1,
    streamId: "proxy_events_node_a",
    revision: 814132,
    observedAt: "2026-10-14T19:04:44.513Z",
    target: { id: "node_a", name: "MacMini", status: "online", health: "ok", lastSeenAt: "2026-10-14T17:18:28.744Z" },
    updatedAt: "2026-10-14T19:04:44.600Z",
  },
  ...overrides,
});

test("proxy stream cursors do not count as a state change", () => {
  const first = proxyStateProjectionSignature(projection());
  const advancedCursor = proxyStateProjectionSignature(projection({
    proxyState: { ...projection().proxyState, revision: 814133, observedAt: "2026-10-14T19:04:45.513Z", updatedAt: "2026-10-14T19:04:45.600Z" },
  }));
  assert.equal(advancedCursor, first);
});

test("every semantic proxy or node change still notifies subscribers", () => {
  const first = proxyStateProjectionSignature(projection());
  const changes = [
    projection({ status: "degraded" }),
    projection({ health: "degraded" }),
    projection({ lastSeenAt: "2026-10-14T17:19:28.744Z" }),
    projection({ connectionPhase: "reconnecting" }),
    projection({ proxyState: { ...projection().proxyState, reachability: "unreachable" } }),
    projection({ proxyState: { ...projection().proxyState, bindingStatus: "revoked" } }),
    projection({ proxyState: { ...projection().proxyState, streamId: "proxy_events_node_a_restarted" } }),
    projection({ proxyState: { ...projection().proxyState, target: { ...projection().proxyState.target, health: "failed" } } }),
  ];
  for (const change of changes) assert.notEqual(proxyStateProjectionSignature(change), first);
});

test("a node without proxy state keeps the plain projection identity", () => {
  const withoutProxy = projection({ proxyState: null });
  assert.equal(proxyStateProjectionSignature(withoutProxy), JSON.stringify(withoutProxy));
  assert.notEqual(proxyStateProjectionSignature(withoutProxy), proxyStateProjectionSignature(projection()));
});
