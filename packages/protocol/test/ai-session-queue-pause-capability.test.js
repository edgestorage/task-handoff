import assert from "node:assert/strict";
import test from "node:test";
import { normalizeControlledInstanceCapabilities, supportsAiSessionQueuePause } from "../src/control-plane.ts";
import { ControlPlaneInstanceDirectoryCapabilitiesSchema, supportsDirectoryAiSessionQueuePause } from "../src/control-plane-directory.ts";

test("AI Session queue pause capability is additive and N-1 safe", () => {
  assert.equal(supportsAiSessionQueuePause(undefined), false);
  assert.equal(supportsAiSessionQueuePause({ features: { aiSessionQueuePause: true, future: "ignored" }, futureDocument: true }), true);
  assert.equal(supportsAiSessionQueuePause({ features: { aiSessionQueuePause: "yes" } }), false);
  assert.equal(normalizeControlledInstanceCapabilities({ features: { aiSessionQueuePause: true } }).features.aiSessionQueuePause, true);
});

test("mobile directory queue pause capability is additive and N-1 safe", () => {
  assert.equal(supportsDirectoryAiSessionQueuePause(undefined), false);
  assert.equal(supportsDirectoryAiSessionQueuePause({ aiSessionTimeline: {}, aiSessionQueuePause: true, future: "ignored" }), true);
  assert.equal(supportsDirectoryAiSessionQueuePause({ aiSessionQueuePause: "yes" }), false);
  assert.equal(ControlPlaneInstanceDirectoryCapabilitiesSchema.parse({ aiSessionTimeline: {} }).aiSessionQueuePause, undefined);
});
