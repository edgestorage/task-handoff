import assert from "node:assert/strict";
import test from "node:test";
import { ModelConfigSchema, NodeModelConfigSchema, supportsNodeModelProviderCapabilities } from "@task-handoff/protocol/control-plane";
import { openCodeProvider } from "../src/node-agent/models/registry.ts";

const model = (capabilities?: { image: boolean }) => NodeModelConfigSchema.parse({
  id: "mdl_provider_capabilities",
  name: "Provider",
  endpoint: "https://models.example.test/v1",
  key: "secret",
  model: "model-a",
  modelNames: [{ name: "model-a", order: 100 }, { name: "model-b", order: 200 }],
  mappings: [],
  protocols: ["openai-chat-completions"],
  app: "opencode",
  enabled: true,
  order: 0,
  labels: {},
  ...(capabilities ? { capabilities } : {}),
  createdAt: "2026-11-01T00:00:00.000Z",
  updatedAt: "2026-11-01T00:00:00.000Z",
});

test("provider image capability expands to every OpenCode model", () => {
  const provider = openCodeProvider(model({ image: true }), ["model-a", "model-b"]) as any;
  for (const name of ["model-a", "model-b"]) {
    assert.deepEqual(provider.models[name].modalities, { input: ["text", "image"], output: ["text"] });
    assert.equal(provider.models[name].attachment, true);
  }
});

test("provider image capability stays off for legacy records", () => {
  const provider = openCodeProvider(model(), ["model-a"]) as any;
  assert.equal(provider.models["model-a"].modalities, undefined);
  assert.equal(provider.models["model-a"].attachment, undefined);
});

test("model records keep provider capabilities optional for older records", () => {
  const legacy = ModelConfigSchema.parse({
    id: "mdl_legacy",
    name: "Legacy",
    endpoint: "https://models.example.test/v1",
    key: "secret",
    model: "legacy-model",
    modelNames: [{ name: "legacy-model", order: 100 }],
    mappings: [],
    protocols: ["openai-chat-completions"],
    app: "opencode",
    enabled: true,
    order: 0,
    labels: {},
    createdAt: "2026-11-01T00:00:00.000Z",
    updatedAt: "2026-11-01T00:00:00.000Z",
  });
  assert.equal(legacy.capabilities, undefined);
  assert.equal(supportsNodeModelProviderCapabilities({}), false);
  assert.equal(supportsNodeModelProviderCapabilities({ managedModels: { providerCapabilities: true } }), true);
});
