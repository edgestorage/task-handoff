import assert from "node:assert/strict";
import test from "node:test";
import { createBrowserUuid } from "../src/lib/random-id.ts";

test("uses native randomUUID when the browser provides it", () => {
  assert.equal(createBrowserUuid({ randomUUID: () => "native-uuid" }), "native-uuid");
});

test("generates an RFC 4122 version 4 UUID without randomUUID", () => {
  const uuid = createBrowserUuid({
    getRandomValues: (bytes) => {
      bytes.fill(0xab);
      return bytes;
    },
  });

  assert.equal(uuid, "abababab-abab-4bab-abab-abababababab");
});

test("generates distinct UUIDs when Web Crypto is unavailable", () => {
  const first = createBrowserUuid(null);
  const second = createBrowserUuid(null);
  assert.match(first, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.notEqual(first, second);
});
