import assert from "node:assert/strict";
import test from "node:test";
import { agentCatalogKey, agentCatalogMemberRows, buildAgentCatalog, agentCatalogGroups, callableAgentCandidates } from "../src/apps/control-plane/agent/agentCatalog.ts";

const definition = (overrides) => ({
  id: "agent-a",
  revision: "a".repeat(64),
  name: "Agent A",
  description: "",
  appendedPrompt: "",
  targetInstanceId: "inst-a",
  cwdFolderId: "folder-a",
  providerId: "codex",
  executionPolicy: { workspaceMaterializer: "overlay-copy-on-write", processSandbox: "instance" },
  callableAgentIds: [],
  createdAt: "2026-09-26T00:00:00.000Z",
  updatedAt: "2026-09-26T00:00:00.000Z",
  ...overrides,
});

// 公开 Node 把 capability document 放在 agent.capabilities 下，能力判定只认这条权威路径。
const node = (id, capabilities) => ({ id, name: `Node ${id}`, status: "online", capabilities: { agent: { capabilities } } });
const capableCapabilities = {
  agentExecution: {
    definitions: true,
    runs: true,
    combinations: [{ runtime: "docker", workspaceMaterializer: "overlay-copy-on-write", processSandbox: "instance", providerId: "codex" }],
  },
};
const definitionsOnlyCapabilities = {
  agentExecution: {
    definitions: true,
    runs: false,
    combinations: [],
  },
};
const instance = (overrides) => ({
  id: "inst-a",
  nodeId: "node-a",
  name: "Instance A",
  node: { id: "node-a", name: "Node node-a" },
  connectionStatus: "connected",
  runtime: { type: "docker" },
  source: { type: "local-folder", path: "/host/project" },
  ...overrides,
});

test("catalog aggregates definitions per node and exposes only node-supported nodes", () => {
  const catalog = buildAgentCatalog({
    nodes: [node("node-a", capableCapabilities), node("node-b", {}), node("node-c", definitionsOnlyCapabilities)],
    definitions: [
      { nodeId: "node-a", agent: definition({}) },
      { nodeId: "node-c", agent: definition({ id: "agent-c", targetInstanceId: "inst-c" }) },
    ],
    instances: [instance({}), instance({ id: "inst-c", nodeId: "node-c", name: "Instance C", node: { id: "node-c", name: "Node node-c" } })],
    foldersByNode: new Map([["node-a", [{ id: "folder-a", name: "project", path: "/host/project" }]]]),
  });
  assert.deepEqual(catalog.nodes.map((entry) => entry.id), ["node-a", "node-c"]);
  assert.equal(catalog.agents.length, 2);
  assert.equal(catalog.runs.length, 0);
  const [agentA, agentC] = catalog.agents;
  assert.equal(agentA.revision, "a".repeat(64));
  assert.equal(agentA.nodeLabel, "Node node-a");
  assert.equal(agentA.instanceLabel, "Instance A · Node node-a");
  assert.equal(agentA.folderPath, "/host/project");
  assert.equal(agentA.executable, true);
  assert.equal(agentA.blockedCode, undefined);
  // 只发布 definitions 的 Node 仍可维护定义，但执行策略未探测通过前一律阻塞。
  assert.equal(agentC.runsSupported, false);
  assert.equal(agentC.blockedCode, "policy-unsupported");
  assert.equal(agentC.executable, false);
  assert.deepEqual(agentCatalogGroups(catalog).map((group) => group.nodeId), ["node-a", "node-c"]);
});

test("catalog keeps same-id Agents on different nodes as distinct aggregate identities", () => {
  const catalog = buildAgentCatalog({
    nodes: [node("node-a", capableCapabilities), node("node-b", capableCapabilities)],
    definitions: [
      { nodeId: "node-a", agent: definition({ name: "Agent on A" }) },
      { nodeId: "node-b", agent: definition({ name: "Agent on B", targetInstanceId: "inst-b" }) },
    ],
    instances: [
      instance({}),
      instance({ id: "inst-b", nodeId: "node-b", name: "Instance B", node: { id: "node-b", name: "Node node-b" } }),
    ],
    foldersByNode: new Map(),
  });

  assert.deepEqual(catalog.agents.map((agent) => agent.key), [
    agentCatalogKey("node-a", "agent-a"),
    agentCatalogKey("node-b", "agent-a"),
  ]);
  assert.equal(new Set(catalog.agents.map((agent) => agent.key)).size, 2);
  assert.deepEqual(agentCatalogGroups(catalog).map((group) => group.agents[0]?.name), ["Agent on A", "Agent on B"]);
  assert.deepEqual(callableAgentCandidates(catalog.agents, "node-a", "different-agent").map((agent) => agent.name), ["Agent on A"]);
});

