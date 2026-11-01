import assert from "node:assert/strict";
import test from "node:test";
import {
  applyOperationApprovalEvent,
  applyOperationApprovalSnapshot,
  operationApprovalEventNeedsRecovery,
} from "../src/apps/control-plane/action-inbox/operationApprovalState.ts";
import { createOperationApprovalStore } from "../src/apps/control-plane/action-inbox/operationApprovalStore.ts";

const request = { id: "approval-1", operation: "instance.delete", targetId: "inst-1", createdAt: "2026-01-01T00:00:00.000Z", expiresAt: "2026-01-01T00:05:00.000Z" };
test("late creation cannot revive terminal operation approval", () => {
  const empty = { generation: "generation-a", revision: 0, requests: [] };
  const pending = applyOperationApprovalEvent(empty, { request, status: "pending", generation: "generation-a", revision: 1 });
  const decided = applyOperationApprovalEvent(pending, { request, status: "approved", generation: "generation-a", revision: 2 });
  assert.deepEqual(decided.requests, []);
  assert.equal(applyOperationApprovalEvent(decided, { request, status: "pending", generation: "generation-a", revision: 1 }), decided);
  assert.equal(applyOperationApprovalSnapshot(decided, pending), decided);
});

test("a restarted approval register supersedes revisions from the previous process", () => {
  const previous = { generation: "generation-a", revision: 9, requests: [request] };
  const restarted = { generation: "generation-b", revision: 0, requests: [] };
  assert.equal(applyOperationApprovalSnapshot(previous, restarted), restarted);

  const event = { request, status: "pending", generation: "generation-b", revision: 1 };
  assert.equal(operationApprovalEventNeedsRecovery(previous, event), true);
  assert.equal(applyOperationApprovalEvent(previous, event), previous);
  assert.deepEqual(applyOperationApprovalEvent(restarted, event).requests, [request]);
});

test("an event before the first snapshot establishes the approval generation", () => {
  const empty = { generation: "", revision: -1, requests: [] };
  const event = { request, status: "pending", generation: "generation-a", revision: 4 };
  assert.equal(operationApprovalEventNeedsRecovery(empty, event), false);
  assert.deepEqual(applyOperationApprovalEvent(empty, event), {
    generation: "generation-a",
    revision: 4,
    requests: [request],
  });
});

test("a new-generation event cannot be overwritten by an older in-flight snapshot", async () => {
  const pending = [];
  const store = createOperationApprovalStore({
    snapshot: () => new Promise((resolve) => pending.push(resolve)),
  });
  const initialRecovery = store.recover();
  const event = { request, status: "pending", generation: "generation-b", revision: 1 };

  store.applyEvent(event);
  pending.shift()({ generation: "generation-a", revision: 9, requests: [] });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(pending.length, 1, "the stale generation response is discarded and recovery is retried");
  pending.shift()({ generation: "generation-b", revision: 1, requests: [request] });
  await initialRecovery;

  assert.deepEqual(store.snapshot.value, {
    generation: "generation-b",
    revision: 1,
    requests: [request],
  });
});

test("resetting the approval store prevents an old recovery from replacing the new epoch", async () => {
  const pending = [];
  const store = createOperationApprovalStore({
    snapshot: () => new Promise((resolve) => pending.push(resolve)),
  });
  const previous = store.recover();
  store.reset();
  const current = store.recover();

  pending.shift()({ generation: "generation-a", revision: 3, requests: [request] });
  await previous;
  assert.deepEqual(store.snapshot.value, { generation: "", revision: -1, requests: [] });

  pending.shift()({ generation: "generation-b", revision: 1, requests: [request] });
  await current;
  assert.deepEqual(store.snapshot.value, {
    generation: "generation-b",
    revision: 1,
    requests: [request],
  });
});

test("recovery accepts the newest snapshot after repeated generation changes", async () => {
  const pending = [];
  const store = createOperationApprovalStore({
    snapshot: () => new Promise((resolve) => pending.push(resolve)),
  });
  const recovery = store.recover();
  store.applyEvent({ request, status: "pending", generation: "generation-b", revision: 1 });

  pending.shift()({ generation: "generation-a", revision: 9, requests: [] });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(pending.length, 1, "one generation mismatch is retried");

  pending.shift()({ generation: "generation-c", revision: 2, requests: [{ ...request, id: "apr_latest" }] });
  await recovery;
  assert.deepEqual(store.snapshot.value, {
    generation: "generation-c",
    revision: 2,
    requests: [{ ...request, id: "apr_latest" }],
  });
});
