import assert from "node:assert/strict";
import test from "node:test";
import {
  AI_SESSION_NEXT_INPUT_CONTEXT_MAX_BYTES,
  AiSessionNextInputGenerationError,
  AiSessionNextInputSuggestionCoordinator,
  aiSessionNextInputContext,
  aiSessionNextInputPrompt,
  parseAiSessionNextInputSuggestion,
  sanitizeAiSessionNextInputSuggestionError,
  truncateAiSessionNextInputUtf8,
  type AiSessionNextInputMessage,
} from "../src/ai-session-next-input.ts";
import type { AiSessionStatus } from "@task-handoff/protocol/ai-sessions";

const now = "2026-11-25T00:00:00.000Z";

function completedTurn(id: string, userPrompt: string, summary: string) {
  return { id, userPrompt, status: "completed", summary, lastMessage: summary, completedAt: "2026-11-25T00:00:30.000Z", updatedAt: "2026-11-25T00:00:30.000Z" };
}

function completedTurns(count: number) {
  return Array.from({ length: count }, (_, index) => completedTurn(
    `turn_${index + 1}`,
    `问题 ${index + 1}`,
    `回答 ${index + 1}`,
  ));
}

function statusSession(overrides: Partial<AiSessionStatus> = {}): AiSessionStatus {
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
    turns: completedTurns(5),
    ...overrides,
  } as AiSessionStatus;
}

class FakeRegistry {
  readonly sessions = new Map<string, AiSessionStatus>();
  readonly events: Array<{ id: string; event: Record<string, unknown> }> = [];
  get(id: string) { return this.sessions.get(id); }
  list() { return [...this.sessions.values()]; }
  applyRealtimeEvent(id: string, event: Record<string, unknown>) {
    this.events.push({ id, event });
    const current = this.sessions.get(id);
    if (!current) return undefined;
    if (event.kind === "next-input-suggestion") {
      if (event.suggestion) {
        const updated = {
          ...current,
          nextInputSuggestion: event.suggestion,
          nextInputSuggestionError: undefined,
        } as AiSessionStatus;
        this.sessions.set(id, updated);
        return updated;
      }
      const {
        nextInputSuggestion: _suggestion,
        nextInputSuggestionError: _suggestionError,
        ...rest
      } = current;
      if (event.suggestionError) {
        const updated = { ...rest, nextInputSuggestionError: event.suggestionError } as AiSessionStatus;
        this.sessions.set(id, updated);
        return updated;
      }
      this.sessions.set(id, rest as AiSessionStatus);
      return rest as AiSessionStatus;
    }
    return current;
  }
  set(session: AiSessionStatus) { this.sessions.set(session.id, session); return session; }
}

function wait(ms = 30) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("parser normalizes structured output and bounds it by Unicode characters", () => {
  assert.equal(parseAiSessionNextInputSuggestion('{"suggestion":"  \\"继续修复测试。\\"  "}'), "继续修复测试。");
  assert.equal(parseAiSessionNextInputSuggestion('{"suggestion":"line one\\nline two"}'), "line one line two");
  assert.equal(parseAiSessionNextInputSuggestion('{"suggestion":"   "}'), undefined);
  assert.equal(parseAiSessionNextInputSuggestion("not json"), undefined);
  assert.equal(parseAiSessionNextInputSuggestion('{"suggestion":42}'), undefined);
  assert.equal(Array.from(parseAiSessionNextInputSuggestion(JSON.stringify({ suggestion: "字".repeat(200) }))!).length, 160);
});

test("suggestion errors are bounded and redact credentials", () => {
  const sanitized = sanitizeAiSessionNextInputSuggestionError(
    "provider failed Authorization: Bearer secret-token api_key=sk-super-secret",
  );
  assert.equal(sanitized.includes("secret-token"), false);
  assert.equal(sanitized.includes("sk-super-secret"), false);
  assert.match(sanitized, /\[redacted\]/u);
  assert.equal(Array.from(sanitizeAiSessionNextInputSuggestionError("x".repeat(2_000))).length, 1_000);
});

