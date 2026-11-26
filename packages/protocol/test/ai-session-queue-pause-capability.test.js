import assert from "node:assert/strict";
import test from "node:test";
import { normalizeControlledInstanceCapabilities, supportsAiSessionQueuePause } from "../src/control-plane.ts";
import { ControlPlaneInstanceDirectoryCapabilitiesSchema, supportsDirectoryAiSessionQueuePause } from "../src/control-plane-directory.ts";
import { directoryAiSessionProviderCapability } from "../src/control-plane-directory.ts";
import { supportsAiSessionHistoryResume } from "../src/ai-session-provider-capabilities.ts";

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

test("history resume is additive for v0.0.61 and accepts future provider IDs", () => {
  const directory = { aiSessionProviders: [
    { agent: "codex", actions: {}, timeline: {} },
    { agent: "dsh", actions: { historyResume: false }, timeline: {} },
    { agent: "future-agent", actions: { historyResume: true, futureAction: true }, timeline: {} },
  ] };
  const supports = (agent) => supportsAiSessionHistoryResume(agent, directoryAiSessionProviderCapability(directory, agent));
  assert.equal(supports("codex"), true);
  assert.equal(supports("dsh"), false);
  assert.equal(supports("future-agent"), true);
  assert.equal(supports("unknown-agent"), false);
});
