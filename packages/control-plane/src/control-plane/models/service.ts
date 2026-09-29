import {
  FederatedModelRegistrySchema,
  ModelConfigSchema,
  ModelMergeResultSchema,
  ModelMutationResultSchema,
  ModelLocationSyncResultSchema,
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
import type { AiSessionHistoryList } from "@task-handoff/protocol/ai-sessions";
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
  listInstances?: () => Promise<ControlledInstance[]>;
  listAiSessions?: () => Promise<{ instances: Array<{ instanceId: string; aiSessions: { sessions: Array<{ id: string; modelSelection?: { modelEntityId: string } }> } }> }>;
  listAiSessionHistory?: (instanceId: string) => Promise<AiSessionHistoryList>;
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
        locations: [{ type: "control-plane", name: model.name, enabled: model.enabled, order: model.order, revision: modelConfigHash(model) }],
        referenceCount: 0,
      });
    }
    for (const { nodeId, model } of fleet.items) {
      const { referenceCount: _referenceCount, ...publicModelRecord } = model;
      const group = groups.get(model.id);
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
        groups.set(model.id, {
          id: model.id,
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
    const id = modelConfigHash(normalizedInput);
    const existing = this.modelGet(id);
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
    const nextId = modelConfigHash({ ...candidate, model: modelNames[0].name });
    if (nextId === source.id) {
      throw Object.assign(new Error("Change the model, endpoint, app, or API key before creating a copy."), {
        statusCode: 409,
        code: "MODEL_COPY_UNCHANGED",
      });
    }
    if (this.modelGet(nextId)) {
      throw Object.assign(new Error(`Model ${nextId} already exists.`), {
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
    const locations: ModelLocationSyncResult[] = [];
    let updated: PublicModelConfig | undefined;
    for (const node of nodes) {
      if (!holderIds.has(node.id)) continue;
      try {
        const record = await this.options.gateway.updateModel(node, id, parsedInput);
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
          locations.push(ModelLocationSyncResultSchema.parse(rolledBack ? {
            nodeId: node.id,
            state: "unsupported",
            code: "NODE_MODEL_STABLE_IDENTITY_UNSUPPORTED",
            message: `Node ${node.id} must be updated before models can be edited in place.`,
          } : {
            nodeId: node.id,
            state: "error",
            code: "NODE_MODEL_LEGACY_EDIT_FORKED",
            message: `Node ${node.id} left a detached copy ${record.id} behind while editing; remove it after updating the node.`,
          }));
          continue;
        }
        const { referenceCount: _referenceCount, ...publicRecord } = record;
        updated = updated || publicRecord;
        locations.push(ModelLocationSyncResultSchema.parse({ nodeId: node.id, state: "synced" }));
      } catch (error) {
        locations.push(nodeLocationFailure(node.id, error));
      }
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

  /** Push the current control-plane content to every known node replica. */
  async sync(id: string) {
    const model = this.modelGet(id);
    if (!model) throwNotFound("MODEL_NOT_FOUND", `Model ${id} was not found on the control plane.`);
    await this.refreshFleetModelIndex(this.options.listNodes());
    return ModelMutationResultSchema.parse({
      model: publicModel(model),
      locations: await this.syncEntityToReplicas(model),
    });
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
    const references = await this.references(id);
    if (references.length) {
      throw Object.assign(new Error(`Model ${id} is referenced by managed instances or AI Sessions.`), {
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

  async prepareAssignment(node: Node, selection: { modelEntityIds?: string[]; codexModelHash?: string | null; claudeModelHash?: string | null; opencodeModelHash?: string | null }) {
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
    const resolve = async (app: "codex" | "claude" | "opencode", selectedId?: string | null) => {
      if (selectedId === null) return undefined;
      const controlPlaneModel = selectedId
        ? controlPlaneModels.find((model) => model.id === selectedId)
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
    return this.databaseModels.get(id);
  }

  private async modelPut(model: ModelConfig) {
    const stored = await this.options.repository.put(model);
    this.databaseModels.set(stored.id, stored);
    return stored;
  }

  private async modelDelete(id: string) {
    const deleted = await this.options.repository.delete(id);
    if (deleted) this.databaseModels.delete(id);
    return deleted;
  }

  private async references(modelId: string) {
    const instances = await this.options.listInstances?.() || [];
    // Nodes that predate stable identities store the content-hash projection
    // of a control-plane entity, so both ids identify the same model there.
    const candidateIds = this.entityReferenceIds(modelId);
    const isReference = (id?: string | null) => Boolean(id && candidateIds.includes(id));
    const references: Array<{ kind: "instance" | "ai-session" | "history"; instanceId: string; aiSessionId?: string }> = [];
    for (const instance of instances) {
      const ids = instance.modelSelection.modelEntityIds?.length
        ? instance.modelSelection.modelEntityIds
        : [instance.modelSelection.codexModelHash, instance.modelSelection.claudeModelHash, instance.modelSelection.opencodeModelHash];
      if (ids.some(isReference)) references.push({ kind: "instance", instanceId: instance.id });
    }
    const current = await this.options.listAiSessions?.() || { instances: [] };
    for (const entry of current.instances) {
      for (const session of entry.aiSessions.sessions) {
        if (isReference(session.modelSelection?.modelEntityId)) {
          references.push({ kind: "ai-session", instanceId: entry.instanceId, aiSessionId: session.id });
        }
      }
    }
    const diagnostics: Array<{ instanceId: string; code: string }> = [];
    await Promise.all(this.options.listAiSessionHistory ? instances.map(async (instance) => {
      try {
        const history = await this.options.listAiSessionHistory!(instance.id);
        for (const item of history.items) {
          if (isReference(item.modelSelection?.modelEntityId)) {
            references.push({ kind: "history", instanceId: instance.id, aiSessionId: item.id });
          }
        }
      } catch (error) {
        diagnostics.push({
          instanceId: instance.id,
          code: error && typeof error === "object" && "code" in error && typeof error.code === "string"
            ? error.code
            : "AI_SESSION_HISTORY_UNAVAILABLE",
        });
      }
    }) : []);
    if (diagnostics.length && references.length === 0) {
      throw Object.assign(new Error("Model references could not be verified for every managed instance."), {
        statusCode: 409,
        code: "MODEL_REFERENCE_CHECK_INCOMPLETE",
        details: { diagnostics },
      });
    }
    return references
      .filter((reference, index, all) => all.findIndex((candidate) => candidate.kind === reference.kind
        && candidate.instanceId === reference.instanceId && candidate.aiSessionId === reference.aiSessionId) === index)
      .sort((a, b) => a.instanceId.localeCompare(b.instanceId) || a.kind.localeCompare(b.kind) || (a.aiSessionId || "").localeCompare(b.aiSessionId || ""));
  }

  private entityReferenceIds(modelId: string) {
    const model = this.modelGet(modelId);
    return model ? [modelId, modelConfigHash(model)] : [modelId];
  }

  private replicaHolderIds(modelId: string, nodes: Node[]) {
    const fleet = this.options.gateway.readFleetModels(nodes);
    return new Set(fleet.items.filter(({ model }) => model.id === modelId).map(({ nodeId }) => nodeId));
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
    if (nodeSupportsStableModelIdentity(node)) {
      await this.options.gateway.deployModel(node, model.id, model);
      return model.id;
    }
    const legacyId = modelConfigHash(model);
    await this.options.gateway.deployModel(node, legacyId, ModelConfigSchema.parse({ ...model, id: legacyId }));
    return legacyId;
  }

  /**
   * Converge the content of a control-plane owned entity onto its replicas.
   * Nodes that cannot store a stable identity keep their previous content and
   * are reported as unsupported instead of forking a second entity.
   */
  private async syncEntityToReplicas(model: ModelConfig, targets?: Set<string>): Promise<ModelLocationSyncResult[]> {
    const nodes = this.options.listNodes();
    const fleet = this.options.gateway.readFleetModels(nodes);
    const holderIds = new Set(fleet.items.filter(({ model: record }) => record.id === model.id).map(({ nodeId }) => nodeId));
    const nodePhases = new Map(fleet.nodeStates.map((state) => [state.nodeId, state.phase]));
    const results: ModelLocationSyncResult[] = [];
    const pending = new Set<string>();
    for (const node of nodes) {
      if (targets ? !targets.has(node.id) : !holderIds.has(node.id)) continue;
      // A reachable node that no longer reports the replica has removed it;
      // retrying would recreate the entity behind the operator's back.
      if (targets && !holderIds.has(node.id) && nodePhases.get(node.id) === "ready") continue;
      if (!nodeSupportsStableModelIdentity(node)) {
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
        await this.options.gateway.deployModel(node, model.id, model);
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
