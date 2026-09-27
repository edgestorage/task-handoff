import assert from "node:assert/strict";
import test from "node:test";
import {
  AGENT_RUN_DEFAULT_BUDGET,
  AGENT_RUN_MAX_TOOL_RESULT_CHARACTERS,
  AgentRunAggregateEventSchema,
  AgentRunChangedEventSchema,
  AgentRunCreateInputSchema,
  AgentRunManualCreateInputSchema,
  AgentRunSchema,
  AgentRunToolResultSchema,
  agentRunTerminalStatus,
  canTransitionAgentRunStatus,
  sanitizeAgentRun,
} from "../src/agent-runs.ts";
import {
  normalizeNodeAgentCapabilities,
  nodeAgentExecutionCapabilities,
  supportsNodeAgentCallableRelations,
  supportsNodeAgentExecutionPolicy,
  supportsNodeAgentRunMembers,
  supportsNodeAgentRuns,
  supportsNodeAgentManualRuns,
  supportsNodeAgentSharedSpace,
  supportsNodeAgentStoryEntryAuthorization,
} from "../src/node-agent-capabilities.ts";

const timestamp = "2026-09-26T00:00:00.000Z";

function executionSnapshot() {
  return {
    agentRevision: "a".repeat(64),
    targetInstanceId: "instance_one",
    cwdFolderId: "folder_one",
    appendedPrompt: "Review the change",
    providerId: "codex",
    executionPolicy: { workspaceMaterializer: "overlay-copy-on-write", processSandbox: "instance" },
  } as const;
}

function run() {
  return {
    runId: "run_one",
    clientRequestId: "request_one",
    revision: 3,
    status: "running",
    input: { prompt: "Review the requested change" },
    provenance: { initiatingInstanceId: "instance_source", initiatingAiSessionId: "session_source", storyId: "story_one" },
    rootMemberId: "member_root",
    budget: { maxMembers: 8, maxDepth: 3, maxConcurrency: 2 },
    members: [{
      memberId: "member_root",
      runId: "run_one",
      agentId: "agent_one",
      instanceId: "instance_one",
      role: "root",
      depth: 0,
      status: "running",
      executionSnapshot: executionSnapshot(),
      createdAt: timestamp,
      updatedAt: timestamp,
    }],
    timeline: [],
    createdAt: timestamp,
    updatedAt: timestamp,
  } as const;
}

test("Agent Run write schemas reject unknown and server-owned fields", () => {
  const input = {
    clientRequestId: "request_one",
    agentId: "agent_one",
    input: { prompt: "Review the requested change" },
    provenance: { initiatingInstanceId: "instance_one", initiatingAiSessionId: "session_one", storyId: "story_one" },
    budget: { maxMembers: 8, maxDepth: 3, maxConcurrency: 2 },
  };
  assert.equal(AgentRunCreateInputSchema.safeParse(input).success, true);
  assert.equal(AgentRunCreateInputSchema.safeParse({ ...input, runId: "run_injected" }).success, false);
  assert.equal(AgentRunCreateInputSchema.safeParse({ ...input, absolutePath: "/host/private" }).success, false);
  assert.equal(AgentRunCreateInputSchema.safeParse({ ...input, input: { prompt: "Review", cwd: "/host/private" } }).success, false);
  assert.equal(AgentRunCreateInputSchema.safeParse({ ...input, provenance: { ...input.provenance, nodeId: "node_one" } }).success, false);
  assert.equal(AgentRunSchema.safeParse({ ...run(), futureField: true }).success, false);
});

