import assert from "node:assert/strict";
import test from "node:test";

import { encodeNodeTunnelRequestBody } from "@task-handoff/protocol/control-plane";
import { decodeCloudRelayRequestBody } from "../src/control-plane/http/relay-request-body.ts";

test("cloud Relay binary request bodies round-trip without becoming JSON objects", () => {
  const content = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const decoded = decodeCloudRelayRequestBody(encodeNodeTunnelRequestBody(content));
  assert.ok(Buffer.isBuffer(decoded));
  assert.deepEqual(decoded, content);
});

test("cloud Relay legacy bodies remain unchanged during rollout", () => {
  assert.equal(decodeCloudRelayRequestBody("{\"ok\":true}"), "{\"ok\":true}");
  const legacy = { path: "/api/example" };
  assert.equal(decodeCloudRelayRequestBody(legacy), legacy);
  assert.equal(decodeCloudRelayRequestBody(undefined), undefined);
});
