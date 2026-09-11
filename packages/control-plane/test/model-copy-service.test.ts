import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { modelConfigHash } from "@task-handoff/protocol/control-plane";
import { ControlPlaneModelService } from "../src/control-plane/models/service.ts";
import { ControlPlaneModelRepository } from "../src/control-plane/models/repository.ts";
import { createControlPlaneDatabase } from "../src/control-plane/persistence/database/index.ts";
import { controlPlaneStorePaths } from "../src/control-plane/persistence/paths.ts";
import { SecretEnvelopeService } from "../src/control-plane/persistence/secret-envelope.ts";

test("control-plane model copies inherit secrets without overwriting an existing identity", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-model-copy-"));
  const paths = controlPlaneStorePaths(directory);
  const database = await createControlPlaneDatabase(paths);
  const secrets = new SecretEnvelopeService(paths.databaseEncryptionKeyPath);
  secrets.init();
  const repository = new ControlPlaneModelRepository(database, secrets);
  try {
    const service = new ControlPlaneModelService({
      repository,
      gateway: {} as never,
      listNodes: () => [],
      requireNode: () => { throw new Error("unused"); },
      fetchImpl: fetch,
    });
    await service.init();

    const legacySpec = { app: "codex" as const, endpoint: "https://legacy.example.test/v1", key: "legacy-secret", model: "legacy-model" };
    const legacyId = modelConfigHash(legacySpec);
    await repository.put({
      id: legacyId,
      name: "Legacy",
      ...legacySpec,
      modelNames: [{ name: "legacy-model", order: 100 }],
      protocols: ["openai-responses"],
      enabled: true,
      order: 50,
      labels: {},
      createdAt: "2026-08-01T00:00:00.000Z",
      updatedAt: "2026-08-01T00:00:00.000Z",
    });
    await service.init();
    const savedLegacy = await service.update(legacyId, { name: "Legacy saved" });
    assert.deepEqual(savedLegacy.modelNames, [{ name: "legacy-model", order: 100 }]);
    const persistedLegacy = await repository.get(legacyId);
    assert.deepEqual(persistedLegacy.modelNames, [{ name: "legacy-model", order: 100 }]);
    assert.deepEqual(persistedLegacy.protocols, ["openai-responses"]);

    const source = await service.create({ name: "Primary", endpoint: "https://api.example.test/v1", key: "secret-key", model: "model-a", app: "codex" });
    assert.deepEqual(source.modelNames, [{ name: "model-a", order: 100 }]);

    const upgraded = await service.update(source.id, { name: "Primary renamed" });
    assert.deepEqual(upgraded.modelNames, [{ name: "model-a", order: 100 }]);

    const multiModel = await service.create({
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

    const copy = await service.copy(source.id, { name: "Secondary", endpoint: source.endpoint, model: "model-b", app: source.app, enabled: source.enabled });
    assert.notEqual(copy.id, source.id);
    assert.equal((await repository.get(copy.id))?.key, "secret-key");
    assert.equal("key" in copy, false);

    await assert.rejects(
      () => service.copy(source.id, { name: "Renamed only", endpoint: source.endpoint, model: source.model, app: source.app, enabled: source.enabled }),
      (error: unknown) => (error as { code?: string }).code === "MODEL_COPY_UNCHANGED",
    );
    await assert.rejects(
      () => service.copy(source.id, { name: "Duplicate", endpoint: copy.endpoint, model: copy.model, app: copy.app, enabled: copy.enabled }),
      (error: unknown) => (error as { code?: string }).code === "MODEL_COPY_CONFLICT",
    );
  } finally {
    await database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("control-plane model deletion protects instance, active session and recoverable history references", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-model-references-"));
  const paths = controlPlaneStorePaths(directory);
  const database = await createControlPlaneDatabase(paths);
  const secrets = new SecretEnvelopeService(paths.databaseEncryptionKeyPath);
  secrets.init();
  const repository = new ControlPlaneModelRepository(database, secrets);
  try {
    let modelId = "";
    const service = new ControlPlaneModelService({
      repository,
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
    await service.init();
    modelId = (await service.create({ name: "Referenced", endpoint: "https://api.example.test/v1", key: "secret", model: "same-name", app: "codex" })).id;
    await assert.rejects(service.delete(modelId), (error: unknown) => {
      const value = error as { code?: string; details?: { references?: unknown[] }; message?: string };
      assert.equal(value.code, "MODEL_IN_USE");
      assert.equal(value.details?.references?.length, 3);
      assert.equal(JSON.stringify(value).includes("secret"), false);
      return true;
    });
    assert.ok(await repository.get(modelId));
  } finally {
    await database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
