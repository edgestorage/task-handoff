import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ModelConfigSchema, createModelEntityId, migratedModelEntityId, type ControlledInstance, type Node } from "@task-handoff/protocol/control-plane";
import { ControlPlaneModelService } from "../src/control-plane/models/service.ts";
import { ControlPlaneModelRepository } from "../src/control-plane/models/repository.ts";
import { createControlPlaneDatabase } from "../src/control-plane/persistence/database/index.ts";
import { controlPlaneStorePaths } from "../src/control-plane/persistence/paths.ts";
import { SecretEnvelopeService } from "../src/control-plane/persistence/secret-envelope.ts";

const ENDPOINT = "https://api.example.test/v1";
const KEY = "secret-key";

function nodeAgentCapabilities(managedModels: Record<string, unknown>) {
  return { agent: { capabilities: { managedModels } } };
}

function relayNode(id = "node_relay") {
  return {
    id,
    capabilities: nodeAgentCapabilities({
      multiEntityAssignment: true,
      privateModelCatalog: true,
      stableModelIdentity: true,
      requestMappings: true,
      modelRelay: { protocols: ["openai-responses", "openai-chat-completions", "anthropic-messages"], streaming: true },
    }),
  } as unknown as Node;
}

function legacyNode(id = "node_legacy") {
  return {
    id,
    capabilities: nodeAgentCapabilities({ multiEntityAssignment: false, privateModelCatalog: false, stableModelIdentity: false }),
  } as unknown as Node;
}

/** A node with stable identities from before the relay producer landed. */
function stableNodeWithoutRelay(id = "node_stable") {
  return {
    id,
    capabilities: nodeAgentCapabilities({
      multiEntityAssignment: true,
      privateModelCatalog: true,
      stableModelIdentity: true,
      modelRelay: { protocols: [], streaming: false },
    }),
  } as unknown as Node;
}

function relayInstance(id: string, nodeId: string, capabilities: unknown = {
  features: { modelRelay: { protocols: ["openai-responses", "openai-chat-completions", "anthropic-messages"], streaming: true } },
}): ControlledInstance {
  return { id, nodeId, protocolVersion: "2026-10-02", capabilities } as unknown as ControlledInstance;
}

type GatewayCall = { nodeId: string; input: Record<string, unknown> };

async function createHarness(options: {
  nodes?: Node[];
  relayEnabled?: Record<string, boolean>;
  instances?: ControlledInstance[];
  seedRepository?: (repository: ControlPlaneModelRepository) => Promise<void>;
  seedNodeModels?: (nodeModels: Map<string, Map<string, Record<string, unknown>>>) => void;
} = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-model-relay-management-"));
  const paths = controlPlaneStorePaths(directory);
  const database = await createControlPlaneDatabase(paths);
  const secrets = new SecretEnvelopeService(paths.databaseEncryptionKeyPath);
  secrets.init();
  const repository = new ControlPlaneModelRepository(database, secrets);
  const nodes = options.nodes ?? [relayNode(), legacyNode()];
  const nodeModels = new Map(nodes.map((node) => [node.id, new Map<string, Record<string, unknown>>()]));
  const calls = {
    create: [] as GatewayCall[],
    update: [] as Array<GatewayCall & { id: string }>,
    deploy: [] as Array<GatewayCall & { id: string }>,
    assign: [] as Array<{ nodeId: string; instanceId: string; input: unknown }>,
  };
  const gateway = {
    listModels: async (node: Node) => [...(nodeModels.get(node.id)?.values() ?? [])],
    createModel: async (node: Node, input: Record<string, unknown>) => {
      calls.create.push({ nodeId: node.id, input });
      const record = { ...input, id: createModelEntityId(), referenceCount: 0 };
      nodeModels.get(node.id)!.set(record.id as string, record);
      return record;
    },
    updateModel: async (node: Node, id: string, input: Record<string, unknown>) => {
      calls.update.push({ nodeId: node.id, id, input });
      const current = nodeModels.get(node.id)!.get(id) ?? { id };
      const record = { ...current, ...input, id };
      nodeModels.get(node.id)!.set(id, record);
      return record;
    },
    deployModel: async (node: Node, id: string, input: Record<string, unknown>) => {
      calls.deploy.push({ nodeId: node.id, id, input });
      const record = { ...input, id };
      nodeModels.get(node.id)!.set(id, record);
      return record;
    },
    deleteModel: async (node: Node, id: string) => {
      nodeModels.get(node.id)!.delete(id);
      return { id, accepted: true };
    },
    assignInstanceModels: async (node: Node, instanceId: string, input: unknown) => {
      calls.assign.push({ nodeId: node.id, instanceId, input });
      return { instance: { id: instanceId, nodeId: node.id, modelSelection: (input as { modelSelection: unknown }).modelSelection } };
    },
    getModelRelay: async (node: Node) => ({
      enabled: options.relayEnabled?.[node.id] ?? true,
      source: "persisted" as const,
    }),
    readFleetModels: (fleetNodes: Node[]) => ({
      items: fleetNodes.flatMap((node) => [...(nodeModels.get(node.id)?.values() ?? [])].map((model) => ({ nodeId: node.id, model }))),
      nodeErrors: [],
      nodeStates: fleetNodes.map((node) => ({ nodeId: node.id, resource: "models", phase: "ready" })),
    }),
    listFleetModels: async (fleetNodes: Node[]) => gateway.readFleetModels(fleetNodes),
  };
  if (options.seedRepository) await options.seedRepository(repository);
  options.seedNodeModels?.(nodeModels);
  const service = new ControlPlaneModelService({
    repository,
    gateway: gateway as never,
    listNodes: () => nodes,
    listInstances: async () => options.instances ?? [],
    requireNode: (id: string) => {
      const node = nodes.find((candidate) => candidate.id === id);
      if (!node) throw new Error(`Node ${id} was not found.`);
      return node;
    },
    fetchImpl: fetch,
  });
  await service.init();
  return {
    service,
    nodes,
    nodeModels,
    calls,
    close: async () => {
      await database.close();
      fs.rmSync(directory, { recursive: true, force: true });
    },
  };
}

