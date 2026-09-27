import assert from "node:assert/strict";
import test from "node:test";
import { AGENT_RUN_MAX_RESULT_CHARACTERS } from "@task-handoff/protocol/agent-runs";
import { projectAgentRunMemberStatus } from "./src/web/agent-run-member-status.ts";

const binding = {
  runId: "run_status",
  memberId: "member_status",
  aiSessionId: "session_status",
  providerSessionId: "thread_status",
  createdAt: "2026-09-27T00:00:00.000Z",
};

test("Agent Run member status preserves provider failure and running states", () => {
  const failed = projectAgentRunMemberStatus(binding, { status: "failed", error: "process exited with code 1" });
  assert.equal(failed.status, "failed");
  assert.equal(failed.error?.code, "AGENT_RUN_PROVIDER_FAILED");
  assert.match(failed.error?.message || "", /code 1/);
  assert.equal(projectAgentRunMemberStatus(binding, { status: "running" }).status, "running");
});

test("Agent Run member status fails when a provider completes without a final message", () => {
  const result = projectAgentRunMemberStatus(binding, { status: "idle", lastMessage: "", summary: "" });
  assert.equal(result.status, "failed");
  assert.equal(result.error?.code, "AGENT_RUN_PROVIDER_NO_FINAL_MESSAGE");
});

test("Agent Run member results are bounded and report truncation", () => {
  const result = projectAgentRunMemberStatus(binding, { status: "idle", lastMessage: "x".repeat(AGENT_RUN_MAX_RESULT_CHARACTERS + 1) });
  assert.equal(result.status, "completed");
  assert.equal(result.result?.text.length, AGENT_RUN_MAX_RESULT_CHARACTERS);
  assert.equal(result.result?.truncated, true);
});
