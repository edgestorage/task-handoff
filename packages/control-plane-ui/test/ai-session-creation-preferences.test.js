import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import {
  loadAiSessionCreationPreferences,
  persistAiSessionCreationPreferences,
} from "../src/apps/control-plane/instance-detail/aiSessionCreationPreferences.ts";

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    values,
  };
}

test("AI session creation preferences merge model and reasoning defaults per agent", () => {
  const storage = memoryStorage();

  persistAiSessionCreationPreferences("codex", {
    modelSelection: { modelEntityId: "model/one", modelName: "gpt-5.6" },
  }, storage);
  persistAiSessionCreationPreferences("codex", { reasoningEffort: "high" }, storage);
  persistAiSessionCreationPreferences("opencode", { reasoningEffort: "low" }, storage);

  assert.deepEqual(loadAiSessionCreationPreferences("codex", storage), {
    modelSelection: { modelEntityId: "model/one", modelName: "gpt-5.6" },
    reasoningEffort: "high",
  });
  assert.deepEqual(loadAiSessionCreationPreferences("opencode", storage), { reasoningEffort: "low" });
});

test("AI session creation preferences sanitize malformed and independently invalid fields", () => {
  const storage = memoryStorage({
    "task-handoff.control-plane.ai-session-creation-preferences.codex": JSON.stringify({
      modelSelection: { modelEntityId: "model-one", modelName: "gpt-5.6", privateEndpoint: "hidden" },
      reasoningEffort: "high",
      futureField: true,
    }),
    "task-handoff.control-plane.ai-session-creation-preferences.claude": "{",
  });

  assert.deepEqual(loadAiSessionCreationPreferences("codex", storage), {
    modelSelection: { modelEntityId: "model-one", modelName: "gpt-5.6" },
    reasoningEffort: "high",
  });
  assert.deepEqual(loadAiSessionCreationPreferences("claude", storage), {});
  assert.deepEqual(loadAiSessionCreationPreferences("", storage), {});
});

test("AI session model selections update creation preferences from both composers", () => {
  const panel = fs.readFileSync(new URL("../src/apps/control-plane/instance-detail/AiSessionPanel.vue", import.meta.url), "utf8");

  assert.match(panel, /@select-model="selectNewSessionModel"/);
  assert.match(panel, /persistAiSessionCreationPreferences\(newSessionApp\.value, \{ modelSelection \}\)/);
  assert.match(panel, /persistAiSessionCreationPreferences\(session\.agent, \{ modelSelection \}\)/);
});