function mappedModelInput(overrides: Record<string, unknown> = {}) {
  return {
    name: "Primary",
    endpoint: ENDPOINT,
    key: KEY,
    model: "public-model",
    modelNames: [{ name: "public-model", upstreamName: "upstream-model", order: 100 }],
    protocols: ["openai-responses"],
    app: "codex",
    ...overrides,
  };
}

function requestMapping(overrides: Record<string, unknown> = {}) {
  return { name: "gpt-5.6-luna", upstreamName: "upstream-model", order: 100, ...overrides };
}

function sameNameModelInput(overrides: Record<string, unknown> = {}) {
  return {
    name: "Codex relay",
    endpoint: ENDPOINT,
    key: KEY,
    model: "public-model",
    modelNames: [{ name: "public-model", order: 100 }],
    protocols: ["openai-responses"],
    app: "codex",
    ...overrides,
  };
}

function errorCode(error: unknown) {
  return (error as { code?: string }).code;
}

test("node model saves project mapping only to relay-capable nodes and require the switch", async () => {
  const harness = await createHarness({ relayEnabled: { node_relay: true, node_legacy: true } });
  try {
    await harness.service.createOnNode("node_relay", mappedModelInput());
    assert.equal(harness.calls.create.length, 1);
    assert.deepEqual(harness.calls.create[0].input.modelNames, [{ name: "public-model", upstreamName: "upstream-model", order: 100 }]);

    // Same-name records keep the v0.0.34 wire shape even on a relay node.
    await harness.service.createOnNode("node_relay", {
      name: "Same",
      endpoint: ENDPOINT,
      key: KEY,
      model: "same-model",
      modelNames: [{ name: "same-model", order: 100 }],
      app: "codex",
    });
    assert.deepEqual(harness.calls.create[1].input.modelNames, [{ name: "same-model", order: 100 }]);
    assert.equal(Object.prototype.hasOwnProperty.call((harness.calls.create[1].input.modelNames as Array<Record<string, unknown>>)[0], "upstreamName"), false);

    // A legacy node still accepts a same-name model without the additive field.
    await harness.service.createOnNode("node_legacy", {
      name: "Legacy same",
      endpoint: ENDPOINT,
      key: KEY,
      model: "legacy-same",
      modelNames: [{ name: "legacy-same", order: 100 }],
      app: "codex",
    });
    assert.deepEqual(harness.calls.create[2].input.modelNames, [{ name: "legacy-same", order: 100 }]);

    await assert.rejects(
      () => harness.service.createOnNode("node_legacy", mappedModelInput({ modelNames: [{ name: "public-model", upstreamName: "elsewhere", order: 100 }] })),
      (error) => errorCode(error) === "NODE_MODEL_RELAY_UNSUPPORTED",
    );
    assert.equal(harness.calls.create.length, 3);
  } finally {
    await harness.close();
  }
});

