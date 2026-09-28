import assert from "node:assert/strict";
import test from "node:test";
import {
  AGENT_ORCHESTRATION_DEFAULT_ID_PREFIX,
  AgentOrchestrationCreateInputSchema,
  AgentOrchestrationSchema,
  AgentOrchestrationUpdateInputSchema,
  agentOrchestrationContainsAgent,
  agentOrchestrationEntryAgentIds,
  agentOrchestrationHasEdge,
  defaultAgentOrchestrationId,
  defaultAgentOrchestrationOwnerAgentId,
  findAgentOrchestrationCycle,
  isDefaultAgentOrchestrationId,
  normalizeAgentOrchestrationGraph,
  sanitizeAgentOrchestration,
} from "../src/agent-orchestrations.ts";

const timestamp = "2026-09-28T00:00:00.000Z";

function orchestration() {
  return {
    id: "orchestration_one",
    revision: "a".repeat(64),
    name: "Release checks",
    agentIds: ["agent_entry", "agent_reviewer"],
    edges: [{ fromAgentId: "agent_entry", toAgentId: "agent_reviewer" }],
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

test("Default orchestration ids derive deterministically from the owning Agent", () => {
  assert.equal(defaultAgentOrchestrationId("agent_one"), `${AGENT_ORCHESTRATION_DEFAULT_ID_PREFIX}agent_one`);
  assert.equal(isDefaultAgentOrchestrationId("default:agent_one"), true);
  assert.equal(isDefaultAgentOrchestrationId("orchestration_one"), false);
  assert.equal(defaultAgentOrchestrationOwnerAgentId("default:agent_one"), "agent_one");
  assert.equal(defaultAgentOrchestrationOwnerAgentId("orchestration_one"), undefined);
  assert.equal(defaultAgentOrchestrationOwnerAgentId("default:"), undefined);
});

test("Top-level entry nodes are derived from in-degree and tolerate multiple roots", () => {
  assert.deepEqual(agentOrchestrationEntryAgentIds({ agentIds: ["a", "b"], edges: [{ fromAgentId: "a", toAgentId: "b" }] }), ["a"]);
  // 多顶级节点：两条互不相连的链都保留为入口。
  assert.deepEqual(agentOrchestrationEntryAgentIds({
    agentIds: ["a", "b", "c", "d"],
    edges: [{ fromAgentId: "a", toAgentId: "b" }, { fromAgentId: "c", toAgentId: "d" }],
  }), ["a", "c"]);
  assert.equal(agentOrchestrationContainsAgent({ agentIds: ["a"], edges: [] }, "a"), true);
  assert.equal(agentOrchestrationHasEdge({ agentIds: ["a", "b"], edges: [{ fromAgentId: "a", toAgentId: "b" }] }, "a", "b"), true);
  assert.equal(agentOrchestrationHasEdge({ agentIds: ["a", "b"], edges: [{ fromAgentId: "a", toAgentId: "b" }] }, "b", "a"), false);
});

test("Graph normalization deduplicates and sorts before revision computation", () => {
  assert.deepEqual(normalizeAgentOrchestrationGraph({
    agentIds: ["b", "a", "b"],
    edges: [
      { fromAgentId: "b", toAgentId: "a" },
      { fromAgentId: "b", toAgentId: "a" },
      { fromAgentId: "a", toAgentId: "b" },
    ],
  }), {
    agentIds: ["a", "b"],
    edges: [{ fromAgentId: "a", toAgentId: "b" }, { fromAgentId: "b", toAgentId: "a" }],
  });
});

test("Cycle detection returns the offending path and clears acyclic graphs", () => {
  assert.equal(findAgentOrchestrationCycle({ agentIds: ["a", "b"], edges: [{ fromAgentId: "a", toAgentId: "b" }] }), undefined);
  assert.equal(findAgentOrchestrationCycle({ agentIds: ["a"], edges: [] }), undefined);
  assert.deepEqual(findAgentOrchestrationCycle({
    agentIds: ["a", "b", "c"],
    edges: [
      { fromAgentId: "a", toAgentId: "b" },
      { fromAgentId: "b", toAgentId: "c" },
      { fromAgentId: "c", toAgentId: "a" },
    ],
  }), ["a", "b", "c", "a"]);
});

test("Orchestration writes are strict while reads tolerate additive unknown fields", () => {
  assert.equal(AgentOrchestrationSchema.safeParse({ ...orchestration(), future: true }).success, false);
  assert.equal(AgentOrchestrationCreateInputSchema.safeParse({
    name: "Release checks",
    agentIds: ["agent_entry"],
    edges: [],
  }).success, true);
  assert.equal(AgentOrchestrationCreateInputSchema.safeParse({ name: "Release checks", agentIds: [] }).success, false);
  assert.equal(AgentOrchestrationUpdateInputSchema.safeParse({ expectedRevision: "a".repeat(64) }).success, true);
  assert.equal(AgentOrchestrationUpdateInputSchema.safeParse({ expectedRevision: "a".repeat(64), agentIds: [] }).success, false);
  // 旧记录或未来字段只被丢弃，不让整条记录读取失败。
  assert.deepEqual(sanitizeAgentOrchestration({
    ...orchestration(),
    edges: [{ fromAgentId: "agent_entry", toAgentId: "agent_reviewer" }],
    ownerAgentId: "agent_entry",
    future: true,
  }), orchestration());
});
