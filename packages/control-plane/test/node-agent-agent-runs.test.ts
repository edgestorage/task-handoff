import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import { AgentDefinitionService } from "../src/node-agent/agents/service.ts";
import { AgentRunService, effectiveAgentRunBudget } from "../src/node-agent/agents/run-service.ts";
import { registerNodeAgentRunRoutes } from "../src/node-agent/agents/routes.ts";
import { openNodeAgentDatabase } from "../src/node-agent/persistence/database.ts";
import { createNodeAgentRepository } from "../src/node-agent/persistence/repository.ts";
import { createStoryDatabaseFixture } from "./story-database-fixture.ts";

const t0 = "2026-09-26T00:00:00.000Z";
const t1 = "2026-09-26T00:00:01.000Z";
const t2 = "2026-09-26T00:00:02.000Z";
const t3 = "2026-09-26T00:00:03.000Z";

function snapshot(overrides: Record<string, unknown> = {}) {
  return {
    agentRevision: "a".repeat(64),
    targetInstanceId: "instance_one",
    cwdFolderId: "folder_one",
    appendedPrompt: "Original prompt",
    providerId: "codex",
    executionPolicy: { workspaceMaterializer: "overlay-copy-on-write", processSandbox: "instance" },
    ...overrides,
  } as never;
}

function createInput(overrides: Record<string, unknown> = {}) {
  return {
    clientRequestId: "request_one",
    input: { prompt: "Review the requested change" },
    provenance: { initiatingInstanceId: "instance_source", initiatingAiSessionId: "session_source", storyId: "story_one" },
    budget: { maxMembers: 4, maxDepth: 2, maxConcurrency: 2 },
    root: { agentId: "agent_reviewer", instanceId: "instance_one", executionSnapshot: snapshot() },
    timestamp: t0,
    ...overrides,
  } as never;
}

function createRunState() {
  const instances = {
    instance_one: {
      id: "instance_one",
      nodeId: "node_1",
      runtimeId: "runtime_docker",
      workspace: { path: "/workspace" },
      runtime: { workspacePath: "/workspace" },
      source: { type: "local-folder", path: "/host/workspace" },
      capabilities: { features: { aiSessionProviders: [{ agent: "codex", actions: {}, timeline: {} }] } },
    },
    instance_source: {
      id: "instance_source",
      nodeId: "node_1",
      runtimeId: "runtime_docker",
      workspace: { path: "/workspace" },
      runtime: { workspacePath: "/workspace" },
      source: { type: "local-folder", path: "/host/workspace" },
      capabilities: { features: { aiSessionProviders: [{ agent: "codex", actions: {}, timeline: {} }] } },
    },
    instance_two: {
      id: "instance_two",
      nodeId: "node_1",
      runtimeId: "runtime_docker",
      workspace: { path: "/workspace" },
      runtime: { workspacePath: "/workspace" },
      source: { type: "local-folder", path: "/host/workspace" },
      capabilities: { features: { aiSessionProviders: [{ agent: "codex", actions: {}, timeline: {} }] } },
    },
    instance_other_runtime: {
      id: "instance_other_runtime",
      nodeId: "node_1",
      runtimeId: "runtime_other",
      workspace: { path: "/workspace" },
      runtime: { workspacePath: "/workspace" },
      source: { type: "local-folder", path: "/host/workspace" },
      capabilities: { features: { aiSessionProviders: [{ agent: "codex", actions: {}, timeline: {} }] } },
    },
  };
  const deletedInstanceIds = new Set<string>();
  return {
    nodeId: "node_1",
    controlledInstances: {
      get: (id: string) => deletedInstanceIds.has(id) ? undefined : (instances as Record<string, unknown>)[id],
      delete: (id: string) => deletedInstanceIds.add(id),
    },
    requireInstance(id: string) {
      const instance = deletedInstanceIds.has(id) ? undefined : (instances as Record<string, unknown>)[id];
      if (!instance) throw Object.assign(new Error("Instance not found."), { code: "NODE_INSTANCE_NOT_FOUND", statusCode: 404 });
      return instance;
    },
    localFolders: { get: (id: string) => ["folder_one", "folder_two", "folder_other"].includes(id) ? { id, path: "/host/workspace/packages/app" } : undefined },
    requireRuntime(id: string) {
      if (id !== "runtime_docker" && id !== "runtime_other") throw Object.assign(new Error("Runtime not found."), { code: "NODE_RUNTIME_NOT_FOUND", statusCode: 404 });
      return { id, type: "docker" };
    },
  };
}