test("catalog derives Story entry labels from Story-owned entry sets per node", () => {
  const catalog = buildAgentCatalog({
    nodes: [node("node-a", capableCapabilities), node("node-b", capableCapabilities)],
    definitions: [
      { nodeId: "node-a", agent: definition({}) },
      { nodeId: "node-b", agent: definition({ targetInstanceId: "inst-b" }) },
    ],
    instances: [
      instance({}),
      instance({ id: "inst-b", nodeId: "node-b", node: { id: "node-b", name: "Node node-b" } }),
    ],
    foldersByNode: new Map(),
    storyEntries: [{
      nodeId: "node-a",
      storyLabel: "Release",
      entrySet: { storyId: "story-a", revision: "b".repeat(64), entries: [{ agentId: "agent-a", status: "available" }] },
    }],
  });

  assert.deepEqual(catalog.agents[0].entryStoryLabels, ["Release"]);
  assert.deepEqual(catalog.agents[1].entryStoryLabels, []);
});

test("catalog derives path and provider label from authoritative node data, not from the definition", () => {
  const catalog = buildAgentCatalog({
    nodes: [node("node-a", capableCapabilities)],
    definitions: [{ nodeId: "node-a", agent: definition({ modelName: "gpt-5.6-terra", providerId: "claude" }) }],
    instances: [instance({ runtime: { type: "local", kind: "local" } })],
    foldersByNode: new Map([]),
    providerLabel: (_instance, providerId) => (providerId === "claude" ? "Claude" : providerId),
  });
  const [agent] = catalog.agents;
  assert.equal(agent.model, "gpt-5.6-terra");
  assert.equal(agent.provider, "Claude");
  // 文件夹不在该 Node 的权威列表里时不推断路径，只按已发布状态阻塞。
  assert.equal(agent.folderPath, "");
  assert.equal(agent.blockedCode, "local-runtime");
  assert.equal(agent.executable, false);
});

test("catalog blocks the first unmet precondition instead of downgrading the execution", () => {
  const cases = [
    { node: node("node-a", {}), instances: [instance({})], expected: "definitions-unsupported" },
    { node: { ...node("node-a", capableCapabilities), status: "offline" }, instances: [instance({})], expected: "node-offline" },
    { node: node("node-a", capableCapabilities), instances: [], expected: "instance-missing" },
    { node: node("node-a", capableCapabilities), instances: [instance({ runtime: { type: "local", kind: "local" } })], expected: "local-runtime" },
    { node: node("node-a", capableCapabilities), instances: [instance({ connectionStatus: "offline" })], expected: "instance-offline" },
    {
      node: node("node-a", definitionsOnlyCapabilities),
      instances: [instance({})],
      expected: "policy-unsupported",
    },
  ];
  for (const { node: target, instances, expected } of cases) {
    const catalog = buildAgentCatalog({
      nodes: [target],
      definitions: [{ nodeId: "node-a", agent: definition({}) }],
      instances,
      foldersByNode: new Map(),
    });
    assert.equal(catalog.agents[0]?.blockedCode, expected);
    assert.equal(catalog.agents[0]?.executable, false);
  }
});

test("catalog keeps callable targets that are not resolvable instead of rewriting them", () => {
  const catalog = buildAgentCatalog({
    nodes: [node("node-a", capableCapabilities)],
    definitions: [{ nodeId: "node-a", agent: definition({ callableAgentIds: ["agent-missing"] }) }],
    instances: [instance({})],
    foldersByNode: new Map(),
  });
  assert.deepEqual(catalog.agents[0].callableAgentIds, ["agent-missing"]);
  assert.equal(catalog.agents[0].blockedCode, "missing-reference");
  assert.deepEqual(callableAgentCandidates(catalog.agents, "node-a", "agent-a"), []);
});

