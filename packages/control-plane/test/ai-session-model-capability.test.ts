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