async function createRunApiFixture(supported = true) {
  const database = await createStoryDatabaseFixture("task-handoff-agent-run-api-");
  const state = createRunState();
  const events: Array<{ type: string; payload: Record<string, unknown>; scope: Record<string, unknown> }> = [];
  const definitions = new AgentDefinitionService(state as never, database.repository.agents.definitions);
  const definition = definitions.create({
    name: "Reviewer",
    appendedPrompt: "Original prompt",
    targetInstanceId: "instance_one",
    cwdFolderId: "folder_one",
    providerId: "codex",
  });
  const runs = new AgentRunService(
    state as never,
    definitions,
    database.repository.agents.runs,
    () => supported,
    (type, payload, scope) => events.push({ type, payload: payload as Record<string, unknown>, scope }),
  );
  const app = Fastify();
  registerNodeAgentRunRoutes(app, runs);
  app.setErrorHandler((error, _request, reply) => {
    const record = error as { code?: string; statusCode?: number; message: string; details?: unknown };
    reply.code(record.statusCode ?? 400).send({
      error: { code: record.code ?? "VALIDATION_ERROR", message: record.message, ...(record.details ? { details: record.details } : {}) },
    });
  });
  return {
    ...database,
    state,
    definitions,
    definition,
    runs,
    events,
    app,
    async close() {
      await app.close();
      await database.close();
    },
  };
}

test("Agent Run creation is idempotent and atomically creates exactly one root member", async () => {
  const fixture = await createStoryDatabaseFixture("task-handoff-agent-runs-idempotent-");
  try {
    const first = fixture.repository.agents.runs.create(createInput());
    const repeated = fixture.repository.agents.runs.create(createInput());
    assert.equal(repeated.runId, first.runId);
    assert.equal(repeated.rootMemberId, first.rootMemberId);
    assert.equal(repeated.members?.length, 1);
    assert.equal(repeated.members?.[0].agentId, "agent_reviewer");
    assert.equal(fixture.repository.agents.runs.list().length, 1);
    assert.throws(
      () => fixture.repository.agents.runs.create(createInput({
        root: { agentId: "agent_changed", instanceId: "instance_one", executionSnapshot: snapshot({ appendedPrompt: "Changed" }) },
      })),
      (error: any) => error.code === "AGENT_RUN_IDEMPOTENCY_CONFLICT" && error.statusCode === 409,
    );
  } finally { await fixture.close(); }
});

test("Member identity is execution-specific and immutable snapshots survive caller mutation", async () => {
  const fixture = await createStoryDatabaseFixture("task-handoff-agent-runs-members-");
  try {
    const mutableSnapshot = snapshot() as any;
    const run = fixture.repository.agents.runs.create(createInput({
      root: { agentId: "agent_reviewer", instanceId: "instance_one", executionSnapshot: mutableSnapshot },
    }));
    mutableSnapshot.appendedPrompt = "Mutated after insert";
    const first = fixture.repository.agents.runs.addMember({
      runId: run.runId,
      parentMemberId: run.rootMemberId,
      clientRequestId: "member_request_first",
      agentId: "agent_worker",
      instanceId: "instance_one",
      input: { prompt: "First member task" },
      executionSnapshot: snapshot({ agentRevision: "b".repeat(64) }),
      timestamp: t1,
    });
    const second = fixture.repository.agents.runs.addMember({
      runId: run.runId,
      parentMemberId: run.rootMemberId,
      clientRequestId: "member_request_second",
      agentId: "agent_worker",
      instanceId: "instance_one",
      input: { prompt: "Second member task" },
      executionSnapshot: snapshot({ agentRevision: "b".repeat(64) }),
      timestamp: t2,
    });
    assert.notEqual(first.memberId, second.memberId);
    assert.equal(first.agentId, second.agentId);
    assert.equal(fixture.repository.agents.runs.get(run.runId)?.members?.[0].executionSnapshot.appendedPrompt, "Original prompt");
  } finally { await fixture.close(); }
});

