import assert from "node:assert/strict";
import test from "node:test";
import { NodeStateProjectionEventSchema } from "../src/control-plane.ts";

test("node state projection carries only public target connection state", () => {
  const parsed = NodeStateProjectionEventSchema.parse({
    nodeId: "node_target",
    status: "online",
    health: "ok",
    lastSeenAt: "2026-08-25T06:00:00.000Z",
    connectionPhase: "healthy",
    connectionDiagnostics: { consecutiveReconnects: 0, pingRttMs: 12 },
    proxyState: null,
  });
  assert.equal(parsed.nodeId, "node_target");
  assert.equal(parsed.connectionDiagnostics.pingRttMs, 12);
  assert.throws(() => NodeStateProjectionEventSchema.parse({
    ...parsed,
    auth: { secret: "must-not-cross-the-event-boundary" },
  }));
});
