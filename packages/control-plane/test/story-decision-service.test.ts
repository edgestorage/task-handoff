import assert from "node:assert/strict";
import test from "node:test";
import { StoryDecisionCommandService } from "../src/node-agent/stories/decision-service.ts";
import { createStoryDatabaseFixture } from "./story-database-fixture.ts";

const timestamp = "2026-09-28T00:00:00.000Z";

async function fixture(options: { idempotentSend?: boolean; transportFailures?: number; rejectFirstSend?: boolean } = {}) {
  const idempotentSend = options.idempotentSend !== false;
  let transportFailures = options.transportFailures ?? 0;
  let rejectFirstSend = options.rejectFirstSend ?? false;
  const database = await createStoryDatabaseFixture("task-handoff-story-decision-");
  await database.repository.stories.insert({
    id: "story_1",
    title: "Decision Story",
    createdAt: timestamp,
    updatedAt: timestamp,
    maxIdleAiSessions: 5,
    nextDocumentSequence: 1,
  });
  const sends: Array<{ url: string; body: unknown }> = [];
  const state = {
    listInstances: () => [{
      id: "instance_1",
      registrationToken: "token_1",
      capabilities: { features: idempotentSend ? { aiSessionSendIdempotency: true } : {} },
      aiSessions: { sessions: [{ id: "session_1", storyId: "story_1", activeTurnId: "turn_1" }] },
    }],
  };
  const events: unknown[] = [];
  const service = new StoryDecisionCommandService(
    state as never,
    database.repository,
    (async (url: string | URL | Request, init?: RequestInit) => {
      sends.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (transportFailures > 0) {
        transportFailures -= 1;
        throw new Error("socket hang up");
      }
      if (rejectFirstSend) {
        rejectFirstSend = false;
        return Response.json({ error: { code: "AI_SESSION_SEND_REJECTED", message: "rejected" } }, { status: 400 });
      }
      return Response.json({ data: { sessionId: "session_1", turnId: "turn_new" } });
    }) as typeof fetch,
    async () => "http://instance.test",
    (event) => events.push(event),
  );
  return { ...database, service, sends, events };
}

test("registering a decision is idempotent per AI Session turn and publishes an event", async () => {
  const context = await fixture();
  try {
    const created = await context.service.register({ storyId: "story_1", sessionId: "session_1", turnId: "turn_1" }, { question: "Ship or hold?", options: [{ id: "ship", label: "Ship" }] });
    assert.equal(created.status, "pending");
    assert.equal(created.revision, 1);
    assert.equal(created.turnId, "turn_1");

    const repeated = await context.service.register({ storyId: "story_1", sessionId: "session_1", turnId: "turn_1" }, { question: "Different question" });
    assert.equal(repeated.id, created.id);
    assert.equal(repeated.question, "Ship or hold?");
    assert.equal((await context.service.list("story_1")).decisions.length, 1);
    assert.equal(context.events.length, 1);
  } finally {
    await context.close();
  }
});

test("registering without an authoritative turn fails closed and archived Stories reject decisions", async () => {
  const context = await fixture();
  try {
    await assert.rejects(
      () => context.service.register({ storyId: "story_1", sessionId: "session_1" }, { question: "Ship?" }),
      (error: any) => error.code === "STORY_DECISION_TURN_REQUIRED",
    );
    await context.repository.stories.update("story_1", { archivedAt: timestamp });
    await assert.rejects(
      () => context.service.register({ storyId: "story_1", sessionId: "session_1", turnId: "turn_2" }, { question: "Ship?" }),
      (error: any) => error.code === "STORY_ARCHIVED",
    );
  } finally {
    await context.close();
  }
});

test("deciding a pending decision continues the session with decisionId as the idempotency key", async () => {
  const context = await fixture();
  try {
    const created = await context.service.register({ storyId: "story_1", sessionId: "session_1", turnId: "turn_1" }, { question: "Ship or hold?", options: [{ id: "ship", label: "Ship" }] });
    const decided = await context.service.decide("story_1", created.id, { optionId: "ship", expectedRevision: created.revision });
    assert.equal(decided.status, "decided");
    assert.equal(decided.decidedTurnId, "turn_new");
    assert.equal(decided.revision, 2);
    assert.equal(context.sends.length, 1);
    assert.match(context.sends[0]!.url, /\/api\/internal\/node-agent\/ai-sessions\/session_1\/messages$/);
    assert.deepEqual(context.sends[0]!.body, { message: "Selected decision option: Ship", clientRequestId: created.id });

    // 重复下达幂等：同一提交再次到达返回首次成功派生的 decidedTurnId，不产生第二个 turn。
    const repeated = await context.service.decide("story_1", created.id, { optionId: "ship", expectedRevision: created.revision });
    assert.equal(repeated.decidedTurnId, "turn_new");
    assert.equal(context.sends.length, 1);

    // 已终态决策不接受改写。
    await assert.rejects(
      () => context.service.decide("story_1", created.id, { response: "hold", expectedRevision: decided.revision }),
      (error: any) => error.code === "STORY_DECISION_TERMINAL",
    );
    assert.equal(context.sends.length, 1);
  } finally {
    await context.close();
  }
});

