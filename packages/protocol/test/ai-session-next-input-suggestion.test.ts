import assert from "node:assert/strict";
import test from "node:test";
import {
  AI_SESSION_NEXT_INPUT_SUGGESTION_DEFAULT_REASONING_EFFORT,
  AI_SESSION_NEXT_INPUT_SUGGESTION_MAX_CHARS,
  AiSessionDetailSchema,
  AiSessionEventMetaSchema,
  AiSessionNextInputSuggestionSchema,
  AiSessionNextInputSuggestionErrorSchema,
  AiSessionNextInputSuggestionReasoningEffortSchema,
  AiSessionPatchEventSchema,
  AiSessionRealtimeInputSchema,
  AiSessionStatusSchema,
  AiSessionSummarySchema,
  projectAiSessionDeltaForConsumer,
  projectAiSessionStreamEventForConsumer,
  projectAiSessionsSnapshotForConsumer,
  resolveAiSessionNextInputSuggestionReasoningEffort,
} from "../src/ai-sessions.ts";
import {
  AiSessionHierarchyCapabilitiesSchema,
  supportsAiSessionConsumerNextInputSuggestion,
  supportsAiSessionProviderNextInputSuggestion,
} from "../src/ai-session-provider-capabilities.ts";
import {
  NodeAgentCapabilitiesSchema,
  supportsNodeAiSessionNextInputSuggestion,
  supportsNodeAiSessionNextInputSuggestionModelSelection,
  supportsNodeAiSessionNextInputSuggestionReasoningEffort,
} from "../src/node-agent-capabilities.ts";
import {
  ControlledInstanceSchema,
  InstanceConfigInputSchema,
  UpdateInstanceInputSchema,
  supportsAiSessionNextInputSuggestionModelSelection,
  supportsAiSessionNextInputSuggestionReasoningEffort,
} from "../src/control-plane.ts";

const now = "2026-11-25T00:00:00.000Z";
const meta = { streamId: "stream", instanceId: "inst", revision: 2, traceId: "trace", generatedAt: now, reason: "startup" };

function suggestion(text = "继续补齐测试") {
  return { text, turnId: "turn_1", generatedAt: now };
}

function suggestionError(message = "模型请求失败") {
  return { code: "AI_SESSION_NEXT_INPUT_GENERATION_FAILED", message, turnId: "turn_1", generatedAt: now };
}

function summary(withSuggestion = true, lineage?: Record<string, unknown>) {
  return {
    id: "ais_0000000000000",
    agent: "codex",
    creationSource: "ai-session",
    ...(lineage ? { lineage } : {}),
    status: "idle",
    phase: "unknown",
    startedAt: now,
    updatedAt: now,
    queue: { revision: 0, pendingCount: 0, items: [] },
    ...(withSuggestion ? { nextInputSuggestion: suggestion() } : {}),
  };
}

test("next-input suggestions are bounded single-line AI session projections", () => {
  assert.equal(AiSessionNextInputSuggestionSchema.parse(suggestion()).text, "继续补齐测试");
  assert.equal(AiSessionNextInputSuggestionSchema.safeParse({ ...suggestion(), text: "a\nb" }).success, false);
  assert.equal(AiSessionNextInputSuggestionSchema.safeParse({ ...suggestion(), text: "" }).success, false);
  assert.equal(
    AiSessionNextInputSuggestionSchema.safeParse({ ...suggestion(), text: "字".repeat(AI_SESSION_NEXT_INPUT_SUGGESTION_MAX_CHARS + 1) }).success,
    false,
  );
  assert.equal(AiSessionNextInputSuggestionSchema.safeParse({ ...suggestion(), turnId: "" }).success, false);
  assert.equal(AiSessionNextInputSuggestionSchema.safeParse({ ...suggestion(), generatedAt: "yesterday" }).success, false);
  assert.equal(AiSessionNextInputSuggestionSchema.safeParse({ ...suggestion(), extra: true }).success, false);
});

test("next-input suggestion errors are bounded, structured, and case-exclusive", () => {
  assert.deepEqual(AiSessionNextInputSuggestionErrorSchema.parse(suggestionError()), suggestionError());
  assert.equal(AiSessionNextInputSuggestionErrorSchema.safeParse({ ...suggestionError(), message: "" }).success, false);
  assert.equal(AiSessionNextInputSuggestionErrorSchema.safeParse({ ...suggestionError(), message: "x".repeat(1_001) }).success, false);
  assert.equal(AiSessionNextInputSuggestionErrorSchema.safeParse({ ...suggestionError(), extra: true }).success, false);
  const status = AiSessionStatusSchema.parse({
    ...summary(false),
    counters: { toolCalls: 0, edits: 0, approvals: 0 },
    nextInputSuggestionError: suggestionError(),
  });
  assert.deepEqual(status.nextInputSuggestionError, suggestionError());
  assert.deepEqual(AiSessionSummarySchema.parse({ ...summary(false), nextInputSuggestionError: suggestionError() }).nextInputSuggestionError, suggestionError());
  assert.equal(AiSessionDetailSchema.safeParse({ ...summary(false), nextInputSuggestionError: suggestionError() }).success, false);
});