test("context uses the latest two completed turns, excludes other states, and truncates UTF-8 safely", () => {
  const session = statusSession({
    turns: [
      completedTurn("turn_1", "旧问题", "旧回答"),
      { id: "turn_2", userPrompt: "失败", status: "failed", summary: "失败", updatedAt: now },
      completedTurn("turn_3", "最近的问题", "最近的回答"),
      completedTurn("turn_4", "最新问题🙂", "最新回答"),
    ],
  });
  const context = aiSessionNextInputContext(session);
  assert.equal(context.length, 2);
  assert.equal(context[0].user, "最近的问题");
  assert.equal(context[1].user, "最新问题🙂");
  assert.match(aiSessionNextInputPrompt(session), /只返回 JSON/u);

  assert.equal(truncateAiSessionNextInputUtf8("a🙂b", 5), "a🙂");
  const bounded = aiSessionNextInputContext(session, 16);
  assert.ok(Buffer.byteLength(bounded.map((turn) => `${turn.user}\n${turn.assistant}`).join(""), "utf8") <= AI_SESSION_NEXT_INPUT_CONTEXT_MAX_BYTES);
  for (const turn of bounded) assert.ok(turn.user && turn.assistant);
});

test("coordinator generates once per settled turn after the debounce", async () => {
  const registry = new FakeRegistry();
  const session = registry.set(statusSession());
  const generated: string[] = [];
  const coordinator = new AiSessionNextInputSuggestionCoordinator({
    registry: registry as never,
    isEnabled: () => true,
    debounceMs: 5,
    generate: async ({ turn }) => {
      generated.push(turn.id);
      return JSON.stringify({ suggestion: "继续补齐测试" });
    },
  });
  coordinator.observeSuccessfulTurn(session.id);
  coordinator.observeSuccessfulTurn(session.id);
  await wait(20);
  assert.deepEqual(generated, ["turn_5"]);
  assert.equal(registry.get(session.id)?.nextInputSuggestion?.text, "继续补齐测试");
  assert.equal(registry.get(session.id)?.nextInputSuggestionError, undefined);
  coordinator.observeSuccessfulTurn(session.id);
  await wait(20);
  assert.deepEqual(generated, ["turn_5"]);
});

test("generation failures publish a dedicated sanitized error and clear any suggestion", async () => {
  const registry = new FakeRegistry();
  const session = registry.set(statusSession({
    nextInputSuggestion: { text: "旧建议", turnId: "turn_5", generatedAt: now },
  }));
  const coordinator = new AiSessionNextInputSuggestionCoordinator({
    registry: registry as never,
    isEnabled: () => true,
    debounceMs: 5,
    generate: async () => {
      throw new Error("HTTP 401 Authorization: Bearer secret-token sk-super-secret");
    },
  });
  coordinator.observeSuccessfulTurn(session.id);
  await wait(20);
  const current = registry.get(session.id);
  assert.equal(current?.nextInputSuggestion, undefined);
  assert.equal(current?.nextInputSuggestionError?.turnId, "turn_5");
  assert.equal(current?.nextInputSuggestionError?.code, "AI_SESSION_NEXT_INPUT_GENERATION_FAILED");
  assert.match(current?.nextInputSuggestionError?.message || "", /\[redacted\]/u);
  assert.equal(current?.nextInputSuggestionError?.message.includes("secret-token"), false);
  assert.equal(current?.nextInputSuggestionError?.message.includes("sk-super-secret"), false);
});

test("coded generation failures keep their actionable error code", async () => {
  const registry = new FakeRegistry();
  const session = registry.set(statusSession());
  const coordinator = new AiSessionNextInputSuggestionCoordinator({
    registry: registry as never,
    isEnabled: () => true,
    debounceMs: 5,
    generate: async () => {
      throw new AiSessionNextInputGenerationError(
        "AI_SESSION_NEXT_INPUT_MODEL_UNRESOLVED",
        "AI model is not configured for this session.",
      );
    },
  });
  coordinator.observeSuccessfulTurn(session.id);
  await wait(20);
  assert.equal(registry.get(session.id)?.nextInputSuggestionError?.code, "AI_SESSION_NEXT_INPUT_MODEL_UNRESOLVED");
  assert.equal(registry.get(session.id)?.nextInputSuggestionError?.message, "AI model is not configured for this session.");
});

