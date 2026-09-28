import assert from "node:assert/strict";
import test from "node:test";
import { consumeControlPlaneAgentEvent, controlPlaneAgentCapabilities, controlPlaneSupportsAgentExecutionPolicy, createControlPlaneAgentsApi } from "../src/agents.ts";
import type { ControlPlaneClientTransport } from "../src/transport.ts";

const revision = "a".repeat(64);

function definition(overrides: Record<string, unknown> = {}) {
  return {
    id: "agent_one",
    revision,
    name: "Reviewer",
    description: "",
    appendedPrompt: "Focus on regressions.",
    targetInstanceId: "instance_one",
    cwdFolderId: "folder_one",
    providerId: "codex",
    executionPolicy: { workspaceMaterializer: "overlay-copy-on-write", processSandbox: "instance" },
    createdAt: "2026-09-26T00:00:00.000Z",
    updatedAt: "2026-09-26T00:00:00.000Z",
    ...overrides,
  };
}

function orchestration(overrides: Record<string, unknown> = {}) {
  return {
    id: "default:agent_one",
    revision,
    name: "Reviewer",
    agentIds: ["agent_one"],
    edges: [],
    createdAt: "2026-09-26T00:00:00.000Z",
    updatedAt: "2026-09-26T00:00:00.000Z",
    ...overrides,
  };
}

function fixture(responses: Record<string, unknown>) {
  const requests: Array<{ path: string; init?: RequestInit }> = [];
  const transport: ControlPlaneClientTransport = {
    async request(path, schema, init) {
      requests.push({ path, init });
      return schema.parse({ data: responses[init?.method || "GET"] });
    },
  };
  return { api: createControlPlaneAgentsApi(transport), requests };
}

test("Agent client tolerates N-1 Node responses while keeping the aggregate envelope", async () => {
  const { api } = fixture({
    GET: {
      agents: [{ nodeId: "node_one", agent: definition({ futureField: "ignored" }) }],
      unavailableNodeIds: ["node_two"],
      futureField: "ignored",
    },
  });
  const aggregate = await api.list();
  assert.deepEqual(aggregate.unavailableNodeIds, ["node_two"]);
  assert.equal(aggregate.agents[0].nodeId, "node_one");
  assert.equal(aggregate.agents[0].agent.futureField, undefined);
  assert.equal(aggregate.agents[0].agent.appendedPrompt, "Focus on regressions.");
});

test("Agent client routes writes to the owning Node and clears presets with null", async () => {
  const { api, requests } = fixture({ POST: definition(), PATCH: definition({ revision: "b".repeat(64), modelName: undefined }) });
  const input = { name: "Reviewer", targetInstanceId: "instance_one", cwdFolderId: "folder_one", providerId: "codex" } as never;
  assert.equal((await api.create("node_one", input)).id, "agent_one");
  await api.update("agent_one", "node_one", { expectedRevision: revision, modelName: null } as never);

  assert.deepEqual(requests.map((request) => [request.path, request.init?.method]), [
    ["/api/agents", "POST"],
    ["/api/agents/agent_one", "PATCH"],
  ]);
  assert.deepEqual(JSON.parse(String(requests[1].init?.body)), { nodeId: "node_one", input: { expectedRevision: revision, modelName: null } });
});

test("Agent client routes Story entry and Run operations with source Node identity", async () => {
  const run = {
    runId: "run_one",
    clientRequestId: "request_one",
    revision: 0,
    status: "queued",
    provenance: { initiatingInstanceId: "instance_one", initiatingAiSessionId: "session_one", storyId: "story_one" },
    orchestrationId: "default:agent_one",
    rootMemberId: "member_one",
    budget: { maxMembers: 4, maxDepth: 2, maxConcurrency: 1 },
    createdAt: "2026-09-26T00:00:00.000Z",
    updatedAt: "2026-09-26T00:00:00.000Z",
  };
  const manualRun = { ...run, provenance: { source: "control-plane" } };
  const responses = [
    { storyId: "story_one", revision, entries: [{ agentId: "agent_missing", orchestrationId: "default:agent_missing", status: "missing-reference" }] },
    { runs: [{ nodeId: "node_one", run: { ...run, future: true } }], unavailableNodeIds: [] },
    run,
    manualRun,
  ];
  const requests: Array<{ path: string; init?: RequestInit }> = [];
  const transport: ControlPlaneClientTransport = {
    async request(path, schema, init) {
      requests.push({ path, init });
      return schema.parse({ data: responses.shift() });
    },
  };
  const api = createControlPlaneAgentsApi(transport);
  assert.equal((await api.storyEntries("story_one", "node_one")).entries[0]?.status, "missing-reference");
  assert.equal((await api.listRuns("node_one")).runs[0]?.run.runId, "run_one");
  assert.equal((await api.cancelRun("run_one", "node_one")).status, "queued");
  assert.equal((await api.createManualRun("node_one", {
    clientRequestId: "request_manual",
    orchestrationId: "default:agent_one",
    input: { prompt: "Run checks" },
  })).provenance.source, "control-plane");
  assert.deepEqual(requests.map(({ path, init }) => [path, init?.method]), [
    ["/api/stories/story_one/agent-entries?nodeId=node_one", undefined],
    ["/api/agent-runs?nodeId=node_one", undefined],
    ["/api/agent-runs/run_one/cancel", "POST"],
    ["/api/agent-runs/manual", "POST"],
  ]);
  assert.deepEqual(JSON.parse(String(requests[2]?.init?.body)), { nodeId: "node_one", input: {} });
  assert.deepEqual(JSON.parse(String(requests[3]?.init?.body)), {
    nodeId: "node_one",
    input: { clientRequestId: "request_manual", orchestrationId: "default:agent_one", input: { prompt: "Run checks" } },
  });
});

