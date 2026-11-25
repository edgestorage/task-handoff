import assert from "node:assert/strict";
import test from "node:test";
import {
  AI_SESSION_NEXT_INPUT_CONTEXT_MAX_BYTES,
  AiSessionNextInputSuggestionCoordinator,
  aiSessionNextInputContext,
  aiSessionNextInputPrompt,
  parseAiSessionNextInputSuggestion,
  truncateAiSessionNextInputUtf8,
} from "../src/ai-session-next-input.ts";
import type { AiSessionStatus } from "@task-handoff/protocol/ai-sessions";

const now = "2026-11-25T00:00:00.000Z";

function completedTurn(id: string, userPrompt: string, summary: string) {
  return { id, userPrompt, status: "completed", summary, lastMessage: summary, completedAt: "2026-11-25T00:00:30.000Z", updatedAt: "2026-11-25T00:00:30.000Z" };
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
    turns: [completedTurn("turn_1", "问题", "回答")],
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
        const updated = { ...current, nextInputSuggestion: event.suggestion } as AiSessionStatus;
        this.sessions.set(id, updated);
        return updated;
      }
      const { nextInputSuggestion: _suggestion, ...rest } = current;
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
  assert.deepEqual(generated, ["turn_1"]);
  assert.equal(registry.get(session.id)?.nextInputSuggestion?.text, "继续补齐测试");
  coordinator.observeSuccessfulTurn(session.id);
  await wait(20);
  assert.deepEqual(generated, ["turn_1"]);
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
    turns: [completedTurn("turn_1", "问题", "回答"), completedTurn("turn_2", "新问题", "新回答")],
  });
  coordinator.observeSuccessfulTurn(session.id, "turn_2");
  await wait(20);
  assert.deepEqual(efforts, ["none", "high"]);

  coordinator.setReasoningEffort("minimal");
  registry.set({
    ...session,
    turns: [
      completedTurn("turn_1", "问题", "回答"),
      completedTurn("turn_2", "新问题", "新回答"),
      completedTurn("turn_3", "再问", "再答"),
    ],
  });
  coordinator.observeSuccessfulTurn(session.id, "turn_3");
  await wait(20);
  assert.deepEqual(efforts, ["none", "high", "minimal"]);
});

test("changing reasoning mode cancels in-flight work, clears the published suggestion, and does not backfill the old turn", async () => {
  const registry = new FakeRegistry();
  const session = registry.set(statusSession({
    nextInputSuggestion: { text: "旧建议", turnId: "turn_1", generatedAt: now },
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
    activeTurnId: "turn_1",
    turns: [{ ...completedTurn("turn_1", "问题", "回答"), status: "running", completedAt: undefined }] as never,
  }));
  let generated = 0;
  const coordinator = new AiSessionNextInputSuggestionCoordinator({
    registry: registry as never,
    isEnabled: () => true,
    debounceMs: 5,
    generate: async () => { generated += 1; return JSON.stringify({ suggestion: "下一步" }); },
  });
  coordinator.observeSuccessfulTurn(session.id, "turn_1");
  await wait(20);
  assert.equal(generated, 0);
  registry.set({ ...session, status: "idle", activeTurnId: undefined, turns: [completedTurn("turn_1", "问题", "回答")] as never });
  coordinator.reconcileSession(session.id);
  await wait(20);
  assert.equal(generated, 1);
  assert.equal(registry.get(session.id)?.nextInputSuggestion?.text, "下一步");
});

