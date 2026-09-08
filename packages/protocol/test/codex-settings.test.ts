import assert from "node:assert/strict";
import test from "node:test";
import {
  CodexInstanceSettingsSchema,
  normalizeControlledInstanceCapabilities,
  parseCodexInstanceSettings,
  supportsControlledInstanceCodexManagedSettings,
  supportsNodeCodexManagedSettings,
} from "../src/control-plane.ts";

test("managed Codex settings use a strict bounded model", () => {
  const settings = CodexInstanceSettingsSchema.parse({
    modelVerbosity: "high",
    personality: "pragmatic",
    multiAgent: {
      enabled: true,
      maxConcurrentThreads: 8,
      defaultModel: { modelEntityId: "mdl_one", modelName: "gpt-codex" },
      defaultReasoningEffort: "high",
    },
  });
  assert.equal(settings.multiAgent.maxConcurrentThreads, 8);
  assert.equal(CodexInstanceSettingsSchema.safeParse({ ...settings, future: true }).success, false);
  assert.equal(CodexInstanceSettingsSchema.safeParse({ multiAgent: { enabled: true, maxConcurrentThreads: 65 } }).success, false);
  assert.deepEqual(parseCodexInstanceSettings({
    ...settings,
    future: true,
    multiAgent: {
      ...settings.multiAgent,
      defaultModel: { ...settings.multiAgent.defaultModel!, future: true },
      future: true,
    },
  }), settings);
});

test("managed Codex capability is additive and defaults to unsupported for v0.0.28", () => {
  assert.equal(supportsNodeCodexManagedSettings({}), false);
  assert.equal(supportsControlledInstanceCodexManagedSettings({ features: {} }), false);
  assert.equal(supportsNodeCodexManagedSettings({ codexManagedSettings: true, future: true }), true);
  const capabilities = normalizeControlledInstanceCapabilities({ features: { codexManagedSettings: true, future: true } });
  assert.equal(capabilities.features.codexManagedSettings, true);
});