test("a later successful generation clears the published suggestion error", async () => {
  const registry = new FakeRegistry();
  const session = registry.set(statusSession({
    nextInputSuggestionError: {
      code: "AI_SESSION_NEXT_INPUT_GENERATION_FAILED",
      message: "旧错误",
      turnId: "turn_5",
      generatedAt: now,
    },
  }));
  const coordinator = new AiSessionNextInputSuggestionCoordinator({
    registry: registry as never,
    isEnabled: () => true,
    debounceMs: 5,
    generate: async () => JSON.stringify({ suggestion: "恢复后的建议" }),
  });
  coordinator.observeSuccessfulTurn(session.id);
  await wait(20);
  assert.equal(registry.get(session.id)?.nextInputSuggestion?.text, "恢复后的建议");
  assert.equal(registry.get(session.id)?.nextInputSuggestionError, undefined);
});

test("coordinator keeps append-only messages from five to ten turns and resets at eleven", async () => {
  const registry = new FakeRegistry();
  registry.set(statusSession());
  const requests: Array<{ turnId: string; messages: AiSessionNextInputMessage[] }> = [];
  const coordinator = new AiSessionNextInputSuggestionCoordinator({
    registry: registry as never,
    isEnabled: () => true,
    debounceMs: 5,
    generate: async ({ turn, messages }) => {
      requests.push({ turnId: turn.id, messages: structuredClone(messages) });
      return JSON.stringify({ suggestion: `建议 ${turn.id}` });
    },
  });

  for (let count = 5; count <= 11; count += 1) {
    if (count > 5) registry.set({ ...registry.get("ais_0000000000000")!, turns: completedTurns(count) });
    coordinator.observeSuccessfulTurn("ais_0000000000000", `turn_${count}`);
    await wait(20);
  }

  assert.deepEqual(requests.map((request) => request.turnId), ["turn_5", "turn_6", "turn_7", "turn_8", "turn_9", "turn_10", "turn_11"]);
  for (let index = 1; index <= 5; index += 1) {
    assert.deepEqual(requests[index].messages.slice(0, requests[index - 1].messages.length), requests[index - 1].messages);
  }
  assert.equal(requests[0].messages.filter((message) => message.role === "user").length, 5);
  assert.equal(requests[1].messages.at(-2)?.content, "建议 turn_5");
  assert.equal(requests[6].messages.some((message) => message.content === "建议 turn_5"), false);
  assert.equal(requests[6].messages.find((message) => message.role === "user")?.content, "User: 问题 6\nAssistant: 回答 6");
  assert.notDeepEqual(requests[6].messages.slice(0, requests[5].messages.length), requests[5].messages);
});

test("coordinator freezes completed turn text after it enters the prefix", async () => {
  const registry = new FakeRegistry();
  const session = registry.set(statusSession());
  const requests: AiSessionNextInputMessage[][] = [];
  const coordinator = new AiSessionNextInputSuggestionCoordinator({
    registry: registry as never,
    isEnabled: () => true,
    debounceMs: 5,
    generate: async ({ turn, messages }) => {
      requests.push(structuredClone(messages));
      return JSON.stringify({ suggestion: `建议 ${turn.id}` });
    },
  });
  coordinator.observeSuccessfulTurn(session.id);
  await wait(20);

  const current = registry.get(session.id)!;
  current.turns![0].userPrompt = "被改写的问题";
  current.turns![0].summary = "被改写的回答";
  current.turns![0].lastMessage = "被改写的回答";
  registry.set({ ...current, turns: [...current.turns!, completedTurn("turn_6", "问题 6", "回答 6")] });
  coordinator.observeSuccessfulTurn(session.id, "turn_6");
  await wait(20);

  assert.deepEqual(requests[1].slice(0, requests[0].length), requests[0]);
  assert.equal(requests[1].some((message) => message.content.includes("被改写")), false);
});

