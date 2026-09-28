import assert from "node:assert/strict";
import test from "node:test";
import {
  AgentInvocationRequestSchema,
  AgentInvocationToolInputSchema,
  agentInvocationToolRevisionSource,
  resolveAgentInvocationToolGrant,
  sanitizeAgentInvocationToolGrant,
} from "../src/agent-invocation-tools.ts";

test("Agent invocation registry resolves an exact deterministic grant", () => {
  const grant = resolveAgentInvocationToolGrant([
    { agentId: "agent_b", orchestrationId: "orchestration_one" },
    { agentId: "agent_a", orchestrationId: "orchestration_one" },
    { agentId: "agent_a", orchestrationId: "orchestration_one" },
    { agentId: "agent_a", orchestrationId: "orchestration_two" },
  ]);
  assert.deepEqual(grant, {
    enabledTools: ["agent_run"],
    allowedTargets: [
      { agentId: "agent_a", orchestrationId: "orchestration_one" },
      { agentId: "agent_a", orchestrationId: "orchestration_two" },
      { agentId: "agent_b", orchestrationId: "orchestration_one" },
    ],
  });
  assert.deepEqual(resolveAgentInvocationToolGrant([]), { enabledTools: [], allowedTargets: [] });
  assert.equal(
    agentInvocationToolRevisionSource("a".repeat(64), grant),
    agentInvocationToolRevisionSource("a".repeat(64), resolveAgentInvocationToolGrant([
      { agentId: "agent_a", orchestrationId: "orchestration_two" },
      { agentId: "agent_b", orchestrationId: "orchestration_one" },
      { agentId: "agent_a", orchestrationId: "orchestration_one" },
    ])),
  );
});

test("Agent invocation grant sanitizer ignores unknown tools and fails closed without known tools", () => {
  assert.deepEqual(sanitizeAgentInvocationToolGrant({
    enabledTools: ["agent_run", "future_agent_tool"],
    allowedTargets: [
      { agentId: "agent_b", orchestrationId: "orchestration_one" },
      { agentId: "agent_a", orchestrationId: "orchestration_one" },
    ],
    future: true,
  }), {
    enabledTools: ["agent_run"],
    allowedTargets: [
      { agentId: "agent_a", orchestrationId: "orchestration_one" },
      { agentId: "agent_b", orchestrationId: "orchestration_one" },
    ],
  });
  assert.deepEqual(sanitizeAgentInvocationToolGrant(undefined), { enabledTools: [], allowedTargets: [] });
});

test("Sessions without a current Story grant never receive the Agent invocation tool", () => {
  assert.deepEqual(sanitizeAgentInvocationToolGrant(undefined), {
    enabledTools: [],
    allowedTargets: [],
  });
  assert.deepEqual(sanitizeAgentInvocationToolGrant({
    enabledTools: ["agent_run"],
    allowedTargets: [],
  }), {
    enabledTools: [],
    allowedTargets: [],
  });
});

test("Agent invocation accepts only model-owned task fields", () => {
  const input = { agentId: "agent_one", prompt: "Review this change", budget: { maxMembers: 4, maxDepth: 2, maxConcurrency: 2 } };
  assert.deepEqual(AgentInvocationToolInputSchema.parse(input), input);
  for (const forbidden of [
    { provenance: { storyId: "story_other" } },
    { cwd: "/host/private" },
    { processSandbox: "container" },
    { credential: "secret" },
    { clientRequestId: "model_owned" },
  ]) {
    assert.equal(AgentInvocationToolInputSchema.safeParse({ ...input, ...forbidden }).success, false);
  }
  assert.equal(AgentInvocationRequestSchema.safeParse({ clientRequestId: "agent_tool_1", input }).success, true);
  assert.equal(AgentInvocationRequestSchema.safeParse({ clientRequestId: "agent_tool_1", input, storyId: "story_other" }).success, false);
});