test("Agent client uses canonical capability normalization for N-1 and current Nodes", () => {
  assert.deepEqual(controlPlaneAgentCapabilities({ agent: { capabilities: {} } }), {
    definitions: false,
    runs: false,
    storyEntryAuthorization: false,
    orchestrations: false,
    runMembers: false,
    manualRuns: false,
    execution: {
      definitions: false,
      runs: false,
      orchestration: { storyEntryAuthorization: false, orchestrations: false, runMembers: false, manualRuns: false },
      sharedSpace: { enabled: false, runtimes: [] },
      combinations: [],
    },
  });
  assert.equal(controlPlaneAgentCapabilities({ agent: { capabilities: { agentExecution: { definitions: true } } } }).definitions, true);
  assert.equal(controlPlaneAgentCapabilities({ agent: { capabilities: { agentExecution: { orchestration: { orchestrations: true } } } } }).orchestrations, true);
  assert.equal(controlPlaneSupportsAgentExecutionPolicy({
    combinations: [{ runtime: "docker", workspaceMaterializer: "overlay-copy-on-write", processSandbox: "instance", providerId: "codex" }],
  }, { workspaceMaterializer: "overlay-copy-on-write", processSandbox: "instance" }, { runtime: "docker", providerId: "codex" }), true);
});

test("Agent client consumes tolerant aggregate events and ignores malformed frames", () => {
  const event = consumeControlPlaneAgentEvent({
    type: "agent.definition.changed",
    payload: {
      nodeId: "node_one",
      futureEnvelopeField: true,
      event: {
        agentId: "agent_one",
        change: "updated",
        revision,
        definition: definition({ futureDefinitionField: true }),
        futureEventField: true,
      },
    },
  });
  assert.equal(event?.payload.nodeId, "node_one");
  assert.equal(event?.payload.event.definition?.id, "agent_one");
  assert.equal((event?.payload.event.definition as Record<string, unknown>)?.futureDefinitionField, undefined);
  assert.equal(consumeControlPlaneAgentEvent({ type: "agent.run.changed", payload: { nodeId: "node_one", event: {} } }), undefined);
  assert.equal(consumeControlPlaneAgentEvent({ type: "node.updated", payload: {} }), undefined);
});

test("Agent client routes orchestration CRUD and reads tolerant aggregate events", async () => {
  const responses = [
    { orchestrations: [{ nodeId: "node_one", orchestration: orchestration({ future: true }) }], unavailableNodeIds: ["node_two"] },
    orchestration(),
    orchestration({ id: "orchestration_new" }),
    orchestration({ revision: "b".repeat(64), name: "Updated" }),
    { id: "default:agent_one", deleted: true },
    { id: "agent_one", deleted: true, deletedOrchestrationIds: ["orchestration_extra"] },
  ];
  const requests: Array<{ path: string; init?: RequestInit }> = [];
  const transport: ControlPlaneClientTransport = {
    async request(path, schema, init) {
      requests.push({ path, init });
      return schema.parse({ data: responses.shift() });
    },
  };
  const api = createControlPlaneAgentsApi(transport);
  const listed = await api.listOrchestrations("node_one");
  assert.deepEqual(listed.unavailableNodeIds, ["node_two"]);
  assert.equal((listed.orchestrations[0]!.orchestration as Record<string, unknown>).future, undefined);
  assert.equal((await api.getOrchestration("default:agent_one", "node_one")).name, "Reviewer");
  assert.equal((await api.createOrchestration("node_one", { name: "Release", agentIds: ["agent_one"], edges: [] })).id, "orchestration_new");
  assert.equal((await api.updateOrchestration("default:agent_one", "node_one", { expectedRevision: revision, name: "Updated" })).name, "Updated");
  assert.equal((await api.removeOrchestration("default:agent_one", "node_one")).deleted, true);
  assert.deepEqual((await api.remove("agent_one", "node_one", { referencingOrchestrations: "delete" })).deletedOrchestrationIds, ["orchestration_extra"]);
  assert.deepEqual(requests.map(({ path, init }) => [path, init?.method]), [
    ["/api/agent-orchestrations?nodeId=node_one", undefined],
    ["/api/agent-orchestrations/default%3Aagent_one?nodeId=node_one", undefined],
    ["/api/agent-orchestrations", "POST"],
    ["/api/agent-orchestrations/default%3Aagent_one", "PATCH"],
    ["/api/agent-orchestrations/default%3Aagent_one?nodeId=node_one", "DELETE"],
    ["/api/agents/agent_one?nodeId=node_one&referencingOrchestrations=delete", "DELETE"],
  ]);

  const event = consumeControlPlaneAgentEvent({
    type: "agent.orchestration.changed",
    payload: {
      nodeId: "node_one",
      event: {
        orchestrationId: "default:agent_one",
        change: "updated",
        revision,
        orchestration: orchestration({ future: true }),
      },
    },
  });
  assert.equal(event?.type, "agent.orchestration.changed");
  assert.equal(event?.payload.nodeId, "node_one");
  assert.equal(event?.payload.event.orchestrationId, "default:agent_one");
});