test("mapped node model saves stay writable while the node relay is disabled", async () => {
  const harness = await createHarness({ relayEnabled: { node_relay: false } });
  try {
    await harness.service.createOnNode("node_relay", mappedModelInput());
    assert.equal(harness.calls.create.length, 1);
    assert.deepEqual((harness.calls.create[0].input.modelNames as Array<Record<string, unknown>>)[0], {
      name: "public-model",
      upstreamName: "upstream-model",
      order: 100,
    });

    const same = await harness.service.createOnNode("node_relay", { name: "Same", endpoint: ENDPOINT, key: KEY, model: "same-model", modelNames: [{ name: "same-model", order: 100 }], app: "codex" });
    const sameId = (same as { id: string }).id;
    await harness.service.updateOnNode("node_relay", sameId, { modelNames: [{ name: "same-model", upstreamName: "elsewhere", order: 100 }] });
    assert.equal(harness.calls.update.length, 1);
    assert.deepEqual((harness.calls.update[0].input.modelNames as Array<Record<string, unknown>>)[0], {
      name: "same-model",
      upstreamName: "elsewhere",
      order: 100,
    });
  } finally {
    await harness.close();
  }
});

test("mapped assignments require only the node relay wire capability", async () => {
  const harness = await createHarness({ relayEnabled: { node_relay: true } });
  try {
    const model = await harness.service.create(mappedModelInput());
    const relay = harness.nodes[0];
    const legacy = harness.nodes[1];

    const assigned = await harness.service.prepareAssignment(relay, { modelEntityIds: [model.id] }, relayInstance("inst_relay", relay.id));
    assert.deepEqual(assigned.modelSelection.modelEntityIds, [model.id]);
    assert.equal(harness.calls.deploy.length, 1);
    assert.deepEqual((harness.calls.deploy[0].input.modelNames as Array<Record<string, unknown>>)[0], {
      name: "public-model",
      upstreamName: "upstream-model",
      order: 100,
    });

    // A creation call has no registered instance yet, an unregistered
    // instance carries no capability document, and a v0.0.34 instance never
    // declares the relay consumer capability: all three keep the assignment
    // and simply project no relay routes.
    const creation = await harness.service.prepareAssignment(relay, { modelEntityIds: [model.id] });
    assert.deepEqual(creation.modelSelection.modelEntityIds, [model.id]);
    const unregistered = await harness.service.prepareAssignment(relay, { modelEntityIds: [model.id] }, { id: "inst_new", nodeId: relay.id, capabilities: {} } as unknown as ControlledInstance);
    assert.deepEqual(unregistered.modelSelection.modelEntityIds, [model.id]);
    const legacyConsumer = await harness.service.prepareAssignment(relay, { modelEntityIds: [model.id] }, relayInstance("inst_old", relay.id, { features: {} }));
    assert.deepEqual(legacyConsumer.modelSelection.modelEntityIds, [model.id]);

    const nodeWithoutRelay = await createHarness({ nodes: [legacyNode("node_legacy")], relayEnabled: { node_legacy: true } });
    try {
      const legacyModel = await nodeWithoutRelay.service.create(mappedModelInput());
      await assert.rejects(
        () => nodeWithoutRelay.service.prepareAssignment(nodeWithoutRelay.nodes[0], { modelEntityIds: [legacyModel.id] }, relayInstance("inst_legacy_node", "node_legacy")),
        (error) => errorCode(error) === "NODE_MODEL_RELAY_UNSUPPORTED",
      );
    } finally {
      await nodeWithoutRelay.close();
    }

    const disabled = await createHarness({ relayEnabled: { node_relay: false } });
    try {
      const disabledModel = await disabled.service.create(mappedModelInput());
      const disabledAssignment = await disabled.service.prepareAssignment(disabled.nodes[0], { modelEntityIds: [disabledModel.id] }, relayInstance("inst_disabled", "node_relay"));
      assert.deepEqual(disabledAssignment.modelSelection.modelEntityIds, [disabledModel.id]);
    } finally {
      await disabled.close();
    }

    // Same-name selections never query the relay capability or switch. A node
    // without the relay producer but with stable identities still receives the
    // entity, because relay consumption is a separate capability domain.
    const sameHarness = await createHarness({ nodes: [stableNodeWithoutRelay("node_same_name")], relayEnabled: { node_same_name: true } });
    try {
      const sameNode = sameHarness.nodes[0];
      const same = await sameHarness.service.create({ name: "Same", endpoint: ENDPOINT, key: KEY, model: "same-model", app: "codex" });
      const sameAssigned = await sameHarness.service.prepareAssignment(sameNode, { modelEntityIds: [same.id] });
      assert.equal(typeof sameAssigned.codexModelHash, "string");
      assert.equal(sameAssigned.modelSelection.codexModelHash, sameAssigned.codexModelHash);
      assert.deepEqual(sameAssigned.modelSelection.modelEntityIds, [same.id]);
    } finally {
      await sameHarness.close();
    }
  } finally {
    await harness.close();
  }
});

