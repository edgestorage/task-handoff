import assert from "node:assert/strict";
import test from "node:test";
import { StoryAiSessionReadService } from "../src/node-agent/stories/ai-session-read-service.ts";

const timestamp = "2026-09-19T00:00:00.000Z";
const agentOutputOnlyKeys = new Set([
  "timeline",
  "revision",
  "bodyRevision",
  "detailRevision",
  "turnsRevision",
  "sourcePriority",
  "snapshotVersion",
  "observedAt",
  "providerMeta",
  "appBindingKeys",
]);

function assertNoInternalProjectionFields(value: unknown): void {
  if (Array.isArray(value)) {
    value.forEach(assertNoInternalProjectionFields);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    assert.equal(agentOutputOnlyKeys.has(key), false, `unexpected Agent output field: ${key}`);
    assertNoInternalProjectionFields(child);
  }
}

const session = (id: string, input: Record<string, unknown> = {}) => ({
  id,
  agent: "codex",
  storyId: "story_1",
  status: "idle",
  startedAt: timestamp,
  updatedAt: timestamp,
  ...input,
});

function fixture(fetchImpl?: typeof fetch) {
  const caller = session("caller", { status: "running", updatedAt: "2026-09-19T00:06:00.000Z" });
  const sameInstanceRoot = session("same_instance", { status: "waiting", updatedAt: "2026-09-19T00:02:00.000Z" });
  const target = session("target", { title: "Target", updatedAt: "2026-09-19T00:05:00.000Z" });
  const fork = session("fork", { lineage: { kind: "fork", parentProviderSessionId: "provider_parent" }, updatedAt: "2026-09-19T00:03:00.000Z" });
  const instances = [
    { id: "instance_1", registrationToken: "token_1", aiSessions: { sessions: [caller, sameInstanceRoot] } },
    { id: "instance_2", registrationToken: "token_2", aiSessions: { sessions: [
      target,
      fork,
      session("same_id_other_instance", { id: "caller", updatedAt: "2026-09-19T00:04:00.000Z" }),
      session("subagent", { lineage: { kind: "subagent", parentProviderSessionId: "provider_parent" } }),
      session("other_story", { storyId: "story_2" }),
      session("failed", { status: "failed" }),
    ] } },
  ];
  const requests: string[] = [];
  const fetcher = fetchImpl || (async (url) => {
    requests.push(String(url));
    if (String(url).endsWith("/turns/turn_1")) {
      return new Response(JSON.stringify({ data: {
        body: {
          sessionId: "target",
          revision: "body_1",
          turn: {
            id: "turn_1",
            userPrompt: "Inspect release.txt",
            userMessages: [{ id: "message_1", text: "Inspect release.txt", attachments: [{ id: "attachment_1", kind: "file", name: "release.txt", mime: "text/plain", size: 12, contentState: "available" }] }],
            status: "completed",
            revision: 2,
          },
        },
        timeline: {
          sessionId: "target",
          turnId: "turn_1",
          generatedAt: timestamp,
          items: [
            { id: "message_1", turnId: "turn_1", type: "user-message", text: "Inspect release.txt", attachments: [{ id: "attachment_1", kind: "file", name: "release.txt", mime: "text/plain", size: 12, contentState: "available" }] },
            { id: "tool_1", turnId: "turn_1", type: "activity", activityKind: "tool", title: "Read", input: "release.txt", output: "ready".repeat(200), status: "completed" },
            { id: "message_2", turnId: "turn_1", type: "ai-message", text: "Release is ready" },
          ],
        },
        future: true,
      } }), { headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({ data: {
      detail: { id: "target", cwd: "/workspace", future: true },
      turnIndex: { sessionId: "target", revision: "index_1", turns: [{ id: "turn_1", status: "completed", revision: 2, bodyRevision: "body_1" }], future: true },
      future: true,
    } }), { headers: { "content-type": "application/json" } });
  });
  const service = new StoryAiSessionReadService({ listInstances: () => instances } as never, fetcher, async (instance) => `http://${instance.id}`);
  return { service, instances, target, requests, caller: { instanceId: "instance_1", sessionId: "caller", storyId: "story_1" } };
}

test("Story AI Session list only includes other current root Sessions in stable order", () => {
  const context = fixture();
  const first = context.service.list(context.caller, 1, 2);
  assert.deepEqual(first.sessions.map((entry) => [entry.instanceId, entry.sessionId]), [
    ["instance_2", "target"],
    ["instance_2", "caller"],
  ]);
  assert.deepEqual(first.pagination, { totalItems: 4, nextPage: 2 });
  assert.deepEqual(context.service.list(context.caller, 2, 2).sessions.map((entry) => entry.sessionId), ["fork", "same_instance"]);
});

test("Story AI Session reads recheck snapshot scope and preserve public Turn content", async () => {
  const context = fixture();
  context.target.storyId = "story_2";
  await assert.rejects(
    () => context.service.get(context.caller, "instance_2", "target", 1, 10),
    (error: any) => error.code === "AI_SESSION_NOT_FOUND",
  );
  assert.equal(context.requests.length, 0);

  context.target.storyId = "story_1";
  const detail = await context.service.get(context.caller, "instance_2", "target", 1, 10);
  assert.deepEqual(detail.ref, { instanceId: "instance_2", sessionId: "target" });
  assert.equal(detail.session.cwd, "/workspace");
  assert.equal(detail.turns[0]?.id, "turn_1");
  assert.deepEqual(detail.pagination, { totalItems: 1 });
  assert.equal("id" in detail.session, false);
  assert.equal("future" in detail, false);
  assertNoInternalProjectionFields(detail);

  const turn = await context.service.turn(context.caller, "instance_2", "target", "turn_1", 1, 2, 256);
  assert.equal("userMessages" in turn.turn, false);
  assert.equal(turn.items[0]?.type === "user-message" ? turn.items[0].attachments?.[0]?.name : undefined, "release.txt");
  assert.equal(turn.items[1]?.type, "activity");
  assert.equal(turn.items[1]?.type === "activity" ? turn.items[1].input : undefined, "release.txt");
  assert.equal(turn.items[1]?.type === "activity" ? turn.items[1].output?.length : undefined, 256);
  assert.deepEqual(turn.items[1]?.truncatedFields, ["output"]);
  assert.equal("turnId" in turn.items[0]!, false);
  assert.deepEqual(turn.pagination, { totalItems: 3, nextPage: 2 });
  assertNoInternalProjectionFields(turn);
});

test("Story AI Session read reports a target instance transport failure without scanning history", async () => {
  const context = fixture(async () => { throw new Error("offline"); });
  await assert.rejects(
    () => context.service.get(context.caller, "instance_2", "target", 1, 10),
    (error: any) => error.code === "AI_SESSION_UNAVAILABLE" && error.statusCode === 503,
  );
});
