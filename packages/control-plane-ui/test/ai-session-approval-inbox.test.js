import assert from "node:assert/strict";
import test from "node:test";
import { aiSessionApprovalItems, aiSessionApprovalDecisions } from "../src/apps/control-plane/action-inbox/aiSessionApprovals.ts";

const waiting = { id: "session-a", agent: "codex", status: "waiting", phase: "approval", updatedAt: "2026-01-01T00:00:00.000Z" };

function instance(id, sessions, features) {
  return { id, name: id, capabilities: { features }, aiSessions: { sessions } };
}

test("inbox projects only actionable sessions across visible instances", () => {
  const items = aiSessionApprovalItems([
    instance("first", [waiting, { ...waiting, id: "idle", status: "idle" }]),
    instance("second", [{ ...waiting, updatedAt: "2026-01-02T00:00:00.000Z" }]),
  ]);
  assert.deepEqual(items.map((item) => item.key), ["ai-session-approval:second:session-a", "ai-session-approval:first:session-a"]);
  assert.deepEqual(aiSessionApprovalItems([]), []);
});

test("legacy decisions apply only to known providers waiting for approval", () => {
  assert.deepEqual(aiSessionApprovalDecisions(waiting), ["allow", "deny", "skip"]);
  assert.deepEqual(aiSessionApprovalDecisions({ ...waiting, agent: "unknown" }), []);
  assert.deepEqual(aiSessionApprovalDecisions({ ...waiting, phase: "running" }), []);
});

test("provider capabilities override the legacy decision fallback", () => {
  const capabilities = { aiSessionProviders: [{ agent: "codex", actions: { approvalDecisions: ["deny"] }, timeline: {} }] };
  assert.deepEqual(aiSessionApprovalDecisions(waiting, capabilities), ["deny"]);
  assert.deepEqual(aiSessionApprovalItems([instance("first", [waiting], capabilities)])[0].decisions, ["deny"]);
  const unsupported = { aiSessionProviders: [{ agent: "codex", actions: { approvalDecisions: [] }, timeline: {} }] };
  assert.deepEqual(aiSessionApprovalItems([instance("first", [waiting], unsupported)]), []);
});
