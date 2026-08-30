import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ModelConfigSchema, modelConfigHash, type ModelConfig } from "@task-handoff/protocol/control-plane";
import { ControlPlaneModelService } from "../src/control-plane/models/service.ts";
import { JsonCollection } from "../src/shared/persistence/store.ts";

test("control-plane model copies inherit secrets without overwriting an existing identity", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-model-copy-"));
  try {
    const models = new JsonCollection<ModelConfig>(directory, { schema: ModelConfigSchema });
    models.init();
    const service = new ControlPlaneModelService({
      models,
      gateway: {} as never,
      listNodes: () => [],
      requireNode: () => { throw new Error("unused"); },
      fetchImpl: fetch,
    });

    const legacySpec = { app: "codex" as const, endpoint: "https://legacy.example.test/v1", key: "legacy-secret", model: "legacy-model" };
    const legacyId = modelConfigHash(legacySpec);
    fs.writeFileSync(path.join(directory, `${legacyId}.json`), JSON.stringify({
      id: legacyId,
      name: "Legacy",
      ...legacySpec,
      enabled: true,
      order: 50,
      labels: {},
      createdAt: "2026-08-01T00:00:00.000Z",
      updatedAt: "2026-08-01T00:00:00.000Z",
    }));
    const savedLegacy = service.update(legacyId, { name: "Legacy saved" });
    assert.deepEqual(savedLegacy.modelNames, [{ name: "legacy-model", order: 100 }]);
    const persistedLegacy = JSON.parse(fs.readFileSync(path.join(directory, `${legacyId}.json`), "utf8"));
    assert.deepEqual(persistedLegacy.modelNames, [{ name: "legacy-model", order: 100 }]);
    assert.deepEqual(persistedLegacy.protocols, ["openai-responses"]);

    const source = service.create({ name: "Primary", endpoint: "https://api.example.test/v1", key: "secret-key", model: "model-a", app: "codex" });
    assert.deepEqual(source.modelNames, [{ name: "model-a", order: 100 }]);

    const upgraded = service.update(source.id, { name: "Primary renamed" });
    assert.deepEqual(upgraded.modelNames, [{ name: "model-a", order: 100 }]);

    const multiModel = service.create({
      name: "Multiple",
      endpoint: "https://multi.example.test/v1",
      key: "multi-secret-key",
      model: "legacy-placeholder",
      modelNames: [
        { name: "model-b", order: 200 },
        { name: "model-a", order: 100 },
      ],
      app: "codex",
    });
    assert.equal(multiModel.model, "model-a");
    assert.deepEqual(multiModel.modelNames, [
      { name: "model-a", order: 100 },
      { name: "model-b", order: 200 },
    ]);

    const copy = service.copy(source.id, { name: "Secondary", endpoint: source.endpoint, model: "model-b", app: source.app, enabled: source.enabled });
    assert.notEqual(copy.id, source.id);
    assert.equal(models.get(copy.id)?.key, "secret-key");
    assert.equal("key" in copy, false);

    assert.throws(
      () => service.copy(source.id, { name: "Renamed only", endpoint: source.endpoint, model: source.model, app: source.app, enabled: source.enabled }),
      (error: unknown) => (error as { code?: string }).code === "MODEL_COPY_UNCHANGED",
    );
    assert.throws(
      () => service.copy(source.id, { name: "Duplicate", endpoint: copy.endpoint, model: copy.model, app: copy.app, enabled: copy.enabled }),
      (error: unknown) => (error as { code?: string }).code === "MODEL_COPY_CONFLICT",
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("control-plane model deletion protects instance, active session and recoverable history references", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-model-references-"));
  try {
    const models = new JsonCollection<ModelConfig>(directory, { schema: ModelConfigSchema });
    models.init();
    let modelId = "";
    const service = new ControlPlaneModelService({
      models,
      gateway: {} as never,
      listNodes: () => [],
      requireNode: () => { throw new Error("unused"); },
      fetchImpl: fetch,
      listInstances: async () => [{ id: "inst_one", modelSelection: { modelEntityIds: [modelId] } } as never, { id: "inst_two", modelSelection: {} } as never],
      listAiSessions: async () => ({ instances: [{ instanceId: "inst_two", aiSessions: { sessions: [{ id: "session_current", modelSelection: { modelEntityId: modelId } }] } }] }),
      listAiSessionHistory: async (instanceId) => ({ items: instanceId === "inst_two" ? [{
        id: "session_history", agent: "codex", creationSource: "ai-session", providerSessionId: "thread_history",
        modelSelection: { modelEntityId: modelId, modelName: "same-name" }, cwd: "/workspace",
        lastActiveAt: "2026-08-28T00:00:00.000Z", archivedAt: "2026-08-28T00:00:00.000Z",
      }] : [] }),
    });
    modelId = service.create({ name: "Referenced", endpoint: "https://api.example.test/v1", key: "secret", model: "same-name", app: "codex" }).id;
    await assert.rejects(service.delete(modelId), (error: unknown) => {
      const value = error as { code?: string; details?: { references?: unknown[] }; message?: string };
      assert.equal(value.code, "MODEL_IN_USE");
      assert.equal(value.details?.references?.length, 3);
      assert.equal(JSON.stringify(value).includes("secret"), false);
      return true;
    });
    assert.ok(models.get(modelId));
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
