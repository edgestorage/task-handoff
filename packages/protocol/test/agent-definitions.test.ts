import assert from "node:assert/strict";
import test from "node:test";
import {
  AGENT_PUBLISHED_EXECUTION_POLICIES,
  AgentDefinitionCreateInputSchema,
  AgentDefinitionChangedEventSchema,
  AgentDefinitionDeleteResultSchema,
  AgentDefinitionSchema,
  AgentDefinitionUpdateInputSchema,
  isPublishedAgentExecutionPolicy,
  sanitizeAgentDefinition,
  sanitizeAgentExecutionPolicy,
} from "../src/agent-definitions.ts";
import {
  nodeAgentExecutionCapabilities,
  supportsNodeAgentDefinitions,
  supportsNodeAgentExecutionPolicy,
} from "../src/node-agent-capabilities.ts";
import { eventTopic } from "../src/events.ts";

test("AgentDefinition rejects strict input that carries unknown or server-owned fields", () => {
  const base = { name: "Reviewer", targetInstanceId: "instance_one", cwdFolderId: "folder_one", providerId: "codex" };
  assert.equal(AgentDefinitionCreateInputSchema.safeParse(base).success, true);
  assert.equal(AgentDefinitionCreateInputSchema.safeParse({ ...base, ownerNodeId: "node_one" }).success, false);
  assert.equal(AgentDefinitionCreateInputSchema.safeParse({ ...base, storyId: "story_one" }).success, false);
  assert.equal(AgentDefinitionCreateInputSchema.safeParse({ ...base, absolutePath: "/host/workspace" }).success, false);
  assert.equal(AgentDefinitionCreateInputSchema.safeParse({ ...base, executionPolicy: { workspaceMaterializer: "copy-on-write", processSandbox: "instance" } }).success, false);
});

test("AgentDefinition update is a patch that never silently clears an omitted field", () => {
  const expectedRevision = "a".repeat(64);
  assert.deepEqual(AgentDefinitionUpdateInputSchema.parse({ expectedRevision }), { expectedRevision });
  assert.deepEqual(AgentDefinitionUpdateInputSchema.parse({ expectedRevision, modelName: null }), { expectedRevision, modelName: null });
  assert.equal(AgentDefinitionUpdateInputSchema.safeParse({ expectedRevision, targetInstanceId: null }).success, false);
});

test("Execution policy is two-layer and only published combinations are accepted", () => {
  assert.deepEqual(sanitizeAgentExecutionPolicy({}), { workspaceMaterializer: "overlay-copy-on-write", processSandbox: "instance" });
  // Unknown stored policy values fail closed instead of changing the original execution semantics.
  assert.throws(() => sanitizeAgentExecutionPolicy({ workspaceMaterializer: "reflink", processSandbox: "remote" }));
  for (const policy of AGENT_PUBLISHED_EXECUTION_POLICIES) assert.equal(isPublishedAgentExecutionPolicy(policy), true);
  assert.equal(isPublishedAgentExecutionPolicy({ workspaceMaterializer: "worktree", processSandbox: "instance" }), false);
  assert.equal(isPublishedAgentExecutionPolicy({ workspaceMaterializer: "overlay-copy-on-write", processSandbox: "container" }), false);
});

test("AgentDefinition reads tolerate unknown fields but still require the declared ones", () => {
  const parsed = sanitizeAgentDefinition({
    id: "agent_one",
    revision: "a".repeat(64),
    name: "Reviewer",
    targetInstanceId: "instance_one",
    cwdFolderId: "folder_one",
    providerId: "codex",
    executionPolicy: { workspaceMaterializer: "overlay-copy-on-write", processSandbox: "instance" },
    createdAt: "2026-09-26T00:00:00.000Z",
    updatedAt: "2026-09-26T00:00:00.000Z",
    callableAgentIds: ["agent_two"],
    futureField: "ignored",
  });
  assert.equal((parsed as Record<string, unknown>).callableAgentIds, undefined);
  assert.equal(parsed.ownerNodeId, undefined);
  assert.throws(() => sanitizeAgentDefinition({ id: "agent_one", revision: "a".repeat(64) }));
});

test("AgentDefinition wire model has no server-owned identity field", () => {
  const shape = Object.keys(AgentDefinitionSchema.shape);
  assert.equal(shape.includes("ownerNodeId"), false);
  assert.equal(shape.includes("path"), false);
  assert.equal(shape.includes("storyId"), false);
  // 拓扑归 AgentOrchestration 所有：定义本体不再承载可调用关系。
  assert.equal(shape.includes("callableAgentIds"), false);
});

test("Missing agentExecution capability normalizes to unsupported without blocking other features", () => {
  const legacy = nodeAgentExecutionCapabilities({ stories: { enabled: true }, managedModels: { multiEntityAssignment: true } });
  assert.deepEqual(legacy, {
    definitions: false,
    runs: false,
    orchestration: { storyEntryAuthorization: false, orchestrations: false, runMembers: false, manualRuns: false },
    sharedSpace: { enabled: false, runtimes: [] },
    combinations: [],
  });
  assert.equal(supportsNodeAgentDefinitions(undefined), false);
  const target = { runtime: "docker", providerId: "codex" };
  const capabilities = { agentExecution: { combinations: [{ runtime: "docker", workspaceMaterializer: "overlay-copy-on-write", processSandbox: "instance", providerId: "codex" }] } };
  assert.equal(supportsNodeAgentExecutionPolicy(undefined, { workspaceMaterializer: "overlay-copy-on-write", processSandbox: "instance" }, target), false);
  assert.equal(supportsNodeAgentExecutionPolicy(capabilities, { workspaceMaterializer: "overlay-copy-on-write", processSandbox: "container" }, target), false);
  assert.equal(supportsNodeAgentExecutionPolicy(capabilities, { workspaceMaterializer: "overlay-copy-on-write", processSandbox: "instance" }, target), true);
  assert.equal(supportsNodeAgentExecutionPolicy(capabilities, { workspaceMaterializer: "overlay-copy-on-write", processSandbox: "instance" }, { ...target, providerId: "claude" }), false);
});

test("Agent definition changes use the agent event topic", () => {
  assert.equal(eventTopic("agent.definition.changed"), "agents");
  assert.equal(eventTopic("agent.orchestration.changed"), "agents");
  assert.equal(eventTopic("agent.run.updated"), "agents");
  const event = { agentId: "agent_one", change: "deleted", revision: "a".repeat(64) };
  assert.equal(AgentDefinitionChangedEventSchema.safeParse(event).success, true);
  assert.equal(AgentDefinitionChangedEventSchema.safeParse({ ...event, nodeId: "node_one" }).success, false);
});

test("Agent deletion reports the orchestrations removed in the same operation", () => {
  assert.deepEqual(AgentDefinitionDeleteResultSchema.parse({ id: "agent_one", deleted: true }), {
    id: "agent_one",
    deleted: true,
    deletedOrchestrationIds: [],
  });
  assert.deepEqual(
    AgentDefinitionDeleteResultSchema.parse({ id: "agent_one", deleted: true, deletedOrchestrationIds: ["orchestration_one"] })
      .deletedOrchestrationIds,
    ["orchestration_one"],
  );
});
