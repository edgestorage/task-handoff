import assert from "node:assert/strict";
import test from "node:test";
import { AgentRunExecutionCapabilityProbe } from "../src/node-agent/agents/execution-capability-probe.ts";

function fixture(options: { verifyFailure?: boolean; sessionSetChanges?: boolean } = {}) {
  const instance = {
    id: "instance_probe",
    runtimeId: "runtime_docker",
    ready: true,
    status: "running",
    connectionStatus: "online",
    agentStatus: "online",
    targetStatus: "reachable",
    runtime: { containerId: "container_1", workspacePath: "/workspace" },
    workspace: { path: "/workspace" },
    capabilities: { features: { aiSessionProviders: [{ agent: "codex", actions: {}, timeline: {} }] } },
    build: { packageVersion: "1.0.0" },
  };
  const calls: string[] = [];
  const workspace = {
    materializer: "overlay-copy-on-write",
    generationId: "generation_probe",
    layout: { root: "/run/task-handoff/agent-runs/workspaces", runRoot: "/run/task-handoff/agent-runs/workspaces/probe", memberRoot: "/run/task-handoff/agent-runs/workspaces/probe/member", cwd: "/run/task-handoff/agent-runs/workspaces/probe/member/merged", markerPath: "/marker" },
    backendIdentity: "container_1:/merged",
    diagnostics: {},
    target: {},
    resourceId: "probe:generation_probe",
    upperPath: "/upper",
    workPath: "/work",
    sharedPath: "/run/task-handoff/agent-runs/shared/probe",
    marker: { version: 1, runId: "probe", memberId: "member", generationId: "generation_probe", createdAt: new Date().toISOString() },
  } as const;
  let probeStateReads = 0;
  let capabilityChanges = 0;
  const probe = new AgentRunExecutionCapabilityProbe({
    state: {
      controlledInstances: { get: (id: string) => id === instance.id ? instance : undefined },
      requireRuntime: () => ({ type: "docker" }),
    } as never,
    candidateInstanceIds: () => [instance.id],
    storage: {
      ensureRunDirectory: async () => { calls.push("shared-ensure"); return {}; },
      prepareProbe: async () => { calls.push("overlay-inject"); return workspace; },
      verifyProbe: async () => {
        calls.push("filesystem-verify");
        if (options.verifyFailure) throw new Error("source write was not rejected");
        return {};
      },
      disposeProbe: async () => { calls.push("overlay-dispose"); },
      inspectOwnership: async () => "absent",
      removeRunDirectory: async () => { calls.push("shared-remove"); return {}; },
    } as never,
    sessions: {
      probeState: async () => {
        probeStateReads += 1;
        return { ordinaryAiSessionIds: options.sessionSetChanges && probeStateReads > 1 ? ["ordinary", "unexpected"] : ["ordinary"] };
      },
      create: async () => { calls.push("thread-create"); return { aiSessionId: "session_probe", providerSessionId: "thread_probe" }; },
      status: async () => ({ status: "completed", result: { text: "probe complete", truncated: false, source: "provider-final-message" } }),
      close: async () => { calls.push("thread-close"); return { closed: true }; },
    } as never,
    pollIntervalMs: 1,
    onCapabilitiesChanged: () => { capabilityChanges += 1; },
  });
  const support = {
    targetInstanceId: instance.id,
    runtimeType: "docker",
    providerId: "codex",
    permissionMode: "auto-review",
    executionPolicy: { workspaceMaterializer: "overlay-copy-on-write", processSandbox: "instance" },
  };
  return { probe, instance, calls, support, capabilityChanges: () => capabilityChanges };
}

test("execution capability is published only after the complete behavior probe and cleanup", async () => {
  const { probe, calls, support, capabilityChanges } = fixture();
  assert.equal(probe.supports(support), false);
  assert.deepEqual(probe.combinations(), []);
  await probe.reconcile();
  assert.equal(probe.supports(support), true);
  assert.deepEqual(probe.combinations(), [{
    runtime: "docker",
    workspaceMaterializer: "overlay-copy-on-write",
    processSandbox: "instance",
    providerId: "codex",
  }]);
  assert.equal(capabilityChanges(), 1);
  await probe.reconcile();
  assert.equal(capabilityChanges(), 1);
  assert.deepEqual(calls, [
    "shared-ensure", "shared-ensure", "overlay-inject", "thread-create", "filesystem-verify",
    "thread-close", "overlay-dispose", "shared-remove", "shared-remove",
  ]);
});

test("filesystem probe failure, ordinary session contamination and full access all fail closed", async () => {
  const failed = fixture({ verifyFailure: true });
  await failed.probe.reconcile();
  assert.equal(failed.probe.supports(failed.support), false);
  assert.ok(failed.calls.includes("overlay-dispose"));

  const contaminated = fixture({ sessionSetChanges: true });
  await contaminated.probe.reconcile();
  assert.equal(contaminated.probe.supports(contaminated.support), false);

  const passed = fixture();
  await passed.probe.reconcile();
  assert.equal(passed.probe.supports({ ...passed.support, permissionMode: "full-access" }), false);
});

test("a replaced controlled-instance container invalidates the previous probe attestation", async () => {
  const { probe, instance, support, capabilityChanges } = fixture();
  await probe.reconcile();
  assert.equal(probe.supports(support), true);
  instance.runtime.containerId = "container_2";
  assert.equal(probe.supports(support), false);
  assert.deepEqual(probe.combinations(), []);
  await probe.reconcile();
  assert.equal(capabilityChanges(), 3);
});