test("mapped entities refuse to converge onto nodes that cannot store the mapping", async () => {
  const stable = stableNodeWithoutRelay();
  const harness = await createHarness({ nodes: [relayNode(), stable], relayEnabled: { node_relay: true, node_stable: true } });
  try {
    const model = await harness.service.create(mappedModelInput());
    // Simulate a fleet where the pre-relay node already holds a stale replica.
    harness.nodeModels.get(stable.id)!.set(model.id, {
      ...mappedModelInput({ modelNames: [{ name: "public-model", order: 100 }] }),
      id: model.id,
      revision: "stale",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    const result = await harness.service.sync(model.id);
    const stableLocation = result.locations.find((location) => location.nodeId === stable.id);
    assert.equal(stableLocation?.state, "error");
    assert.equal(stableLocation?.code, "NODE_MODEL_RELAY_UNSUPPORTED");
    assert.equal(harness.calls.deploy.some((call) => call.nodeId === stable.id), false);
  } finally {
    await harness.close();
  }
});

test("explicit request mapping writes fail closed on nodes that cannot store them", async () => {
  const harness = await createHarness({ relayEnabled: { node_relay: true, node_legacy: true } });
  try {
    const [relay, legacy] = harness.nodes;
    const relayed = await harness.service.createOnNode(relay.id, sameNameModelInput({ mappings: [requestMapping()] }));
    assert.deepEqual(harness.calls.create[0].input.mappings, [{ name: "gpt-5.6-luna", upstreamName: "upstream-model", order: 100 }]);

    await assert.rejects(
      () => harness.service.createOnNode(legacy.id, sameNameModelInput({ mappings: [requestMapping()] })),
      (error) => errorCode(error) === "NODE_MODEL_MAPPINGS_UNSUPPORTED",
    );
    assert.equal(harness.calls.create.length, 1);

    // Same-name writes without mappings keep the released wire shape: the
    // additive field is absent entirely, not empty.
    await harness.service.createOnNode(legacy.id, sameNameModelInput({ name: "Legacy" }));
    assert.equal(Object.prototype.hasOwnProperty.call(harness.calls.create[1].input, "mappings"), false);

    // Untouched patches stay allowed; an explicit clear is inert, an explicit
    // mapping edit fails closed before any node write.
    const legacySame = await harness.service.createOnNode(legacy.id, sameNameModelInput({ name: "Legacy same" })) as { id: string };
    await harness.service.updateOnNode(legacy.id, legacySame.id, { name: "Renamed" });
    assert.equal(Object.prototype.hasOwnProperty.call(harness.calls.update[0].input, "mappings"), false);
    await harness.service.updateOnNode(legacy.id, legacySame.id, { mappings: [] });
    assert.equal(Object.prototype.hasOwnProperty.call(harness.calls.update[1].input, "mappings"), false);
    await assert.rejects(
      () => harness.service.updateOnNode(legacy.id, legacySame.id, { mappings: [requestMapping()] }),
      (error) => errorCode(error) === "NODE_MODEL_MAPPINGS_UNSUPPORTED",
    );
    assert.equal(harness.calls.update.length, 2);

    await harness.service.updateOnNode(relay.id, relayed.id, { mappings: [requestMapping({ upstreamName: "upstream-2" })] });
    assert.deepEqual(harness.calls.update[2].input.mappings, [{ name: "gpt-5.6-luna", upstreamName: "upstream-2", order: 100 }]);
  } finally {
    await harness.close();
  }
});

test("control-plane request mappings sync to capable replicas and degrade visibly elsewhere", async () => {
  const stable = stableNodeWithoutRelay("node_stable_mappings");
  const harness = await createHarness({ nodes: [relayNode("node_relay_mappings"), stable] });
  try {
    const [relay] = harness.nodes;
    const model = await harness.service.create(sameNameModelInput({ mappings: [requestMapping()] }));
    assert.deepEqual((model as { mappings: unknown }).mappings, [{ name: "gpt-5.6-luna", upstreamName: "upstream-model", order: 100 }]);

    // Assignability is untouched: a node without the capability still receives
    // the base content, just without the additive field.
    await harness.service.prepareAssignment(relay, { modelEntityIds: [model.id] }, relayInstance("inst_mapping_relay", relay.id));
    const relayDeploy = harness.calls.deploy.find((call) => call.nodeId === relay.id);
    assert.deepEqual(relayDeploy?.input.mappings, [{ name: "gpt-5.6-luna", upstreamName: "upstream-model", order: 100 }]);

    await harness.service.prepareAssignment(stable, { modelEntityIds: [model.id] }, relayInstance("inst_mapping_stable", stable.id));
    const stableDeploy = harness.calls.deploy.find((call) => call.nodeId === stable.id);
    assert.equal(Object.prototype.hasOwnProperty.call(stableDeploy?.input ?? {}, "mappings"), false);

    const result = await harness.service.sync(model.id);
    const stableLocation = result.locations.find((location) => location.nodeId === stable.id);
    assert.equal(stableLocation?.state, "unsupported");
    assert.equal(stableLocation?.code, "NODE_MODEL_MAPPINGS_UNSUPPORTED");
    const relayLocation = result.locations.find((location) => location.nodeId === relay.id);
    assert.equal(relayLocation?.state, "synced");
  } finally {
    await harness.close();
  }
});

test("different entities may share one external name and keep distinct upstreams", async () => {
  const harness = await createHarness({ relayEnabled: { node_relay: true } });
  try {
    const first = await harness.service.create(mappedModelInput({ name: "First", endpoint: "https://a.example.test/v1", modelNames: [{ name: "shared-name", upstreamName: "upstream-a", order: 100 }] }));
    const second = await harness.service.create(mappedModelInput({ name: "Second", endpoint: "https://b.example.test/v1", key: "second-key", modelNames: [{ name: "shared-name", upstreamName: "upstream-b", order: 100 }] }));
    assert.notEqual(first.id, second.id);
    // The management projection carries the mapping but never the credential.
    assert.deepEqual(first.modelNames, [{ name: "shared-name", upstreamName: "upstream-a", order: 100 }]);
    assert.equal(Object.prototype.hasOwnProperty.call(first, "key"), false);
    assert.equal(typeof first.keyPreview, "string");

    const assigned = await harness.service.prepareAssignment(
      harness.nodes[0],
      { modelEntityIds: [first.id, second.id] },
      relayInstance("inst_shared", "node_relay"),
    );
    assert.deepEqual(assigned.modelSelection.modelEntityIds, [first.id, second.id]);
    const deployed = harness.calls.deploy.map((call) => call.input);
    assert.deepEqual(deployed.map((input) => (input.modelNames as Array<{ name: string; upstreamName?: string }>)[0]), [
      { name: "shared-name", upstreamName: "upstream-a", order: 100 },
      { name: "shared-name", upstreamName: "upstream-b", order: 100 },
    ]);
  } finally {
    await harness.close();
  }
});

test("a mapped assignment applies while the relay is off and follows the stored selection", async () => {
  const harness = await createHarness({ relayEnabled: { node_relay: false } });
  try {
    const same = await harness.service.create({ name: "Same", endpoint: ENDPOINT, key: KEY, model: "same-model", app: "codex" });
    const instance = relayInstance("inst_stable", "node_relay");
    instance.modelSelection = { modelEntityIds: [same.id] } as never;
    await harness.service.ensureInstanceAssignment(instance);
    assert.equal(harness.calls.assign.length, 1);

    const mapped = await harness.service.create(mappedModelInput());
    instance.modelSelection = { modelEntityIds: [mapped.id] } as never;
    await harness.service.ensureInstanceAssignment(instance);
    assert.equal(harness.calls.assign.length, 2);
    const assignedSelection = (harness.calls.assign[1].input as { modelSelection: { modelEntityIds: string[] } }).modelSelection;
    assert.deepEqual(assignedSelection.modelEntityIds, [mapped.id]);
  } finally {
    await harness.close();
  }
});

test("control-plane records persist request mappings across a database reopen", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-model-mappings-db-"));
  const paths = controlPlaneStorePaths(directory);
  const secrets = new SecretEnvelopeService(paths.databaseEncryptionKeyPath);
  secrets.init();
  const first = await createControlPlaneDatabase(paths);
  try {
    const repository = new ControlPlaneModelRepository(first, secrets);
    await repository.put(ModelConfigSchema.parse({
      id: createModelEntityId(),
      name: "Persisted",
      endpoint: ENDPOINT,
      key: KEY,
      model: "public-model",
      modelNames: [{ name: "public-model", order: 100 }],
      mappings: [requestMapping()],
      protocols: ["openai-responses"],
      app: "codex",
      enabled: true,
      order: 100,
      labels: {},
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }));
  } finally {
    await first.close();
  }
  const second = await createControlPlaneDatabase(paths);
  try {
    const repository = new ControlPlaneModelRepository(second, secrets);
    const models = await repository.list();
    assert.equal(models.length, 1);
    assert.deepEqual(models[0]!.mappings, [{ name: "gpt-5.6-luna", upstreamName: "upstream-model", order: 100 }]);
  } finally {
    await second.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("a legacy content-hash record upgrades to a stable id on its first request mapping write", async () => {
  // Compatibility for v0.0.35: the retired released identity shape, replaced
  // by the deterministic derived entity id on the first write.
  const legacyId = `mdl_${"a".repeat(64)}`;
  const legacyEntityId = migratedModelEntityId(legacyId);
  const timestamp = new Date().toISOString();
  const legacyRecord = {
    id: legacyId,
    name: "Legacy",
    endpoint: ENDPOINT,
    key: KEY,
    model: "public-model",
    modelNames: [{ name: "public-model", order: 100 }],
    protocols: ["openai-responses"],
    app: "codex",
    enabled: true,
    order: 100,
    labels: {},
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  const instance = relayInstance("inst_legacy", "node_relay");
  instance.modelSelection = { modelEntityIds: [legacyId] } as never;
  const harness = await createHarness({
    nodes: [relayNode("node_relay")],
    instances: [instance],
    seedRepository: async (repository) => {
      await repository.put(ModelConfigSchema.parse(legacyRecord));
    },
    seedNodeModels: (nodeModels) => {
      // The node still holds the replica a v0.0.34 control plane deployed
      // under the content hash.
      nodeModels.get("node_relay")!.set(legacyId, { ...legacyRecord, key: undefined, referenceCount: 1, revision: legacyId });
    },
  });
  try {
    // Reads never rewrite the released identity by themselves.
    assert.deepEqual(harness.service.list().map((model) => model.id), [legacyId]);

    const updated = await harness.service.update(legacyId, { mappings: [requestMapping()] });
    const stableId = updated.model.id;
    assert.equal(stableId, legacyEntityId);
    assert.equal(stableId, harness.service.require(legacyId).id);
    assert.deepEqual(updated.model.mappings, [{ name: "gpt-5.6-luna", upstreamName: "upstream-model", order: 100 }]);
    assert.deepEqual(harness.service.require(stableId).mappings, updated.model.mappings);

    // The node receives the mapped record under the stable id, and the
    // instance assignment moves off the content-hash projection.
    const deploy = harness.calls.deploy.filter((call) => call.id === stableId).at(-1)!;
    assert.deepEqual(deploy.input.mappings, [{ name: "gpt-5.6-luna", upstreamName: "upstream-model", order: 100 }]);
    await harness.service.ensureInstanceAssignment(instance);
    const assigned = harness.calls.assign.at(-1)!;
    assert.deepEqual((assigned.input as { modelSelection: { modelEntityIds: string[] } }).modelSelection.modelEntityIds, [stableId]);
  } finally {
    await harness.close();
  }
});
