import assert from "node:assert/strict";
import test from "node:test";
import {
  AI_SESSION_NEXT_INPUT_MAX_WINDOW_TURNS,
  AI_SESSION_NEXT_INPUT_MIN_TURNS,
  AI_SESSION_NEXT_INPUT_SYSTEM_PROMPT,
  AI_SESSION_NEXT_INPUT_WINDOW_STEP_TURNS,
  buildAiSessionNextInputMessages,
  createAiSessionNextInputMessagePlan,
} from "../src/ai-session-next-input.ts";
import type { AiSessionStatus } from "@task-handoff/protocol/ai-sessions";

const now = "2026-11-25T00:00:00.000Z";

function completedTurn(index: number, userPrompt = `用户 ${index}`, assistant = `回复 ${index}`) {
  return {
    id: `turn_${index}`,
    userPrompt,
    status: "completed",
    summary: assistant,
    lastMessage: assistant,
    completedAt: "2026-11-25T00:00:30.000Z",
    updatedAt: "2026-11-25T00:00:30.000Z",
  };
}

function statusSession(turnCount: number): AiSessionStatus {
  return {
    id: "ais_0000000000000",
    agent: "codex",
    creationSource: "ai-session",
    providerSessionId: "thread",
    status: "idle",
    phase: "unknown",
    counters: { toolCalls: 0, edits: 0, approvals: 0 },
    queue: { revision: 0, pendingCount: 0, items: [] },
    subAgents: [],
    toolCallsSinceLastMessage: 0,
    unread: false,
    startedAt: now,
    updatedAt: now,
    turns: Array.from({ length: turnCount }, (_, index) => completedTurn(index + 1)),
  } as AiSessionStatus;
}

function turnIds(start: number, end: number) {
  return Array.from({ length: end - start + 1 }, (_, index) => `turn_${start + index}`);
}

test("the window starts at one turn, grows to ten, then advances by five", () => {
  assert.equal(createAiSessionNextInputMessagePlan({ session: statusSession(0) }), undefined);

  const expectedStarts = new Map([
    [1, 0], [2, 0], [3, 0], [4, 0], [5, 0], [6, 0], [7, 0], [8, 0], [9, 0], [10, 0],
    [11, 5], [12, 5], [13, 5], [14, 5], [15, 5],
    [16, 10], [17, 10], [18, 10], [19, 10], [20, 10],
    [21, 15], [25, 15], [26, 20],
  ]);
  for (const [count, start] of expectedStarts) {
    const plan = createAiSessionNextInputMessagePlan({ session: statusSession(count) });
    assert.ok(plan);
    assert.equal(plan.windowStart, start);
    assert.deepEqual(plan.windowTurnIds, turnIds(start + 1, count));
    assert.ok(plan.windowTurnIds.length >= AI_SESSION_NEXT_INPUT_MIN_TURNS);
    assert.ok(plan.windowTurnIds.length <= AI_SESSION_NEXT_INPUT_MAX_WINDOW_TURNS);
  }
  assert.equal(AI_SESSION_NEXT_INPUT_WINDOW_STEP_TURNS, 5);
});

test("messages use a fixed system prompt, one user message per turn, and plain-text prior suggestions", () => {
  const messages = buildAiSessionNextInputMessages([
    { id: "turn_5", user: "旧问题", assistant: "旧回答" },
    { id: "turn_6", user: "最新问题", assistant: "最新回答" },
  ], new Map([
    ["turn_5", "建议 5"],
    ["turn_6", "建议 6"],
  ]));

  assert.deepEqual(messages, [
    { role: "system", content: AI_SESSION_NEXT_INPUT_SYSTEM_PROMPT },
    { role: "user", content: "User: 旧问题\nAssistant: 旧回答" },
    { role: "assistant", content: "建议 5" },
    { role: "user", content: "User: 最新问题\nAssistant: 最新回答" },
    { role: "assistant", content: "建议 6" },
  ]);
  assert.equal(messages.filter((message) => message.role === "system").length, 1);
});

