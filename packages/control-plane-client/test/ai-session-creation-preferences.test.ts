import assert from "node:assert/strict";
import test from "node:test";

import {
  mergeAiSessionCreationPreferences,
  sanitizeAiSessionCreationPreferences,
} from "../src/ai-session-creation-preferences.ts";

test("sanitizes creation preferences independently and drops unknown fields", () => {
  assert.deepEqual(sanitizeAiSessionCreationPreferences({
    modelSelection: {
      modelEntityId: "model-one",
      modelName: "gpt-5.6",
      modelUpstreamName: "upstream-one",
      privateEndpoint: "hidden",
    },
    reasoningEffort: "high",
    futureField: true,
  }), {
    modelSelection: {
      modelEntityId: "model-one",
      modelName: "gpt-5.6",
      modelUpstreamName: "upstream-one",
    },
    reasoningEffort: "high",
  });

  assert.deepEqual(sanitizeAiSessionCreationPreferences({
    modelSelection: { modelEntityId: "model-one", modelName: "gpt-5.6" },
    reasoningEffort: "unsupported",
  }), {
    modelSelection: { modelEntityId: "model-one", modelName: "gpt-5.6" },
  });

  assert.deepEqual(sanitizeAiSessionCreationPreferences("not-an-object"), {});
  assert.deepEqual(sanitizeAiSessionCreationPreferences([]), {});
});

test("merges a creation preference patch without clearing the other field", () => {
  assert.deepEqual(mergeAiSessionCreationPreferences(
    { modelSelection: { modelEntityId: "model-one", modelName: "gpt-5.6" }, reasoningEffort: "high" },
    { reasoningEffort: "low" },
  ), {
    modelSelection: { modelEntityId: "model-one", modelName: "gpt-5.6" },
    reasoningEffort: "low",
  });
});
