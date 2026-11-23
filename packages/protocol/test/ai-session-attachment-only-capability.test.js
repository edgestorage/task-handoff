import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizeControlledInstanceCapabilities,
  supportsAiSessionAttachmentOnlyMessages,
} from "../src/control-plane.ts";
import {
  ControlPlaneInstanceDirectoryCapabilitiesSchema,
  supportsDirectoryAiSessionAttachmentOnlyMessages,
} from "../src/control-plane-directory.ts";

test("attachment-only AI Session capability is additive and independently normalized", () => {
  assert.equal(supportsAiSessionAttachmentOnlyMessages({ features: {} }), false);
  assert.equal(supportsAiSessionAttachmentOnlyMessages({ features: { aiSessionAttachmentOnlyMessages: "yes" } }), false);
  assert.equal(supportsAiSessionAttachmentOnlyMessages({ features: { aiSessionAttachmentOnlyMessages: true, future: true } }), true);
  assert.equal(normalizeControlledInstanceCapabilities({ features: { aiSessionAttachmentOnlyMessages: true } }).features.aiSessionAttachmentOnlyMessages, true);
});

test("directory attachment-only AI Session capability ignores malformed unrelated fields", () => {
  assert.equal(supportsDirectoryAiSessionAttachmentOnlyMessages({ aiSessionTimeline: {}, aiSessionAttachmentOnlyMessages: true, future: true }), true);
  assert.equal(supportsDirectoryAiSessionAttachmentOnlyMessages({ aiSessionAttachmentOnlyMessages: "yes" }), false);
  assert.equal(ControlPlaneInstanceDirectoryCapabilitiesSchema.parse({ aiSessionTimeline: {} }).aiSessionAttachmentOnlyMessages, undefined);
});
