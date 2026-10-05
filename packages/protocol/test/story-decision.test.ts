import assert from "node:assert/strict";
import test from "node:test";
import {
  StoryDecisionCreateInputSchema,
  StoryDecisionDecideInputSchema,
  StoryDecisionListSchema,
  StoryDecisionSchema,
  StoryDecisionChangedEventSchema,
  sanitizeStoryDecisionList,
} from "../src/stories.ts";
import { AiSessionMessageInputSchema } from "../src/ai-sessions.ts";
import {
  DEFAULT_STORY_AGENT_TOOL_POLICY,
  StoryAgentDecisionRequestInputSchema,
  StoryAgentDecisionRequestResultSchema,
  StoryAgentToolNameSchema,
  StoryAgentToolPolicySchema,
  resolveStoryAgentToolNames,
  STORY_AGENT_TOOL_SCHEMAS,
} from "../src/story-agent-tools.ts";

const baseDecision = {
  id: "story_decision_1",
  storyId: "story_1",
  sessionId: "session_1",
  turnId: "turn_1",
  question: "Ship or hold?",
  options: [],
  allowFreeText: true,
  status: "pending",
  revision: 1,
  createdAt: "2026-09-28T00:00:00.000Z",
  updatedAt: "2026-09-28T00:00:00.000Z",
};

test("Story decision registration input rejects caller-supplied identity fields", () => {
  assert.equal(StoryDecisionCreateInputSchema.safeParse({ question: "Ship or hold?" }).success, true);
  for (const field of ["storyId", "sessionId", "turnId", "decisionId", "status", "revision"]) {
    assert.equal(
      StoryDecisionCreateInputSchema.safeParse({ question: "Ship or hold?", [field]: "x" }).success,
      false,
      field,
    );
  }
  assert.equal(StoryDecisionCreateInputSchema.safeParse({ question: "x", options: [
    { id: "a", label: "A" }, { id: "a", label: "B" },
  ] }).success, false);
  assert.equal(StoryDecisionCreateInputSchema.safeParse({ question: "x", allowFreeText: false }).success, false);
  assert.equal(StoryDecisionCreateInputSchema.safeParse({ question: "x", allowFreeText: false, options: [{ id: "a", label: "A" }] }).success, true);
});

test("Story decision decide and cancel inputs require optimistic concurrency", () => {
  assert.equal(StoryDecisionDecideInputSchema.safeParse({ optionId: "a", expectedRevision: 1 }).success, true);
  assert.equal(StoryDecisionDecideInputSchema.safeParse({ response: "hold", expectedRevision: 1 }).success, true);
  assert.equal(StoryDecisionDecideInputSchema.safeParse({ expectedRevision: 1 }).success, false);
  assert.equal(StoryDecisionDecideInputSchema.safeParse({ response: "hold" }).success, false);
  // 旧实例退化路径的显式重试开关。
  assert.equal(StoryDecisionDecideInputSchema.safeParse({ optionId: "a", expectedRevision: 1, retry: true }).success, true);
  assert.equal(StoryDecisionDecideInputSchema.safeParse({ optionId: "a", expectedRevision: 1, retry: "yes" }).success, false);
});

test("Story decision consumer reads drop unknown fields and tolerate missing decision data", () => {
  const parsed = sanitizeStoryDecisionList({ decisions: [
    { ...baseDecision, future: true },
    { id: "broken" },
  ], future: true });
  assert.deepEqual(parsed.decisions.map((decision) => decision.id), ["story_decision_1"]);
  assert.equal("future" in parsed.decisions[0]!, false);
  assert.deepEqual(sanitizeStoryDecisionList({}).decisions, []);
  assert.equal(StoryDecisionListSchema.parse({ decisions: [baseDecision] }).decisions.length, 1);
});

test("Story decision change events carry the authoritative revision and change type", () => {
  assert.equal(StoryDecisionChangedEventSchema.safeParse({
    storyId: "story_1", decisionId: "story_decision_1", revision: 2, change: "decided",
  }).success, true);
  assert.equal(StoryDecisionChangedEventSchema.safeParse({
    storyId: "story_1", decisionId: "story_decision_1", revision: 2, change: "unknown",
  }).success, false);
});

test("story_request_decision is a strict terminal tool in the decisions category", () => {
  assert.equal(StoryAgentToolNameSchema.safeParse("story_request_decision").success, true);
  const decisionsOnly = { content: false, actions: false, automations: false, aiSessions: false, decisions: true };
  assert.deepEqual(resolveStoryAgentToolNames(decisionsOnly), ["story_request_decision"]);
  assert.deepEqual(resolveStoryAgentToolNames(decisionsOnly, { archived: true }), []);
  assert.equal(StoryAgentDecisionRequestInputSchema.safeParse({ question: "Ship?" }).success, true);
  assert.equal(StoryAgentDecisionRequestInputSchema.safeParse({ question: "Ship?", sessionId: "s" }).success, false);
  assert.equal(StoryAgentDecisionRequestResultSchema.safeParse({ decisionId: "d", status: "pending" }).success, true);
  assert.equal(StoryAgentDecisionRequestResultSchema.safeParse({ decisionId: "d", status: "pending", question: "leak" }).success, false);
  assert.equal(STORY_AGENT_TOOL_SCHEMAS.story_request_decision.input, StoryAgentDecisionRequestInputSchema);
});

test("Story decision schema is strict and new Story tool policies default decisions on", () => {
  assert.equal(StoryDecisionSchema.safeParse({ ...baseDecision, extra: true }).success, false);
  assert.equal(StoryDecisionSchema.safeParse(baseDecision).success, true);
  assert.equal(StoryAgentToolPolicySchema.parse(DEFAULT_STORY_AGENT_TOOL_POLICY).decisions, true);
  assert.equal(StoryAgentToolPolicySchema.safeParse({ content: true, actions: false, automations: false, aiSessions: false }).success, false);
});

test("AI Session send input takes the additive clientRequestId while staying strict", () => {
  // 新实例声明幂等能力后接受该键；旧实例的 strict 入参不认识它，node-agent 因此退化到私有 resuming 账本。
  assert.equal(AiSessionMessageInputSchema.safeParse({ message: "Decision reply", clientRequestId: "story_decision_1" }).success, true);
  assert.equal(AiSessionMessageInputSchema.safeParse({ message: "Decision reply", futureField: true }).success, false);
});