test("the fixed system prompt does not change when the user language changes", () => {
  const chinese = buildAiSessionNextInputMessages([{ id: "turn_1", user: "继续修复", assistant: "已修复" }]);
  const english = buildAiSessionNextInputMessages([{ id: "turn_2", user: "continue", assistant: "done" }]);
  assert.deepEqual(chinese[0], english[0]);
  assert.match(AI_SESSION_NEXT_INPUT_SYSTEM_PROMPT, /Never call tools/u);
});

test("consecutive requests inside one window are strict message prefixes", () => {
  const suggestionsByTurnId = new Map<string, string>();
  let previousPlan: ReturnType<typeof createAiSessionNextInputMessagePlan>;
  let previousSnapshots: ReadonlyMap<string, { id: string; user: string; assistant: string }> | undefined;

  for (let count = AI_SESSION_NEXT_INPUT_MIN_TURNS; count <= 25; count += 1) {
    const plan = createAiSessionNextInputMessagePlan({
      session: statusSession(count),
      previousSnapshots,
      suggestionsByTurnId,
    });
    assert.ok(plan);

    if (previousPlan && plan.windowStart === previousPlan.windowStart) {
      assert.deepEqual(plan.messages.slice(0, previousPlan.messages.length), previousPlan.messages);
    }
    if (count === 11) {
      assert.equal(plan.windowTurnIds[0], "turn_6");
      assert.equal(plan.messages.some((message) => message.content === "建议 5"), false);
      assert.notDeepEqual(plan.messages.slice(0, previousPlan!.messages.length), previousPlan!.messages);
    }
    if (count === 16) {
      assert.equal(plan.windowTurnIds[0], "turn_11");
      assert.equal(plan.messages.some((message) => message.content === "建议 10"), false);
      assert.notDeepEqual(plan.messages.slice(0, previousPlan!.messages.length), previousPlan!.messages);
    }
    if (count === 21) {
      assert.equal(plan.windowTurnIds[0], "turn_16");
      assert.equal(plan.messages.some((message) => message.content === "建议 15"), false);
      assert.notDeepEqual(plan.messages.slice(0, previousPlan!.messages.length), previousPlan!.messages);
    }

    suggestionsByTurnId.set(`turn_${count}`, `建议 ${count}`);
    previousPlan = plan;
    previousSnapshots = plan.snapshots;
  }
});

test("frozen turn snapshots prevent later status mutations from rewriting the prefix", () => {
  const session = statusSession(5);
  const first = createAiSessionNextInputMessagePlan({ session });
  assert.ok(first);

  const turnFive = session.turns!.find((turn) => turn.id === "turn_5")!;
  turnFive.userPrompt = "被改写的问题";
  turnFive.summary = "被改写的回答";
  turnFive.lastMessage = "被改写的回答";
  session.turns!.push(completedTurn(6) as never);

  const second = createAiSessionNextInputMessagePlan({
    session,
    previousSnapshots: first.snapshots,
    suggestionsByTurnId: new Map([["turn_5", "建议 5"]]),
  });
  assert.ok(second);
  assert.deepEqual(second.messages.slice(0, first.messages.length), first.messages);
  assert.ok(second.messages.some((message) => message.content === "User: 用户 5\nAssistant: 回复 5"));
  assert.equal(second.messages.some((message) => message.content.includes("被改写")), false);
  assert.equal(second.messages.at(-2)?.content, "建议 5");
  assert.equal(second.messages.at(-1)?.content, "User: 用户 6\nAssistant: 回复 6");
});

test("only completed turns with real user and assistant text enter the messages", () => {
  const session = statusSession(5);
  session.turns!.push(
    { id: "turn_failed", userPrompt: "失败问题", status: "failed", summary: "失败", updatedAt: now } as never,
    { id: "turn_running", userPrompt: "运行中问题", status: "running", summary: "运行中", updatedAt: now } as never,
  );

  const plan = createAiSessionNextInputMessagePlan({ session });
  assert.ok(plan);
  assert.deepEqual(plan.windowTurnIds, turnIds(1, 5));

  session.turns!.push(completedTurn(6, "空回答", "") as never);
  assert.equal(createAiSessionNextInputMessagePlan({ session }), undefined);
});