test("catalog projects authoritative Run members without inventing shared-space diagnostics", () => {
  const catalog = buildAgentCatalog({
    nodes: [node("node-a", capableCapabilities)],
    definitions: [{ nodeId: "node-a", agent: definition({}) }],
    instances: [instance({})],
    foldersByNode: new Map(),
    runs: [{ nodeId: "node-a", run: {
      runId: "run-a",
      clientRequestId: "request-a",
      revision: 1,
      status: "completed",
      provenance: { initiatingInstanceId: "inst-a", initiatingAiSessionId: "session-a", storyId: "story-a" },
      rootMemberId: "member-a",
      budget: { maxMembers: 4, maxDepth: 2, maxConcurrency: 1 },
      cleanup: { status: "completed", attempts: 1, updatedAt: "2026-09-26T00:00:04.000Z" },
      resultDelivery: { status: "delivered", attempts: 1, updatedAt: "2026-09-26T00:00:04.000Z", deliveredAt: "2026-09-26T00:00:04.000Z" },
      sharedSpace: { runtimeId: "runtime-a", state: "retained", usageBytes: 4096, quotaBytes: 1073741824, expiresAt: "2026-10-03T00:00:04.000Z" },
      members: [{
        memberId: "member-a",
        runId: "run-a",
        agentId: "agent-a",
        instanceId: "inst-a",
        role: "root",
        depth: 0,
        status: "completed",
        executionSnapshot: {
          agentRevision: "a".repeat(64),
          targetInstanceId: "inst-a",
          cwdFolderId: "folder-a",
          appendedPrompt: "",
          providerId: "codex",
          executionPolicy: { workspaceMaterializer: "overlay-copy-on-write", processSandbox: "instance" },
        },
        result: { text: "Done", truncated: false },
        createdAt: "2026-09-26T00:00:00.000Z",
        updatedAt: "2026-09-26T00:00:03.000Z",
        completedAt: "2026-09-26T00:00:03.000Z",
      }],
      timeline: [],
      createdAt: "2026-09-26T00:00:00.000Z",
      updatedAt: "2026-09-26T00:00:04.000Z",
      completedAt: "2026-09-26T00:00:04.000Z",
    } }],
  });
  assert.equal(catalog.runs[0].members[0].agentLabel, "Agent A");
  assert.equal(catalog.runs[0].members[0].resultSummary, "Done");
  assert.equal(catalog.runs[0].workspaceDestroyed, true);
  assert.equal(catalog.runs[0].revision, 1);
  assert.equal(catalog.runs[0].resultDeliveryStatus, "delivered");
  assert.equal(catalog.runs[0].sharedExpiresLabel, "2026-10-03T00:00:04.000Z");
  assert.equal(catalog.runs[0].sharedUsageBytes, 4096);
  assert.equal(catalog.runs[0].sharedQuotaBytes, 1073741824);
  assert.equal(catalog.runs[0].sharedRootPath, undefined);
});

test("member rows preserve arbitrary call depth, duplicate Agent executions, orphans, and malformed cycles", () => {
  const member = (memberId, agentId, parentMemberId) => ({
    memberId,
    agentId,
    agentLabel: agentId,
    instanceLabel: "Instance A",
    ...(parentMemberId ? { parentMemberId } : {}),
    status: "completed",
    durationLabel: "1s",
    resultSummary: memberId,
  });
  const rows = agentCatalogMemberRows([
    member("root", "agent-a"),
    member("child", "agent-b", "root"),
    member("grandchild-1", "agent-a", "child"),
    member("grandchild-2", "agent-a", "child"),
    member("orphan", "agent-c", "missing-parent"),
    member("cycle-a", "agent-d", "cycle-b"),
    member("cycle-b", "agent-e", "cycle-a"),
  ]);

  assert.deepEqual(rows.map((row) => [row.member.memberId, row.depth]), [
    ["root", 0],
    ["child", 1],
    ["grandchild-1", 2],
    ["grandchild-2", 2],
    ["orphan", 0],
    ["cycle-a", 0],
    ["cycle-b", 1],
  ]);
  assert.equal(new Set(rows.map((row) => row.member.memberId)).size, 7);
  assert.equal(rows.find((row) => row.member.memberId === "child")?.parent?.memberId, "root");
  assert.equal(rows.find((row) => row.member.memberId === "orphan")?.parent, undefined);
});