test("late suggestion results never enter the next request history", async () => {
  const registry = new FakeRegistry();
  const session = registry.set(statusSession());
  const requests: AiSessionNextInputMessage[][] = [];
  const releases: Array<(value: string) => void> = [];
  const coordinator = new AiSessionNextInputSuggestionCoordinator({
    registry: registry as never,
    isEnabled: () => true,
    debounceMs: 5,
    generate: ({ turn, messages }) => {
      requests.push(structuredClone(messages));
      if (turn.id === "turn_5" || turn.id === "turn_6") {
        return new Promise<string>((resolve) => { releases.push(resolve); });
      }
      return Promise.resolve(JSON.stringify({ suggestion: "建议 turn_7" }));
    },
  });

  coordinator.observeSuccessfulTurn(session.id);
  await wait(20);
  registry.set({ ...registry.get(session.id)!, turns: completedTurns(6) });
  coordinator.reconcileSession(session.id);
  coordinator.observeSuccessfulTurn(session.id, "turn_6");
  await wait(20);

  releases[0](JSON.stringify({ suggestion: "迟到建议" }));
  await wait(20);
  releases[1](JSON.stringify({ suggestion: "建议 turn_6" }));
  await wait(20);
  registry.set({ ...registry.get(session.id)!, turns: completedTurns(7) });
  coordinator.observeSuccessfulTurn(session.id, "turn_7");
  await wait(20);

  assert.equal(requests[2].some((message) => message.content === "建议 turn_6"), true);
  assert.equal(requests[2].some((message) => message.content === "迟到建议"), false);
});

test("changing reasoning effort clears the published suggestion but preserves message history", async () => {
  const registry = new FakeRegistry();
  const session = registry.set(statusSession());
  const requests: AiSessionNextInputMessage[][] = [];
  const coordinator = new AiSessionNextInputSuggestionCoordinator({
    registry: registry as never,
    isEnabled: () => true,
    debounceMs: 5,
    generate: async ({ turn, messages }) => {
      requests.push(structuredClone(messages));
      return JSON.stringify({ suggestion: `建议 ${turn.id}` });
    },
  });
  coordinator.observeSuccessfulTurn(session.id);
  await wait(20);
  coordinator.setReasoningEffort("high");
  assert.equal(registry.get(session.id)?.nextInputSuggestion, undefined);

  registry.set({ ...registry.get(session.id)!, turns: completedTurns(6) });
  coordinator.observeSuccessfulTurn(session.id, "turn_6");
  await wait(20);
  assert.deepEqual(requests[1].slice(0, requests[0].length), requests[0]);
  assert.equal(requests[1].at(-2)?.content, "建议 turn_5");
});

test("changing the suggestion model cancels in-flight work and clears the published suggestion", async () => {
  const registry = new FakeRegistry();
  const session = registry.set(statusSession({
    nextInputSuggestion: { text: "旧建议", turnId: "turn_5", generatedAt: now },
  }));
  let release: ((value: string) => void) | undefined;
  let signal: AbortSignal | undefined;
  const coordinator = new AiSessionNextInputSuggestionCoordinator({
    registry: registry as never,
    isEnabled: () => true,
    debounceMs: 5,
    generate: (input) => {
      signal = input.signal;
      return new Promise<string>((resolve) => { release = resolve; });
    },
  });

  coordinator.observeSuccessfulTurn(session.id);
  await wait(20);
  assert.equal(signal?.aborted, false);

  coordinator.setModelSelection({ modelEntityId: "mdl_suggestion", modelName: "suggestion-model" });
  assert.equal(signal?.aborted, true);
  assert.equal(registry.get(session.id)?.nextInputSuggestion, undefined);
  release?.(JSON.stringify({ suggestion: "迟到建议" }));
  await wait(30);
  assert.equal(registry.get(session.id)?.nextInputSuggestion, undefined);

  coordinator.setModelSelection({ modelEntityId: "mdl_suggestion", modelName: "suggestion-model", modelUpstreamName: "suggestion-upstream" });
  assert.equal(registry.get(session.id)?.nextInputSuggestion, undefined);
});

test("coordinator does not generate when the latest completed turn lacks an assistant reply", async () => {
  const registry = new FakeRegistry();
  const session = registry.set(statusSession({
    turns: [...completedTurns(5), { ...completedTurn("turn_6", "空回答", ""), lastMessage: "" }] as never,
  }));
  let generated = 0;
  const coordinator = new AiSessionNextInputSuggestionCoordinator({
    registry: registry as never,
    isEnabled: () => true,
    debounceMs: 5,
    generate: async () => { generated += 1; return JSON.stringify({ suggestion: "不应出现" }); },
  });
  coordinator.observeSuccessfulTurn(session.id);
  await wait(20);
  assert.equal(generated, 0);
});

