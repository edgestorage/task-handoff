import {
  FederatedModelRegistrySchema,
  ModelConfigSchema,
  ModelMergeResultSchema,
  ModelMutationResultSchema,
  ModelLocationSyncResultSchema,
  CreateNodeModelSchema,
  UpdateNodeModelSchema,
  createModelEntityId,
  defaultModelProtocols,
  isModelEntityId,
  migratedModelEntityId,
  modelContentRevision,
  normalizeModelNameEntries,
  normalizeModelRequestMappings,
  projectModelNameEntries,
  NodeModelMergeSchema,
  supportsNodeModelRequestMappings,
  supportsNodeModelRelay,
  supportsNodeStableModelIdentity,
  type ControlledInstance,
  type ModelLocationSyncResult,
  type ModelConfig,
  type ModelNameEntry,
  type ModelRequestMapping,
  type Node,
  type NodeModelPublicRecord,
  type PublicModelConfig,
} from "@task-handoff/protocol/control-plane";
import type { ControlPlaneModelRepository } from "./repository.ts";
import { CopyModelInputSchema, CreateModelInputSchema, ModelDiscoveryInputSchema, ModelTestInputSchema, UpdateModelInputSchema, type ModelDiscoveryInput, type ModelTestInput, type UpdateModelInput } from "../application/inputs.ts";
import { now, throwNotFound } from "../application/helpers.ts";
import type { ControlPlaneNodeAgentGateway } from "../nodes/gateway.ts";
import { normalizeModel, publicModel } from "../public-records.ts";
import { discoverModels, testModelEndpoint } from "../../shared/models/model-endpoint.ts";

function nodeAgentCapabilities(node: Node) {
  const agent = node.capabilities.agent;
  return agent && typeof agent === "object" && !Array.isArray(agent)
    ? (agent as Record<string, unknown>).capabilities
    : undefined;
}

function nodeSupportsStableModelIdentity(node: Node) {
  return supportsNodeStableModelIdentity(nodeAgentCapabilities(node));
}

function nodeSupportsModelRequestMappings(node: Node) {
  return supportsNodeModelRequestMappings(nodeAgentCapabilities(node));
}

type NodeOwnedWriteIntent = "edit" | "sync";

// A node without a capability document cannot be classified; only a parsed
// document that denies stable identities proves the node predates entity ids.
function nodeDeniesStableModelIdentity(node: Node) {
  const capabilities = nodeAgentCapabilities(node);
  return capabilities !== undefined && !supportsNodeStableModelIdentity(capabilities);
}

function nodeOwnedStableIdentityMessage(nodeId: string, intent: NodeOwnedWriteIntent) {
  return intent === "edit"
    ? `Node ${nodeId} must be updated before models can be edited in place.`
    : `Node ${nodeId} must be updated before models can be synced there.`;
}

/** Wire shape accepted by the node assignment endpoint. */
export type PreparedModelAssignment = {
  modelSelection: {
    modelEntityIds?: string[];
    codexModelHash?: string | null;
    claudeModelHash?: string | null;
    opencodeModelHash?: string | null;
  };
  modelEntityIds?: string[];
  codexModelHash?: string | null;
  claudeModelHash?: string | null;
  opencodeModelHash?: string | null;
};

// Public projection of a node owned replica. The secret stays on the nodes:
// applying this patch in place converges content without moving key material.
function nodeOwnedModelProjection(model: NodeModelPublicRecord): UpdateModelInput {
  return {
    name: model.name,
    endpoint: model.endpoint,
    model: model.model,
    modelNames: model.modelNames,
    mappings: model.mappings,
    protocols: model.protocols,
    app: model.app,
    enabled: model.enabled,
  };
}

// Compatibility for v0.0.34: nodes without the request-mapping capability
// have a strict wire schema that rejects the additive field, so it is removed
// entirely instead of being sent as an empty list.
function withoutRequestMappings<T extends { mappings?: ModelRequestMapping[] }>(patch: T): T {
  if (!("mappings" in patch)) return patch;
  const { mappings: _mappings, ...rest } = patch;
  return rest as T;
}

/**
 * Project one model write onto a node's wire model. A node without the relay
 * producer capability cannot honor a non-same-name mapping, so the mapping is
 * ignored silently and the record is projected with upstreamName = name
 * instead of failing the write or the assignment that depends on it.
 */
function nodeModelWirePatch<T extends { model?: string; modelNames?: ModelNameEntry[]; mappings?: ModelRequestMapping[] }>(node: Node, patch: T): T {
  const wire = nodeSupportsModelRequestMappings(node) ? patch : withoutRequestMappings(patch);
  if (!wire.modelNames?.length) return wire;
  const entries = normalizeModelNameEntries(wire.modelNames, wire.model);
  const projected = supportsNodeModelRelay(nodeAgentCapabilities(node))
    ? entries
    : entries.map((entry) => ({ ...entry, upstreamName: entry.name }));
  return { ...wire, modelNames: projectModelNameEntries(projected) };
}