test("Member creation enforces run ownership, member count and depth budgets", async () => {
  const fixture = await createStoryDatabaseFixture("task-handoff-agent-runs-budget-");
  try {
    const run = fixture.repository.agents.runs.create(createInput({ budget: { maxMembers: 2, maxDepth: 1, maxConcurrency: 1 } }));
    const child = fixture.repository.agents.runs.addMember({
      runId: run.runId,
      parentMemberId: run.rootMemberId,
      clientRequestId: "member_request_child",
      agentId: "agent_worker",
      instanceId: "instance_one",
      input: { prompt: "Child task" },
      executionSnapshot: snapshot(),
    });
    assert.throws(() => fixture.repository.agents.runs.addMember({
      runId: run.runId,
      parentMemberId: child.memberId,
      clientRequestId: "member_request_depth_exceeded",
      agentId: "agent_third",
      instanceId: "instance_one",
      input: { prompt: "Too deep" },
      executionSnapshot: snapshot(),
    }), (error: any) => error.code === "AGENT_RUN_MEMBER_BUDGET_EXCEEDED");

    const other = fixture.repository.agents.runs.create(createInput({ clientRequestId: "request_two" }));
    assert.throws(() => fixture.repository.agents.runs.addMember({
      runId: other.runId,
      parentMemberId: child.memberId,
      clientRequestId: "member_request_wrong_run",
      agentId: "agent_worker",
      instanceId: "instance_one",
      input: { prompt: "Wrong run" },
      executionSnapshot: snapshot(),
    }), (error: any) => error.code === "AGENT_RUN_PARENT_MEMBER_NOT_FOUND");
  } finally { await fixture.close(); }
});

test("callee scheduling preserves its own instance and fails when that authoritative target is deleted", async () => {
  const fixture = await createRunApiFixture(true);
  try {
    const callee = fixture.definitions.create({
      name: "Worker",
      targetInstanceId: "instance_two",
      cwdFolderId: "folder_two",
      providerId: "codex",
    });
    const root = fixture.definitions.update(fixture.definition.id, {
      expectedRevision: fixture.definition.revision,
      callableAgentIds: [callee.id],
    });
    const run = fixture.runs.create({
      clientRequestId: "request_cross_instance",
      agentId: root.id,
      input: { prompt: "Coordinate the work" },
      provenance: { initiatingInstanceId: "instance_source", initiatingAiSessionId: "session_source", storyId: "story_one" },
      budget: { maxMembers: 3, maxDepth: 2, maxConcurrency: 1 },
    });
    fixture.runs.transitionRun(run.runId, { status: "preparing" });
    fixture.runs.transitionRun(run.runId, { status: "running" });
    fixture.runs.transitionMember(run.runId, run.rootMemberId, { status: "preparing" });
    fixture.runs.transitionMember(run.runId, run.rootMemberId, { status: "running" });
    const member = fixture.runs.addMember({
      runId: run.runId,
      parentMemberId: run.rootMemberId,
      clientRequestId: "callee_request_one",
      agentId: callee.id,
      input: { prompt: "Implement the change" },
    });
    assert.equal(member.instanceId, "instance_two");
    assert.equal(member.executionSnapshot.targetInstanceId, "instance_two");

    fixture.state.controlledInstances.delete("instance_two");
    assert.throws(() => fixture.runs.addMember({
      runId: run.runId,
      parentMemberId: run.rootMemberId,
      clientRequestId: "callee_request_after_delete",
      agentId: callee.id,
      input: { prompt: "Try again" },
    }), (error: any) => error.code === "AGENT_DEFINITION_TARGET_INSTANCE_UNKNOWN");
  } finally { await fixture.close(); }
});

