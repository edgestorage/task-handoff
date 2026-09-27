import assert from "node:assert/strict";
import test from "node:test";
import {
  AgentRunMemberInstanceCreateInputSchema,
  AgentRunMemberInstanceStatusSchema,
} from "../src/agent-run-instance.ts";

function createInput() {
  return {
    runId: "run_12345678",
    memberId: "member_12345678",
    clientRequestId: "request_12345678",
    providerId: "codex",
    cwd: { type: "runtime-path", path: "/run/task-handoff/agent-runs/workspaces/run/member/merged" },
    writableRoots: {
      workspace: { type: "runtime-path", path: "/run/task-handoff/agent-runs/workspaces/run/member/merged" },
      shared: { type: "runtime-path", path: "/run/task-handoff/agent-runs/shared/run_12345678" },
    },
    prompt: "Review the change",
    appendedPrompt: "Keep the output concise",
    enabledTools: ["agent_run"],
  };
}

test("Agent Run member instance input owns exact runtime roots and rejects additive overrides", () => {
  assert.equal(AgentRunMemberInstanceCreateInputSchema.parse(createInput()).providerId, "codex");
  assert.throws(() => AgentRunMemberInstanceCreateInputSchema.parse({ ...createInput(), hostPath: "/tmp/escape" }));
  assert.throws(() => AgentRunMemberInstanceCreateInputSchema.parse({
    ...createInput(),
    writableRoots: { ...createInput().writableRoots, workspace: { type: "runtime-path", path: "/different" } },
  }));
  assert.throws(() => AgentRunMemberInstanceCreateInputSchema.parse({
    ...createInput(),
    writableRoots: { workspace: createInput().cwd, shared: createInput().cwd },
  }));
});

test("Agent Run member status requires terminal payloads", () => {
  const identity = { runId: "run_12345678", memberId: "member_12345678", aiSessionId: "session_12345678" };
  assert.throws(() => AgentRunMemberInstanceStatusSchema.parse({ ...identity, status: "completed" }));
  assert.throws(() => AgentRunMemberInstanceStatusSchema.parse({ ...identity, status: "failed" }));
  assert.equal(AgentRunMemberInstanceStatusSchema.parse({
    ...identity,
    status: "completed",
    result: { text: "done", truncated: false, source: "provider-final-message" },
  }).status, "completed");
});