test("the coordinator defaults to none, follows the session when selected, and lets an explicit mode override it", async () => {
  const registry = new FakeRegistry();
  const session = registry.set(statusSession({ reasoningEffort: "high" }));
  const efforts: Array<string | undefined> = [];
  const coordinator = new AiSessionNextInputSuggestionCoordinator({
    registry: registry as never,
    isEnabled: () => true,
    debounceMs: 5,
    generate: async ({ reasoningEffort }) => {
      efforts.push(reasoningEffort);
      return JSON.stringify({ suggestion: "继续补齐测试" });
    },
  });

  coordinator.observeSuccessfulTurn(session.id);
  await wait(20);
  assert.deepEqual(efforts, ["none"]);

  coordinator.setReasoningEffort("session");
  registry.set({
    ...session,
    turns: completedTurns(6),
  });
  coordinator.observeSuccessfulTurn(session.id, "turn_6");
  await wait(20);
  assert.deepEqual(efforts, ["none", "high"]);

  coordinator.setReasoningEffort("minimal");
  registry.set({
    ...session,
    turns: completedTurns(7),
  });
  coordinator.observeSuccessfulTurn(session.id, "turn_7");
  await wait(20);
  assert.deepEqual(efforts, ["none", "high", "minimal"]);
});

test("changing reasoning mode cancels in-flight work, clears the published suggestion, and does not backfill the old turn", async () => {
  const registry = new FakeRegistry();
  const session = registry.set(statusSession({
    nextInputSuggestion: { text: "旧建议", turnId: "turn_5", generatedAt: now },
  }));
  let generated = 0;
  let release: ((value: string) => void) | undefined;
  let signal: AbortSignal | undefined;
  const coordinator = new AiSessionNextInputSuggestionCoordinator({
    registry: registry as never,
    isEnabled: () => true,
    debounceMs: 5,
    generate: (input) => {
      generated += 1;
      signal = input.signal;
      return new Promise<string>((resolve) => { release = resolve; });
    },
  });

  coordinator.observeSuccessfulTurn(session.id);
  await wait(20);
  assert.equal(generated, 1);
  assert.equal(signal?.aborted, false);

  coordinator.setReasoningEffort("high");
  assert.equal(signal?.aborted, true);
  assert.equal(registry.get(session.id)?.nextInputSuggestion, undefined);
  release?.(JSON.stringify({ suggestion: "迟到建议" }));
  await wait(30);

  assert.equal(generated, 1);
  assert.equal(registry.get(session.id)?.nextInputSuggestion, undefined);
});

test("closing a session drops coordinator state and cancels a pending generation", async () => {
  const registry = new FakeRegistry();
  const session = registry.set(statusSession());
  let generated = 0;
  const coordinator = new AiSessionNextInputSuggestionCoordinator({
    registry: registry as never,
    isEnabled: () => true,
    debounceMs: 20,
    generate: async () => { generated += 1; return JSON.stringify({ suggestion: "不应出现" }); },
  });
  coordinator.observeSuccessfulTurn(session.id);
  registry.sessions.delete(session.id);
  coordinator.retainSessions(new Set());
  await wait(60);
  assert.equal(generated, 0);
});

test("baseline turns are remembered and never generated on startup or resume", async () => {
  const registry = new FakeRegistry();
  const session = registry.set(statusSession());
  let generated = 0;
  const coordinator = new AiSessionNextInputSuggestionCoordinator({
    registry: registry as never,
    isEnabled: () => true,
    debounceMs: 5,
    generate: async () => { generated += 1; return JSON.stringify({ suggestion: "不应出现" }); },
  });
  coordinator.observeBaseline(registry.get(session.id)!);
  coordinator.observeSuccessfulTurn(session.id);
  await wait(20);
  assert.equal(generated, 0);
});

