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
  const grant = resolveAgentInvocationToolGrant(["agent_b", "agent_a", "agent_a"]);
  assert.deepEqual(grant, {
    enabledTools: ["agent_run"],
    allowedAgentIds: ["agent_a", "agent_b"],
  });
  assert.deepEqual(resolveAgentInvocationToolGrant([]), { enabledTools: [], allowedAgentIds: [] });
  assert.equal(
    agentInvocationToolRevisionSource("a".repeat(64), grant),
    agentInvocationToolRevisionSource("a".repeat(64), resolveAgentInvocationToolGrant(["agent_a", "agent_b"])),
  );
});

test("Agent invocation grant sanitizer ignores unknown tools and fails closed without known tools", () => {
  assert.deepEqual(sanitizeAgentInvocationToolGrant({
    enabledTools: ["agent_run", "future_agent_tool"],
    allowedAgentIds: ["agent_b", "agent_a"],
    future: true,
  }), {
    enabledTools: ["agent_run"],
    allowedAgentIds: ["agent_a", "agent_b"],
  });
  assert.deepEqual(sanitizeAgentInvocationToolGrant(undefined), { enabledTools: [], allowedAgentIds: [] });
});

test("Sessions without a current Story grant never receive the Agent invocation tool", () => {
  assert.deepEqual(sanitizeAgentInvocationToolGrant(undefined), {
    enabledTools: [],
    allowedAgentIds: [],
  });
  assert.deepEqual(sanitizeAgentInvocationToolGrant({
    enabledTools: ["agent_run"],
    allowedAgentIds: [],
  }), {
    enabledTools: [],
    allowedAgentIds: [],
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