test("an early success survives a completed turn that appears before idle and generates once", async () => {
  const registry = new FakeRegistry();
  const session = registry.set(statusSession({
    status: "running",
    activeTurnId: "turn_1",
    turns: [{ ...completedTurn("turn_1", "问题", "回答"), status: "running", completedAt: undefined }] as never,
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

  coordinator.observeSuccessfulTurn(session.id, "turn_1");
  registry.set({
    ...session,
    status: "running",
    turns: [completedTurn("turn_1", "问题", "回答")] as never,
  });
  coordinator.reconcileSession(session.id);
  await wait(20);
  assert.deepEqual(generated, []);

  registry.set({ ...session, status: "idle", activeTurnId: undefined, turns: [completedTurn("turn_1", "问题", "回答")] as never });
  coordinator.reconcileSession(session.id);
  await wait(20);
  coordinator.reconcileSession(session.id);
  await wait(20);

  assert.deepEqual(generated, ["turn_1"]);
  assert.equal(registry.get(session.id)?.nextInputSuggestion?.text, "只在最终 idle 后生成");
});

test("an early success for a different provider turn is not attributed to the settled turn", async () => {
  const registry = new FakeRegistry();
  const session = registry.set(statusSession({
    status: "running",
    activeTurnId: "turn_1",
    turns: [{ ...completedTurn("turn_1", "问题", "回答"), status: "running", completedAt: undefined }] as never,
  }));
  let generated = 0;
  const coordinator = new AiSessionNextInputSuggestionCoordinator({
    registry: registry as never,
    isEnabled: () => true,
    debounceMs: 5,
    generate: async () => { generated += 1; return JSON.stringify({ suggestion: "不应出现" }); },
  });

  coordinator.observeSuccessfulTurn(session.id, "turn_other");
  registry.set({ ...session, status: "idle", activeTurnId: undefined, turns: [completedTurn("turn_1", "问题", "回答")] as never });
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
  registry.set({ ...session, status: "running", activeTurnId: "turn_2", turns: [completedTurn("turn_2", "新问题", "回复")] as never });
  coordinator.reconcileSession(session.id);
  release?.(JSON.stringify({ suggestion: "迟到结果" }));
  await wait(20);
  assert.equal(registry.get(session.id)?.nextInputSuggestion, undefined);
});

test("requests time out without a diagnostic and release the slot for the next turn", async () => {
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
      if (turn.id === "turn_1") return new Promise<string>(() => {});
      return Promise.resolve(JSON.stringify({ suggestion: "下一轮建议" }));
    },
  });
  coordinator.observeSuccessfulTurn(session.id);
  await wait(40);
  assert.equal(generated, 1);
  assert.equal(signals[0].aborted, true);
  assert.equal(registry.get(session.id)?.nextInputSuggestion, undefined);
  assert.deepEqual(diagnostics, []);

  registry.set({
    ...session,
    turns: [completedTurn("turn_1", "问题", "回答"), completedTurn("turn_2", "新问题", "新回复")],
  });
  coordinator.observeSuccessfulTurn(session.id, "turn_2");
  await wait(25);
  assert.equal(generated, 2);
  assert.equal(registry.get(session.id)?.nextInputSuggestion?.text, "下一轮建议");
  assert.equal(registry.get(session.id)?.nextInputSuggestion?.turnId, "turn_2");
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

test("late results after the request deadline are discarded when adapters ignore abort", async () => {
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
  assert.equal(registry.events.some((entry) => (entry.event as { kind?: string }).kind === "next-input-suggestion"), false);
});

test("cancelling pending work drops late results but keeps an already published suggestion", async () => {
  const registry = new FakeRegistry();
  const session = registry.set(statusSession({ nextInputSuggestion: { text: "已有建议", turnId: "turn_1", generatedAt: now } }));
  let release: ((value: string) => void) | undefined;
  const coordinator = new AiSessionNextInputSuggestionCoordinator({
    registry: registry as never,
    isEnabled: () => true,
    debounceMs: 5,
    generate: () => new Promise<string>((resolve) => { release = resolve; }),
  });
  registry.set({
    ...session,
    turns: [completedTurn("turn_1", "问题", "回答"), completedTurn("turn_2", "新问题", "新回复")],
  });
  coordinator.observeSuccessfulTurn(session.id, "turn_2");
  await wait(20);
  coordinator.cancelPending();
  release?.(JSON.stringify({ suggestion: "迟到建议" }));
  await wait(20);
  assert.equal(registry.get(session.id)?.nextInputSuggestion?.text, "已有建议");
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
  registry.set({ ...session, nextInputSuggestion: { text: "已有建议", turnId: "turn_1", generatedAt: now } });
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
  coordinator.observeSuccessfulTurn(session.id);
  await wait(20);
  assert.equal(generated, 1);
  mode = "ok";
  registry.set({
    ...session,
    turns: [completedTurn("turn_1", "问题", "回答"), completedTurn("turn_2", "新问题", "新回复")],
  });
  coordinator.observeSuccessfulTurn(session.id, "turn_2");
  await wait(20);
  assert.equal(generated, 2);
  assert.equal(registry.get(session.id)?.nextInputSuggestion?.turnId, "turn_2");
});