test("deciding rejects stale revisions and unknown options without sending", async () => {
  const context = await fixture();
  try {
    const created = await context.service.register({ storyId: "story_1", sessionId: "session_1", turnId: "turn_1" }, { question: "Ship?", options: [{ id: "ship", label: "Ship" }] });
    await assert.rejects(
      () => context.service.decide("story_1", created.id, { optionId: "missing", expectedRevision: created.revision }),
      (error: any) => error.code === "STORY_DECISION_OPTION_UNKNOWN",
    );
    await assert.rejects(
      () => context.service.decide("story_1", created.id, { optionId: "ship", expectedRevision: 99 }),
      (error: any) => error.code === "STORY_DECISION_REVISION_CONFLICT",
    );
    assert.equal(context.sends.length, 0);
  } finally {
    await context.close();
  }
});

test("closing a session expires its pending decisions through the authoritative side", async () => {
  const context = await fixture();
  try {
    const created = await context.service.register({ storyId: "story_1", sessionId: "session_1", turnId: "turn_1" }, { question: "Ship?" });
    const expired = await context.service.expireForSession("session_1", { code: "AI_SESSION_CLOSED", message: "closed" });
    assert.equal(expired.length, 1);
    assert.equal(expired[0]!.status, "expired");
    assert.equal(expired[0]!.revision, created.revision + 1);
    assert.equal((await context.service.get("story_1", created.id)).expiredReason?.code, "AI_SESSION_CLOSED");
  } finally {
    await context.close();
  }
});

test("archived Stories keep their pending decisions read-only", async () => {
  const context = await fixture();
  try {
    const created = await context.service.register({ storyId: "story_1", sessionId: "session_1", turnId: "turn_1" }, { question: "Ship?" });
    await context.repository.stories.update("story_1", { archivedAt: timestamp });
    await assert.rejects(
      () => context.service.decide("story_1", created.id, { response: "ship", expectedRevision: created.revision }),
      (error: any) => error.code === "STORY_DECISION_STORY_ARCHIVED",
    );
    await assert.rejects(
      () => context.service.cancel("story_1", created.id, { expectedRevision: created.revision }),
      (error: any) => error.code === "STORY_DECISION_STORY_ARCHIVED",
    );
    assert.equal((await context.service.get("story_1", created.id)).status, "pending");
  } finally {
    await context.close();
  }
});

test("an old instance without send idempotency degrades to the private resuming ledger", async () => {
  const context = await fixture({ idempotentSend: false, transportFailures: 1 });
  try {
    const created = await context.service.register({ storyId: "story_1", sessionId: "session_1", turnId: "turn_1" }, { question: "Ship?", options: [{ id: "ship", label: "Ship" }] });
    await assert.rejects(
      () => context.service.decide("story_1", created.id, { optionId: "ship", expectedRevision: created.revision }),
      (error: any) => error.code === "STORY_DECISION_DISPATCH_UNAVAILABLE",
    );
    // 发送结果不确定，私有账本必须保留 resuming。
    assert.equal((await context.repository.decisions.get(created.id))?.resumeState, "resuming");
    // 未显式确认前禁止盲目重发，返回结构化诊断。
    await assert.rejects(
      () => context.service.decide("story_1", created.id, { optionId: "ship", expectedRevision: created.revision }),
      (error: any) => error.code === "STORY_DECISION_RESUME_PENDING" && error.details?.targetTag === "v0.0.33",
    );
    assert.equal(context.sends.length, 1);
    assert.deepEqual(context.sends[0]!.body, { message: "Selected decision option: Ship" });

    const decided = await context.service.decide("story_1", created.id, { optionId: "ship", expectedRevision: created.revision, retry: true });
    assert.equal(decided.status, "decided");
    assert.equal(decided.decidedTurnId, "turn_new");
    assert.equal(context.sends.length, 2);
    assert.equal((await context.repository.decisions.get(created.id))?.resumeState, null);
  } finally {
    await context.close();
  }
});

test("a definite send rejection clears the resuming ledger so a plain retry works", async () => {
  const context = await fixture({ idempotentSend: false, rejectFirstSend: true });
  try {
    const created = await context.service.register({ storyId: "story_1", sessionId: "session_1", turnId: "turn_1" }, { question: "Ship?", options: [{ id: "ship", label: "Ship" }] });
    await assert.rejects(
      () => context.service.decide("story_1", created.id, { optionId: "ship", expectedRevision: created.revision }),
      (error: any) => error.code === "AI_SESSION_SEND_REJECTED",
    );
    assert.equal((await context.repository.decisions.get(created.id))?.resumeState, null);

    const decided = await context.service.decide("story_1", created.id, { optionId: "ship", expectedRevision: created.revision });
    assert.equal(decided.decidedTurnId, "turn_new");
  } finally {
    await context.close();
  }
});

test("registering rejects an AI Session that belongs to a different Story", async () => {
  const context = await fixture();
  try {
    await context.repository.stories.insert({
      id: "story_2",
      title: "Other Story",
      createdAt: timestamp,
      updatedAt: timestamp,
      maxIdleAiSessions: 5,
      nextDocumentSequence: 1,
    });
    await assert.rejects(
      () => context.service.register({ storyId: "story_2", sessionId: "session_1", turnId: "turn_1" }, { question: "Ship?" }),
      (error: any) => error.code === "STORY_DECISION_SESSION_SCOPE_MISMATCH",
    );
    assert.equal((await context.service.list("story_2")).decisions.length, 0);
  } finally {
    await context.close();
  }
});
