import {
  FederatedModelRegistrySchema,
  ModelConfigSchema,
  ModelMergeResultSchema,
  ModelMutationResultSchema,
  ModelLocationSyncResultSchema,
  createModelEntityId,
  modelConfigHash,
  NodeModelMergeSchema,
  supportsNodeMultiEntityModelAssignment,
  supportsNodeStableModelIdentity,
  type ControlledInstance,
  type ModelLocationSyncResult,
  type ModelConfig,
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

type NodeOwnedWriteIntent = "edit" | "sync";

// A node without a capability document cannot be classified; only a parsed
// document that denies stable identities proves the node edits by forking.
function nodeDeniesStableModelIdentity(node: Node) {
  const capabilities = nodeAgentCapabilities(node);
  return capabilities !== undefined && !supportsNodeStableModelIdentity(capabilities);
}

function nodeOwnedStableIdentityMessage(nodeId: string, intent: NodeOwnedWriteIntent) {
  return intent === "edit"
    ? `Node ${nodeId} must be updated before models can be edited in place.`
    : `Node ${nodeId} must be updated before models can be synced there.`;
}

/**
 * Wire shape accepted by the node assignment endpoint. Nodes without stable
 * model identities receive the per-agent hash fields, newer nodes also receive
 * the ordered entity collection.
 */
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
    protocols: model.protocols,
    app: model.app,
    enabled: model.enabled,
  };
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
  // Compatibility for v0.0.34: content-hash ids that were already deployed to
  // nodes without stable model identities, keyed by projection id. The node
  // keeps a replica under that id even after the entity content changes, so
  // the mapping cannot be recomputed from current content and is persisted.
  private readonly legacyProjections = new Map<string, string>();
  private readonly legacyProjectionIds = new Map<string, Set<string>>();
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
    this.legacyProjections.clear();
    this.legacyProjectionIds.clear();
    for (const projection of await this.options.repository.listLegacyProjections()) {
      this.legacyProjections.set(projection.id, projection.modelId);
      const ids = this.legacyProjectionIds.get(projection.modelId) || new Set<string>();
      ids.add(projection.id);
      this.legacyProjectionIds.set(projection.modelId, ids);
    }
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
        | { type: "node"; nodeId: string; name: string; enabled: boolean; order: number; referenceCount: number; revision?: string; replicaId?: string }
      >;
      referenceCount: number;
    }>();
    // Nodes without stable model identities hold a control-plane entity under
    // its content-hash projection; fold those records back onto the entity so
    // the registry keeps one row per identity.
    const projectionIndex = this.modelProjectionIndex();
    for (const model of this.listAll()) {
      groups.set(model.id, {
        id: model.id,
        model: publicModel(model),
        locations: [{ type: "control-plane", name: model.name, enabled: model.enabled, order: model.order, revision: modelConfigHash(model) }],
        referenceCount: 0,
      });
    }
    for (const { nodeId, model } of fleet.items) {
      const entityId = projectionIndex.get(model.id) ?? model.id;
      const { referenceCount: _referenceCount, ...publicModelRecord } = model;
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
          ...(entityId === model.id ? {} : { replicaId: model.id }),
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
    const protocols = parsedInput.protocols?.length
      ? parsedInput.protocols
      : parsedInput.app === "claude" ? ["anthropic-messages"]
        : parsedInput.app === "opencode" ? ["openai-chat-completions"]
          : ["openai-responses"];
    const modelNames = normalizeModelNames(parsedInput.modelNames, parsedInput.model);
    const normalizedInput = { ...parsedInput, modelNames, model: modelNames[0].name };
    const timestamp = now();
    // Entity identity is opaque and stable. Re-adding the same content still
    // converges on the existing entity, but a new record mints a short id.
    const contentHash = modelConfigHash(normalizedInput);
    const existing = this.findByContentHash(contentHash);
    let id = existing?.id;
    if (!id) {
      id = createModelEntityId();
      while (this.modelGet(id)) id = createModelEntityId();
    }
    const model = ModelConfigSchema.parse({
      ...normalizedInput,
      protocols,
      id,
      enabled: parsedInput.enabled ?? true,
      order: parsedInput.order ?? this.nextOrder(),
      labels: parsedInput.labels || {},
      createdAt: existing?.createdAt || timestamp,
      updatedAt: timestamp,
    });
    return publicModel(await this.modelPut(model));
  }

  async copy(id: string, input: unknown) {
    const source = this.requireSecret(id);
    const parsedInput = CopyModelInputSchema.parse(input);
    const candidate = {
      ...parsedInput,
      key: parsedInput.key?.trim() || source.key,
    };
    const modelNames = normalizeModelNames(candidate.modelNames, candidate.model);
    const nextContentHash = modelConfigHash({ ...candidate, model: modelNames[0].name });
    if (nextContentHash === modelConfigHash(source)) {
      throw Object.assign(new Error("Change the model, endpoint, app, or API key before creating a copy."), {
        statusCode: 409,
        code: "MODEL_COPY_UNCHANGED",
      });
    }
    const conflict = this.findByContentHash(nextContentHash);
    if (conflict) {
      throw Object.assign(new Error(`Model ${conflict.id} already exists.`), {
        statusCode: 409,
        code: "MODEL_COPY_CONFLICT",
      });
    }
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
    const modelNames = parsedInput.modelNames?.length
      ? normalizeModelNames(parsedInput.modelNames, parsedInput.model || current.model)
      : parsedInput.model ? normalizeModelNames(undefined, parsedInput.model) : normalizeModelNames(current.modelNames, current.model);
    const protocols = parsedInput.protocols?.length
      ? parsedInput.protocols
      : current.protocols?.length ? current.protocols : defaultProtocols(parsedInput.app || current.app);
    const next = ModelConfigSchema.parse({
      ...current,
      ...parsedInput,
      key: parsedInput.key?.trim() ? parsedInput.key : current.key,
      protocols,
      modelNames,
      model: modelNames[0].name,
      createdAt: current.createdAt,
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
   * denies stable identities skips the write instead of forking a duplicate;
   * an unknown document still probes the fork response so the control plane
   * cannot stay stuck on a stale "legacy" classification.
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
      const record = await this.options.gateway.updateModel(node, id, patch);
      if (record.id !== id) {
        // Compatibility for v0.0.34: a node without stable identities forks
        // the entity instead of editing it in place. Remove the fork and
        // fail that location so the registry cannot accumulate a copy that
        // would show up as a second model.
        let rolledBack = true;
        try {
          await this.options.gateway.deleteModel(node, record.id);
        } catch {
          rolledBack = false;
        }
        return {
          location: ModelLocationSyncResultSchema.parse(rolledBack ? {
            nodeId: node.id,
            state: "unsupported",
            code: "NODE_MODEL_STABLE_IDENTITY_UNSUPPORTED",
            message: nodeOwnedStableIdentityMessage(node.id, intent),
          } : {
            nodeId: node.id,
            state: "error",
            code: "NODE_MODEL_LEGACY_EDIT_FORKED",
            message: `Node ${node.id} left a detached copy ${record.id} behind while editing; remove it after updating the node.`,
          }),
        };
      }
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
    const holderIds = new Set(fleet.items.filter(({ model }) => model.id === id).map(({ nodeId }) => nodeId));
    const targetHolderIds = new Set(fleet.items.filter(({ model }) => model.id === targetModelId).map(({ nodeId }) => nodeId));
    const target = this.modelGet(targetModelId);
    if (!target && !targetHolderIds.size) {
      throwNotFound("MODEL_NOT_FOUND", `Model ${targetModelId} was not found on the control plane or any node.`);
    }
    const locations: Array<{ nodeId: string; merged: boolean; reassignedInstances: string[]; code?: string; message?: string }> = [];
    for (const node of nodes) {
      if (!holderIds.has(node.id)) continue;
      try {
        if (target && !targetHolderIds.has(node.id)) {
          await this.options.gateway.deployModel(node, target.id, target);
        }
        const result = await this.options.gateway.mergeModel(node, id, targetModelId);
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
    const merged = locations.every((location) => location.merged);
    if (merged && this.modelGet(id)) await this.modelDelete(id);
    return ModelMergeResultSchema.parse({ modelId: id, targetModelId, merged, locations });
  }

  async delete(id: string) {
    this.requireSecret(id);
    const references = await this.instanceReferences(id);
    if (references.length) {
      throw Object.assign(new Error(`Model ${id} is assigned to ${references.length} managed instance${references.length === 1 ? "" : "s"}.`), {
        statusCode: 409,
        code: "MODEL_IN_USE",
        details: { references },
      });
    }
    return this.modelDelete(id);
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
    return this.options.gateway.createModel(this.options.requireNode(nodeId), input);
  }

  updateOnNode(nodeId: string, modelId: string, input: unknown) {
    return this.options.gateway.updateModel(this.options.requireNode(nodeId), modelId, input);
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

  async prepareAssignment(node: Node, selection: { modelEntityIds?: string[]; codexModelHash?: string | null; claudeModelHash?: string | null; opencodeModelHash?: string | null }): Promise<PreparedModelAssignment> {
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
    // Nodes without stable identities store the legacy content hash as the
    // entity id, so every reference this assignment sends must be projected
    // onto the id the model actually got deployed with on this node.
    const nodeEntityIds: string[] = [];
    for (const entityId of entityIds) {
      const controlPlaneModel = controlPlaneModels.find((model) => model.id === entityId);
      if (controlPlaneModel) {
        assertEnabledModel(controlPlaneModel);
        const deployedId = await this.deployModelToNode(node, controlPlaneModel);
        resolvedEntities.push(deployedId === controlPlaneModel.id
          ? controlPlaneModel
          : ModelConfigSchema.parse({ ...controlPlaneModel, id: deployedId }));
        nodeEntityIds.push(deployedId);
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
    // A stored selection on a node without stable identities references the
    // content-hash projection. Fold it back onto the control-plane entity so
    // enabled state, app checks, and later edits keep following the
    // authoritative record instead of the node-local replica.
    const projectionIndex = this.modelProjectionIndex();
    const resolve = async (app: "codex" | "claude" | "opencode", selectedId?: string | null) => {
      if (selectedId === null) return undefined;
      const projectedEntityId = selectedId ? projectionIndex.get(selectedId) : undefined;
      const controlPlaneModel = selectedId
        ? controlPlaneModels.find((model) => model.id === selectedId || model.id === projectedEntityId)
        : controlPlaneModels.find((model) => model.enabled && modelSupportsApp(model, app));
      if (controlPlaneModel) {
        assertUsableModel(controlPlaneModel, app);
        return this.deployModelToNode(node, controlPlaneModel);
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
      // The node persists and validates the selection it is assigned, so on a
      // node without stable identities the stored reference must be the
      // content-hash projection the model was deployed under, not the
      // control-plane entity id the caller picked.
      if (storedSelection.codexModelHash !== undefined) storedSelection.codexModelHash = codexModelHash ?? null;
      if (storedSelection.claudeModelHash !== undefined) storedSelection.claudeModelHash = claudeModelHash ?? null;
      if (storedSelection.opencodeModelHash !== undefined) storedSelection.opencodeModelHash = opencodeModelHash ?? null;
    }
    const prepared = {
      modelSelection: storedSelection,
      modelEntityIds: projectedEntityIds,
      codexModelHash,
      claudeModelHash,
      opencodeModelHash,
    };
    if (supportsNodeMultiEntityModelAssignment(nodeAgentCapabilities(node))) return prepared;
    // Compatibility for v0.0.23: its strict update schema only accepts the
    // per-agent hashes, so do not send either ordered-array field.
    const { modelEntityIds: _modelEntityIds, ...legacySelection } = storedSelection;
    const legacyModelSelection = hasEntitySelection
      ? {
          codexModelHash: codexModelHash ?? null,
          claudeModelHash: claudeModelHash ?? null,
          opencodeModelHash: opencodeModelHash ?? null,
        }
      : legacySelection;
    return {
      modelSelection: legacyModelSelection,
      codexModelHash,
      claudeModelHash,
      opencodeModelHash,
    };
  }

  async ensureInstanceAssignment(instance: ControlledInstance) {
    const node = this.options.requireNode(instance.nodeId);
    const prepared = await this.prepareAssignment(node, instance.modelSelection);
    const assigned = await this.options.gateway.assignInstanceModels(node, instance.id, prepared);
    await this.retireSupersededNodeModels(node, prepared);
    return assigned;
  }

  /**
   * Retire the content-revision projections a node kept for one entity once an
   * assignment has moved to a newer revision. Nodes without stable model
   * identities store one registry record per deployed revision, so the record
   * the assignment no longer references would otherwise stay behind and show up
   * as a duplicate location. Runs only after the new assignment is durable: a
   * record another instance still references answers 409 and is retried by the
   * next assignment on that node. Never throws - the assignment already
   * succeeded and cleanup must not fail the caller.
   */
  async retireSupersededNodeModels(node: Node, assignment: PreparedModelAssignment) {
    try {
      const assignedIds = new Set<string>();
      for (const id of [
        ...(assignment.modelSelection.modelEntityIds ?? []),
        ...(assignment.modelEntityIds ?? []),
        assignment.modelSelection.codexModelHash,
        assignment.modelSelection.claudeModelHash,
        assignment.modelSelection.opencodeModelHash,
        assignment.codexModelHash,
        assignment.claudeModelHash,
        assignment.opencodeModelHash,
      ]) {
        if (id) assignedIds.add(id);
      }
      if (!assignedIds.size) return;
      const projectionIndex = this.modelProjectionIndex();
      const superseded = new Set<string>();
      for (const assignedId of assignedIds) {
        const entityId = projectionIndex.get(assignedId) ?? assignedId;
        for (const projectionId of this.legacyProjectionIds.get(entityId) || []) {
          if (!assignedIds.has(projectionId)) superseded.add(projectionId);
        }
      }
      if (!superseded.size) return;
      const records = await this.options.gateway.listModels(node);
      for (const record of records) {
        if (!superseded.has(record.id)) continue;
        try {
          await this.options.gateway.deleteModel(node, record.id);
        } catch {
          // Another assignment still holds the revision (409 NODE_MODEL_IN_USE)
          // or the node rejected the delete; leave it for the next assignment.
        }
      }
    } catch {
      // Discovery failed (offline node, unsupported listing); retry later.
    }
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
    return this.databaseModels.get(id);
  }

  private findByContentHash(contentHash: string) {
    return this.modelList().find((model) => modelConfigHash(model) === contentHash);
  }

  /**
   * Maps legacy content-hash projections back onto control-plane entity ids.
   * Recorded deployments keep their mapping after edits; projections shared by
   * several entities are ambiguous and stay unmapped.
   */
  private modelProjectionIndex() {
    const index = new Map<string, string>(this.legacyProjections);
    const ambiguous = new Set<string>();
    for (const model of this.modelList()) {
      const projection = modelConfigHash(model);
      const current = index.get(projection);
      if (current !== undefined && current !== model.id) {
        ambiguous.add(projection);
        continue;
      }
      index.set(projection, model.id);
    }
    for (const projection of ambiguous) index.delete(projection);
    return index;
  }

  private async recordLegacyProjection(projectionId: string, modelId: string) {
    if (this.legacyProjections.get(projectionId) === modelId) return;
    await this.options.repository.putLegacyProjection(projectionId, modelId);
    this.legacyProjections.set(projectionId, modelId);
    const ids = this.legacyProjectionIds.get(modelId) || new Set<string>();
    ids.add(projectionId);
    this.legacyProjectionIds.set(modelId, ids);
  }

  private async modelPut(model: ModelConfig) {
    const stored = await this.options.repository.put(model);
    this.databaseModels.set(stored.id, stored);
    return stored;
  }

  private async modelDelete(id: string) {
    const deleted = await this.options.repository.delete(id);
    if (deleted) {
      this.databaseModels.delete(id);
      const projections = [...(this.legacyProjectionIds.get(id) || [])];
      if (projections.length) {
        await this.options.repository.deleteLegacyProjections(projections);
        this.legacyProjectionIds.delete(id);
        for (const projection of projections) this.legacyProjections.delete(projection);
      }
    }
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
    // Nodes that predate stable identities store the content-hash projection
    // of a control-plane entity, so both ids identify the same model there.
    const candidateIds = this.entityReferenceIds(modelId);
    const references = new Map<string, { kind: "instance"; instanceId: string }>();
    for (const instance of instances) {
      const ids = instance.modelSelection.modelEntityIds?.length
        ? instance.modelSelection.modelEntityIds
        : [instance.modelSelection.codexModelHash, instance.modelSelection.claudeModelHash, instance.modelSelection.opencodeModelHash];
      if (ids.some((id) => Boolean(id && candidateIds.includes(id)))) {
        references.set(instance.id, { kind: "instance", instanceId: instance.id });
      }
    }
    return [...references.values()].sort((left, right) => left.instanceId.localeCompare(right.instanceId));
  }

  private entityReferenceIds(modelId: string) {
    const model = this.modelGet(modelId);
    return model
      ? [...new Set([modelId, modelConfigHash(model), ...(this.legacyProjectionIds.get(modelId) || [])])]
      : [modelId];
  }

  private replicaHolderIds(modelId: string, nodes: Node[]) {
    const fleet = this.options.gateway.readFleetModels(nodes);
    const projectionIndex = this.modelProjectionIndex();
    return new Set(fleet.items
      .filter(({ model }) => (projectionIndex.get(model.id) ?? model.id) === modelId)
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
   * Deploy a control-plane entity to one node and return the id the node will
   * use for it. Nodes without stable model identities still validate the
   * legacy content hash, so they receive that projection until they upgrade.
   */
  private async deployModelToNode(node: Node, model: ModelConfig) {
    const [resolved] = await this.withFreshNodeCapabilities([node], false);
    if (nodeSupportsStableModelIdentity(resolved)) {
      await this.options.gateway.deployModel(resolved, model.id, model);
      return model.id;
    }
    const legacyId = modelConfigHash(model);
    await this.options.gateway.deployModel(resolved, legacyId, ModelConfigSchema.parse({ ...model, id: legacyId }));
    await this.recordLegacyProjection(legacyId, model.id);
    return legacyId;
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
    const projectionIndex = this.modelProjectionIndex();
    const holderIds = new Set(fleet.items
      .filter(({ model: record }) => (projectionIndex.get(record.id) ?? record.id) === model.id)
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
        await this.options.gateway.deployModel(resolved, model.id, model);
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
  const source = entries?.length ? entries : [{ name: legacyModel, order: 100 }];
  const seen = new Set<string>();
  return source
    .map((entry) => ({ name: entry.name.trim(), order: entry.order }))
    .filter((entry) => {
      if (!entry.name || seen.has(entry.name)) return false;
      seen.add(entry.name);
      return true;
    })
    .sort((left, right) => left.order - right.order || left.name.localeCompare(right.name))
    .map((entry, index) => ({ name: entry.name, order: (index + 1) * 100 }));
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
