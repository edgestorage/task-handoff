import {
  FederatedModelRegistrySchema,
  ModelConfigSchema,
  modelConfigHash,
  supportsNodeMultiEntityModelAssignment,
  type ControlledInstance,
  type ModelConfig,
  type Node,
  type NodeModelPublicRecord,
} from "@task-handoff/protocol/control-plane";
import type { JsonCollection } from "../../shared/persistence/store.ts";
import type { AiSessionHistoryList } from "@task-handoff/protocol/ai-sessions";
import { CopyModelInputSchema, CreateModelInputSchema, ModelDiscoveryInputSchema, ModelTestInputSchema, UpdateModelInputSchema, type ModelDiscoveryInput, type ModelTestInput, type UpdateModelInput } from "../application/inputs.ts";
import { now, throwNotFound } from "../application/helpers.ts";
import type { ControlPlaneNodeAgentGateway } from "../nodes/gateway.ts";
import { normalizeModel, publicModel } from "../public-records.ts";
import { discoverModels, testModelEndpoint } from "../../shared/models/model-endpoint.ts";

type ControlPlaneModelServiceOptions = {
  models: JsonCollection<ModelConfig>;
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

  constructor(options: ControlPlaneModelServiceOptions) {
    this.options = options;
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
      model: ReturnType<typeof publicModel> | NodeModelPublicRecord;
      locations: Array<
        | { type: "control-plane"; name: string; enabled: boolean; order: number }
        | { type: "node"; nodeId: string; name: string; enabled: boolean; order: number; referenceCount: number }
      >;
      referenceCount: number;
    }>();
    for (const model of this.listAll()) {
      groups.set(model.id, {
        id: model.id,
        model: publicModel(model),
        locations: [{ type: "control-plane", name: model.name, enabled: model.enabled, order: model.order }],
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
          }],
          referenceCount: model.referenceCount,
        });
      }
    }
    return FederatedModelRegistrySchema.parse({
      models: [...groups.values()].sort((a, b) => a.model.order - b.model.order || a.model.name.localeCompare(b.model.name)),
      nodeDiagnostics: fleet.nodeErrors.map((error) => ({ nodeId: error.nodeId, code: error.code, message: error.message })),
      updatedAt: now(),
    });
  }

  create(input: unknown) {
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
    const existing = this.options.models.get(id);
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
    return publicModel(this.options.models.put(model));
  }

  copy(id: string, input: unknown) {
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
    if (this.options.models.get(nextId)) {
      throw Object.assign(new Error(`Model ${nextId} already exists.`), {
        statusCode: 409,
        code: "MODEL_COPY_CONFLICT",
      });
    }
    return this.create(candidate);
  }

  update(id: string, input: unknown) {
    const parsedInput: UpdateModelInput = UpdateModelInputSchema.parse(input);
    const current = this.requireSecret(id);
    const modelNames = parsedInput.modelNames?.length
      ? normalizeModelNames(parsedInput.modelNames, parsedInput.model || current.model)
      : parsedInput.model ? normalizeModelNames(undefined, parsedInput.model) : normalizeModelNames(current.modelNames, current.model);
    const protocols = parsedInput.protocols?.length
      ? parsedInput.protocols
      : current.protocols?.length ? current.protocols : defaultProtocols(parsedInput.app || current.app);
    const candidate = ModelConfigSchema.parse({
      ...current,
      ...parsedInput,
      key: parsedInput.key?.trim() ? parsedInput.key : current.key,
      protocols,
      modelNames,
      model: modelNames[0].name,
      createdAt: current.createdAt,
      updatedAt: now(),
    });
    const nextId = modelConfigHash(candidate);
    return publicModel(this.options.models.put(ModelConfigSchema.parse({ ...candidate, id: nextId })));
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
    return this.options.models.delete(id);
  }

  reorder(ids: string[]) {
    const uniqueIds = [...new Set(ids)];
    const byId = new Map(this.options.models.list().map((model) => [model.id, model]));
    for (const id of uniqueIds) {
      if (!byId.has(id)) throwNotFound("MODEL_NOT_FOUND", `Model ${id} was not found.`);
    }
    uniqueIds.forEach((id, index) => {
      const current = byId.get(id)!;
      this.options.models.put(ModelConfigSchema.parse({ ...current, order: (index + 1) * 100, updatedAt: now() }));
    });
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
    const storedSelection: {
      modelEntityIds?: string[];
      codexModelHash?: string | null; claudeModelHash?: string | null; opencodeModelHash?: string | null;
    } = {
      ...(selection.modelEntityIds?.length ? { modelEntityIds: [...new Set(selection.modelEntityIds.map((id) => id.trim()).filter(Boolean))] } : {}),
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
    for (const entityId of entityIds) {
      const controlPlaneModel = controlPlaneModels.find((model) => model.id === entityId);
      if (controlPlaneModel) {
        assertEnabledModel(controlPlaneModel);
        await this.options.gateway.deployModel(node, controlPlaneModel.id, controlPlaneModel);
        resolvedEntities.push(controlPlaneModel);
        continue;
      }
      const local = nodeModels.find((model) => model.id === entityId);
      if (!local) throwNotFound("MODEL_NOT_FOUND", `Model ${entityId} was not found on control-plane or node ${node.id}.`);
      assertEnabledModel(local);
      // Node model listings are public records. Project them back to the
      // internal shape instead of spreading response-only credential and
      // reference metadata into the strict model config schema.
      resolvedEntities.push(nodePublicModelToConfig(local));
    }
    const resolve = async (app: "codex" | "claude" | "opencode", selectedId?: string | null) => {
      if (selectedId === null) return undefined;
      const controlPlaneModel = selectedId
        ? this.listAll().find((model) => model.id === selectedId)
        : controlPlaneModels.find((model) => model.enabled && modelSupportsApp(model, app));
      if (controlPlaneModel) {
        assertUsableModel(controlPlaneModel, app);
        await this.options.gateway.deployModel(node, controlPlaneModel.id, controlPlaneModel);
        return controlPlaneModel.id;
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
    const codexModelHash = entityIds.length ? storedSelection.codexModelHash : await resolve("codex", storedSelection.codexModelHash);
    const claudeModelHash = entityIds.length ? storedSelection.claudeModelHash : await resolve("claude", storedSelection.claudeModelHash);
    const opencodeModelHash = entityIds.length ? storedSelection.opencodeModelHash : await resolve("opencode", storedSelection.opencodeModelHash);
    const prepared = {
      modelSelection: storedSelection,
      modelEntityIds: entityIds,
      codexModelHash,
      claudeModelHash,
      opencodeModelHash,
    };
    const agent = node.capabilities.agent;
    const capabilities = agent && typeof agent === "object" && !Array.isArray(agent)
      ? (agent as { capabilities?: unknown }).capabilities
      : undefined;
    if (supportsNodeMultiEntityModelAssignment(capabilities)) return prepared;
    // Compatibility for v0.0.23: its strict update schema only accepts the
    // per-agent hashes, so do not send either ordered-array field.
    const { modelEntityIds: _modelEntityIds, ...legacySelection } = storedSelection;
    return {
      modelSelection: legacySelection,
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
    return this.options.models.list()
      .map((model) => this.normalize(model))
      .sort((a, b) => a.order - b.order || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  }

  private requireSecret(id: string) {
    const record = this.options.models.get(id);
    if (!record) throwNotFound("MODEL_NOT_FOUND", `Model ${id} was not found.`);
    return this.normalize(record);
  }

  private normalize(record: unknown) {
    const model = normalizeModel(record);
    if (model !== record) this.options.models.put(model);
    return model;
  }

  private nextOrder() {
    return this.options.models.list().reduce((max, model) => Math.max(max, model.order), 0) + 100;
  }

  private async references(modelId: string) {
    const instances = await this.options.listInstances?.() || [];
    const references: Array<{ kind: "instance" | "ai-session" | "history"; instanceId: string; aiSessionId?: string }> = [];
    for (const instance of instances) {
      const ids = instance.modelSelection.modelEntityIds?.length
        ? instance.modelSelection.modelEntityIds
        : [instance.modelSelection.codexModelHash, instance.modelSelection.claudeModelHash, instance.modelSelection.opencodeModelHash];
      if (ids.includes(modelId)) references.push({ kind: "instance", instanceId: instance.id });
    }
    const current = await this.options.listAiSessions?.() || { instances: [] };
    for (const entry of current.instances) {
      for (const session of entry.aiSessions.sessions) {
        if (session.modelSelection?.modelEntityId === modelId) {
          references.push({ kind: "ai-session", instanceId: entry.instanceId, aiSessionId: session.id });
        }
      }
    }
    const diagnostics: Array<{ instanceId: string; code: string }> = [];
    await Promise.all(this.options.listAiSessionHistory ? instances.map(async (instance) => {
      try {
        const history = await this.options.listAiSessionHistory!(instance.id);
        for (const item of history.items) {
          if (item.modelSelection?.modelEntityId === modelId) {
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
  const agent = node.capabilities.agent;
  const agentCapabilities = agent && typeof agent === "object" && !Array.isArray(agent)
    ? (agent as Record<string, unknown>).capabilities
    : undefined;
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
