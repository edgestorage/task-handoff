import assert from "node:assert/strict";
import test from "node:test";
import { AgentDefinitionService } from "../src/node-agent/agents/service.ts";
import { AgentOrchestrationService } from "../src/node-agent/agents/orchestration-service.ts";
import { AgentRunCoordinator } from "../src/node-agent/agents/run-coordinator.ts";
import { AgentRunService } from "../src/node-agent/agents/run-service.ts";
import { WorkspaceMaterializerRegistry, agentRunWorkspaceLayout } from "../src/node-agent/agents/workspace-materializer.ts";
import { defaultAgentOrchestrationId } from "@task-handoff/protocol/agent-orchestrations";
import { createStoryDatabaseFixture } from "./story-database-fixture.ts";

async function waitUntil(predicate: () => boolean, diagnostic: () => unknown, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for test state: ${JSON.stringify(diagnostic())}`);
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

function stateFixture() {
  const instance = {
    id: "instance_one",
    nodeId: "node_one",
    runtimeId: "runtime_one",
    source: { type: "local-folder", path: "/host/workspace" },
    workspace: { path: "/workspace" },
    runtime: { workspacePath: "/workspace", containerName: "instance-one" },
    capabilities: { features: { aiSessionProviders: [{ agent: "codex", actions: {}, timeline: {} }] } },
  };
  return {
    node: { id: "node_one" },
    controlledInstances: { get: (id: string) => id === instance.id ? instance : undefined },
    requireInstance(id: string) {
      if (id !== instance.id) throw new Error("Instance not found");
      return instance;
    },
    requireRuntime(id: string) {
      if (id !== "runtime_one") throw new Error("Runtime not found");
      return { id, type: "docker" };
    },
    localFolders: { get: (id: string) => id === "folder_one" ? { id, path: "/host/workspace/project" } : undefined },
  };
}

async function coordinatorFixture(status: "completed" | "running", cleanupFailures = 0, attach = true) {
  const database = await createStoryDatabaseFixture("task-handoff-agent-run-coordinator-");
  const state = stateFixture();
  const orchestrations = new AgentOrchestrationService(database.repository.agents.orchestrations, database.repository.agents.definitions);
  const definitions = new AgentDefinitionService(state as never, database.repository.agents.definitions, orchestrations);
  const definition = definitions.create({
    name: "Reviewer",
    appendedPrompt: "Review carefully",
    targetInstanceId: "instance_one",
    cwdFolderId: "folder_one",
    providerId: "codex",
  });
  const runs = new AgentRunService(state as never, definitions, orchestrations, database.repository.agents.runs, () => true);
  const actions: string[] = [];
  const completedMembers = new Set<string>();
  const materializers = new WorkspaceMaterializerRegistry();
  materializers.register({ runtimeType: "docker", workspaceMaterializer: "overlay-copy-on-write", processSandbox: "instance" }, {
    kind: "overlay-copy-on-write",
    async prepare(input) {
      actions.push("workspace.prepare");
      return {
        materializer: "overlay-copy-on-write",
        generationId: input.generationId,
        layout: agentRunWorkspaceLayout(input.runId, input.memberId),
        backendIdentity: `workspace:${input.memberId}`,
        diagnostics: {},
      };
    },
    async inspectOwnership() { return "owned"; },
    async dispose() {
      actions.push("workspace.dispose");
      if (cleanupFailures > 0) {
        cleanupFailures -= 1;
        actions.push("workspace.dispose.failed");
        throw Object.assign(new Error("workspace busy"), { code: "AGENT_RUN_OVERLAY_DISPOSE_FAILED", retryable: true });
      }
    },
  });
  let retained = false;
  const sharedSpaces = {
    async ensure() { actions.push("shared.ensure"); },
    bindingForMember(runId: string, runtimeId: string) {
      return { runId, runtimeId, runtimePath: `/shared/${runId}` };
    },
    pathPolicyForMember(runId: string, runtimeId: string, cwd: string) {
      this.bindingForMember(runId, runtimeId);
      return { cwd, writableRoots: [cwd, `/shared/${runId}`] };
    },
    async refreshUsage() {},
    retain() { retained = true; actions.push("shared.retain"); },
  };
  const sessions = {
    async create(_instance: unknown, input: any) {
      actions.push("session.create");
      assert.deepEqual(input.writableRoots, {
        workspace: { type: "runtime-path", path: input.cwd.path },
        shared: { type: "runtime-path", path: `/shared/${input.runId}` },
      });
      return { disposition: "created", aiSessionId: `session_${input.memberId}`, providerSessionId: `thread_${input.memberId}` };
    },
    async status(_instance: unknown, runId: string, memberId: string) {
      const memberStatus = status === "completed" || completedMembers.has(memberId) ? "completed" : status;
      return memberStatus === "completed"
        ? { runId, memberId, aiSessionId: `session_${memberId}`, status: memberStatus, result: { text: "completed result", truncated: false, source: "provider-final-message" } }
        : { runId, memberId, aiSessionId: `session_${memberId}`, status };
    },
    async close() { actions.push("session.close"); return { closed: true }; },
  };
  const coordinator = new AgentRunCoordinator({
    state: state as never,
    runs,
    materializers,
    sharedSpaces: sharedSpaces as never,
    resources: database.repository.agents.resources,
    sessions: sessions as never,
    pollIntervalMs: 1,
    cleanupRetryBaseMs: 1,
  });
  if (attach) runs.setCoordinator(coordinator);
  return {
    ...database,
    runs,
    definition,
    coordinator,
    actions,
    retained: () => retained,
    completeMember: (memberId: string) => completedMembers.add(memberId),
  };
}

function createRun(fixture: Awaited<ReturnType<typeof coordinatorFixture>>, clientRequestId: string) {
  return fixture.runs.create({
    clientRequestId,
    orchestrationId: defaultAgentOrchestrationId(fixture.definition.id),
    input: { prompt: "Review this change" },
    provenance: { initiatingInstanceId: "instance_one", initiatingAiSessionId: "story_session", storyId: "story_one" },
  });
}

test("coordinator projects a successful member result and closes the thread before workspace disposal", async () => {
  const fixture = await coordinatorFixture("completed");
  try {
    const run = createRun(fixture, "request_success");
    const result = await fixture.runs.waitForToolResult(run.runId, undefined, 5_000);
    assert.equal(result.status, "completed");
    assert.equal(result.result?.text, "completed result");
    assert.ok(fixture.actions.indexOf("session.close") < fixture.actions.indexOf("workspace.dispose"));
    assert.equal(fixture.retained(), true);
    assert.equal(fixture.repository.agents.resources.listForRun(run.runId).find((resource) => resource.kind === "provider-thread")?.phase, "deleted");
  } finally {
    await fixture.coordinator.stop();
    await fixture.close();
  }
});

test("coordinator cancellation converges through finalizing and still disposes in order", async () => {
  const fixture = await coordinatorFixture("running");
  try {
    const run = createRun(fixture, "request_cancel");
    while (!fixture.actions.includes("session.create")) await new Promise((resolve) => setTimeout(resolve, 1));
    fixture.runs.cancel(run.runId, {});
    const result = await fixture.runs.waitForToolResult(run.runId, undefined, 5_000);
    assert.equal(result.status, "cancelled");
    assert.ok(fixture.actions.indexOf("session.close") < fixture.actions.indexOf("workspace.dispose"));
  } finally {
    await fixture.coordinator.stop();
    await fixture.close();
  }
});

test("periodic reconciliation does not recover a Run owned by the current coordinator", async () => {
  const fixture = await coordinatorFixture("running");
  try {
    const run = createRun(fixture, "request_live_reconciliation");
    await waitUntil(
      () => fixture.runs.get(run.runId).status === "running",
      () => ({ run: fixture.runs.get(run.runId), actions: fixture.actions }),
    );

    await fixture.coordinator.reconcile();

    assert.equal(fixture.runs.get(run.runId).status, "running");
    assert.equal(fixture.actions.includes("session.close"), false);
    fixture.completeMember(run.rootMemberId);
    const completed = await fixture.runs.waitForToolResult(run.runId, undefined, 5_000);
    assert.equal(completed.status, "completed");
  } finally {
    await fixture.coordinator.stop();
    await fixture.close();
  }
});

test("coordinator keeps cleanup failures in finalizing and retries until convergence", async () => {
  const fixture = await coordinatorFixture("completed", 1);
  try {
    const run = createRun(fixture, "request_cleanup_retry");
    while (!fixture.actions.includes("workspace.dispose.failed")) await new Promise((resolve) => setTimeout(resolve, 1));
    const retrying = fixture.runs.get(run.runId);
    assert.equal(retrying.status, "finalizing");
    assert.equal(retrying.cleanup?.status, "retrying");
    const result = await fixture.runs.waitForToolResult(run.runId, undefined, 5_000);
    assert.equal(result.status, "completed");
    assert.equal(fixture.runs.get(run.runId).cleanup?.attempts, 2);
    assert.equal(fixture.actions.filter((action) => action === "workspace.dispose").length, 2);
  } finally {
    await fixture.coordinator.stop();
    await fixture.close();
  }
});

test("startup reconciliation resumes only a queued Run that never created resources", async () => {
  const fixture = await coordinatorFixture("completed", 0, false);
  try {
    const run = createRun(fixture, "request_queued_recovery");
    assert.equal(run.status, "queued");
    await fixture.coordinator.reconcile();
    const result = await fixture.runs.waitForToolResult(run.runId, undefined, 5_000);
    assert.equal(result.status, "completed");
    assert.equal(fixture.actions.filter((action) => action === "session.create").length, 1);
  } finally {
    await fixture.coordinator.stop();
    await fixture.close();
  }
});

test("startup reconciliation never re-executes a Run that already started", async () => {
  const fixture = await coordinatorFixture("completed", 0, false);
  try {
    const run = createRun(fixture, "request_running_recovery");
    fixture.runs.transitionRun(run.runId, { status: "preparing" });
    fixture.runs.transitionRun(run.runId, { status: "running" });
    fixture.runs.transitionMember(run.runId, run.rootMemberId, { status: "preparing" });
    fixture.runs.transitionMember(run.runId, run.rootMemberId, { status: "running", aiSessionId: "session_recovered" });
    const resource = fixture.repository.agents.resources.register({
      runId: run.runId,
      memberId: run.rootMemberId,
      instanceId: "instance_one",
      runtimeId: "runtime_one",
      kind: "provider-thread",
      generationId: "generation_recovered",
      backendIdentity: "thread_recovered",
    });
    fixture.repository.agents.resources.transition(resource.resourceId, "ready");
    await fixture.coordinator.reconcile();
    const recovered = fixture.runs.get(run.runId);
    assert.equal(recovered.status, "failed");
    assert.equal(recovered.error?.code, "AGENT_RUN_NODE_RESTARTED");
    assert.equal(fixture.actions.includes("session.create"), false);
    assert.equal(fixture.actions.includes("session.close"), true);
  } finally {
    await fixture.coordinator.stop();
    await fixture.close();
  }
});

for (const interruptedStatus of ["preparing", "finalizing"] as const) {
  test(`startup reconciliation fails an interrupted ${interruptedStatus} Run without re-execution`, async () => {
    const fixture = await coordinatorFixture("completed", 0, false);
    try {
      const run = createRun(fixture, `request_${interruptedStatus}_recovery`);
      if (interruptedStatus === "preparing") fixture.runs.transitionRun(run.runId, { status: "preparing" });
      else {
        fixture.runs.transitionRun(run.runId, { status: "preparing" });
        fixture.runs.transitionRun(run.runId, { status: "finalizing" });
      }
      await fixture.coordinator.reconcile();
      const recovered = fixture.runs.get(run.runId);
      assert.equal(recovered.status, "failed");
      assert.equal(recovered.error?.code, "AGENT_RUN_NODE_RESTARTED");
      assert.equal(fixture.actions.includes("session.create"), false);
    } finally {
      await fixture.coordinator.stop();
      await fixture.close();
    }
  });
}

test("duplicate cancellation is idempotent while cleanup is finalizing", async () => {
  const fixture = await coordinatorFixture("running");
  try {
    const run = createRun(fixture, "request_duplicate_cancel");
    await waitUntil(() => fixture.actions.includes("session.create"), () => fixture.actions);
    const first = fixture.runs.cancel(run.runId, {});
    const repeated = fixture.runs.cancel(run.runId, {});
    assert.equal(first.runId, repeated.runId);
    assert.equal(repeated.status, "finalizing");
    await fixture.runs.waitForToolResult(run.runId, undefined, 5_000);
  } finally {
    await fixture.coordinator.stop();
    await fixture.close();
  }
});

test("Story-level Run scheduling is FIFO with at most two active Runs per initiating session", async () => {
  const fixture = await coordinatorFixture("running");
  try {
    const first = createRun(fixture, "request_fifo_first");
    const second = createRun(fixture, "request_fifo_second");
    const third = createRun(fixture, "request_fifo_third");
    await waitUntil(
      () => fixture.actions.filter((action) => action === "session.create").length >= 2,
      () => ({ actions: fixture.actions }),
    );
    assert.equal(fixture.actions.filter((action) => action === "session.create").length, 2);
    assert.equal(fixture.runs.get(third.runId).status, "queued");
    fixture.completeMember(first.rootMemberId);
    await fixture.runs.waitForToolResult(first.runId, undefined, 5_000);
    await waitUntil(
      () => fixture.actions.filter((action) => action === "session.create").length >= 3,
      () => ({ actions: fixture.actions, runs: [first, second, third].map((run) => fixture.runs.get(run.runId).status) }),
    );
    assert.notEqual(fixture.runs.get(third.runId).status, "queued");
    fixture.completeMember(second.rootMemberId);
    fixture.completeMember(third.rootMemberId);
    await Promise.all([
      fixture.runs.waitForToolResult(second.runId, undefined, 5_000),
      fixture.runs.waitForToolResult(third.runId, undefined, 5_000),
    ]);
  } finally {
    await fixture.coordinator.stop();
    await fixture.close();
  }
});