test("Run and member transitions persist results, errors and cleanup diagnostics", async () => {
  const fixture = await createStoryDatabaseFixture("task-handoff-agent-runs-transition-");
  try {
    const run = fixture.repository.agents.runs.create(createInput());
    assert.throws(
      () => fixture.repository.agents.runs.transitionRun(run.runId, { status: "completed" }),
      (error: any) => error.code === "AGENT_RUN_STATUS_TRANSITION_INVALID" && error.details.from === "queued",
    );
    fixture.repository.agents.runs.transitionRun(run.runId, { status: "preparing", timestamp: t1 });
    fixture.repository.agents.runs.transitionRun(run.runId, { status: "running", timestamp: t2 });

    fixture.repository.agents.runs.transitionMember(run.runId, run.rootMemberId, { status: "preparing", aiSessionId: "session_member", timestamp: t1 });
    fixture.repository.agents.runs.transitionMember(run.runId, run.rootMemberId, { status: "running", timestamp: t2 });
    fixture.repository.agents.runs.transitionMember(run.runId, run.rootMemberId, { status: "finalizing", timestamp: t3 });
    const member = fixture.repository.agents.runs.transitionMember(run.runId, run.rootMemberId, {
      status: "failed",
      error: { code: "PROVIDER_EXITED", message: "Provider exited with code 1", retryable: false },
      timestamp: "2026-09-26T00:00:04.000Z",
    });
    assert.equal(member.aiSessionId, "session_member");
    assert.equal(member.error?.code, "PROVIDER_EXITED");
    assert.equal(member.completedAt, "2026-09-26T00:00:04.000Z");

    fixture.repository.agents.runs.transitionRun(run.runId, { status: "finalizing", timestamp: t3 });
    const completed = fixture.repository.agents.runs.transitionRun(run.runId, {
      status: "completed",
      result: { text: "Final answer", truncated: false, source: "provider-final-message" },
      resultDelivery: { status: "delivered", attempts: 1, updatedAt: "2026-09-26T00:00:04.000Z", deliveredAt: "2026-09-26T00:00:04.000Z" },
      cleanup: { status: "completed", attempts: 1, updatedAt: "2026-09-26T00:00:04.000Z" },
      timestamp: "2026-09-26T00:00:04.000Z",
    });
    assert.equal(completed.result?.text, "Final answer");
    assert.equal(completed.resultDelivery?.status, "delivered");
    assert.equal(completed.cleanup?.status, "completed");
    assert.equal(completed.completedAt, "2026-09-26T00:00:04.000Z");
    assert.ok(completed.revision > run.revision);
  } finally { await fixture.close(); }
});