test("Agent Run consumer sanitization ignores additive unknown fields recursively", () => {
  const input = run() as any;
  input.futureField = "ignored";
  input.provenance.futureField = "ignored";
  input.budget.futureField = "ignored";
  input.members[0].futureField = "ignored";
  input.members[0].executionSnapshot.futureField = "ignored";
  input.sharedSpace = { runtimeId: "runtime_one", state: "retained", usageBytes: 1, quotaBytes: 1024, expiresAt: timestamp, futureField: "ignored" };
  const parsed = sanitizeAgentRun(input);
  assert.equal((parsed as any).futureField, undefined);
  assert.equal((parsed.provenance as any).futureField, undefined);
  assert.equal((parsed.members?.[0] as any).futureField, undefined);
  assert.equal((parsed.members?.[0].executionSnapshot as any).futureField, undefined);
  assert.equal((parsed.sharedSpace as any).futureField, undefined);
});

test("Agent Run result delivery is additive and tool results are independently bounded", () => {
  const completed = {
    ...run(),
    status: "completed",
    result: { text: "done", truncated: false, source: "provider-final-message" },
    resultDelivery: {
      status: "delivered",
      attempts: 1,
      updatedAt: timestamp,
      deliveredAt: timestamp,
    },
    completedAt: timestamp,
  };
  assert.equal(AgentRunSchema.safeParse(completed).success, true);
  assert.equal(AgentRunSchema.safeParse({ ...completed, resultDelivery: { status: "delivered" } }).success, false);
  assert.equal(AgentRunToolResultSchema.safeParse({
    runId: "run_one",
    status: "completed",
    result: { text: "done", truncated: false },
  }).success, true);
  assert.equal(AgentRunToolResultSchema.safeParse({ runId: "run_one", status: "failed" }).success, false);
  assert.equal(AgentRunToolResultSchema.safeParse({
    runId: "run_one",
    status: "completed",
    result: { text: "x".repeat(AGENT_RUN_MAX_TOOL_RESULT_CHARACTERS + 1), truncated: true },
  }).success, false);
});

test("Agent Run create budget is optional and defaults remain server-owned", () => {
  const input = {
    clientRequestId: "request_default_budget",
    agentId: "agent_one",
    input: { prompt: "Review the requested change" },
    provenance: { initiatingInstanceId: "instance_one", initiatingAiSessionId: "session_one", storyId: "story_one" },
  };
  assert.equal(AgentRunCreateInputSchema.safeParse(input).success, true);
  assert.deepEqual(AGENT_RUN_DEFAULT_BUDGET, { maxMembers: 16, maxDepth: 4, maxConcurrency: 4 });
});

test("Manual Agent Run input keeps authenticated provenance server-owned", () => {
  const input = {
    clientRequestId: "request_manual",
    agentId: "agent_one",
    input: { prompt: "Run the release checks" },
  };
  assert.equal(AgentRunManualCreateInputSchema.safeParse(input).success, true);
  assert.equal(AgentRunManualCreateInputSchema.safeParse({
    ...input,
    provenance: { source: "control-plane", authorizationSubject: { kind: "control-plane-user", subjectId: "user_other" } },
  }).success, false);
  assert.equal(AgentRunCreateInputSchema.safeParse({ ...input, provenance: { source: "control-plane" } }).success, true);
  assert.equal(AgentRunSchema.safeParse({ ...run(), provenance: { source: "control-plane" } }).success, true);
});

test("Node Agent run events exclude nodeId while aggregate events own it", () => {
  const event = { runId: "run_one", revision: 3, run: run() };
  assert.equal(AgentRunChangedEventSchema.safeParse(event).success, true);
  assert.equal(AgentRunChangedEventSchema.safeParse({ ...event, nodeId: "node_one" }).success, false);
  assert.equal(AgentRunAggregateEventSchema.safeParse({ nodeId: "node_one", event }).success, true);
  assert.equal(AgentRunAggregateEventSchema.safeParse({ event }).success, false);
});