test("a success reported before the registry settles is scheduled after the idle turn arrives", async () => {
  const registry = new FakeRegistry();
  const session = registry.set(statusSession({
    status: "running",
    activeTurnId: "turn_6",
    turns: [
      ...completedTurns(5),
      { ...completedTurn("turn_6", "新问题", "新回答"), status: "running", completedAt: undefined },
    ] as never,
  }));
  let generated = 0;
  const coordinator = new AiSessionNextInputSuggestionCoordinator({
    registry: registry as never,
    isEnabled: () => true,
    debounceMs: 5,
    generate: async () => { generated += 1; return JSON.stringify({ suggestion: "下一步" }); },
  });
  coordinator.observeSuccessfulTurn(session.id, "turn_6");
  await wait(20);
  assert.equal(generated, 0);
  registry.set({ ...session, status: "idle", activeTurnId: undefined, turns: completedTurns(6) as never });
  coordinator.reconcileSession(session.id);
  await wait(20);
  assert.equal(generated, 1);
  assert.equal(registry.get(session.id)?.nextInputSuggestion?.text, "下一步");
});

test("an early success survives a completed turn that appears before idle and generates once", async () => {
  const registry = new FakeRegistry();
  const session = registry.set(statusSession({
    status: "running",
    activeTurnId: "turn_6",
    turns: [
      ...completedTurns(5),
      { ...completedTurn("turn_6", "新问题", "新回答"), status: "running", completedAt: undefined },
    ] as never,
  }));
  const generated: string[] = [];
  const coordinator = new AiSessionNextInputSuggestionCoordinator({
    registry: registry as never,
    isEnabled: () => true,
    debounceMs: 5,
    generate: async ({ turn }) => {
      generated.push(turn.id);
      return JSON.stringify({ suggestion: "只在最终 idle 后生成" });
    },
  });

  coordinator.observeSuccessfulTurn(session.id, "turn_6");
  registry.set({
    ...session,
    status: "running",
    turns: completedTurns(6) as never,
  });
  coordinator.reconcileSession(session.id);
  await wait(20);
  assert.deepEqual(generated, []);

  registry.set({ ...session, status: "idle", activeTurnId: undefined, turns: completedTurns(6) as never });
  coordinator.reconcileSession(session.id);
  await wait(20);
  coordinator.reconcileSession(session.id);
  await wait(20);

  assert.deepEqual(generated, ["turn_6"]);
  assert.equal(registry.get(session.id)?.nextInputSuggestion?.text, "只在最终 idle 后生成");
});

test("an early success for a different provider turn is not attributed to the settled turn", async () => {
  const registry = new FakeRegistry();
  const session = registry.set(statusSession({
    status: "running",
    activeTurnId: "turn_6",
    turns: [
      ...completedTurns(5),
      { ...completedTurn("turn_6", "新问题", "新回答"), status: "running", completedAt: undefined },
    ] as never,
  }));
  let generated = 0;
  const coordinator = new AiSessionNextInputSuggestionCoordinator({
    registry: registry as never,
    isEnabled: () => true,
    debounceMs: 5,
    generate: async () => { generated += 1; return JSON.stringify({ suggestion: "不应出现" }); },
  });

  coordinator.observeSuccessfulTurn(session.id, "turn_other");
  registry.set({ ...session, status: "idle", activeTurnId: undefined, turns: completedTurns(6) as never });
  coordinator.reconcileSession(session.id);
  await wait(20);

  assert.equal(generated, 0);
  assert.equal(registry.get(session.id)?.nextInputSuggestion, undefined);
});

test("a settled success for a different turn is not attributed to the latest turn", async () => {
  const registry = new FakeRegistry();
  const session = registry.set(statusSession());
  let generated = 0;
  const coordinator = new AiSessionNextInputSuggestionCoordinator({
    registry: registry as never,
    isEnabled: () => true,
    debounceMs: 5,
    generate: async () => { generated += 1; return JSON.stringify({ suggestion: "不应出现" }); },
  });
  coordinator.observeSuccessfulTurn(session.id, "turn_other");
  await wait(20);
  assert.equal(generated, 0);
});

