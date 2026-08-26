import assert from "node:assert/strict";
import test from "node:test";

import { AiSessionStatusSchema } from "@task-handoff/protocol/ai-sessions";
import { AiSessionActionService } from "../src/control-plane/sessions/ai-session-actions.ts";

const now = "2026-08-26T00:00:00.000Z";
const legacy = AiSessionStatusSchema.parse({
  id: "session-1",
  agent: "codex",
  status: "idle",
  phase: "unknown",
  startedAt: now,
  updatedAt: now,
  turns: [{
    id: "turn-1",
    status: "completed",
    phase: "responding",
    revision: 2,
    userPrompt: "question",
    lastMessage: "answer",
    startedAt: now,
    updatedAt: now,
  }],
});

function serviceFor(request) {
  return new AiSessionActionService({
    requireInstance: async () => ({ id: "instance-1" }),
    requireRuntime: async () => ({ type: "local" }),
    request,
  });
}

test("v0.0.23 complete detail is projected into split detail, index, and Turn body", async () => {
  const routes = [];
  const service = serviceFor(async (_instance, route) => {
    routes.push(route);
    if (route.endsWith("?projection=index")) {
      return { sessionId: legacy.id, turns: legacy.turns, nextCursor: { turnId: "turn-1", revision: 2 } };
    }
    if (route.endsWith("/turns/turn-1")) {
      throw Object.assign(new Error("Route not found"), { statusCode: 404, code: "ROUTE_NOT_FOUND" });
    }
    return legacy;
  });

  const detail = await service.detail("instance-1", legacy.id);
  assert.equal(detail.kind, "updated");
  assert.equal("turns" in detail.detail, false);
  const index = await service.turnIndex("instance-1", legacy.id);
  assert.deepEqual(index.index.turns.map((turn) => turn.id), ["turn-1"]);
  const body = await service.turnBody("instance-1", legacy.id, "turn-1");
  assert.equal(body.body.turn.lastMessage, "answer");
  assert.ok(routes.filter((route) => route === "/ai-sessions/session-1").length >= 3);
});

test("current single-Turn not-found errors are not hidden by legacy fallback", async () => {
  const expected = Object.assign(new Error("Turn not found"), { statusCode: 404, code: "AI_SESSION_TURN_NOT_FOUND" });
  const service = serviceFor(async () => { throw expected; });
  await assert.rejects(service.turnBody("instance-1", legacy.id, "missing"), (error) => error === expected);
});

test("split reads forward projection revisions and preserve not-modified responses", async () => {
  const routes = [];
  const service = serviceFor(async (_instance, route) => {
    routes.push(route);
    if (route.includes("projection=index")) return { kind: "not-modified", revision: "turns-rev-1" };
    if (route.includes("/turns/turn-1")) return { kind: "not-modified", revision: "body-rev-1" };
    return { kind: "not-modified", revision: "detail-rev-1" };
  });

  assert.deepEqual(await service.detail("instance-1", legacy.id, "detail-rev-1"), {
    kind: "not-modified",
    revision: "detail-rev-1",
  });
  assert.deepEqual(await service.turnIndex("instance-1", legacy.id, "turns-rev-1"), {
    kind: "not-modified",
    revision: "turns-rev-1",
  });
  assert.deepEqual(await service.turnBody("instance-1", legacy.id, "turn-1", "body-rev-1"), {
    kind: "not-modified",
    revision: "body-rev-1",
  });
  assert.deepEqual(routes, [
    "/ai-sessions/session-1?revision=detail-rev-1",
    "/ai-sessions/session-1/turns?projection=index&revision=turns-rev-1",
    "/ai-sessions/session-1/turns/turn-1?revision=body-rev-1",
  ]);
});