function nodeLocationFailure(nodeId: string, error: unknown): ModelLocationSyncResult {
  const record = error && typeof error === "object" ? error as Record<string, unknown> : {};
  const statusCode = typeof record.statusCode === "number" ? record.statusCode : undefined;
  // Transport failures and 5xx responses are transient; the replica stays
  // pending and converges on the next retry. 4xx responses need an operator.
  const state = statusCode && statusCode < 500 ? "error" : "pending";
  return ModelLocationSyncResultSchema.parse({
    nodeId,
    state,
    code: typeof record.code === "string" && record.code.trim()
      ? record.code
      : state === "pending" ? "NODE_MODEL_SYNC_DEFERRED" : "NODE_MODEL_SYNC_FAILED",
    message: error instanceof Error ? error.message : String(error),
  });
}

type ControlPlaneModelServiceOptions = {
  repository: ControlPlaneModelRepository;
  gateway: ControlPlaneNodeAgentGateway;
  listNodes: () => Node[];
  requireNode: (id: string) => Node;
  fetchImpl: typeof fetch;
  // Revalidates a node's cached capability document before writes that depend
  // on it. Explicit mutations force a probe; background convergence respects
  // the cache TTL so retries stay cheap.
  ensureNodeCapabilities?: (node: Node, options?: { force?: boolean }) => Promise<Node>;
  listInstances?: () => Promise<ControlledInstance[]>;
};

export class ControlPlaneModelService {
  private readonly options: ControlPlaneModelServiceOptions;
  private readonly databaseModels = new Map<string, ModelConfig>();
  // Replica node ids that still need an edit pushed to them. Entries are
  // retried on registry reads and by the explicit sync endpoint.
  private readonly pendingModelSyncs = new Map<string, Set<string>>();
  private flushingPendingSyncs = false;

  constructor(options: ControlPlaneModelServiceOptions) {
    this.options = options;
  }

  async init() {
    this.databaseModels.clear();
    for (const model of await this.options.repository.list()) this.databaseModels.set(model.id, model);
  }

  /**
   * Upgrade a record persisted before model entity identities when a write
   * touches it. The target id is derived from the legacy id so a node holding
   * the same legacy replica derives the identical identity, and the caller
   * continues with the upgraded record instead of failing.
   */
  private async ensureStableIdentity(record: ModelConfig): Promise<ModelConfig> {
    if (isModelEntityId(record.id)) return record;
    let id = migratedModelEntityId(record.id);
    while (this.databaseModels.has(id)) id = createModelEntityId();
    const rekeyed = ModelConfigSchema.parse({ ...record, id });
    await this.options.repository.transaction(async (repository) => {
      await repository.put(rekeyed);
      await repository.delete(record.id);
    });
    this.databaseModels.delete(record.id);
    this.databaseModels.set(id, rekeyed);
    return rekeyed;
  }

  list() {
    return this.listAll().map(publicModel);
  }

  async listFederated(signal?: AbortSignal, progressive = false) {
    const nodes = this.options.listNodes();
    const fleet = progressive
      ? this.options.gateway.readFleetModels(nodes)
      : await this.options.gateway.listFleetModels(nodes, { signal });
    if (progressive) void this.options.gateway.refreshFleetModels(nodes);
    const groups = new Map<string, {
      id: string;
      model: PublicModelConfig | NodeModelPublicRecord;
      locations: Array<
        | { type: "control-plane"; name: string; enabled: boolean; order: number; revision?: string }
        | { type: "node"; nodeId: string; name: string; enabled: boolean; order: number; referenceCount: number; revision?: string }
      >;
      referenceCount: number;
    }>();
    for (const model of this.listAll()) {
      groups.set(model.id, {
        id: model.id,
        model: publicModel(model),
        locations: [{ type: "control-plane", name: model.name, enabled: model.enabled, order: model.order, revision: modelContentRevision(model) }],
        referenceCount: 0,
      });
    }
    for (const { nodeId, model } of fleet.items) {
      const { referenceCount: _referenceCount, ...publicModelRecord } = model;
      const entityId = this.replicaEntityId(model.id);
      const group = groups.get(entityId);
      if (group) {
        group.locations.push({
          type: "node",
          nodeId,
          name: model.name,
          enabled: model.enabled,
          order: model.order,
          referenceCount: model.referenceCount,
          ...(model.revision ? { revision: model.revision } : {}),
        });
        group.referenceCount += model.referenceCount;
      } else {
        groups.set(entityId, {
          id: entityId,
          model: publicModelRecord,
          locations: [{
            type: "node",
            nodeId,
            name: model.name,
            enabled: model.enabled,
            order: model.order,
            referenceCount: model.referenceCount,
            ...(model.revision ? { revision: model.revision } : {}),
          }],
          referenceCount: model.referenceCount,
        });
      }
    }
    // Reading the registry is the natural retry point for replicas that were
    // offline during an edit; the flush is best-effort and never blocks the read.
    void this.flushPendingModelSyncs();
    return FederatedModelRegistrySchema.parse({
      models: [...groups.values()].sort((a, b) => a.model.order - b.model.order || a.model.name.localeCompare(b.model.name)),
      nodeDiagnostics: fleet.nodeErrors.map((error) => ({ nodeId: error.nodeId, code: error.code, message: error.message })),
      updatedAt: now(),
    });
  }

