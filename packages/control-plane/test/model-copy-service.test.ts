import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { migratedModelEntityId } from "@task-handoff/protocol/control-plane";
import { ControlPlaneModelService } from "../src/control-plane/models/service.ts";
import { ControlPlaneModelRepository } from "../src/control-plane/models/repository.ts";
import { createControlPlaneDatabase } from "../src/control-plane/persistence/database/index.ts";
import { controlPlaneStorePaths } from "../src/control-plane/persistence/paths.ts";
import { SecretEnvelopeService } from "../src/control-plane/persistence/secret-envelope.ts";

test("control-plane model copies inherit secrets and matching content retains separate identities", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-model-copy-"));
  const paths = controlPlaneStorePaths(directory);
  const database = await createControlPlaneDatabase(paths);
  const secrets = new SecretEnvelopeService(paths.databaseEncryptionKeyPath);
  secrets.init();
  const repository = new ControlPlaneModelRepository(database, secrets);
  try {
    const service = new ControlPlaneModelService({
      repository,
      gateway: { listFleetModels: async () => ({ items: [], nodeErrors: [] }) } as never,
      listNodes: () => [],
      requireNode: () => { throw new Error("unused"); },
      fetchImpl: fetch,
    });
    await service.init();

    // Compatibility for v0.0.35: a record persisted under the retired
    // content-hash identity upgrades onto its derived entity id on the first
    // save and answers under the stable id from then on.
    const legacySpec = { app: "codex" as const, endpoint: "https://legacy.example.test/v1", key: "legacy-secret", model: "legacy-model" };
    const legacyId = `mdl_${"a".repeat(64)}`;
    const legacyEntityId = migratedModelEntityId(legacyId);
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
    assert.equal(savedLegacy.model.id, legacyEntityId);
    assert.deepEqual(savedLegacy.model.modelNames, [{ name: "legacy-model", order: 100 }]);
    assert.equal(await repository.get(legacyId), undefined);
    const persistedLegacy = await repository.get(legacyEntityId);
    assert.ok(persistedLegacy);
    // Repository reads always normalize to the canonical in-memory shape
    // (upstreamName = name), while the stored record stays compact.
    assert.deepEqual(persistedLegacy.modelNames, [{ name: "legacy-model", upstreamName: "legacy-model", order: 100 }]);
    assert.deepEqual((await database.models.get(legacyEntityId))?.modelNames, [{ name: "legacy-model", order: 100 }]);
    assert.deepEqual(persistedLegacy.protocols, ["openai-responses"]);

    const source = await service.create({ name: "Primary", endpoint: "https://api.example.test/v1", key: "secret-key", model: "model-a", app: "codex" });
    assert.deepEqual(source.modelNames, [{ name: "model-a", order: 100 }]);

    const upgraded = await service.update(source.id, { name: "Primary renamed" });
    assert.deepEqual(upgraded.model.modelNames, [{ name: "model-a", order: 100 }]);
    assert.equal(upgraded.model.order, source.order);
    assert.deepEqual(upgraded.model.protocols, source.protocols);

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

    const renamedOnly = await service.copy(source.id, { name: "Renamed only", endpoint: source.endpoint, model: source.model, app: source.app, enabled: source.enabled });
    const sameName = await service.create({ name: source.name, endpoint: source.endpoint, key: "secret-key", model: source.model, app: source.app });
    assert.equal(renamedOnly.revision, source.revision);
    assert.equal(sameName.revision, source.revision);
    assert.equal(new Set([source.id, renamedOnly.id, sameName.id]).size, 3);
    assert.equal((await repository.get(renamedOnly.id))?.key, "secret-key");

    const duplicate = await service.copy(source.id, { name: "Duplicate", endpoint: copy.endpoint, model: copy.model, app: copy.app, enabled: copy.enabled });
    assert.equal(duplicate.revision, copy.revision);
    assert.notEqual(duplicate.id, copy.id);
    assert.equal((await repository.get(duplicate.id))?.key, "secret-key");
    const matchingGroups = (await service.listFederated()).models.filter((group) => group.model.revision === source.revision);
    assert.deepEqual(new Set(matchingGroups.map((group) => group.id)), new Set([source.id, renamedOnly.id, sameName.id]));
  } finally {
    await database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("control-plane model deletion is protected by instance assignments only", async () => {
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
    });
    await service.init();
    modelId = (await service.create({ name: "Referenced", endpoint: "https://api.example.test/v1", key: "secret", model: "same-name", app: "codex" })).id;
    await assert.rejects(service.delete(modelId), (error: unknown) => {
      const value = error as { code?: string; details?: { references?: unknown[] }; message?: string };
      assert.equal(value.code, "MODEL_IN_USE");
      assert.deepEqual(value.details?.references, [{ kind: "instance", instanceId: "inst_one" }]);
      assert.equal(JSON.stringify(value).includes("secret"), false);
      return true;
    });
    assert.ok(await repository.get(modelId));
  } finally {
    await database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("paused node model convergence remains pending until the node reconnects", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-model-paused-node-"));
  const paths = controlPlaneStorePaths(directory);
  const database = await createControlPlaneDatabase(paths);
  const secrets = new SecretEnvelopeService(paths.databaseEncryptionKeyPath);
  secrets.init();
  const repository = new ControlPlaneModelRepository(database, secrets);
  try {
    let modelId = "";
    let deployCalls = 0;
    const node = {
      id: "node_paused",
      connectionEnabled: false,
      capabilities: {
        agent: {
          capabilities: {
            managedModels: { multiEntityAssignment: true, privateModelCatalog: true, stableModelIdentity: true },
          },
        },
      },
    } as never;
    let stored = {
      id: "",
      name: "Paused replica",
      endpoint: "https://api.example.test/v1",
      model: "paused-model",
      modelNames: [{ name: "paused-model", order: 100 }],
      mappings: [],
      protocols: ["openai-responses"],
      app: "codex",
      enabled: true,
      order: 100,
      labels: {},
      createdAt: "2026-08-01T00:00:00.000Z",
      updatedAt: "2026-08-01T00:00:00.000Z",
      keyPreview: "secr...cret",
      keySet: true,
      referenceCount: 0,
    };
    const fleet = () => ({
      items: modelId ? [{ nodeId: "node_paused", model: { ...stored, id: modelId } }] : [],
      nodeErrors: [],
      nodeStates: [{ nodeId: "node_paused", resource: "models", phase: "ready" }],
    });
    const service = new ControlPlaneModelService({
      repository,
      gateway: {
        listFleetModels: async () => fleet(),
        readFleetModels: () => fleet(),
        deployModel: async (_node: unknown, id: string, input: Record<string, unknown>) => {
          deployCalls += 1;
          stored = { ...stored, ...input, id, updatedAt: "2026-08-02T00:00:00.000Z" } as typeof stored;
          return stored;
        },
      } as never,
      listNodes: () => [node],
      requireNode: () => node,
      fetchImpl: fetch,
    });
    await service.init();
    modelId = (await service.create({
      name: "Paused replica",
      endpoint: "https://api.example.test/v1",
      key: "secret",
      model: "paused-model",
      app: "codex",
    })).id;

    const updated = await service.update(modelId, { name: "Paused replica renamed" });
    assert.equal(deployCalls, 0);
    assert.equal(updated.model.name, "Paused replica renamed");
    assert.deepEqual(updated.locations, [{
      nodeId: "node_paused",
      state: "pending",
      code: "NODE_AGENT_CONNECTION_DISABLED",
      message: "Node agent connection is disabled locally.",
    }]);

    (node as { connectionEnabled: boolean }).connectionEnabled = true;
    await service.flushPendingModelSyncs();
    assert.equal(deployCalls, 1);
    assert.equal(stored.name, "Paused replica renamed");
  } finally {
    await database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("node-owned deferred edits merge durably and are consumed per node", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-model-node-owned-pending-"));
  const paths = controlPlaneStorePaths(directory);
  const database = await createControlPlaneDatabase(paths);
  const secrets = new SecretEnvelopeService(paths.databaseEncryptionKeyPath);
  secrets.init();
  const repository = new ControlPlaneModelRepository(database, secrets);
  const createdAt = "2026-08-01T00:00:00.000Z";
  const modelId = "mdl_node_owned_one";
  let version = 0;
  const record = (name: string, enabled = true) => ({
    id: modelId,
    name,
    endpoint: "https://api.example.test/v1",
    model: "node-model",
    modelNames: [{ name: "node-model", upstreamName: "node-model", order: 100 }],
    mappings: [],
    protocols: ["openai-responses"] as const,
    app: "codex" as const,
    enabled,
    order: 100,
    labels: { route: "node" },
    createdAt,
    updatedAt: createdAt,
    keyPreview: "secr...cret",
    keySet: true,
    referenceCount: 0,
    revision: `mdlr_${"a".repeat(64)}`,
  });
  const records = new Map([
    ["node_a", record("Original replica")],
    ["node_b", record("Original replica")],
  ]);
  const node = (id: string) => ({
    id,
    connectionEnabled: false,
    capabilities: {
      agent: { capabilities: { managedModels: { stableModelIdentity: true } } },
    },
  } as never);
  const nodes = [node("node_a"), node("node_b")];
  const fleet = () => ({
    items: nodes
      .filter((candidate) => (candidate as { connectionEnabled: boolean }).connectionEnabled !== undefined)
      .map((candidate) => ({ nodeId: (candidate as { id: string }).id, model: records.get((candidate as { id: string }).id)! })),
    nodeErrors: [],
    nodeStates: nodes.map((candidate) => ({ nodeId: (candidate as { id: string }).id, resource: "models", phase: "ready" })),
  });
  const gateway = {
    listFleetModels: async () => fleet(),
    readFleetModels: () => fleet(),
    updateModel: async (target: { id: string }, id: string, patch: Record<string, unknown>) => {
      version += 1;
      const current = records.get(target.id)!;
      const next = {
        ...current,
        ...patch,
        id,
        updatedAt: new Date(Date.parse(createdAt) + version * 1000).toISOString(),
        revision: `mdlr_${version.toString(16).padStart(64, "0")}`,
      };
      records.set(target.id, next);
      return next;
    },
  } as never;
  const makeService = () => new ControlPlaneModelService({
    repository: new ControlPlaneModelRepository(database, secrets),
    gateway,
    listNodes: () => nodes,
    requireNode: () => nodes[0]!,
    fetchImpl: fetch,
  });
  try {
    const service = makeService();
    await service.init();
    const first = await service.update(modelId, { name: "Durable rename" });
    assert.equal(first.locations.every((location) => location.state === "pending"), true);
    const second = await service.update(modelId, { enabled: false });
    assert.equal(second.model.name, "Durable rename");
    assert.equal(second.model.enabled, false);

    const restarted = makeService();
    await restarted.init();
    const persisted = await repository.listPendingNodeEdits();
    assert.equal(persisted.length, 2);
    assert.deepEqual(new Set(persisted.map((edit) => edit.nodeId)), new Set(["node_a", "node_b"]));
    assert.deepEqual(persisted[0]!.patch, { name: "Durable rename", enabled: false });

    (nodes[0] as { connectionEnabled: boolean }).connectionEnabled = true;
    await restarted.flushPendingModelSyncs();
    assert.equal(records.get("node_a")!.name, "Durable rename");
    assert.equal(records.get("node_a")!.enabled, false);
    assert.equal(records.get("node_a")!.order, 100);
    assert.deepEqual(records.get("node_a")!.labels, { route: "node" });
    assert.equal(records.get("node_b")!.name, "Original replica");
    assert.deepEqual((await repository.listPendingNodeEdits()).map((edit) => edit.nodeId), ["node_b"]);

    (nodes[1] as { connectionEnabled: boolean }).connectionEnabled = true;
    await restarted.flushPendingModelSyncs();
    assert.equal(records.get("node_b")!.name, "Durable rename");
    assert.equal(records.get("node_b")!.enabled, false);
    assert.deepEqual(await repository.listPendingNodeEdits(), []);
  } finally {
    await database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("concurrent node-owned deferred edits are serialized per replica", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-model-node-owned-concurrent-"));
  const paths = controlPlaneStorePaths(directory);
  const database = await createControlPlaneDatabase(paths);
  const secrets = new SecretEnvelopeService(paths.databaseEncryptionKeyPath);
  secrets.init();
  const repository = new ControlPlaneModelRepository(database, secrets);
  const modelId = "mdl_node_owned_concurrent";
  const createdAt = "2026-08-01T00:00:00.000Z";
  const stored = {
    id: modelId,
    name: "Original",
    endpoint: "https://api.example.test/v1",
    model: "node-model",
    modelNames: [{ name: "node-model", upstreamName: "node-model", order: 100 }],
    mappings: [],
    protocols: ["openai-responses"] as const,
    app: "codex" as const,
    enabled: true,
    order: 100,
    labels: {},
    createdAt,
    updatedAt: createdAt,
    keyPreview: "secr...cret",
    keySet: true,
    referenceCount: 0,
    revision: `mdlr_${"c".repeat(64)}`,
  };
  const node = {
    id: "node_concurrent",
    connectionEnabled: false,
    capabilities: {
      agent: { capabilities: { managedModels: { stableModelIdentity: true } } },
    },
  } as never;
  const fleet = () => ({
    items: [{ nodeId: "node_concurrent", model: stored }],
    nodeErrors: [],
    nodeStates: [{ nodeId: "node_concurrent", resource: "models", phase: "ready" }],
  });
  const originalPutPendingNodeEdit = repository.putPendingNodeEdit.bind(repository);
  const delay = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
  let putCalls = 0;
  let releaseSecond!: () => void;
  const secondArrived = new Promise<void>((resolve) => { releaseSecond = resolve; });
  let firstEntered!: () => void;
  const firstPutEntered = new Promise<void>((resolve) => { firstEntered = resolve; });
  repository.putPendingNodeEdit = async (input) => {
    putCalls += 1;
    if (putCalls === 1) {
      firstEntered();
      // The timeout keeps this test progressing once writes are serialized;
      // without a per-replica lock the second write arrives immediately and
      // then overtakes this one.
      await Promise.race([secondArrived, delay(30)]);
      await delay(10);
    } else {
      releaseSecond();
    }
    return originalPutPendingNodeEdit(input);
  };
  const service = new ControlPlaneModelService({
    repository,
    gateway: {
      listFleetModels: async () => fleet(),
      readFleetModels: () => fleet(),
      updateModel: async () => { throw new Error("offline node must not be written"); },
    } as never,
    listNodes: () => [node],
    requireNode: () => node,
    fetchImpl: fetch,
  });
  try {
    await service.init();
    const first = service.update(modelId, { name: "First edit" });
    await firstPutEntered;
    const second = service.update(modelId, { name: "Second edit", enabled: false });
    await Promise.all([first, second]);
    const persisted = await repository.listPendingNodeEdits();
    assert.equal(putCalls, 2);
    assert.equal(persisted.length, 1);
    assert.deepEqual(persisted[0]!.patch, { name: "Second edit", enabled: false });
  } finally {
    await database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("permanent node rejection preserves the new intent and fails the write", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-model-node-owned-rejected-"));
  const paths = controlPlaneStorePaths(directory);
  const database = await createControlPlaneDatabase(paths);
  const secrets = new SecretEnvelopeService(paths.databaseEncryptionKeyPath);
  secrets.init();
  const repository = new ControlPlaneModelRepository(database, secrets);
  const modelId = "mdl_node_owned_rejected";
  const createdAt = "2026-08-01T00:00:00.000Z";
  const record = (name: string, enabled = true) => ({
    id: modelId,
    name,
    endpoint: "https://api.example.test/v1",
    model: "node-model",
    modelNames: [{ name: "node-model", upstreamName: "node-model", order: 100 }],
    mappings: [],
    protocols: ["openai-responses"] as const,
    app: "codex" as const,
    enabled,
    order: 100,
    labels: {},
    createdAt,
    updatedAt: createdAt,
    keyPreview: "secr...cret",
    keySet: true,
    referenceCount: 0,
    revision: `mdlr_${"d".repeat(64)}`,
  });
  const stored = record("Original");
  const node = {
    id: "node_rejected",
    connectionEnabled: false,
    capabilities: {
      agent: { capabilities: { managedModels: { stableModelIdentity: true } } },
    },
  } as never;
  const fleet = () => ({
    items: [{ nodeId: "node_rejected", model: stored }],
    nodeErrors: [],
    nodeStates: [{ nodeId: "node_rejected", resource: "models", phase: "ready" }],
  });
  let pendingDuringApply: Awaited<ReturnType<ControlPlaneModelRepository["listPendingNodeEdits"]>> = [];
  const gateway: {
    listFleetModels: () => Promise<ReturnType<typeof fleet>>;
    readFleetModels: () => ReturnType<typeof fleet>;
    updateModel: (target: { id: string }, id: string, patch: Record<string, unknown>) => Promise<Record<string, unknown>>;
  } = {
    listFleetModels: async () => fleet(),
    readFleetModels: () => fleet(),
    updateModel: async () => {
      pendingDuringApply = await repository.listPendingNodeEdits();
      throw Object.assign(new Error("Node rejected the model patch."), { statusCode: 400, code: "NODE_MODEL_INVALID" });
    },
  };
  const service = new ControlPlaneModelService({
    repository,
    gateway: gateway as never,
    listNodes: () => [node],
    requireNode: () => node,
    fetchImpl: fetch,
  });
  try {
    await service.init();
    await service.update(modelId, { name: "Pending name" });
    (node as { connectionEnabled: boolean }).connectionEnabled = true;
    await assert.rejects(service.update(modelId, { enabled: false }), (error: unknown) => {
      const failure = error as { statusCode?: number; code?: string };
      assert.equal(failure.statusCode, 502);
      assert.equal(failure.code, "MODEL_UPDATE_SYNC_FAILED");
      return true;
    });
    // The merged revision is durable before the node write, so a crash cannot
    // replay the superseded name-only intent.
    assert.deepEqual(pendingDuringApply[0]!.patch, { name: "Pending name", enabled: false });
    assert.deepEqual((await repository.listPendingNodeEdits())[0]!.patch, { name: "Pending name", enabled: false });

    gateway.updateModel = async (target: { id: string }, id: string, patch: Record<string, unknown>) => {
      const next = {
        ...stored,
        ...patch,
        id,
        updatedAt: "2026-08-01T00:00:01.000Z",
        revision: `mdlr_${"e".repeat(64)}`,
      };
      Object.assign(stored, next);
      return next;
    };
    await service.flushPendingModelSyncs();
    assert.equal(stored.name, "Pending name");
    assert.equal(stored.enabled, false);
    assert.deepEqual(await repository.listPendingNodeEdits(), []);
  } finally {
    await database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("node-owned deferred edits are visible on refresh and encrypt credential material", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-model-node-owned-overlay-"));
  const paths = controlPlaneStorePaths(directory);
  const database = await createControlPlaneDatabase(paths);
  const secrets = new SecretEnvelopeService(paths.databaseEncryptionKeyPath);
  secrets.init();
  const repository = new ControlPlaneModelRepository(database, secrets);
  const modelId = "mdl_node_owned_overlay";
  const createdAt = "2026-08-01T00:00:00.000Z";
  const stored = {
    id: modelId,
    name: "Original",
    endpoint: "https://old.example.test/v1",
    model: "old-model",
    modelNames: [{ name: "old-model", upstreamName: "old-model", order: 100 }],
    mappings: [],
    protocols: ["openai-responses"] as const,
    app: "codex" as const,
    enabled: true,
    order: 100,
    labels: {},
    createdAt,
    updatedAt: createdAt,
    keyPreview: "secr...cret",
    keySet: true,
    referenceCount: 0,
    revision: `mdlr_${"b".repeat(64)}`,
  };
  const node = {
    id: "node_overlay",
    connectionEnabled: false,
    capabilities: {
      agent: { capabilities: { managedModels: { stableModelIdentity: true } } },
    },
  } as never;
  const fleet = () => ({
    items: [{ nodeId: "node_overlay", model: stored }],
    nodeErrors: [],
    nodeStates: [{ nodeId: "node_overlay", resource: "models", phase: "ready" }],
  });
  const service = new ControlPlaneModelService({
    repository,
    gateway: {
      listFleetModels: async () => fleet(),
      readFleetModels: () => fleet(),
      updateModel: async () => { throw new Error("offline node must not be written"); },
    } as never,
    listNodes: () => [node],
    requireNode: () => node,
    fetchImpl: fetch,
  });
  try {
    await service.init();
    const patch = {
      name: "Pending name",
      endpoint: "https://new.example.test/v1",
      model: "new-model",
      modelNames: [{ name: "new-model", upstreamName: "new-upstream", order: 100 }],
      key: "pending-model-secret",
    };
    const result = await service.update(modelId, patch);
    assert.equal(result.model.name, patch.name);
    assert.equal(result.model.endpoint, patch.endpoint);
    assert.deepEqual(result.model.modelNames, patch.modelNames);
    assert.equal(result.model.keyPreview, "set");

    const registry = await service.listFederated();
    const group = registry.models.find((candidate) => candidate.id === modelId)!;
    assert.equal(group.model.name, patch.name);
    assert.equal(group.model.endpoint, patch.endpoint);
    assert.deepEqual(group.model.modelNames, patch.modelNames);
    assert.equal(group.locations[0]!.type, "node");
    if (group.locations[0]!.type === "node") assert.equal(group.locations[0]!.name, patch.name);

    const rows = await database.modelPendingNodeEdits.list();
    assert.equal(rows.length, 1);
    assert.doesNotMatch(JSON.stringify(rows), /pending-model-secret/);

    let appliedPatch: Record<string, unknown> | undefined;
    const restarted = new ControlPlaneModelService({
      repository: new ControlPlaneModelRepository(database, secrets),
      gateway: {
        listFleetModels: async () => fleet(),
        readFleetModels: () => fleet(),
        updateModel: async (_node: unknown, id: string, patch: Record<string, unknown>) => {
          appliedPatch = patch;
          return { ...stored, ...patch, id, keyPreview: "set" };
        },
      } as never,
      listNodes: () => [node],
      requireNode: () => node,
      fetchImpl: fetch,
    });
    await restarted.init();
    const afterRestart = await restarted.listFederated();
    assert.equal(afterRestart.models.find((candidate) => candidate.id === modelId)?.model.name, patch.name);
    (node as { connectionEnabled: boolean }).connectionEnabled = true;
    await restarted.flushPendingModelSyncs();
    assert.equal(appliedPatch?.key, patch.key);
    assert.deepEqual(await repository.listPendingNodeEdits(), []);
  } finally {
    await database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
