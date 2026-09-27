import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AgentRunMemberBindingStore } from "./src/web/agent-run-member-bindings.ts";

test("Agent Run member bindings survive restart and close permanently", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-agent-member-bindings-"));
  try {
    const first = new AgentRunMemberBindingStore(root);
    first.bind({ runId: "run_one", memberId: "member_one", aiSessionId: "session_one", providerSessionId: "thread_one" }, "2026-09-27T00:00:00.000Z");
    const restored = new AgentRunMemberBindingStore(root);
    assert.equal(restored.get("run_one", "member_one")?.aiSessionId, "session_one");
    restored.close("run_one", "member_one", "2026-09-27T00:01:00.000Z");
    assert.equal(new AgentRunMemberBindingStore(root).getBySession("session_one")?.closedAt, "2026-09-27T00:01:00.000Z");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Agent Run member binding identities cannot be reassigned", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-agent-member-conflict-"));
  try {
    const store = new AgentRunMemberBindingStore(root);
    store.bind({ runId: "run_one", memberId: "member_one", aiSessionId: "session_one", providerSessionId: "thread_one" });
    assert.throws(
      () => store.bind({ runId: "run_two", memberId: "member_two", aiSessionId: "session_one", providerSessionId: "thread_two" }),
      (error: any) => error.code === "AGENT_RUN_MEMBER_SESSION_CONFLICT",
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