test("Agent Run status transitions use one recoverable state machine", () => {
  assert.equal(canTransitionAgentRunStatus("queued", "preparing"), true);
  assert.equal(canTransitionAgentRunStatus("preparing", "running"), true);
  assert.equal(canTransitionAgentRunStatus("running", "finalizing"), true);
  for (const terminal of ["completed", "failed", "cancelled"] as const) {
    assert.equal(canTransitionAgentRunStatus("finalizing", terminal), true);
    assert.equal(canTransitionAgentRunStatus(terminal, "running"), false);
  }
  assert.equal(canTransitionAgentRunStatus("queued", "completed"), false);
  assert.equal(canTransitionAgentRunStatus("running", "failed"), false);
  assert.equal(canTransitionAgentRunStatus("running", "running"), true);
});

test("Run terminal status requires both root member and cleanup convergence", () => {
  const cleanup = { status: "completed", attempts: 1, updatedAt: timestamp } as const;
  assert.equal(agentRunTerminalStatus("completed", cleanup), "completed");
  assert.equal(agentRunTerminalStatus("failed", cleanup), "failed");
  assert.equal(agentRunTerminalStatus("cancelled", cleanup), "cancelled");
  assert.equal(agentRunTerminalStatus("running", cleanup), undefined);
  assert.equal(agentRunTerminalStatus("completed", { ...cleanup, status: "retrying" }), undefined);
  assert.equal(agentRunTerminalStatus("completed", { ...cleanup, status: "manual-intervention" }), "failed");
  assert.equal(agentRunTerminalStatus("completed", undefined), undefined);
});

test("Agent execution incremental capabilities normalize through one query boundary", () => {
  assert.deepEqual(nodeAgentExecutionCapabilities(undefined), {
    definitions: false,
    runs: false,
    orchestration: { storyEntryAuthorization: false, callableRelations: false, runMembers: false, manualRuns: false },
    sharedSpace: { enabled: false, runtimes: [] },
    combinations: [],
  });
  const capabilities = {
    agentExecution: {
      runs: true,
      orchestration: { storyEntryAuthorization: true, callableRelations: true, runMembers: true, manualRuns: true, future: true },
      sharedSpace: { enabled: true, runtimes: ["docker"], future: true },
      future: true,
    },
  };
  assert.equal(supportsNodeAgentRuns(capabilities), true);
  assert.equal(supportsNodeAgentStoryEntryAuthorization(capabilities), true);
  assert.equal(supportsNodeAgentCallableRelations(capabilities), true);
  assert.equal(supportsNodeAgentRunMembers(capabilities), true);
  assert.equal(supportsNodeAgentManualRuns(capabilities), true);
  assert.equal(supportsNodeAgentSharedSpace(capabilities, "docker"), true);
  assert.equal(supportsNodeAgentSharedSpace(capabilities, "local"), false);
  assert.equal(supportsNodeAgentRuns({ agentExecution: { future: true } }), false);
  assert.equal(supportsNodeAgentManualRuns({ agentExecution: { runs: true } }), false);
});

test("Unknown execution combinations fail closed without disabling unrelated N-1 capabilities", () => {
  const capabilities = {
    stories: { enabled: true },
    agentExecution: {
      definitions: true,
      runs: true,
      combinations: [
        { runtime: "docker", workspaceMaterializer: "future-overlay", processSandbox: "instance", providerId: "codex" },
        { runtime: "docker", workspaceMaterializer: "overlay-copy-on-write", processSandbox: "instance", providerId: "codex", future: true },
      ],
    },
  };
  const normalized = normalizeNodeAgentCapabilities(capabilities);
  assert.equal(normalized.stories.enabled, true);
  assert.equal(normalized.agentExecution.definitions, true);
  assert.equal(normalized.agentExecution.runs, true);
  assert.deepEqual(normalized.agentExecution.combinations, [{
    runtime: "docker",
    workspaceMaterializer: "overlay-copy-on-write",
    processSandbox: "instance",
    providerId: "codex",
  }]);
  assert.equal(supportsNodeAgentExecutionPolicy(capabilities, {
    workspaceMaterializer: "future-overlay",
    processSandbox: "instance",
  }, { runtime: "docker", providerId: "codex" }), false);
});