test("Member failure is isolated from completed sibling results", async () => {
  const fixture = await createRunApiFixture(true);
  try {
    const run = fixture.runs.create({
      clientRequestId: "request_member_isolation",
      input: { prompt: "Review the requested change" },
      agentId: fixture.definition.id,
      provenance: { initiatingInstanceId: "instance_source", initiatingAiSessionId: "session_source", storyId: "story_one" },
      budget: { maxMembers: 4, maxDepth: 2, maxConcurrency: 2 },
    });
    const completedSibling = fixture.repository.agents.runs.addMember({
      runId: run.runId,
      parentMemberId: run.rootMemberId,
      clientRequestId: "member_request_completed",
      agentId: fixture.definition.id,
      instanceId: "instance_one",
      input: { prompt: "Complete this task" },
      executionSnapshot: snapshot({ agentRevision: fixture.definition.revision }),
    });
    const failedSibling = fixture.repository.agents.runs.addMember({
      runId: run.runId,
      parentMemberId: run.rootMemberId,
      clientRequestId: "member_request_failed",
      agentId: fixture.definition.id,
      instanceId: "instance_one",
      input: { prompt: "Fail this task" },
      executionSnapshot: snapshot({ agentRevision: fixture.definition.revision }),
    });
    for (const status of ["preparing", "running", "finalizing"] as const) {
      fixture.runs.transitionMember(run.runId, completedSibling.memberId, { status });
    }
    fixture.runs.transitionMember(run.runId, completedSibling.memberId, {
      status: "completed",
      result: { text: "preserved result", truncated: false, source: "provider-final-message" },
    });
    for (const status of ["preparing", "running", "finalizing"] as const) {
      fixture.runs.transitionMember(run.runId, failedSibling.memberId, { status });
    }
    fixture.runs.transitionMember(run.runId, failedSibling.memberId, {
      status: "failed",
      error: { code: "PROVIDER_FAILED", message: "callee failed", retryable: false },
    });

    const stored = fixture.runs.get(run.runId);
    assert.equal(stored.status, "queued");
    assert.equal(stored.result, undefined);
    assert.equal(stored.members?.find((member) => member.memberId === completedSibling.memberId)?.result?.text, "preserved result");
    assert.equal(stored.members?.find((member) => member.memberId === failedSibling.memberId)?.error?.code, "PROVIDER_FAILED");
    assert.equal(fixture.events.at(-1)?.type, "agent.run.member.changed");
    assert.equal(fixture.events.at(-1)?.payload.memberId, failedSibling.memberId);
  } finally { await fixture.close(); }
});

test("Run budget requests can only tighten Node defaults", () => {
  assert.deepEqual(effectiveAgentRunBudget(), { maxMembers: 16, maxDepth: 4, maxConcurrency: 4 });
  assert.deepEqual(
    effectiveAgentRunBudget({ maxMembers: 100, maxDepth: 2, maxConcurrency: 100 }),
    { maxMembers: 16, maxDepth: 2, maxConcurrency: 4 },
  );
});

test("Timeline sequence is monotonic and persisted with the aggregate revision", async () => {
  const fixture = await createStoryDatabaseFixture("task-handoff-agent-runs-timeline-");
  try {
    const run = fixture.repository.agents.runs.create(createInput());
    const first = fixture.repository.agents.runs.appendTimeline({ runId: run.runId, memberId: run.rootMemberId, kind: "member.queued", timestamp: t1 });
    const second = fixture.repository.agents.runs.appendTimeline({ runId: run.runId, kind: "run.preparing", data: { attempt: 1 }, timestamp: t2 });
    assert.equal(first.sequence, 1);
    assert.equal(second.sequence, 2);
    const stored = fixture.repository.agents.runs.get(run.runId);
    assert.deepEqual(stored?.timeline?.map((entry) => entry.sequence), [1, 2]);
    assert.equal(stored?.timeline?.[1].data.attempt, 1);
    assert.equal(stored?.revision, 2);
  } finally { await fixture.close(); }
});

test("Agent Run history is readable after restart", async () => {
  const fixture = await createStoryDatabaseFixture("task-handoff-agent-runs-restart-");
  let reopened: ReturnType<typeof createNodeAgentRepository> | undefined;
  try {
    const run = fixture.repository.agents.runs.create(createInput());
    fixture.repository.agents.runs.appendTimeline({ runId: run.runId, kind: "created", timestamp: t1 });
    await fixture.repository.close();
    const database = await openNodeAgentDatabase(fixture.paths);
    reopened = createNodeAgentRepository(database);
    const restored = reopened.agents.runs.get(run.runId);
    assert.equal(restored?.clientRequestId, "request_one");
    assert.equal(restored?.members?.length, 1);
    assert.equal(restored?.timeline?.[0].kind, "created");
  } finally {
    await reopened?.close();
    await fixture.close();
  }
});

test("Outer repository transactions roll back run and root member together", async () => {
  const fixture = await createStoryDatabaseFixture("task-handoff-agent-runs-rollback-");
  try {
    assert.throws(() => fixture.repository.transactionSync((repository) => {
      repository.agents.runs.create(createInput());
      throw new Error("abort");
    }), /abort/);
    assert.equal(fixture.repository.agents.runs.getByClientRequestId("request_one"), undefined);
    const memberCount = fixture.database.client.prepare("SELECT COUNT(*) AS count FROM na_agent_run_members").get() as { count: number };
    assert.equal(Number(memberCount.count), 0);
  } finally { await fixture.close(); }
});

