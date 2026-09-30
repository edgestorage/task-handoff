import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { modelConfigHash, type ControlledInstance, type Node } from "@task-handoff/protocol/control-plane";
import { ControlPlaneModelService, type PreparedModelAssignment } from "../src/control-plane/models/service.ts";
import { ControlPlaneModelRepository } from "../src/control-plane/models/repository.ts";
import { createControlPlaneDatabase } from "../src/control-plane/persistence/database/index.ts";
import { controlPlaneStorePaths } from "../src/control-plane/persistence/paths.ts";
import { SecretEnvelopeService } from "../src/control-plane/persistence/secret-envelope.ts";

const ENDPOINT = "https://api.example.test/v1";
const KEY = "secret-key";

// A node agent from before stable model identities: deployments are keyed by
// the content hash and editing content leaves the previous record behind.
const legacyNode = {
  id: "node_legacy",
  capabilities: {
    agent: {
      capabilities: { managedModels: { multiEntityAssignment: false, privateModelCatalog: false, stableModelIdentity: false } },
    },
  },
} as unknown as Node;

function assignedIds(input: PreparedModelAssignment) {
  return [...new Set([
    ...(input.modelSelection.modelEntityIds ?? []),
    ...(input.modelEntityIds ?? []),
    input.modelSelection.codexModelHash,
    input.modelSelection.claudeModelHash,
    input.modelSelection.opencodeModelHash,
    input.codexModelHash,
    input.claudeModelHash,
    input.opencodeModelHash,
  ].filter((id): id is string => Boolean(id)))];
}

async function createHarness() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-model-projection-"));
  const paths = controlPlaneStorePaths(directory);
  const database = await createControlPlaneDatabase(paths);
  const secrets = new SecretEnvelopeService(paths.databaseEncryptionKeyPath);
  secrets.init();
  const repository = new ControlPlaneModelRepository(database, secrets);
  const records = new Map<string, Record<string, unknown>>();
  const references = new Map<string, string[]>();
  const deleted: string[] = [];
  const referencesOf = (id: string) => [...references.values()].filter((ids) => ids.includes(id));
  const fleet = (nodes: Node[]) => ({
    items: nodes.flatMap((node) => [...records.values()].map((model) => ({ nodeId: node.id, model }))),
    nodeErrors: [],
    nodeStates: nodes.map((node) => ({ nodeId: node.id, resource: "models", phase: "ready" })),
  });
  const gateway = {
    listModels: async () => [...records.values()],
    deployModel: async (_node: Node, id: string, model: Record<string, unknown>) => {
      records.set(id, { ...model, id, referenceCount: referencesOf(id).length, revision: modelConfigHash(model as never) });
      return records.get(id);
    },
    deleteModel: async (_node: Node, id: string) => {
      if (referencesOf(id).length) {
        throw Object.assign(new Error(`Model ${id} is assigned to a managed instance.`), { statusCode: 409, code: "NODE_MODEL_IN_USE" });
      }
      records.delete(id);
      deleted.push(id);
      return { id, accepted: true };
    },
    assignInstanceModels: async (_node: Node, instanceId: string, input: PreparedModelAssignment) => {
      references.set(instanceId, assignedIds(input));
      return { instance: { id: instanceId, nodeId: legacyNode.id, modelSelection: input.modelSelection } };
    },
    listFleetModels: async (nodes: Node[]) => fleet(nodes),
    readFleetModels: (nodes: Node[]) => fleet(nodes),
  };
  const service = new ControlPlaneModelService({
    repository,
    gateway: gateway as never,
    listNodes: () => [legacyNode],
    requireNode: () => legacyNode,
    fetchImpl: fetch,
  });
  await service.init();
  return {
    service,
    records,
    references,
    deleted,
    close: async () => {
      await database.close();
      fs.rmSync(directory, { recursive: true, force: true });
    },
  };
}

async function createModel(service: ControlPlaneModelService) {
  const model = await service.create({ name: "Primary", endpoint: ENDPOINT, key: KEY, model: "model-a", app: "codex" });
  return { model, firstHash: modelConfigHash({ app: "codex", endpoint: ENDPOINT, key: KEY, model: "model-a" }) };
}

test("a superseded content-hash projection is retired after the assignment is durable", async () => {
  const harness = await createHarness();
  try {
    const { model, firstHash } = await createModel(harness.service);
    const first = await harness.service.prepareAssignment(legacyNode, { modelEntityIds: [model.id] });
    assert.equal(first.codexModelHash, firstHash);
    assert.equal(harness.records.has(firstHash), true);

    harness.references.set("inst_one", [firstHash]);
    await harness.service.update(model.id, { model: "model-b" });
    const nextHash = modelConfigHash({ app: "codex", endpoint: ENDPOINT, key: KEY, model: "model-b" });
    assert.notEqual(nextHash, firstHash);

    const instance = { id: "inst_one", nodeId: legacyNode.id, modelSelection: { codexModelHash: firstHash } } as unknown as ControlledInstance;
    await harness.service.ensureInstanceAssignment(instance);

    assert.deepEqual([...harness.records.keys()], [nextHash]);
    assert.deepEqual(harness.deleted, [firstHash]);
  } finally {
    await harness.close();
  }
});

test("a projection another instance still references is left for the next assignment", async () => {
  const harness = await createHarness();
  try {
    const { model, firstHash } = await createModel(harness.service);
    await harness.service.prepareAssignment(legacyNode, { modelEntityIds: [model.id] });
    harness.references.set("inst_one", [firstHash]);
    harness.references.set("inst_two", [firstHash]);
    await harness.service.update(model.id, { model: "model-b" });
    const nextHash = modelConfigHash({ app: "codex", endpoint: ENDPOINT, key: KEY, model: "model-b" });

    const firstInstance = { id: "inst_one", nodeId: legacyNode.id, modelSelection: { codexModelHash: firstHash } } as unknown as ControlledInstance;
    await harness.service.ensureInstanceAssignment(firstInstance);
    assert.equal(harness.records.has(firstHash), true);
    assert.deepEqual(harness.deleted, []);

    const secondInstance = { id: "inst_two", nodeId: legacyNode.id, modelSelection: { codexModelHash: firstHash } } as unknown as ControlledInstance;
    await harness.service.ensureInstanceAssignment(secondInstance);

    assert.equal(harness.records.has(firstHash), false);
    assert.deepEqual([...harness.records.keys()], [nextHash]);
    assert.deepEqual(harness.deleted, [firstHash]);
  } finally {
    await harness.close();
  }
});