test("late generations are discarded after a new turn starts", async () => {
  const registry = new FakeRegistry();
  const session = registry.set(statusSession());
  let release: ((value: string) => void) | undefined;
  const coordinator = new AiSessionNextInputSuggestionCoordinator({
    registry: registry as never,
    isEnabled: () => true,
    debounceMs: 5,
    generate: ({ signal }) => new Promise((resolve) => {
      release = resolve;
      signal.addEventListener("abort", () => resolve(JSON.stringify({ suggestion: "迟到结果" })));
    }),
  });
  coordinator.observeSuccessfulTurn(session.id);
  await wait(20);
  registry.set({
    ...session,
    status: "running",
    activeTurnId: "turn_6",
    turns: [
      ...completedTurns(5),
      { ...completedTurn("turn_6", "新问题", "回复"), status: "running", completedAt: undefined },
    ] as never,
  });
  coordinator.reconcileSession(session.id);
  release?.(JSON.stringify({ suggestion: "迟到结果" }));
  await wait(20);
  assert.equal(registry.get(session.id)?.nextInputSuggestion, undefined);
});

test("requests time out with a visible error and release the slot for the next turn", async () => {
  const registry = new FakeRegistry();
  const session = registry.set(statusSession());
  const diagnostics: Array<Record<string, unknown>> = [];
  const signals: AbortSignal[] = [];
  let generated = 0;
  const coordinator = new AiSessionNextInputSuggestionCoordinator({
    registry: registry as never,
    isEnabled: () => true,
    debounceMs: 5,
    requestTimeoutMs: 15,
    onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    generate: ({ signal, turn }) => {
      generated += 1;
      signals.push(signal);
      if (turn.id === "turn_5") return new Promise<string>(() => {});
      return Promise.resolve(JSON.stringify({ suggestion: "下一轮建议" }));
    },
  });
  coordinator.observeSuccessfulTurn(session.id);
  await wait(40);
  assert.equal(generated, 1);
  assert.equal(signals[0].aborted, true);
  assert.equal(registry.get(session.id)?.nextInputSuggestion, undefined);
  assert.equal(registry.get(session.id)?.nextInputSuggestionError?.code, "AI_SESSION_NEXT_INPUT_TIMEOUT");
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0].code, "AI_SESSION_NEXT_INPUT_TIMEOUT");

  registry.set({
    ...session,
    turns: completedTurns(6),
  });
  coordinator.observeSuccessfulTurn(session.id, "turn_6");
  await wait(25);
  assert.equal(generated, 2);
  assert.equal(registry.get(session.id)?.nextInputSuggestion?.text, "下一轮建议");
  assert.equal(registry.get(session.id)?.nextInputSuggestion?.turnId, "turn_6");
  assert.equal(registry.get(session.id)?.nextInputSuggestionError, undefined);
});
test("one in-flight request per session does not start a second generation", async () => {
  const registry = new FakeRegistry();
  const session = registry.set(statusSession());
  let generated = 0;
  let release: ((value: string) => void) | undefined;
  const coordinator = new AiSessionNextInputSuggestionCoordinator({
    registry: registry as never,
    isEnabled: () => true,
    debounceMs: 5,
    generate: () => new Promise<string>((resolve) => {
      generated += 1;
      release = resolve;
    }),
  });
  coordinator.observeSuccessfulTurn(session.id);
  await wait(20);
  assert.equal(generated, 1);
  coordinator.observeSuccessfulTurn(session.id);
  coordinator.reconcileSession(session.id);
  await wait(20);
  assert.equal(generated, 1);
  release?.(JSON.stringify({ suggestion: "唯一建议" }));
  await wait(20);
  assert.equal(registry.get(session.id)?.nextInputSuggestion?.text, "唯一建议");
});

test("late results after the request deadline are discarded while the timeout error remains", async () => {
  const registry = new FakeRegistry();
  const session = registry.set(statusSession());
  let release: ((value: string) => void) | undefined;
  const coordinator = new AiSessionNextInputSuggestionCoordinator({
    registry: registry as never,
    isEnabled: () => true,
    debounceMs: 5,
    requestTimeoutMs: 15,
    generate: () => new Promise<string>((resolve) => {
      release = resolve;
    }),
  });
  coordinator.observeSuccessfulTurn(session.id);
  await wait(40);
  release?.(JSON.stringify({ suggestion: "迟到结果" }));
  await wait(20);
  assert.equal(registry.get(session.id)?.nextInputSuggestion, undefined);
  assert.equal(registry.get(session.id)?.nextInputSuggestionError?.code, "AI_SESSION_NEXT_INPUT_TIMEOUT");
  assert.equal(registry.events.filter((entry) => (entry.event as { kind?: string }).kind === "next-input-suggestion").length, 1);
});