test("Agent Run API creates an immutable idempotent snapshot and publishes node-local events", async () => {
  const fixture = await createRunApiFixture();
  try {
    const payload = {
      clientRequestId: "request_api",
      agentId: fixture.definition.id,
      input: { prompt: "Review the requested change" },
      provenance: { initiatingInstanceId: "instance_source", initiatingAiSessionId: "session_source", storyId: "story_one" },
      budget: { maxMembers: 4, maxDepth: 2, maxConcurrency: 2 },
    };
    const created = await fixture.app.inject({ method: "POST", url: "/api/node-agent/agent-runs", payload });
    assert.equal(created.statusCode, 201);
    const run = created.json().data;
    assert.equal(run.members.length, 1);
    assert.equal(run.members[0].executionSnapshot.appendedPrompt, "Original prompt");
    assert.equal(run.members[0].executionSnapshot.agentRevision, fixture.definition.revision);
    assert.equal(run.nodeId, undefined);

    fixture.definitions.update(fixture.definition.id, {
      expectedRevision: fixture.definition.revision,
      appendedPrompt: "Edited prompt",
    });
    const repeated = await fixture.app.inject({ method: "POST", url: "/api/node-agent/agent-runs", payload });
    assert.equal(repeated.statusCode, 201);
    assert.equal(repeated.json().data.runId, run.runId);
    assert.equal(repeated.json().data.members[0].executionSnapshot.appendedPrompt, "Original prompt");
    assert.equal(fixture.repository.agents.runs.list().length, 1);

    for (const conflictingPayload of [
      { ...payload, agentId: "agent_missing" },
      { ...payload, input: { prompt: "Do a different task" } },
      { ...payload, provenance: { ...payload.provenance, initiatingAiSessionId: "session_other" } },
      { ...payload, budget: { ...payload.budget, maxDepth: 1 } },
    ]) {
      const conflict = await fixture.app.inject({ method: "POST", url: "/api/node-agent/agent-runs", payload: conflictingPayload });
      assert.equal(conflict.statusCode, 409);
      assert.equal(conflict.json().error.code, "AGENT_RUN_IDEMPOTENCY_CONFLICT");
      assert.equal(conflict.json().error.details.runId, run.runId);
    }

    const list = await fixture.app.inject({ method: "GET", url: "/api/node-agent/agent-runs" });
    assert.deepEqual(list.json().data.runs.map((item: { runId: string }) => item.runId), [run.runId]);
    const member = await fixture.app.inject({
      method: "GET",
      url: `/api/node-agent/agent-runs/${run.runId}/members/${run.rootMemberId}`,
    });
    assert.equal(member.json().data.memberId, run.rootMemberId);

    assert.deepEqual(fixture.events.map((event) => event.type), ["agent.run.changed", "agent.run.member.changed"]);
    assert.equal(fixture.events[0].payload.nodeId, undefined);
    assert.equal(fixture.events[1].payload.nodeId, undefined);
    assert.equal(fixture.events[0].payload.revision, run.revision);
    assert.deepEqual(fixture.events[0].scope, {});
    assert.deepEqual(fixture.events[1].scope, { instanceId: "instance_one" });
  } finally { await fixture.close(); }
});

test("Node Agent accepts a manual Control Plane run without a fabricated initiating instance", async () => {
  const fixture = await createRunApiFixture();
  try {
    const response = await fixture.app.inject({
      method: "POST",
      url: "/api/node-agent/agent-runs",
      payload: {
        clientRequestId: "request_manual",
        agentId: fixture.definition.id,
        input: { prompt: "Run the release checks" },
        provenance: {
          source: "control-plane",
          authorizationSubject: { kind: "control-plane-user", subjectId: "user_one", authorizationRevision: 3 },
        },
      },
    });
    assert.equal(response.statusCode, 201);
    assert.deepEqual(response.json().data.provenance, {
      source: "control-plane",
      authorizationSubject: { kind: "control-plane-user", subjectId: "user_one", authorizationRevision: 3 },
    });
    assert.equal(response.json().data.members[0].instanceId, "instance_one");
  } finally { await fixture.close(); }
});