test("the suggestion only belongs to status and summary projections", () => {
  const status = AiSessionStatusSchema.parse({ ...summary(), counters: { toolCalls: 0, edits: 0, approvals: 0 } });
  assert.deepEqual(status.nextInputSuggestion, suggestion());
  const projected = AiSessionSummarySchema.parse(summary());
  assert.deepEqual(projected.nextInputSuggestion, suggestion());
  assert.equal("nextInputSuggestion" in AiSessionDetailSchema.shape, false);
  assert.equal(AiSessionDetailSchema.safeParse({ ...summary(), nextInputSuggestion: suggestion() }).success, false);
});

test("realtime next-input events use an explicit object or null payload", () => {
  const base = { type: "event", sessionId: "ais_0000000000000", source: "realtime" } as const;
  assert.equal(AiSessionRealtimeInputSchema.safeParse({ ...base, kind: "next-input-suggestion", suggestion: suggestion() }).success, true);
  assert.equal(AiSessionRealtimeInputSchema.safeParse({ ...base, kind: "next-input-suggestion", suggestion: null }).success, true);
  assert.equal(AiSessionRealtimeInputSchema.safeParse({ ...base, kind: "next-input-suggestion", suggestion: null, suggestionError: suggestionError() }).success, true);
  assert.equal(AiSessionRealtimeInputSchema.safeParse({ ...base, kind: "next-input-suggestion", suggestionError: suggestionError() }).success, true);
  assert.equal(AiSessionRealtimeInputSchema.safeParse({ ...base, kind: "next-input-suggestion", suggestion: suggestion(), suggestionError: suggestionError() }).success, false);
  assert.equal(AiSessionRealtimeInputSchema.safeParse({ ...base, kind: "next-input-suggestion" }).success, false);
  assert.equal(AiSessionRealtimeInputSchema.safeParse({ ...base, kind: "lifecycle", status: "idle", suggestion: suggestion() }).success, false);
  assert.equal(AiSessionRealtimeInputSchema.safeParse({ ...base, kind: "lifecycle", status: "idle", suggestionError: suggestionError() }).success, false);
});

test("next-input suggestion patches carry a protocol-valid event reason", () => {
  const eventMeta = { ...meta, reason: "next-input-suggestion", previousRevision: 1 };
  assert.equal(AiSessionEventMetaSchema.safeParse(eventMeta).success, true);
  assert.equal(AiSessionPatchEventSchema.safeParse({ meta: eventMeta, upserted: [summary()], removed: [] }).success, true);
});

test("suggestion reasoning modes are additive, default to none, and resolve follow-session explicitly", () => {
  assert.deepEqual(AiSessionNextInputSuggestionReasoningEffortSchema.options, [
    "session", "none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra",
  ]);
  assert.equal(AI_SESSION_NEXT_INPUT_SUGGESTION_DEFAULT_REASONING_EFFORT, "none");
  assert.equal(resolveAiSessionNextInputSuggestionReasoningEffort("session", "high"), "high");
  assert.equal(resolveAiSessionNextInputSuggestionReasoningEffort("session", undefined), undefined);
  assert.equal(resolveAiSessionNextInputSuggestionReasoningEffort("none", "high"), "none");
  assert.equal(resolveAiSessionNextInputSuggestionReasoningEffort("minimal", undefined), "minimal");
  assert.equal(AiSessionNextInputSuggestionReasoningEffortSchema.safeParse("future").success, false);
});

test("instance configuration defaults the reasoning mode to none and rejects unknown modes", () => {
  assert.equal(
    ControlledInstanceSchema.shape.config.parse({}).aiSessionNextInputSuggestionReasoningEffort,
    "none",
  );
  assert.equal(
    InstanceConfigInputSchema.parse({ aiSessionNextInputSuggestionReasoningEffort: "session" }).aiSessionNextInputSuggestionReasoningEffort,
    "session",
  );
  assert.equal(
    InstanceConfigInputSchema.safeParse({ aiSessionNextInputSuggestionReasoningEffort: "future" }).success,
    false,
  );
  assert.equal(
    UpdateInstanceInputSchema.parse({
      config: {
        aiSessionNextInputSuggestionModelSelection: null,
      },
    }).config?.aiSessionNextInputSuggestionModelSelection,
    null,
  );
  assert.equal(
    InstanceConfigInputSchema.safeParse({
      aiSessionNextInputSuggestionModelSelection: null,
    }).success,
    false,
  );
  assert.equal(
    ControlledInstanceSchema.shape.config.parse({
      aiSessionNextInputSuggestionModelSelection: {
        modelEntityId: "mdl_suggestion",
        modelName: "Suggestion model",
      },
    }).aiSessionNextInputSuggestionModelSelection?.modelEntityId,
    "mdl_suggestion",
  );
});

