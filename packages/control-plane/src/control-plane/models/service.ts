import {
  FederatedModelRegistrySchema,
  ModelConfigSchema,
  modelConfigHash,
  type ControlledInstance,
  type ModelConfig,
  type Node,
  type NodeModelPublicRecord,
} from "@task-handoff/protocol/control-plane";
import type { JsonCollection } from "../../shared/persistence/store.ts";
import { CreateModelInputSchema, ModelDiscoveryInputSchema, ModelTestInputSchema, UpdateModelInputSchema, type ModelDiscoveryInput, type ModelTestInput, type UpdateModelInput } from "../application/inputs.ts";
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
    const timestamp = now();
    const id = modelConfigHash(parsedInput);
    const existing = this.options.models.get(id);
    const model = ModelConfigSchema.parse({
      ...parsedInput,
      id,
      enabled: parsedInput.enabled ?? true,
      order: parsedInput.order ?? this.nextOrder(),
      labels: parsedInput.labels || {},
      createdAt: existing?.createdAt || timestamp,
      updatedAt: timestamp,
    });
    return publicModel(this.options.models.put(model));
  }

  update(id: string, input: unknown) {
    const parsedInput: UpdateModelInput = UpdateModelInputSchema.parse(input);
    const current = this.requireSecret(id);
    const candidate = ModelConfigSchema.parse({
      ...current,
      ...parsedInput,
      key: parsedInput.key?.trim() ? parsedInput.key : current.key,
      createdAt: current.createdAt,
      updatedAt: now(),
    });
    const nextId = modelConfigHash(candidate);
    return publicModel(this.options.models.put(ModelConfigSchema.parse({ ...candidate, id: nextId })));
  }

  delete(id: string) {
    this.requireSecret(id);
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

  async prepareAssignment(node: Node, selection: { codexModelHash?: string | null; claudeModelHash?: string | null }) {
    const nodeModels = await this.options.gateway.listModels(node);
    const storedSelection = {
      ...(selection.codexModelHash === null
        ? { codexModelHash: null }
        : selection.codexModelHash?.trim() ? { codexModelHash: selection.codexModelHash.trim() } : {}),
      ...(selection.claudeModelHash === null
        ? { claudeModelHash: null }
        : selection.claudeModelHash?.trim() ? { claudeModelHash: selection.claudeModelHash.trim() } : {}),
    };
    const resolve = async (app: "codex" | "claude", selectedId?: string | null) => {
      if (selectedId === null) return undefined;
      const controlPlaneModel = selectedId
        ? this.listAll().find((model) => model.id === selectedId)
        : this.listAll().find((model) => model.enabled && model.app === app);
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
    return {
      modelSelection: storedSelection,
      codexModelHash: await resolve("codex", storedSelection.codexModelHash),
      claudeModelHash: await resolve("claude", storedSelection.claudeModelHash),
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

  private resolvePrivateInput<T extends ModelDiscoveryInput | ModelTestInput>(input: T): T & { key: string } {
    const key = input.key?.trim() || (input.existingModelId ? this.requireSecret(input.existingModelId).key : "");
    if (!key) {
      throw Object.assign(new Error("An API key is required to contact the model endpoint."), { statusCode: 400, code: "MODEL_API_KEY_REQUIRED" });
    }
    return { ...input, key };
  }
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

function assertUsableModel(model: Pick<ModelConfig, "id" | "app" | "enabled">, app: "codex" | "claude") {
  if (model.app !== app) {
    throw Object.assign(new Error(`Model ${model.id} is not a ${app} model.`), {
      statusCode: 400,
      code: "MODEL_APP_MISMATCH",
    });
  }
  if (!model.enabled) {
    throw Object.assign(new Error(`Model ${model.id} is disabled.`), { statusCode: 400, code: "MODEL_DISABLED" });
  }
}
