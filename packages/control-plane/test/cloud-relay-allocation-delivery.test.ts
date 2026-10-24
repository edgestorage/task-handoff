import assert from "node:assert/strict";
import test from "node:test";
import { CloudConnectivityBackgroundRuntime } from "../src/control-plane/cloud-connectivity/coordinator-runtime.ts";

test("a Relay allocation attach failure records its phase and cause", async () => {
  const warnings: Array<[Record<string, unknown>, string | undefined]> = [];
  const runtime = new CloudConnectivityBackgroundRuntime({
    state: {
      snapshot: () => ({ status: "active", scopes: { deviceAccess: true, nodeRelay: false }, serviceOrigin: "https://cloud.example.test" }),
      backgroundCredential: () => "c".repeat(43),
      nextConnectionEpoch: () => 1,
    } as any,
    accountSession: {} as any,
    identity: {} as any,
    relayConnector: { async connect() { throw new Error("unused"); } },
    logger: { warn: (data, message) => warnings.push([data, message]) },
    clock: () => 1_000,
  });
  (runtime as any).dataConnections = {
    async attach() { throw Object.assign(new Error("relay handshake reset"), { code: "ECONNRESET", retryable: true }); },
  };

  await assert.rejects(
    () => (runtime as any).handleRequest("relay-allocation", { allocationId: "allocation_a", relayUrl: "wss://relay.example.test/connect" }),
    { code: "ECONNRESET" },
  );
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0]![0].code, "CLOUD_RELAY_ALLOCATION_ATTACH_FAILED");
  assert.equal(warnings[0]![0].allocationId, "allocation_a");
  assert.equal(warnings[0]![0].relayUrl, "wss://relay.example.test/connect");
  assert.equal(warnings[0]![0].errorCode, "ECONNRESET");
  assert.equal(warnings[0]![0].errorMessage, "relay handshake reset");
  assert.equal(warnings[0]![0].retryable, true);
  assert.equal(warnings[0]![0].durationMs, 0);
  assert.equal(warnings[0]![1], "cloud_relay_allocation_attach_failed");
});