  async create(input: unknown) {
    const parsedInput = CreateModelInputSchema.parse(input);
    const protocols = parsedInput.protocols?.length ? parsedInput.protocols : defaultModelProtocols(parsedInput.app);
    const modelNames = normalizeModelNames(parsedInput.modelNames, parsedInput.model);
    const normalizedInput = {
      ...parsedInput,
      modelNames,
      mappings: normalizeModelRequestMappings(parsedInput.mappings),
      model: modelNames[0].name,
    };
    const timestamp = now();
    let id = createModelEntityId();
    while (this.modelGet(id)) id = createModelEntityId();
    const model = ModelConfigSchema.parse({
      ...normalizedInput,
      protocols,
      id,
      enabled: parsedInput.enabled ?? true,
      order: parsedInput.order ?? this.nextOrder(),
      labels: parsedInput.labels || {},
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    return publicModel(await this.modelPut(model));
  }

  async copy(id: string, input: unknown) {
    const source = this.requireSecret(id);
    const parsedInput = CopyModelInputSchema.parse(input);
    const candidate = {
      ...parsedInput,
      // A copy inherits the source mappings unless the operator replaced them.
      mappings: normalizeModelRequestMappings(parsedInput.mappings === undefined ? source.mappings : parsedInput.mappings),
      key: parsedInput.key?.trim() || source.key,
    };
    return this.create(candidate);
  }

  async update(id: string, input: unknown) {
    const parsedInput: UpdateModelInput = UpdateModelInputSchema.parse(input);
    const current = this.modelGet(id);
    return current ? this.updateOwnedEntity(current, parsedInput) : this.updateNodeOwnedEntity(id, parsedInput);
  }

  /**
   * Edit a control-plane owned entity in place: the id stays stable, only the
   * content revision advances, and every node that already holds a replica is
   * updated before the call returns. Instances keep resolving the same entity
   * id, so assignments and AI session selections are never orphaned.
   */
  private async updateOwnedEntity(current: ModelConfig, parsedInput: UpdateModelInput) {
    // A record persisted before entity identities upgrades on its first save
    // instead of being edited under the legacy id.
    const stable = await this.ensureStableIdentity(current);
    const modelNames = parsedInput.modelNames?.length
      ? normalizeModelNames(parsedInput.modelNames, parsedInput.model || stable.model)
      : parsedInput.model ? normalizeModelNames(undefined, parsedInput.model) : normalizeModelNames(stable.modelNames, stable.model);
    const protocols = parsedInput.protocols?.length
      ? parsedInput.protocols
      : stable.protocols?.length ? stable.protocols : defaultProtocols(parsedInput.app || stable.app);
    const next = ModelConfigSchema.parse({
      ...stable,
      ...parsedInput,
      key: parsedInput.key?.trim() ? parsedInput.key : stable.key,
      protocols,
      modelNames,
      mappings: parsedInput.mappings !== undefined
        ? normalizeModelRequestMappings(parsedInput.mappings)
        : stable.mappings,
      model: modelNames[0].name,
      createdAt: stable.createdAt,
      updatedAt: now(),
    });
    await this.modelPut(next);
    await this.refreshFleetModelIndex(this.options.listNodes());
    return ModelMutationResultSchema.parse({
      model: publicModel(next),
      locations: await this.syncEntityToReplicas(next),
    });
  }

  /**
   * A node owned entity is edited through the nodes that hold it; the control
   * plane proxies the edit and reports the per-node outcome instead of
   * creating a second entity.
   */
  private async updateNodeOwnedEntity(id: string, parsedInput: UpdateModelInput) {
    const nodes = this.options.listNodes();
    await this.refreshFleetModelIndex(nodes);
    const holderIds = this.replicaHolderIds(id, nodes);
    if (!holderIds.size) {
      throwNotFound("MODEL_NOT_FOUND", `Model ${id} was not found on the control plane or any node.`);
    }
    const holders = await this.withFreshNodeCapabilities(nodes.filter((node) => holderIds.has(node.id)), true);
    const locations: ModelLocationSyncResult[] = [];
    let updated: PublicModelConfig | undefined;
    for (const node of holders) {
      const applied = await this.applyNodeEntityUpdate(node, id, parsedInput, "edit");
      if (applied.record) updated = updated || applied.record;
      locations.push(applied.location);
    }
    if (!updated) {
      const detail = locations.find((location) => location.message)?.message;
      throw Object.assign(new Error(detail
        ? `Model ${id} could not be updated on any node: ${detail}`
        : `Model ${id} could not be updated on any node.`), {
        statusCode: 502,
        code: "MODEL_UPDATE_SYNC_FAILED",
        details: { locations },
      });
    }
    return ModelMutationResultSchema.parse({ model: updated, locations });
  }

  /**
   * Apply one patch to a node owned replica. A parsed capability document that
   * denies stable identities skips the write instead of forking a duplicate.
   */
  private async applyNodeEntityUpdate(
    node: Node,
    id: string,
    patch: UpdateModelInput,
    intent: NodeOwnedWriteIntent,
  ): Promise<{ location: ModelLocationSyncResult; record?: PublicModelConfig }> {
    if (nodeDeniesStableModelIdentity(node)) {
      return {
        location: ModelLocationSyncResultSchema.parse({
          nodeId: node.id,
          state: "unsupported",
          code: "NODE_MODEL_STABLE_IDENTITY_UNSUPPORTED",
          message: nodeOwnedStableIdentityMessage(node.id, intent),
        }),
      };
    }
    try {
      const record = await this.options.gateway.updateModel(node, id, nodeModelWirePatch(node, patch));
      // The node upgrades a legacy id on save, so the returned record may
      // carry the new entity identity. Follow it instead of failing.
      const { referenceCount: _referenceCount, ...publicRecord } = record;
      return {
        location: ModelLocationSyncResultSchema.parse({ nodeId: node.id, state: "synced" }),
        record: publicRecord,
      };
    } catch (error) {
      return { location: nodeLocationFailure(node.id, error) };
    }
  }

  /**
   * Push the current content to every known replica. Control-plane owned
   * entities deploy the stored record; node owned entities converge onto the
   * newest replica because their secret only exists on the nodes.
   */
  async sync(id: string) {
    const model = this.modelGet(id);
    if (!model) return this.syncNodeOwnedEntity(id);
    await this.refreshFleetModelIndex(this.options.listNodes());
    return ModelMutationResultSchema.parse({
      model: publicModel(model),
      locations: await this.syncEntityToReplicas(model),
    });
  }

  /**
   * Convergence for node owned entities: the newest replica is the authority
   * and its public projection is applied in place to every lagging holder.
   */
  private async syncNodeOwnedEntity(id: string) {
    const nodes = this.options.listNodes();
    await this.refreshFleetModelIndex(nodes);
    const fleet = this.options.gateway.readFleetModels(nodes);
    const holders = fleet.items.filter(({ model }) => model.id === id);
    if (!holders.length) {
      throwNotFound("MODEL_NOT_FOUND", `Model ${id} was not found on the control plane or any node.`);
    }
    const authority = holders.reduce((best, candidate) => candidate.model.updatedAt > best.model.updatedAt ? candidate : best);
    const projection = nodeOwnedModelProjection(authority.model);
    const refreshed = new Map((await this.withFreshNodeCapabilities(
      nodes.filter((node) => holders.some((holder) => holder.nodeId === node.id)),
      true,
    )).map((node) => [node.id, node]));
    const locations: ModelLocationSyncResult[] = [];
    for (const holder of holders) {
      const node = refreshed.get(holder.nodeId);
      if (!node) continue;
      if (holder.nodeId === authority.nodeId
        || (holder.model.revision && authority.model.revision && holder.model.revision === authority.model.revision)) {
        locations.push(ModelLocationSyncResultSchema.parse({ nodeId: node.id, state: "synced" }));
        continue;
      }
      const applied = await this.applyNodeEntityUpdate(node, id, projection, "sync");
      locations.push(applied.location);
    }
    const { referenceCount: _referenceCount, ...publicRecord } = authority.model;
    return ModelMutationResultSchema.parse({ model: publicRecord, locations });
  }

  /**
   * Fold a superseded model entity into its successor across every node that
   * still holds it, then retire the control-plane record when no replica
   * remains. This is the recovery path for registries that accumulated
   * detached copies before identities became stable.
   */
  async merge(id: string, input: unknown) {
    const { targetModelId } = NodeModelMergeSchema.parse(input);
    if (id === targetModelId) {
      throw Object.assign(new Error("A model cannot be merged into itself."), { statusCode: 400, code: "MODEL_MERGE_SAME" });
    }
    const nodes = this.options.listNodes();
    await this.refreshFleetModelIndex(nodes);
    const fleet = this.options.gateway.readFleetModels(nodes);
    // A node may still keep the entity under a legacy content hash, so address
    // every holder by the replica id it actually stores.
    const ghostReplicaIds = new Map<string, string>();
    const targetReplicaIds = new Map<string, string>();
    for (const { nodeId, model } of fleet.items) {
      const entityId = this.replicaEntityId(model.id);
      if (entityId === id) ghostReplicaIds.set(nodeId, model.id);
      if (entityId === targetModelId) targetReplicaIds.set(nodeId, model.id);
    }
    const target = this.modelGet(targetModelId);
    if (!target && !targetReplicaIds.size) {
      throwNotFound("MODEL_NOT_FOUND", `Model ${targetModelId} was not found on the control plane or any node.`);
    }
    // A source that exists nowhere resolves to no replica at all; without this
    // guard the merge below would report an empty success for a stale id.
    if (!this.modelGet(id) && !ghostReplicaIds.size) {
      throwNotFound("MODEL_NOT_FOUND", `Model ${id} was not found on the control plane or any node.`);
    }
    const locations: Array<{ nodeId: string; merged: boolean; reassignedInstances: string[]; code?: string; message?: string }> = [];
    for (const node of nodes) {
      const ghostReplicaId = ghostReplicaIds.get(node.id);
      if (!ghostReplicaId) continue;
      const targetReplicaId = targetReplicaIds.get(node.id) ?? target?.id ?? targetModelId;
      try {
        if (target && !targetReplicaIds.has(node.id)) {
          await this.options.gateway.deployModel(node, target.id, nodeModelWirePatch(node, target));
        }
        const result = await this.options.gateway.mergeModel(node, ghostReplicaId, targetReplicaId);
        locations.push({ nodeId: node.id, merged: true, reassignedInstances: result.reassignedInstances });
      } catch (error) {
        const record = error && typeof error === "object" ? error as Record<string, unknown> : {};
        locations.push({
          nodeId: node.id,
          merged: false,
          reassignedInstances: [],
          code: typeof record.code === "string" && record.code.trim() ? record.code : "NODE_MODEL_MERGE_FAILED",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
    // Folding replicas is the only effect a merge has. When no node holds an
    // addressable replica (for example a record whose legacy replica already
    // upgraded to an identity this control plane cannot associate), report the
    // request as failed instead of an empty success that retires the record
    // while the node keeps its copy.
    if (!locations.length) {
      throw Object.assign(new Error(`Model ${id} has no reachable node replica to merge; nothing was changed.`), {
        statusCode: 409,
        code: "MODEL_MERGE_NOTHING_TO_MERGE",
      });
    }
    const merged = locations.every((location) => location.merged);
    const ghost = this.modelGet(id);
    if (merged && ghost) await this.modelDelete(ghost.id);
    return ModelMergeResultSchema.parse({ modelId: id, targetModelId, merged, locations });
  }

  async delete(id: string) {
    const model = this.requireSecret(id);
    const references = await this.instanceReferences(model.id);
    if (references.length) {
      throw Object.assign(new Error(`Model ${model.id} is assigned to ${references.length} managed instance${references.length === 1 ? "" : "s"}.`), {
        statusCode: 409,
        code: "MODEL_IN_USE",
        details: { references },
      });
    }
    return this.modelDelete(model.id);
  }

  async reorder(ids: string[]) {
    const uniqueIds = [...new Set(ids)];
    const byId = new Map(this.modelList().map((model) => [model.id, model]));
    for (const id of uniqueIds) {
      if (!byId.has(id)) throwNotFound("MODEL_NOT_FOUND", `Model ${id} was not found.`);
    }
    const updates = uniqueIds.map((id, index) => {
      const current = byId.get(id)!;
      return ModelConfigSchema.parse({ ...current, order: (index + 1) * 100, updatedAt: now() });
    });
    await this.options.repository.transaction(async (repository) => {
      for (const model of updates) await repository.put(model);
    });
    for (const model of updates) this.databaseModels.set(model.id, model);
    return this.list();
  }

  createOnNode(nodeId: string, input: unknown) {
    const node = this.options.requireNode(nodeId);
    return this.createNodeModelWrite(node, CreateNodeModelSchema.parse(input));
  }

  updateOnNode(nodeId: string, modelId: string, input: unknown) {
    const node = this.options.requireNode(nodeId);
    return this.updateNodeModelWrite(node, modelId, UpdateNodeModelSchema.parse(input));
  }

  private async createNodeModelWrite(node: Node, input: ReturnType<typeof CreateNodeModelSchema.parse>) {
    const target = await this.refreshModelWriteNode(node);
    return this.options.gateway.createModel(target, nodeModelWirePatch(target, input));
  }

  private async updateNodeModelWrite(node: Node, modelId: string, input: ReturnType<typeof UpdateNodeModelSchema.parse>) {
    const target = await this.refreshModelWriteNode(node);
    return this.options.gateway.updateModel(target, modelId, nodeModelWirePatch(target, input));
  }

  /**
   * Explicit node model saves revalidate the capability document, project the
   * wire names and fail closed on nodes whose wire model cannot carry a
   * mapping. The explicit probe keeps a recently updated node from being
   * misclassified by a cached capability document.
   */
  private async refreshModelWriteNode(node: Node) {
    const [resolved] = await this.withFreshNodeCapabilities([node], true);
    return resolved || node;
  }

  deleteOnNode(nodeId: string, modelId: string) {
    return this.options.gateway.deleteModel(this.options.requireNode(nodeId), modelId);
  }

  discover(input: unknown) {
    const parsed = ModelDiscoveryInputSchema.parse(input);
    return discoverModels(this.options.fetchImpl, this.resolvePrivateInput(parsed));
  }

  test(input: unknown) {
    const parsed = ModelTestInputSchema.parse(input);
    return testModelEndpoint(this.options.fetchImpl, this.resolvePrivateInput(parsed));
  }

  discoverOnNode(nodeId: string, input: unknown) {
    const node = this.options.requireNode(nodeId);
    requireModelEndpointProbe(node);
    return this.options.gateway.discoverModels(node, input);
  }

  testOnNode(nodeId: string, input: unknown) {
    const node = this.options.requireNode(nodeId);
    requireModelEndpointProbe(node);
    return this.options.gateway.testModel(node, input);
  }

  require(id: string, includeSecret = false) {
    const model = this.requireSecret(id);
    return includeSecret ? model : publicModel(model);
  }

  async prepareAssignment(
    node: Node,
    selection: { modelEntityIds?: string[]; codexModelHash?: string | null; claudeModelHash?: string | null; opencodeModelHash?: string | null },
    instance?: ControlledInstance,
  ): Promise<PreparedModelAssignment> {
    const nodeModels = await this.options.gateway.listModels(node);
    const hasEntitySelection = selection.modelEntityIds !== undefined;
    const storedSelection: {
      modelEntityIds?: string[];
      codexModelHash?: string | null; claudeModelHash?: string | null; opencodeModelHash?: string | null;
    } = {
      ...(hasEntitySelection ? { modelEntityIds: [...new Set(selection.modelEntityIds!.map((id) => id.trim()).filter(Boolean))] } : {}),
      ...(selection.codexModelHash === null
        ? { codexModelHash: null }
        : selection.codexModelHash?.trim() ? { codexModelHash: selection.codexModelHash.trim() } : {}),
      ...(selection.claudeModelHash === null
        ? { claudeModelHash: null }
        : selection.claudeModelHash?.trim() ? { claudeModelHash: selection.claudeModelHash.trim() } : {}),
      ...(selection.opencodeModelHash === null
        ? { opencodeModelHash: null }
        : selection.opencodeModelHash?.trim() ? { opencodeModelHash: selection.opencodeModelHash.trim() } : {}),
    };
    const entityIds = storedSelection.modelEntityIds || [];
    const controlPlaneModels = this.listAll();
    const resolvedEntities: ModelConfig[] = [];
    const nodeEntityIds: string[] = [];
    for (const entityId of entityIds) {
      const controlPlaneModel = this.modelGet(entityId);
      if (controlPlaneModel) {
        assertEnabledModel(controlPlaneModel);
        const deployed = await this.deployModelToNode(node, controlPlaneModel);
        resolvedEntities.push(deployed);
        nodeEntityIds.push(deployed.id);
        continue;
      }
      const local = nodeModels.find((model) => model.id === entityId);
      if (!local) throwNotFound("MODEL_NOT_FOUND", `Model ${entityId} was not found on control-plane or node ${node.id}.`);
      assertEnabledModel(local);
      // Node model listings are public records. Project them back to the
      // internal shape instead of spreading response-only credential and
      // reference metadata into the strict model config schema.
      resolvedEntities.push(nodePublicModelToConfig(local));
      nodeEntityIds.push(local.id);
    }
    const projectedEntityIds = [...new Set(nodeEntityIds)];
    if (hasEntitySelection) storedSelection.modelEntityIds = projectedEntityIds;
    const resolve = async (app: "codex" | "claude" | "opencode", selectedId?: string | null) => {
      if (selectedId === null) return undefined;
      const controlPlaneModel = selectedId
        ? this.modelGet(selectedId)
        : controlPlaneModels.find((model) => model.enabled && modelSupportsApp(model, app));
      if (controlPlaneModel) {
        assertUsableModel(controlPlaneModel, app);
        return (await this.deployModelToNode(node, controlPlaneModel)).id;
      }
      if (!selectedId) return undefined;
      const local = nodeModels.find((model) => model.id === selectedId);
      if (!local) throwNotFound("MODEL_NOT_FOUND", `Model ${selectedId} was not found on control-plane or node ${node.id}.`);
      assertUsableModel(local, app);
      return local.id;
    };
    const firstFor = (app: "codex" | "claude" | "opencode") => resolvedEntities.find((model) => modelSupportsApp(model, app))?.id;
    if (entityIds.length) {
      storedSelection.codexModelHash = firstFor("codex");
      storedSelection.claudeModelHash = firstFor("claude");
      storedSelection.opencodeModelHash = firstFor("opencode");
    }
    const codexModelHash = hasEntitySelection
      ? storedSelection.codexModelHash
      : await resolve("codex", storedSelection.codexModelHash);
    const claudeModelHash = hasEntitySelection
      ? storedSelection.claudeModelHash
      : await resolve("claude", storedSelection.claudeModelHash);
    const opencodeModelHash = hasEntitySelection
      ? storedSelection.opencodeModelHash
      : await resolve("opencode", storedSelection.opencodeModelHash);
    if (!hasEntitySelection) {
      // The node persists and validates the selection it is assigned, so the
      // stored reference mirrors the id the model was actually deployed under
      // (an upgraded entity may have advanced to a new identity).
      if (storedSelection.codexModelHash !== undefined) storedSelection.codexModelHash = codexModelHash ?? null;
      if (storedSelection.claudeModelHash !== undefined) storedSelection.claudeModelHash = claudeModelHash ?? null;
      if (storedSelection.opencodeModelHash !== undefined) storedSelection.opencodeModelHash = opencodeModelHash ?? null;
    }
    return {
      modelSelection: storedSelection,
      modelEntityIds: projectedEntityIds,
      codexModelHash,
      claudeModelHash,
      opencodeModelHash,
    };
  }

  async ensureInstanceAssignment(instance: ControlledInstance) {
    const node = this.options.requireNode(instance.nodeId);
    const prepared = await this.prepareAssignment(node, instance.modelSelection, instance);
    return this.options.gateway.assignInstanceModels(node, instance.id, prepared);
  }

  private listAll() {
    return this.modelList()
      .map((model) => this.normalize(model))
      .sort((a, b) => a.order - b.order || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  }

  private requireSecret(id: string) {
    const record = this.modelGet(id);
    if (!record) throwNotFound("MODEL_NOT_FOUND", `Model ${id} was not found.`);
    return this.normalize(record);
  }

  private normalize(record: unknown) {
    const model = normalizeModel(record);
    return model;
  }

  private nextOrder() {
    return this.modelList().reduce((max, model) => Math.max(max, model.order), 0) + 100;
  }

  private modelList() {
    return [...this.databaseModels.values()];
  }

  private modelGet(id: string) {
    const direct = this.databaseModels.get(id);
    if (direct || isModelEntityId(id)) return direct;
    // Compatibility migration: a replica persisted under a legacy content hash
    // resolves to the entity identity this control plane upgraded it to. The
    // derivation is deterministic, so it replaces the retired projection table
    // without persisting an alias.
    return this.databaseModels.get(migratedModelEntityId(id));
  }

  /** Control-plane entity a stored replica id belongs to, or the id itself. */
  private replicaEntityId(id: string) {
    return this.modelGet(id)?.id ?? id;
  }

  private async modelPut(model: ModelConfig) {
    if (!isModelEntityId(model.id)) {
      throw new Error(`Refusing to persist model ${model.id} without a stable entity id.`);
    }
    const stored = await this.options.repository.put(model);
    this.databaseModels.set(stored.id, stored);
    return stored;
  }

  private async modelDelete(id: string) {
    const deleted = await this.options.repository.delete(id);
    if (deleted) this.databaseModels.delete(id);
    return deleted;
  }

  /**
   * Only instance model assignments pin a registry entry. AI session
   * selections are runtime snapshots of whatever the session used when it
   * started, and sessions already degrade through their own model-unavailable
   * recovery when the selected entity is gone, so they never block deletion.
   */
  private async instanceReferences(modelId: string) {
    const instances = await this.options.listInstances?.() || [];
    const references = new Map<string, { kind: "instance"; instanceId: string }>();
    for (const instance of instances) {
      const ids = instance.modelSelection.modelEntityIds?.length
        ? instance.modelSelection.modelEntityIds
        : [instance.modelSelection.codexModelHash, instance.modelSelection.claudeModelHash, instance.modelSelection.opencodeModelHash];
      if (ids.some((id) => Boolean(id && this.replicaEntityId(id) === modelId))) {
        references.set(instance.id, { kind: "instance", instanceId: instance.id });
      }
    }
    return [...references.values()].sort((left, right) => left.instanceId.localeCompare(right.instanceId));
  }

  private replicaHolderIds(modelId: string, nodes: Node[]) {
    const fleet = this.options.gateway.readFleetModels(nodes);
    return new Set(fleet.items
      .filter(({ model }) => this.replicaEntityId(model.id) === modelId)
      .map(({ nodeId }) => nodeId));
  }

  /**
   * Refresh the per-node model index before an edit, merge, or manual sync so
   * that replicas are resolved from the current fleet instead of a stale
   * snapshot. Node failures stay in the snapshot's diagnostics.
   */
  private async refreshFleetModelIndex(nodes: Node[]) {
    if (!nodes.length) return;
    await this.options.gateway.listFleetModels(nodes);
  }

  /**
   * Deploy a control-plane entity to one node. A record persisted under a
   * legacy id upgrades first so the node only ever receives entity ids.
   */
  private async deployModelToNode(node: Node, model: ModelConfig): Promise<ModelConfig> {
    const [resolved] = await this.withFreshNodeCapabilities([node], false);
    if (nodeDeniesStableModelIdentity(resolved)) {
      throw Object.assign(new Error(nodeOwnedStableIdentityMessage(node.id, "sync")), {
        statusCode: 409,
        code: "NODE_MODEL_STABLE_IDENTITY_UNSUPPORTED",
      });
    }
    const stable = await this.ensureStableIdentity(model);
    await this.options.gateway.deployModel(resolved, stable.id, nodeModelWirePatch(resolved, stable));
    return stable;
  }

  /**
   * Revalidate cached node capability documents before writes that branch on
   * them. Direct-http nodes never deliver the capabilities-changed tunnel
   * event, so without this probe an updated node keeps its stale document
   * until an operator opens the node check by hand.
   */
  private async withFreshNodeCapabilities(nodes: Node[], force: boolean): Promise<Node[]> {
    if (!this.options.ensureNodeCapabilities || !nodes.length) return nodes;
    return Promise.all(nodes.map(async (node) => {
      try {
        return await this.options.ensureNodeCapabilities!(node, { force });
      } catch {
        return node;
      }
    }));
  }

  /**
   * Converge the content of a control-plane owned entity onto its replicas.
   * Nodes that cannot store a stable identity keep their previous content and
   * are reported as unsupported instead of forking a second entity.
   */
  private async syncEntityToReplicas(model: ModelConfig, targets?: Set<string>): Promise<ModelLocationSyncResult[]> {
    const nodes = this.options.listNodes();
    if (!nodes.length) return [];
    const fleet = this.options.gateway.readFleetModels(nodes);
    const holderIds = new Set(fleet.items
      .filter(({ model: record }) => this.replicaEntityId(record.id) === model.id)
      .map(({ nodeId }) => nodeId));
    const nodePhases = new Map(fleet.nodeStates.map((state) => [state.nodeId, state.phase]));
    const involved = nodes.filter((node) => targets ? targets.has(node.id) : holderIds.has(node.id));
    // Explicit syncs revalidate capabilities up front; background retries use
    // the cached document so offline replicas are not probed on every read.
    const refreshed = new Map((await this.withFreshNodeCapabilities(involved, !targets)).map((node) => [node.id, node]));
    const results: ModelLocationSyncResult[] = [];
    const pending = new Set<string>();
    for (const node of nodes) {
      if (targets ? !targets.has(node.id) : !holderIds.has(node.id)) continue;
      // A reachable node that no longer reports the replica has removed it;
      // retrying would recreate the entity behind the operator's back.
      if (targets && !holderIds.has(node.id) && nodePhases.get(node.id) === "ready") continue;
      const resolved = refreshed.get(node.id) || node;
      if (!nodeSupportsStableModelIdentity(resolved)) {
        pending.add(node.id);
        results.push(ModelLocationSyncResultSchema.parse({
          nodeId: node.id,
          state: "unsupported",
          code: "NODE_MODEL_STABLE_IDENTITY_UNSUPPORTED",
          message: `Node ${node.id} must be updated before model edits can converge there.`,
        }));
        continue;
      }
      try {
        await this.options.gateway.deployModel(resolved, model.id, nodeModelWirePatch(resolved, model));
        results.push(ModelLocationSyncResultSchema.parse({ nodeId: node.id, state: "synced" }));
      } catch (error) {
        const failure = nodeLocationFailure(node.id, error);
        if (failure.state === "pending") pending.add(node.id);
        results.push(failure);
      }
    }
    if (pending.size) this.pendingModelSyncs.set(model.id, pending);
    else this.pendingModelSyncs.delete(model.id);
    return results;
  }

  /** Best-effort convergence for replicas that were unreachable during an edit. */
  async flushPendingModelSyncs() {
    if (this.flushingPendingSyncs || !this.pendingModelSyncs.size) return;
    this.flushingPendingSyncs = true;
    try {
      for (const [modelId, nodeIds] of [...this.pendingModelSyncs]) {
        const model = this.modelGet(modelId);
        if (!model) {
          this.pendingModelSyncs.delete(modelId);
          continue;
        }
        await this.syncEntityToReplicas(model, nodeIds);
      }
    } finally {
      this.flushingPendingSyncs = false;
    }
  }

  private resolvePrivateInput<T extends ModelDiscoveryInput | ModelTestInput>(input: T): T & { key: string } {
    const key = input.key?.trim() || (input.existingModelId ? this.requireSecret(input.existingModelId).key : "");
    if (!key) {
      throw Object.assign(new Error("An API key is required to contact the model endpoint."), { statusCode: 400, code: "MODEL_API_KEY_REQUIRED" });
    }
    return { ...input, key };
  }
}

function normalizeModelNames(entries: ModelConfig["modelNames"] | undefined, legacyModel: string) {
  // Duplicate external names stay in the list so the strict schema refine
  // rejects an ambiguous mapping instead of silently dropping an entry.
  return normalizeModelNameEntries(entries, legacyModel);
}

function defaultProtocols(app: ModelConfig["app"]): ModelConfig["protocols"] {
  return app === "claude" ? ["anthropic-messages"] : app === "opencode" ? ["openai-chat-completions"] : ["openai-responses"];
}

function nodePublicModelToConfig(model: NodeModelPublicRecord): ModelConfig {
  return ModelConfigSchema.parse({
    id: model.id,
    name: model.name,
    endpoint: model.endpoint,
    key: "node-private",
    model: model.model,
    modelNames: model.modelNames,
    mappings: model.mappings,
    protocols: model.protocols,
    app: model.app,
    enabled: model.enabled,
    order: model.order,
    labels: model.labels,
    createdAt: model.createdAt,
    updatedAt: model.updatedAt,
  });
}

function requireModelEndpointProbe(node: Node) {
  const agentCapabilities = nodeAgentCapabilities(node);
  if (!agentCapabilities || typeof agentCapabilities !== "object" || Array.isArray(agentCapabilities)
    || (agentCapabilities as Record<string, unknown>).modelEndpointProbe !== true) {
    throw Object.assign(new Error("This node agent does not support model endpoint discovery or testing."), {
      statusCode: 409,
      code: "NODE_MODEL_ENDPOINT_PROBE_UNSUPPORTED",
    });
  }
}

function assertUsableModel(model: Pick<ModelConfig, "id" | "app" | "enabled">, app: "codex" | "claude" | "opencode") {
  if (!modelSupportsApp(model, app)) {
    throw Object.assign(new Error(`Model ${model.id} is not a ${app} model.`), {
      statusCode: 400,
      code: "MODEL_APP_MISMATCH",
    });
  }
  if (!model.enabled) {
    throw Object.assign(new Error(`Model ${model.id} is disabled.`), { statusCode: 400, code: "MODEL_DISABLED" });
  }
}

function assertEnabledModel(model: Pick<ModelConfig, "id" | "enabled">) {
  if (!model.enabled) {
    throw Object.assign(new Error(`Model ${model.id} is disabled.`), { statusCode: 400, code: "MODEL_DISABLED" });
  }
}

function modelSupportsApp(model: Pick<ModelConfig, "app"> & { protocols?: ModelConfig["protocols"] }, app: "codex" | "claude" | "opencode") {
  const protocol = app === "claude" ? "anthropic-messages" : app === "opencode" ? "openai-chat-completions" : "openai-responses";
  return model.protocols?.length ? model.protocols.includes(protocol) : model.app === app;
}