test("Agent Run API reports structured target, capability, lookup, revision and terminal errors", async () => {
  const unsupported = await createRunApiFixture(false);
  try {
    const payload = {
      clientRequestId: "request_unsupported",
      agentId: unsupported.definition.id,
      input: { prompt: "Review the requested change" },
      provenance: { initiatingInstanceId: "instance_source", initiatingAiSessionId: "session_source", storyId: "story_one" },
      budget: { maxMembers: 4, maxDepth: 2, maxConcurrency: 2 },
    };
    const response = await unsupported.app.inject({ method: "POST", url: "/api/node-agent/agent-runs", payload });
    assert.equal(response.statusCode, 409);
    assert.equal(response.json().error.code, "AGENT_RUN_EXECUTION_UNSUPPORTED");
    assert.equal(unsupported.repository.agents.runs.list().length, 0);

    const invalidProvenance = await unsupported.app.inject({
      method: "POST",
      url: "/api/node-agent/agent-runs",
      payload: { ...payload, clientRequestId: "request_missing_source", provenance: { ...payload.provenance, initiatingInstanceId: "instance_missing" } },
    });
    assert.equal(invalidProvenance.statusCode, 404);
    assert.equal(invalidProvenance.json().error.code, "AGENT_RUN_INITIATING_INSTANCE_UNKNOWN");
  } finally { await unsupported.close(); }

  const fixture = await createRunApiFixture(true);
  try {
    const run = fixture.runs.create({
      clientRequestId: "request_cancel",
      input: { prompt: "Review the requested change" },
      agentId: fixture.definition.id,
      provenance: { initiatingInstanceId: "instance_source", initiatingAiSessionId: "session_source", storyId: "story_one" },
      budget: { maxMembers: 4, maxDepth: 2, maxConcurrency: 2 },
    });
    const missing = await fixture.app.inject({ method: "GET", url: "/api/node-agent/agent-runs/run_missing" });
    assert.equal(missing.statusCode, 404);
    assert.equal(missing.json().error.code, "AGENT_RUN_NOT_FOUND");

    const missingMember = await fixture.app.inject({
      method: "GET",
      url: `/api/node-agent/agent-runs/${run.runId}/members/member_missing`,
    });
    assert.equal(missingMember.statusCode, 404);
    assert.equal(missingMember.json().error.code, "AGENT_RUN_MEMBER_NOT_FOUND");

    const stale = await fixture.app.inject({
      method: "POST",
      url: `/api/node-agent/agent-runs/${run.runId}/cancel`,
      payload: { expectedRevision: run.revision + 1 },
    });
    assert.equal(stale.statusCode, 409);
    assert.equal(stale.json().error.code, "AGENT_RUN_REVISION_CONFLICT");
    assert.equal(stale.json().error.details.actualRevision, run.revision);

    const cancelled = await fixture.app.inject({
      method: "POST",
      url: `/api/node-agent/agent-runs/${run.runId}/cancel`,
      payload: { expectedRevision: run.revision },
    });
    assert.equal(cancelled.statusCode, 200);
    assert.equal(cancelled.json().data.status, "finalizing");
    assert.equal(cancelled.json().data.revision, run.revision + 1);
    assert.equal(fixture.events.at(-1)?.payload.revision, run.revision + 1);

    const idempotentCancel = await fixture.app.inject({
      method: "POST",
      url: `/api/node-agent/agent-runs/${run.runId}/cancel`,
      payload: {},
    });
    assert.equal(idempotentCancel.json().data.revision, run.revision + 1);
  } finally { await fixture.close(); }
});
