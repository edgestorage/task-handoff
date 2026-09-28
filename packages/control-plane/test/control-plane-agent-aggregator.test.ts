import assert from "node:assert/strict";
import test from "node:test";
import { ControlPlaneAgentAggregator, deriveAgentRunCallTree } from "../src/control-plane/agents/agent-aggregator.ts";
import { ControlPlaneEventBus } from "../src/control-plane/events/bus.ts";
import { NodeTunnelEventRouter } from "../src/control-plane/nodes/tunnel-event-router.ts";
import { defaultAgentOrchestrationId } from "@task-handoff/protocol/agent-orchestrations";

const revision = "a".repeat(64);
const timestamp = "2026-09-26T00:00:00.000Z";

function definition(id: string) {
  return {
    id,
    revision,
    name: id,
    description: "",
    appendedPrompt: "",
    targetInstanceId: "instance_one",
    cwdFolderId: "folder_one",
    providerId: "codex",
    executionPolicy: { workspaceMaterializer: "overlay-copy-on-write" as const, processSandbox: "instance" as const },
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function orchestration(id: string, agentIds: string[]) {
  return {
    id,
    revision,
    name: id,
    agentIds,
    edges: [],
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function member(memberId: string, parentMemberId?: string) {
  return {
    memberId,
    runId: "run_one",
    agentId: "agent_shared",
    ...(parentMemberId ? { parentMemberId } : {}),
    instanceId: "instance_one",
    role: parentMemberId ? "callee" as const : "root" as const,
    depth: parentMemberId ? 1 : 0,
    status: "queued" as const,
    executionSnapshot: {
      agentRevision: revision,
      targetInstanceId: "instance_one",
      cwdFolderId: "folder_one",
      appendedPrompt: "",
      providerId: "codex",
      executionPolicy: { workspaceMaterializer: "overlay-copy-on-write" as const, processSandbox: "instance" as const },
    },
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function run() {
  return {
    runId: "run_one",
    clientRequestId: "request_one",
    revision: 0,
    status: "queued" as const,
    provenance: { initiatingInstanceId: "instance_one", initiatingAiSessionId: "session_one", storyId: "story_one" },
    orchestrationId: defaultAgentOrchestrationId("agent_shared"),
    rootMemberId: "member_root",
    budget: { maxMembers: 4, maxDepth: 2, maxConcurrency: 1 },
    members: [member("member_root")],
    timeline: [],
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

test("Agent aggregator keys identical object ids by source Node and applies deletion events", () => {
  const aggregator = new ControlPlaneAgentAggregator();
  aggregator.replaceDefinitions("node_one", [definition("agent_shared")]);
  aggregator.replaceDefinitions("node_two", [definition("agent_shared")]);
  aggregator.handleEvent("node_one", "agent.definition.changed", {
    agentId: "agent_shared",
    change: "deleted",
    revision,
    definition: definition("agent_shared"),
  });
  assert.deepEqual(aggregator.definitionsForNode("node_one"), []);
  assert.equal(aggregator.definitionsForNode("node_two")[0]?.id, "agent_shared");
});

test("Agent aggregator projects member revisions and derives a call tree", () => {
  const aggregator = new ControlPlaneAgentAggregator();
  aggregator.handleEvent("node_one", "agent.run.changed", { runId: "run_one", revision: 0, run: run() });
  const child = member("member_child", "member_root");
  aggregator.handleEvent("node_one", "agent.run.member.changed", {
    runId: "run_one",
    memberId: child.memberId,
    revision: 1,
    member: child,
  });
  const projected = aggregator.runsForNode("node_one")[0]!;
  assert.equal(projected.revision, 1);
  const tree = deriveAgentRunCallTree(projected);
  assert.equal(tree[0]?.member.memberId, "member_root");
  assert.equal(tree[0]?.children[0]?.member.memberId, "member_child");
});

test("Node tunnel validates Agent events and adds Node identity only at the aggregate boundary", () => {
  const aggregator = new ControlPlaneAgentAggregator();
  const events = new ControlPlaneEventBus();
  const published: unknown[] = [];
  events.on((event) => published.push(event));
  const router = new NodeTunnelEventRouter({
    events,
    onAgentEvent: (nodeId, type, payload) => aggregator.handleEvent(nodeId, type, payload),
  });
  router.handle("node_one", {
    type: "node-agent.event.forwarded",
    event: {
      id: "event_one",
      type: "agent.definition.changed",
      createdAt: timestamp,
      payload: { agentId: "agent_one", change: "created", revision, definition: definition("agent_one") },
    },
  });
  const event = published[0] as { payload: { nodeId: string; event: { agentId: string } }; scope: { nodeId: string } };
  assert.equal(event.payload.nodeId, "node_one");
  assert.equal(event.payload.event.agentId, "agent_one");
  assert.deepEqual(event.scope, { nodeId: "node_one", instanceId: "instance_one" });
  assert.equal(aggregator.definitionsForNode("node_one")[0]?.id, "agent_one");
});

test("Agent aggregator keeps orchestration projections per Node alongside definitions", () => {
  const aggregator = new ControlPlaneAgentAggregator();
  aggregator.replaceOrchestrations("node_one", [orchestration("orchestration_one", ["agent_one"])]);
  aggregator.replaceOrchestrations("node_two", [orchestration("orchestration_one", ["agent_two"])]);
  aggregator.handleEvent("node_one", "agent.orchestration.changed", {
    orchestrationId: "orchestration_one",
    change: "deleted",
    revision,
    orchestration: orchestration("orchestration_one", ["agent_one"]),
  });
  assert.deepEqual(aggregator.orchestrationsForNode("node_one"), []);
  assert.deepEqual(aggregator.orchestrationsForNode("node_two").map((entry) => entry.agentIds), [["agent_two"]]);

  const events = new ControlPlaneEventBus();
  const published: unknown[] = [];
  events.on((event) => published.push(event));
  const router = new NodeTunnelEventRouter({
    events,
    onAgentEvent: (nodeId, type, payload) => aggregator.handleEvent(nodeId, type, payload),
  });
  router.handle("node_one", {
    type: "node-agent.event.forwarded",
    event: {
      id: "event_two",
      type: "agent.orchestration.changed",
      createdAt: timestamp,
      payload: { orchestrationId: "orchestration_one", change: "created", revision, orchestration: orchestration("orchestration_one", ["agent_one"]) },
    },
  });
  const event = published[0] as { payload: { nodeId: string; event: { orchestrationId: string } }; scope: { nodeId: string } };
  assert.equal(event.payload.nodeId, "node_one");
  assert.equal(event.payload.event.orchestrationId, "orchestration_one");
  assert.equal(event.scope.nodeId, "node_one");
});

test("Node tunnel treats capability changes as invalidation signals", async () => {
  const refreshed: string[] = [];
  const router = new NodeTunnelEventRouter({
    onCapabilitiesChanged: async (nodeId) => { refreshed.push(nodeId); },
  });
  router.handle("node_one", {
    type: "node-agent.event.forwarded",
    event: { type: "node-agent.capabilities.changed", payload: {} },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(refreshed, ["node_one"]);

  router.handle("node_one", {
    type: "node-agent.event.forwarded",
    event: { type: "node-agent.capabilities.changed", payload: null },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(refreshed, ["node_one"]);
});
