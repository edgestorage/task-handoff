import assert from "node:assert/strict";
import test from "node:test";
import { NodeAgentCloudRelayClient } from "../src/cloud-relay/client.ts";

test("a rate-limited adaptive request keeps its Retry-After delay and never falls back to v1", async () => {
  const calls: string[] = [];
  const warnings: Array<{ data: Record<string, unknown>; message: string }> = [];
  const binding = {
    status: "active",
    credential: "thnc_" + "a".repeat(43),
    cloudOrigin: "https://cloud.example.test",
    cloudOriginMode: "fixed",
  };
  const client = new NodeAgentCloudRelayClient({
    identity: { cloudRelayBinding: () => binding } as any,
    host: {
      log: {
        warn(data: Record<string, unknown>, message: string) { warnings.push({ data, message }); },
      },
    } as any,
    nodeId: "node_alpha",
    controlWebSocket: false,
    fetchImpl: async (input) => {
      const url = new URL(String(input));
      calls.push(url.pathname);
      return new Response(JSON.stringify({ error: { code: "RATE_LIMITED", message: "Rate limit exceeded, retry in 17 seconds" } }), {
        status: 429,
        headers: { "content-type": "application/json", "retry-after": "17" },
      });
    },
  });

  await assert.rejects(
    () => (client as any).reconnectAllocations(binding, ["cp_alpha"]),
    (error: any) => {
      assert.equal(error.code, "RATE_LIMITED");
      assert.equal(error.statusCode, 429);
      assert.equal(error.retryAfterMs, 17_000);
      return true;
    },
  );
  assert.deepEqual(calls, ["/api/v1/node-relay/v2/probe-targets"]);
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].data.reason, "rate-limited");
  assert.equal(warnings[0].data.retryAfterMs, 17_000);
});
