import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { migratedModelEntityId, type Node } from "@task-handoff/protocol/control-plane";
import { ControlPlaneModelService } from "../src/control-plane/models/service.ts";
import { ControlPlaneModelRepository } from "../src/control-plane/models/repository.ts";
import { createControlPlaneDatabase } from "../src/control-plane/persistence/database/index.ts";
import { controlPlaneStorePaths } from "../src/control-plane/persistence/paths.ts";
import { SecretEnvelopeService } from "../src/control-plane/persistence/secret-envelope.ts";

const ENDPOINT = "https://api.example.test/v1";
const KEY = "secret-key";
// Compatibility for v0.0.35: released writers persisted control-plane models
// under their content hash. The first write touching such a record upgrades it
// onto this deterministic entity identity instead of editing the retired id.
const LEGACY_ID = `mdl_${"a".repeat(64)}`;
const LEGACY_ENTITY_ID = migratedModelEntityId(LEGACY_ID);

function node(id: string, stableModelIdentity: boolean): Node {
  return {
    id,
    capabilities: {
      agent: {
        capabilities: {
          managedModels: { multiEntityAssignment: stableModelIdentity, privateModelCatalog: stableModelIdentity, stableModelIdentity },
        },
      },
    },
  } as unknown as Node;
}

async function createHarness(nodes: Node[]) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-model-identity-"));
  const paths = controlPlaneStorePaths(directory);
  const database = await createControlPlaneDatabase(paths);
  const secrets = new SecretEnvelopeService(paths.databaseEncryptionKeyPath);
  secrets.init();
  const repository = new ControlPlaneModelRepository(database, secrets);
  const records = new Map<string, Record<string, unknown>>();
  const deploys: Array<{ nodeId: string; id: string }> = [];
  const fleet = () => ({
    items: nodes.flatMap((entry) => [...records.values()].map((model) => ({ nodeId: entry.id, model }))),
    nodeErrors: [],
    nodeStates: nodes.map((entry) => ({ nodeId: entry.id, resource: "models", phase: "ready" })),
  });
  const gateway = {
    listModels: async () => [...records.values()],
    deployModel: async (entry: Node, id: string, model: Record<string, unknown>) => {
      deploys.push({ nodeId: entry.id, id });
      records.set(id, { ...model, id, referenceCount: 0 });
      return records.get(id);
    },
    deleteModel: async (_entry: Node, id: string) => {
      records.delete(id);
      return { id, accepted: true };
    },
    assignInstanceModels: async (_entry: Node, instanceId: string, input: { modelSelection: unknown }) => ({
      instance: { id: instanceId, nodeId: entry.id, modelSelection: input.modelSelection },
    }),
    listFleetModels: async () => fleet(),
    readFleetModels: () => fleet(),
  };
  const service = new ControlPlaneModelService({
    repository,
    gateway: gateway as never,
    listNodes: () => nodes,
    requireNode: (id) => nodes.find((entry) => entry.id === id) || nodes[0],
    fetchImpl: fetch,
  });
  await service.init();
  return {
    service,
    repository,
    records,
    deploys,
    close: async () => {
      await database.close();
      fs.rmSync(directory, { recursive: true, force: true });
    },
  };
}

