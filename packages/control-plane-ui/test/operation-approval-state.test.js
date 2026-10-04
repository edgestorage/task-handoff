import assert from "node:assert/strict";
import test from "node:test";
import { applyOperationApprovalEvent, applyOperationApprovalSnapshot } from "../src/apps/control-plane/action-inbox/operationApprovalState.ts";

const request = { id: "approval-1", operation: "instance.delete", targetId: "inst-1", createdAt: "2026-01-01T00:00:00.000Z", expiresAt: "2026-01-01T00:05:00.000Z" };
test("late creation cannot revive terminal operation approval", () => {
  const empty = { revision: 0, requests: [] };
  const pending = applyOperationApprovalEvent(empty, { request, status: "pending", revision: 1 });
  const decided = applyOperationApprovalEvent(pending, { request, status: "approved", revision: 2 });
  assert.deepEqual(decided.requests, []);
  assert.equal(applyOperationApprovalEvent(decided, { request, status: "pending", revision: 1 }), decided);
  assert.equal(applyOperationApprovalSnapshot(decided, pending), decided);
});