test("cancelling pending work drops late results but keeps an already published suggestion", async () => {
  const registry = new FakeRegistry();
  const session = registry.set(statusSession({ nextInputSuggestion: { text: "已有建议", turnId: "turn_5", generatedAt: now } }));
  let release: ((value: string) => void) | undefined;
  const coordinator = new AiSessionNextInputSuggestionCoordinator({
    registry: registry as never,
    isEnabled: () => true,
    debounceMs: 5,
    generate: () => new Promise<string>((resolve) => { release = resolve; }),
  });
  registry.set({
    ...session,
    turns: completedTurns(6),
  });
  coordinator.observeSuccessfulTurn(session.id, "turn_6");
  await wait(20);
  coordinator.cancelPending();
  release?.(JSON.stringify({ suggestion: "迟到建议" }));
  await wait(20);
  assert.equal(registry.get(session.id)?.nextInputSuggestion?.text, "已有建议");
  assert.equal(registry.get(session.id)?.nextInputSuggestionError, undefined);
});

test("disabled coordinators never generate and disabling clears every suggestion", async () => {
  const registry = new FakeRegistry();
  const session = registry.set(statusSession());
  let enabled = false;
  let generated = 0;
  const coordinator = new AiSessionNextInputSuggestionCoordinator({
    registry: registry as never,
    isEnabled: () => enabled,
    debounceMs: 5,
    generate: async () => { generated += 1; return JSON.stringify({ suggestion: "不应出现" }); },
  });
  coordinator.observeSuccessfulTurn(session.id);
  await wait(20);
  assert.equal(generated, 0);
  enabled = true;
  registry.set({ ...session, nextInputSuggestion: { text: "已有建议", turnId: "turn_5", generatedAt: now } });
  coordinator.setEnabled(false);
  assert.equal(registry.get(session.id)?.nextInputSuggestion, undefined);
  assert.equal(generated, 0);
});

test("subagent sessions never schedule a suggestion", async () => {
  const registry = new FakeRegistry();
  const child = registry.set(statusSession({ lineage: { kind: "subagent", parentProviderSessionId: "thread" } }));
  let generated = 0;
  const coordinator = new AiSessionNextInputSuggestionCoordinator({
    registry: registry as never,
    isEnabled: () => true,
    debounceMs: 5,
    generate: async () => { generated += 1; return JSON.stringify({ suggestion: "不应出现" }); },
  });
  coordinator.observeSuccessfulTurn(child.id);
  await wait(20);
  assert.equal(generated, 0);
});

test("failed and empty results consume the turn exactly once", async () => {
  const registry = new FakeRegistry();
  const session = registry.set(statusSession());
  let generated = 0;
  let mode: "empty" | "ok" = "empty";
  const coordinator = new AiSessionNextInputSuggestionCoordinator({
    registry: registry as never,
    isEnabled: () => true,
    debounceMs: 5,
    generate: async () => {
      generated += 1;
      if (mode === "empty") return JSON.stringify({ suggestion: "   " });
      return JSON.stringify({ suggestion: "最终建议" });
    },
  });
  coordinator.observeSuccessfulTurn(session.id);
  await wait(20);
  assert.equal(generated, 1);
  assert.equal(registry.get(session.id)?.nextInputSuggestion, undefined);
  assert.equal(registry.get(session.id)?.nextInputSuggestionError?.code, "AI_SESSION_NEXT_INPUT_RESPONSE_INVALID");
  coordinator.observeSuccessfulTurn(session.id);
  await wait(20);
  assert.equal(generated, 1);
  mode = "ok";
  registry.set({
    ...session,
    turns: completedTurns(6),
  });
  coordinator.observeSuccessfulTurn(session.id, "turn_6");
  await wait(20);
  assert.equal(generated, 2);
  assert.equal(registry.get(session.id)?.nextInputSuggestion?.turnId, "turn_6");
  assert.equal(registry.get(session.id)?.nextInputSuggestionError, undefined);
});
