import assert from "node:assert/strict";
import test from "node:test";

import {
  ControlPlaneInstanceDirectoryCapabilitiesSchema,
  supportsDirectoryAiSessionSendIdempotency,
} from "../src/control-plane-directory.ts";

test("directory send idempotency is additive and N-1 safe", () => {
  assert.equal(ControlPlaneInstanceDirectoryCapabilitiesSchema.parse({}).aiSessionSendIdempotency, undefined);
  assert.equal(supportsDirectoryAiSessionSendIdempotency(undefined), false);
  assert.equal(supportsDirectoryAiSessionSendIdempotency({ aiSessionTimeline: {}, future: "ignored" }), false);
  assert.equal(supportsDirectoryAiSessionSendIdempotency({ aiSessionSendIdempotency: true, future: "ignored" }), true);
});
