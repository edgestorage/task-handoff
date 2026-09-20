import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_STORY_AGENT_TOOL_POLICY,
  normalizeStoryAgentToolPolicy,
  resolveStoryAgentToolNames,
  sanitizeStoryAgentToolResolution,
  storyAgentPagination,
  StoryAgentActionListResultSchema,
  StoryAgentAutomationCreateInputSchema,
  StoryAgentAutomationStatusSchema,
  StoryAgentAiSessionGetResultSchema,
  StoryAgentAiSessionTurnResultSchema,
  StoryAgentContentSetResultSchema,
  StoryAgentToolPolicySchema,
  StoryAgentToolPolicyUpdateInputSchema,
  storyAgentToolPolicyRevisionSource,
} from "../src/story-agent-tools.ts";
import { nodeAgentCapabilitiesFromPublicNode, nodeStoryAgentToolCapabilities, normalizeNodeAgentCapabilities } from "../src/control-plane.ts";

test("Story Agent Tool policy is strict on input and tolerant on consumer reads", () => {
  assert.equal(StoryAgentToolPolicySchema.safeParse({ ...DEFAULT_STORY_AGENT_TOOL_POLICY, unknown: true }).success, false);
  assert.equal(StoryAgentToolPolicyUpdateInputSchema.safeParse({ policy: DEFAULT_STORY_AGENT_TOOL_POLICY, unknown: true }).success, false);
  assert.deepEqual(normalizeStoryAgentToolPolicy({ content: false, actions: true, future: true }), {
    content: false,
    actions: true,
    automations: false,
    aiSessions: false,
  });
  assert.deepEqual(normalizeStoryAgentToolPolicy(undefined), DEFAULT_STORY_AGENT_TOOL_POLICY);
});

test("Story Agent Tool categories resolve deterministically and archive removes mutations", () => {
  const policy = { content: true, actions: true, automations: true, aiSessions: false };
  assert.deepEqual(resolveStoryAgentToolNames(policy), [
    "story_list_content", "story_get_content", "story_set_content",
    "story_list_actions", "story_run_action",
    "story_list_automations", "story_create_automation", "story_update_automation",
    "story_delete_automation", "story_run_automation", "story_list_automation_runs",
  ]);
  assert.deepEqual(resolveStoryAgentToolNames(policy, { archived: true }), [
    "story_list_content", "story_get_content", "story_list_actions",
    "story_list_automations", "story_list_automation_runs",
  ]);
  assert.equal(storyAgentToolPolicyRevisionSource(policy), storyAgentToolPolicyRevisionSource({ ...policy }));
});

test("Story Agent Tool resolution ignores unknown tool names", () => {
  const value = sanitizeStoryAgentToolResolution({
    storyId: "story_1",
    policy: DEFAULT_STORY_AGENT_TOOL_POLICY,
    revision: "a".repeat(64),
    enabledTools: ["story_list_content", "story_future_tool"],
    future: true,
  });
  assert.deepEqual(value.enabledTools, ["story_list_content"]);
});

test("Automation tool creation only accepts an existing action reference", () => {
  assert.equal(StoryAgentAutomationCreateInputSchema.safeParse({
    actionId: "action_1",
    schedule: { scheduleKind: "interval", intervalMs: 60_000 },
  }).success, true);
  assert.equal(StoryAgentAutomationCreateInputSchema.safeParse({
    action: { id: "action_1", title: "Action", promptTemplate: "Run" },
    schedule: { scheduleKind: "interval", intervalMs: 60_000 },
  }).success, false);
});

test("Story Agent output schemas expose only bounded domain projections", () => {
  assert.deepEqual(StoryAgentContentSetResultSchema.parse({
    title: "Release notes",
    storyPath: "release.md",
    revision: "a".repeat(64),
    size: 42,
  }), {
    title: "Release notes",
    storyPath: "release.md",
    revision: "a".repeat(64),
    size: 42,
  });
  assert.equal(StoryAgentActionListResultSchema.safeParse({
    actions: [{
      id: "action_1",
      title: "Ship",
      promptPreview: "x".repeat(500),
      promptTruncated: true,
      executable: false,
      unavailableReason: "STORY_ACTION_TARGET_REQUIRED",
      targetInstanceId: "private",
    }],
    pagination: { totalItems: 1 },
  }).success, false);
  assert.equal(StoryAgentAutomationStatusSchema.safeParse({
    id: "automation_1",
    actionId: "action_1",
    schedule: { scheduleKind: "interval", intervalMs: 60_000 },
    enabled: true,
    policy: { maxConcurrentRuns: 1, whenBusy: "skip" },
    updatedAt: "2026-09-20T00:00:00.000Z",
    effectiveStatus: "scheduled",
    activeRunCount: 0,
    storyId: "story_1",
  }).success, false);
  assert.deepEqual(storyAgentPagination(21, 1, 20), { totalItems: 21, nextPage: 2 });
  assert.deepEqual(storyAgentPagination(501, 500, 1), { totalItems: 501 });
});

test("Story AI Session Agent outputs exclude Timeline and cache revision fields", () => {
  const ref = { instanceId: "instance_1", sessionId: "session_1" };
  const session = { cwd: "/workspace", modelName: "gpt-5" };
  const pagination = { totalItems: 1 };
  assert.equal(StoryAgentAiSessionGetResultSchema.safeParse({
    ref,
    session,
    turns: [{ id: "turn_1", status: "completed" }],
    pagination,
  }).success, true);
  assert.equal(StoryAgentAiSessionGetResultSchema.safeParse({
    ref,
    session: { ...session, id: "session_1" },
    turns: [{ id: "turn_1", status: "completed" }],
    pagination,
  }).success, false);
  assert.equal(StoryAgentAiSessionTurnResultSchema.safeParse({
    ref,
    turn: { id: "turn_1", status: "completed", userPrompt: "duplicate" },
    items: [{ id: "message_1", type: "user-message", text: "hello" }],
    pagination,
  }).success, false);
  assert.equal(StoryAgentAiSessionTurnResultSchema.safeParse({
    ref,
    turn: { id: "turn_1", status: "completed" },
    items: [{ id: "message_1", turnId: "turn_1", type: "user-message", text: "hello" }],
    pagination,
    timeline: { turnId: "turn_1" },
  }).success, false);
});

test("v0.0.32 capabilities normalize new Story tool domains to unsupported", () => {
  assert.deepEqual(nodeStoryAgentToolCapabilities({ stories: { enabled: true, agentTools: true } }), {
    policy: false,
    actions: false,
    automations: false,
    aiSessionRead: false,
  });
  assert.equal(normalizeNodeAgentCapabilities({ stories: { enabled: true, agentTools: true } }).stories.agentTools, true);
});

test("public Node records expose only their nested node-agent capability document to feature queries", () => {
  const document = { stories: { agentToolCapabilities: { policy: true } } };
  assert.equal(nodeAgentCapabilitiesFromPublicNode({ agent: { capabilities: document } }), document);
  assert.equal(nodeAgentCapabilitiesFromPublicNode({ stories: document.stories }), undefined);
  assert.equal(nodeAgentCapabilitiesFromPublicNode({}), undefined);
});
