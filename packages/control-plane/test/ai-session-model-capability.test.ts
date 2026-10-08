import assert from "node:assert/strict";
import test from "node:test";
import type { ControlledInstance, NodeRuntime } from "@task-handoff/protocol/control-plane";
import { AiSessionActionService } from "../src/control-plane/sessions/ai-session-actions.ts";

const legacyInstance = {
  id: "inst_legacy",
  nodeId: "node_legacy",
  config: { defaultCodexPermissionMode: "ask" },
  capabilities: {},
  aiSessions: { sessions: [] },
} as unknown as ControlledInstance;

test("v0.0.23 controlled instance disables only explicit model selection at create", async () => {
  const requests: Array<{ route: string; body: Record<string, unknown> }> = [];
  const service = new AiSessionActionService({
    requireInstance: async () => legacyInstance,
    requireRuntime: async () => ({} as NodeRuntime),
    request: async (_instance, route, init) => {
      requests.push({ route, body: JSON.parse(String(init?.body || "{}")) });
      return { disposition: "created", aiSessionId: "session_legacy", providerSessionId: "thread_legacy", creationSource: "ai-session" };
    },
  });
  const base = {
    agent: "codex" as const,
    cwd: { type: "runtime-path" as const, path: "/workspace" },
    clientRequestId: "request_legacy",
    message: "hello",
    attachments: [],
    references: [],
  };

  assert.equal((await service.create(legacyInstance.id, base)).disposition, "created");
  assert.equal("modelSelection" in requests[0].body, false);
  await assert.rejects(
    service.create(legacyInstance.id, {
      ...base,
      clientRequestId: "request_model",
      modelSelection: { modelEntityId: "mdl_new", modelName: "new-model" },
    }),
    (error: unknown) => (error as { code?: string }).code === "AI_SESSION_MODEL_SELECTION_UNSUPPORTED",
  );
  assert.equal(requests.length, 1);
});

test("v0.0.31 controlled instance disables only rename and does not receive the new route", async () => {
  const requests: string[] = [];
  const legacySessionInstance = {
    ...legacyInstance,
    aiSessions: { sessions: [{
      id: "session_legacy",
      agent: "codex",
      status: "waiting",
      phase: "approval",
      actions: { send: true, interrupt: true, approval: true, close: true },
    }] },
  } as unknown as ControlledInstance;
  const service = new AiSessionActionService({
    requireInstance: async () => legacySessionInstance,
    requireRuntime: async () => ({} as NodeRuntime),
    request: async (_instance, route) => { requests.push(route); return {}; },
  });

  await assert.rejects(
    service.rename("inst_legacy", "session_legacy", { title: "Renamed", expectedTitle: "Original", clientRequestId: "rename-legacy" }),
    (error: unknown) => (error as { code?: string }).code === "AI_SESSION_RENAME_UNSUPPORTED",
  );
  assert.deepEqual(requests, []);
  assert.equal(legacySessionInstance.aiSessions.sessions[0].actions?.send, true);
  assert.equal(legacySessionInstance.aiSessions.sessions[0].actions?.approval, true);
  assert.equal(legacySessionInstance.aiSessions.sessions[0].actions?.close, true);
});

function instanceWithModelSelection(stableIdentity: boolean | undefined, sessions: unknown[] = []) {
  const modelSelection: Record<string, unknown> = {
    selectModelAtCreate: true,
    selectProviderAtCreate: true,
    selectModelAtResume: true,
    selectProviderAtResume: true,
    switchModelWithinProvider: true,
    switchProviderDuringSession: true,
  };
  if (stableIdentity !== undefined) modelSelection.stableIdentity = stableIdentity;
  return {
    id: "inst_identity",
    nodeId: "node_identity",
    config: { defaultCodexPermissionMode: "ask" },
    capabilities: { features: { aiSessionProviders: [{ agent: "codex", actions: { create: true, send: true }, timeline: {}, modelSelection }] } },
    aiSessions: { sessions, runningCount: 0 },
  } as unknown as ControlledInstance;
}

const identitySelection = { modelEntityId: "mdl_a", modelName: "model-a", modelUpstreamName: "upstream-a" };

test("modelUpstreamName is withheld from instances that predate the stable-identity split", async () => {
  const requests: Array<Record<string, unknown>> = [];
  const service = new AiSessionActionService({
    requireInstance: async () => instanceWithModelSelection(undefined),
    requireRuntime: async () => ({} as NodeRuntime),
    request: async (_instance, _route, init) => {
      requests.push(JSON.parse(String(init?.body || "{}")));
      return { disposition: "created", aiSessionId: "session_identity", providerSessionId: "thread_identity", creationSource: "ai-session" };
    },
  });

  await service.create("inst_identity", {
    agent: "codex",
    cwd: { type: "runtime-path", path: "/workspace" },
    message: "hello",
    clientRequestId: "request_identity",
    modelSelection: identitySelection,
  });
  assert.deepEqual(requests[0].modelSelection, { modelEntityId: "mdl_a", modelName: "model-a" });
});

test("modelUpstreamName reaches instances that advertise stable identity", async () => {
  const requests: Array<Record<string, unknown>> = [];
  const service = new AiSessionActionService({
    requireInstance: async () => instanceWithModelSelection(true),
    requireRuntime: async () => ({} as NodeRuntime),
    request: async (_instance, _route, init) => {
      requests.push(JSON.parse(String(init?.body || "{}")));
      return { disposition: "created", aiSessionId: "session_identity", providerSessionId: "thread_identity", creationSource: "ai-session" };
    },
  });

  await service.create("inst_identity", {
    agent: "codex",
    cwd: { type: "runtime-path", path: "/workspace" },
    message: "hello",
    clientRequestId: "request_identity",
    modelSelection: identitySelection,
  });
  assert.deepEqual(requests[0].modelSelection, identitySelection);
});

test("a model switch also withholds modelUpstreamName from a pre-split instance", async () => {
  const requests: Array<Record<string, unknown>> = [];
  const session = { id: "session_identity", agent: "codex", status: "idle", actions: { send: true }, modelSelection: { modelEntityId: "mdl_a", modelName: "model-a" } };
  const service = new AiSessionActionService({
    requireInstance: async () => instanceWithModelSelection(undefined, [session]),
    requireRuntime: async () => ({} as NodeRuntime),
    request: async (_instance, _route, init) => {
      requests.push(JSON.parse(String(init?.body || "{}")));
      return { sessionId: "session_identity", accepted: true };
    },
  });

  await service.updateModelSelection("inst_identity", "session_identity", "request_identity", identitySelection);
  assert.deepEqual(requests[0].modelSelection, { modelEntityId: "mdl_a", modelName: "model-a" });
});
