import assert from "node:assert/strict";
import test from "node:test";
import { connectCloudAccountNodeWithTrustRetry } from "../src/apps/control-plane/settings/cloudAccountNodeConnection.ts";

test("an explicit account node connection reopens rejected trust first", async () => {
  const calls = [];
  const result = await connectCloudAccountNodeWithTrustRetry({
    reapply: async () => {
      calls.push("reapply");
      return "reopened";
    },
    claim: async () => {
      calls.push("claim");
      return "claimed";
    },
  });
  assert.equal(result, "reopened");
  assert.deepEqual(calls, ["reapply"]);
});

test("account node connection falls back for legacy trust retry support", async () => {
  for (const code of [
    "CLOUD_NODE_TRUST_RETRY_COORDINATOR_UNSUPPORTED",
    "CLOUD_NODE_TRUST_RETRY_NODE_AGENT_UNSUPPORTED",
    "CLOUD_NODE_TRUST_RETRY_NODE_AGENT_NOT_OBSERVED",
  ]) {
    const calls = [];
    const result = await connectCloudAccountNodeWithTrustRetry({
      reapply: async () => {
        calls.push("reapply");
        throw Object.assign(new Error("unsupported"), { code });
      },
      claim: async () => {
        calls.push("claim");
        return "claimed";
      },
    });
    assert.equal(result, "claimed");
    assert.deepEqual(calls, ["reapply", "claim"]);
  }
});

test("account node connection preserves unrelated failures", async () => {
  let claimed = false;
  await assert.rejects(connectCloudAccountNodeWithTrustRetry({
    reapply: async () => { throw Object.assign(new Error("busy"), { code: "CLOUD_BINDING_UNAVAILABLE" }); },
    claim: async () => { claimed = true; return "claimed"; },
  }), { code: "CLOUD_BINDING_UNAVAILABLE" });
  assert.equal(claimed, false);
});