test("consumer capability is additive and independent from subagents", () => {
  assert.equal(supportsAiSessionConsumerNextInputSuggestion({ subagents: true }), false);
  assert.equal(supportsAiSessionConsumerNextInputSuggestion({ subagents: true, nextInputSuggestion: true }), true);
  assert.equal(supportsAiSessionConsumerNextInputSuggestion(undefined), false);
  assert.equal(AiSessionHierarchyCapabilitiesSchema.parse({ subagents: true }).nextInputSuggestion, false);
  assert.equal(supportsAiSessionProviderNextInputSuggestion({
    agent: "codex",
    actions: {},
    permissionModes: [],
    timeline: {},
    hierarchy: { subagents: true, nextInputSuggestion: true },
  }), true);
  assert.equal(supportsNodeAiSessionNextInputSuggestion({ aiSessionNextInputSuggestion: true }), true);
  assert.equal(supportsNodeAiSessionNextInputSuggestion(NodeAgentCapabilitiesSchema.parse({})), false);
  assert.equal(supportsNodeAiSessionNextInputSuggestionReasoningEffort({
    aiSessionNextInputSuggestionReasoningEffort: true,
  }), true);
  assert.equal(supportsNodeAiSessionNextInputSuggestionReasoningEffort(
    NodeAgentCapabilitiesSchema.parse({}),
  ), false);
  assert.equal(supportsAiSessionNextInputSuggestionReasoningEffort({
    features: { aiSessionNextInputSuggestionReasoningEffort: true },
  }), true);
  assert.equal(supportsAiSessionNextInputSuggestionReasoningEffort({ features: {} }), false);
  assert.equal(supportsNodeAiSessionNextInputSuggestionModelSelection({
    aiSessionNextInputSuggestionModelSelection: true,
  }), true);
  assert.equal(supportsNodeAiSessionNextInputSuggestionModelSelection(
    NodeAgentCapabilitiesSchema.parse({}),
  ), false);
  assert.equal(supportsAiSessionNextInputSuggestionModelSelection({
    features: { aiSessionNextInputSuggestionModelSelection: true },
  }), true);
  assert.equal(supportsAiSessionNextInputSuggestionModelSelection({ features: {} }), false);
});

test("snapshot projection strips suggestions without flattening opted-in subagents", () => {
  const child = { ...summary(true, { kind: "subagent", parentProviderSessionId: "thread-root" }), nextInputSuggestionError: suggestionError() };
  const snapshot = { runningCount: 0, waitingCount: 0, staleCount: 0, sessions: [child], updatedAt: now };
  const stripped = projectAiSessionsSnapshotForConsumer(snapshot as never, { subagents: true, nextInputSuggestion: false });
  assert.equal(stripped.sessions[0].nextInputSuggestion, undefined);
  assert.equal(stripped.sessions[0].nextInputSuggestionError, undefined);
  assert.deepEqual(stripped.sessions[0].lineage, { kind: "subagent", parentProviderSessionId: "thread-root" });
  const kept = projectAiSessionsSnapshotForConsumer(snapshot as never, { subagents: false, nextInputSuggestion: true });
  assert.deepEqual(kept.sessions[0].nextInputSuggestion, suggestion());
  assert.deepEqual(kept.sessions[0].nextInputSuggestionError, suggestionError());
  assert.equal(kept.sessions[0].lineage, undefined);
  const noStrip = projectAiSessionsSnapshotForConsumer(snapshot as never, { subagents: false, nextInputSuggestion: false });
  assert.equal(noStrip.sessions[0].nextInputSuggestion, undefined);
});

test("delta and stream projection strip the suggestion when the consumer did not declare it", () => {
  const delta = {
    streamId: "stream",
    instanceId: "inst",
    sinceRevision: 1,
    latestRevision: 2,
    earliestRetainedRevision: 1,
    syncRequired: false,
    events: [{
      type: "ai-session.patch",
      payload: { meta, upserted: [summary(true)], removed: [] },
    }],
  };
  const projected = projectAiSessionDeltaForConsumer(delta as never, { subagents: true, nextInputSuggestion: false });
  assert.equal(projected.events[0].payload.upserted[0].nextInputSuggestion, undefined);
  const retained = projectAiSessionDeltaForConsumer(delta as never, { subagents: true, nextInputSuggestion: true });
  assert.deepEqual(retained.events[0].payload.upserted[0].nextInputSuggestion, suggestion());

  const stream = {
    type: "ai-session.patch",
    payload: { meta, upserted: [summary(true)], removed: [] },
  };
  const projectedStream = projectAiSessionStreamEventForConsumer(stream as never, { subagents: true, nextInputSuggestion: false });
  assert.equal(projectedStream.payload.upserted[0].nextInputSuggestion, undefined);
});