test("a persisted content-hash record upgrades on save and deploys its derived entity id", async () => {
  const stable = node("node_stable", true);
  const harness = await createHarness([stable]);
  try {
    const timestamp = "2026-08-01T00:00:00.000Z";
    await harness.repository.put({
      id: LEGACY_ID,
      name: "Legacy",
      endpoint: ENDPOINT,
      key: KEY,
      model: "model-a",
      modelNames: [{ name: "model-a", order: 100 }],
      protocols: ["openai-responses"],
      app: "codex",
      enabled: true,
      order: 50,
      labels: {},
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    await harness.service.init();

    const prepared = await harness.service.prepareAssignment(stable, { modelEntityIds: [LEGACY_ID] });
    assert.deepEqual(prepared.modelEntityIds, [LEGACY_ENTITY_ID]);
    assert.equal(prepared.codexModelHash, LEGACY_ENTITY_ID);
    assert.deepEqual(harness.deploys, [{ nodeId: stable.id, id: LEGACY_ENTITY_ID }]);
    // The retired id is gone from control-plane persistence; the node only
    // ever received the derived entity identity.
    assert.equal(await harness.repository.get(LEGACY_ID), undefined);
    assert.equal((await harness.repository.get(LEGACY_ENTITY_ID))?.name, "Legacy");
    assert.deepEqual([...harness.records.keys()], [LEGACY_ENTITY_ID]);
  } finally {
    await harness.close();
  }
});

test("a node without stable model identities is refused instead of projecting content hashes", async () => {
  const legacy = node("node_legacy", false);
  const harness = await createHarness([legacy]);
  try {
    const model = await harness.service.create({ name: "Primary", endpoint: ENDPOINT, key: KEY, model: "model-a", app: "codex" });
    await assert.rejects(
      () => harness.service.prepareAssignment(legacy, { modelEntityIds: [model.id] }),
      (error: unknown) => {
        const value = error as { statusCode?: number; code?: string };
        assert.equal(value.statusCode, 409);
        assert.equal(value.code, "NODE_MODEL_STABLE_IDENTITY_UNSUPPORTED");
        return true;
      },
    );
    assert.deepEqual(harness.deploys, []);
    assert.deepEqual([...harness.records.keys()], []);
  } finally {
    await harness.close();
  }
});

async function seedLegacyRecord(harness: Awaited<ReturnType<typeof createHarness>>) {
  const timestamp = "2026-08-01T00:00:00.000Z";
  await harness.repository.put({
    id: LEGACY_ID,
    name: "Legacy",
    endpoint: ENDPOINT,
    key: KEY,
    model: "model-a",
    modelNames: [{ name: "model-a", order: 100 }],
    protocols: ["openai-responses"],
    app: "codex",
    enabled: true,
    order: 50,
    labels: {},
    createdAt: timestamp,
    updatedAt: timestamp,
  });
  await harness.service.init();
}

test("a merge with no addressable node replica fails instead of retiring the record", async () => {
  const stable = node("node_stable", true);
  const harness = await createHarness([stable]);
  try {
    await seedLegacyRecord(harness);
    // The node already upgraded its replica onto the derived identity, so the
    // control plane cannot associate it with the persisted legacy record.
    harness.records.set(LEGACY_ENTITY_ID, {
      id: LEGACY_ENTITY_ID,
      name: "Legacy",
      endpoint: ENDPOINT,
      model: "model-a",
      enabled: true,
      order: 50,
      labels: {},
      modelNames: [{ name: "model-a", order: 100 }],
      protocols: ["openai-responses"],
      app: "codex",
      referenceCount: 0,
      createdAt: "2026-08-01T00:00:00.000Z",
      updatedAt: "2026-08-01T00:00:00.000Z",
    });
    const target = await harness.service.create({ name: "Successor", endpoint: ENDPOINT, key: KEY, model: "model-b", app: "codex" });

    await assert.rejects(
      () => harness.service.merge(LEGACY_ID, { targetModelId: target.id }),
      (error: unknown) => {
        const value = error as { statusCode?: number; code?: string };
        assert.equal(value.statusCode, 409);
        assert.equal(value.code, "MODEL_MERGE_NOTHING_TO_MERGE");
        return true;
      },
    );
    // Nothing was merged, so neither side may be retired or rewritten.
    assert.equal((await harness.repository.get(LEGACY_ID))?.name, "Legacy");
    assert.equal(harness.records.has(LEGACY_ENTITY_ID), true);
  } finally {
    await harness.close();
  }
});

test("merging a source that exists nowhere reports not found", async () => {
  const stable = node("node_stable", true);
  const harness = await createHarness([stable]);
  try {
    const target = await harness.service.create({ name: "Successor", endpoint: ENDPOINT, key: KEY, model: "model-b", app: "codex" });
    await assert.rejects(
      () => harness.service.merge(`mdl_${"c".repeat(64)}`, { targetModelId: target.id }),
      (error: unknown) => {
        const value = error as { statusCode?: number; code?: string };
        assert.equal(value.statusCode, 404);
        assert.equal(value.code, "MODEL_NOT_FOUND");
        return true;
      },
    );
  } finally {
    await harness.close();
  }
});
