import { z } from "zod";
import {
  ControlledInstanceSchema,
  CreateNodeModelSchema,
  DeployNodeModelSchema,
  NodeModelAssignmentSchema,
  NodeModelConfigSchema,
  NodeModelPublicRecordSchema,
  UpdateNodeModelAssignmentSchema,
  UpdateNodeModelSchema,
  createModelEntityId,
  isModelConfigHashId,
  modelConfigHash,
  modelContentRevision,
  normalizeModelNameEntries,
  normalizeModelRequestMappings,
  projectModelNameEntries,
  supportsControlledInstanceModelRelay,
  supportsControlledInstanceModelRelayProtocol,
  type ControlledInstance,
  type NodeModelAssignment,
  type NodeModelConfig,
  type NodeModelPublicRecord,
} from "@task-handoff/protocol/control-plane";
import type { NodeAgentStorePaths } from "../persistence/paths.ts";
import { modelRelayRouteBaseUrl } from "./relay-routes.ts";
import type { ModelAssignmentRepository, ModelRepository } from "../persistence/model-repository.ts";
import { createNodeAgentRepository } from "../persistence/repository.ts";
import { openNodeAgentDatabaseSync } from "../persistence/database.ts";
import { nowIso as now } from "@task-handoff/core/core/time";
import { INSTANCE_PRIVATE_MODEL_CATALOG_RELAY_PROTOCOL_VERSION, InstancePrivateModelCatalogSchema } from "./private-catalog.ts";

type InstanceAccess = {
  has(id: string): boolean;
  list(): ControlledInstance[];
  require(id: string): ControlledInstance;
  put(instance: ControlledInstance): ControlledInstance;
};

/**
 * Compatibility for v0.0.34: a legacy hash identity addresses a record by its
 * content, so it can never carry request mappings (two records with equal
 * content but different mappings would collide on one hash).
 */
function legacyMappingIdentityError() {
  return Object.assign(new Error("Model request mappings require a stable model entity identity."), {
    statusCode: 400,
    code: "NODE_MODEL_REQUEST_MAPPING_REQUIRES_STABLE_IDENTITY",
  });
}

export class NodeModelRegistry {
  private readonly models: ModelRepository;
  private readonly assignments: ModelAssignmentRepository;
  private readonly transaction: <T>(operation: () => T) => T;
  private readonly nodeId: string;
  private readonly instances: InstanceAccess;
  private readonly modelRelay?: { enabled(): boolean; originFor(instance: ControlledInstance): string };

  constructor(
    paths: NodeAgentStorePaths,
    nodeId: string,
    instances: InstanceAccess,
    persistence?: { models: ModelRepository; assignments: ModelAssignmentRepository; transaction<T>(operation: () => T): T },
    modelRelay?: { enabled(): boolean; originFor(instance: ControlledInstance): string },
  ) {
    this.nodeId = nodeId;
    this.instances = instances;
    this.modelRelay = modelRelay;
    const repositories = persistence || createNodeAgentRepository(openNodeAgentDatabaseSync(paths)).model;
    this.models = repositories.models;
    this.assignments = repositories.assignments;
    this.transaction = repositories.transaction.bind(repositories);
  }

  init() {}

  /** Live relay switch accessor; the resolver must never cache this value. */
  modelRelayEnabled() {
    return this.modelRelay?.enabled() === true;
  }

  instance(instanceId: string) {
    return this.instances.require(instanceId);
  }

  assignment(instanceId: string) {
    return this.assignments.get(instanceId);
  }

  /** Assigned entity ids including compatibility hash references, deduplicated. */
  assignedModelIds(instanceId: string) {
    const assignment = this.assignments.get(instanceId);
    return assignment ? this.assignmentModelIds(assignment) : [];
  }

  getModel(id: string) {
    return this.models.get(id);
  }

  /**
   * A mapping is non-trivial when an external name differs from the upstream
   * name it resolves to. Entities without such an entry stay direct-mode safe.
   */
  isMappedModel(model: Pick<NodeModelConfig, "modelNames" | "model">) {
    return normalizeModelNames(model.modelNames, model.model).some((entry) => entry.upstreamName !== entry.name);
  }

  /** Instance ids with any model assignment, including legacy hash refs. */
  assignedInstanceIds() {
    return this.instances.list().flatMap((instance) => {
      const assignment = this.assignments.get(instance.id);
      return assignment && this.assignmentModelIds(assignment).length ? [instance.id] : [];
    });
  }

  /**
   * Instance ids whose assignment contains a non-same-name mapping and that
   * actually consume relay routes. Disabling the relay switch must be rejected
   * while this list is non-empty; instances without relay support are not
   * affected by the switch, so they never pin it.
   */
  mappedAssignmentInstanceIds() {
    return this.instances.list().flatMap((instance) => {
      if (!supportsControlledInstanceModelRelay(instance.capabilities)) return [];
      const assignment = this.assignments.get(instance.id);
      if (!assignment) return [];
      const mapped = this.assignmentModelIds(assignment).some((id) => {
        const model = this.models.get(id);
        return Boolean(model && this.isMappedModel(model));
      });
      return mapped ? [instance.id] : [];
    });
  }

  list(): NodeModelPublicRecord[] {
    const referenceCounts = new Map<string, number>();
    for (const instance of this.instances.list()) {
      const assignment = this.assignments.get(instance.id);
      for (const modelHash of new Set([
        ...(assignment?.modelEntityIds || []),
        assignment?.codexModelHash,
        assignment?.claudeModelHash,
        assignment?.opencodeModelHash,
      ])) {
        if (modelHash) referenceCounts.set(modelHash, (referenceCounts.get(modelHash) || 0) + 1);
      }
    }
    return this.models.list().map((model) => this.toPublic(model, referenceCounts.get(model.id) || 0));
  }

  create(input: z.infer<typeof CreateNodeModelSchema>) {
    const timestamp = now();
    const modelNames = normalizeModelNames(input.modelNames, input.model);
    const normalizedInput = {
      ...input,
      model: modelNames[0].name,
      modelNames,
      mappings: normalizeModelRequestMappings(input.mappings),
      protocols: input.protocols?.length ? input.protocols : defaultProtocols(input.app),
    };
    // Entity identity is opaque and stable. Re-adding the same content still
    // converges on the existing entity, but a new record mints a short id.
    const contentRevision = modelContentRevision(normalizedInput);
    const current = this.models.list().find((model) => modelContentRevision(model) === contentRevision);
    let id = current?.id;
    if (!id) {
      id = createModelEntityId();
      while (this.models.get(id)) id = createModelEntityId();
    }
    const model = NodeModelConfigSchema.parse({
      ...normalizedInput,
      id,
      enabled: input.enabled ?? true,
      order: input.order ?? this.nextOrder(),
      labels: input.labels || {},
      createdAt: current?.createdAt || timestamp,
      updatedAt: timestamp,
    });
    return this.toPublic(this.models.put(model), this.referenceIds(id).length);
  }

  deploy(input: z.infer<typeof DeployNodeModelSchema>) {
    const expectedHash = modelConfigHash(input);
    const existing = this.models.get(input.id);
    const modelNames = normalizeModelNames(input.modelNames, input.model);
    const mappings = normalizeModelRequestMappings(input.mappings);
    const normalizedInput = {
      ...input,
      model: modelNames[0].name,
      modelNames,
      mappings,
      protocols: input.protocols?.length ? input.protocols : defaultProtocols(input.app),
    };
    if (input.id !== expectedHash && !existing && isModelConfigHashId(input.id)) {
      // Compatibility for v0.0.34: released control planes deploy under the
      // content hash, so a hash-shaped unknown id must still match its content.
      // Current writers mint opaque entity ids, which are accepted as-is;
      // in-place revisions of entities this node already owns stay allowed.
      throw Object.assign(new Error(`Model content hash ${expectedHash} does not match ${input.id}.`), { statusCode: 400, code: "NODE_MODEL_HASH_MISMATCH" });
    }
    if (this.isMappedModel(normalizedInput)) {
      // Mapping resolution needs a stable entity identity. The legacy hash
      // projection cannot carry one, so it must never transport a mapping.
      if (isModelConfigHashId(input.id)) {
        throw Object.assign(new Error("Model name mappings require a stable model entity identity."), {
          statusCode: 400,
          code: "NODE_MODEL_RELAY_MAPPING_REQUIRES_STABLE_IDENTITY",
        });
      }
    }
    if (mappings.length && isModelConfigHashId(input.id)) {
      // Compatibility for v0.0.34: legacy hash ids cannot be edited in place,
      // so request mappings must never be stored under one.
      throw legacyMappingIdentityError();
    }
    const stored = this.models.put(NodeModelConfigSchema.parse({
      ...normalizedInput,
      createdAt: existing?.createdAt || normalizedInput.createdAt,
    }));
    return this.toPublic(stored, this.referenceIds(stored.id).length);
  }

  update(id: string, input: z.infer<typeof UpdateNodeModelSchema>) {
    const current = this.requireModel(id);
    const modelNames = input.modelNames?.length
      ? normalizeModelNames(input.modelNames, input.model || current.model)
      : input.model ? normalizeModelNames(undefined, input.model) : normalizeModelNames(current.modelNames, current.model);
    const protocols = input.protocols?.length
      ? input.protocols
      : current.protocols?.length ? current.protocols : defaultProtocols(input.app || current.app);
    // An explicit empty list clears every mapping; a missing field keeps the
    // stored list. Unlike modelNames there is no legacy fallback to derive.
    const mappings = input.mappings !== undefined
      ? normalizeModelRequestMappings(input.mappings)
      : normalizeModelRequestMappings(current.mappings);
    // Only an explicit mapping edit trips this check, so untouched patches to a
    // stored legacy record keep working; deploy() carries the same invariant.
    if (input.mappings !== undefined && mappings.length && isModelConfigHashId(id)) {
      throw legacyMappingIdentityError();
    }
    const candidate = NodeModelConfigSchema.parse({
      ...current,
      ...input,
      key: input.key?.trim() ? input.key : current.key,
      protocols,
      model: modelNames[0].name,
      modelNames,
      mappings,
      createdAt: current.createdAt,
      updatedAt: now(),
    });
    // The entity id is stable: editing content updates this record in place so
    // instance assignments and AI session selections keep resolving to it.
    const stored = this.models.put(NodeModelConfigSchema.parse({ ...candidate, id }));
    return this.toPublic(stored, this.referenceIds(id).length);
  }

  delete(id: string) {
    this.requireModel(id);
    const instanceIds = this.referenceIds(id);
    if (instanceIds.length) {
      throw Object.assign(new Error(`Model ${id} is assigned to ${instanceIds.length} instance${instanceIds.length === 1 ? "" : "s"}.`), {
        statusCode: 409,
        code: "NODE_MODEL_IN_USE",
        instanceIds,
      });
    }
    return this.models.delete(id);
  }

  resolveProbeKey(existingModelId?: string, override?: string) {
    const key = override?.trim() || (existingModelId ? this.requireModel(existingModelId).key : "");
    if (!key) throw Object.assign(new Error("An API key is required to contact the model endpoint."), { statusCode: 400, code: "MODEL_API_KEY_REQUIRED" });
    return key;
  }

  assign(instanceId: string, input: z.infer<typeof UpdateNodeModelAssignmentSchema>) {
    const current = this.instances.require(instanceId);
    for (const modelEntityId of input.modelEntityIds) {
      this.validateEntityRef(modelEntityId);
    }
    if (input.modelSelection.modelEntityIds !== undefined
      && JSON.stringify(input.modelSelection.modelEntityIds) !== JSON.stringify(input.modelEntityIds)) {
      throw Object.assign(new Error("Ordered model entity selection does not match its node assignment."), { statusCode: 400, code: "NODE_MODEL_SELECTION_MISMATCH" });
    }
    this.validateRef("codex", input.codexModelHash);
    this.validateRef("claude", input.claudeModelHash);
    this.validateRef("opencode", input.opencodeModelHash);
    if (input.modelSelection.codexModelHash !== undefined && (input.modelSelection.codexModelHash ?? undefined) !== input.codexModelHash) {
      throw Object.assign(new Error("Codex model selection does not match its node assignment."), { statusCode: 400, code: "NODE_MODEL_SELECTION_MISMATCH" });
    }
    if (input.modelSelection.claudeModelHash !== undefined && (input.modelSelection.claudeModelHash ?? undefined) !== input.claudeModelHash) {
      throw Object.assign(new Error("Claude model selection does not match its node assignment."), { statusCode: 400, code: "NODE_MODEL_SELECTION_MISMATCH" });
    }
    if (input.modelSelection.opencodeModelHash !== undefined && (input.modelSelection.opencodeModelHash ?? undefined) !== input.opencodeModelHash) {
      throw Object.assign(new Error("OpenCode model selection does not match its node assignment."), { statusCode: 400, code: "NODE_MODEL_SELECTION_MISMATCH" });
    }
    const assignment = NodeModelAssignmentSchema.parse({ instanceId, modelEntityIds: input.modelEntityIds, codexModelHash: input.codexModelHash, claudeModelHash: input.claudeModelHash, opencodeModelHash: input.opencodeModelHash, updatedAt: now() });
    return this.transaction(() => {
      const storedAssignment = this.assignments.put(assignment);
      const instance = this.instances.put(ControlledInstanceSchema.parse({ ...current, modelSelection: input.modelSelection, updatedAt: now() }));
      return { assignment: storedAssignment, instance };
    });
  }

  resolvedEnvironment(instanceId: string) {
    const assignment = this.assignments.get(instanceId);
    if (!assignment) {
      return {};
    }
    const instance = this.instances.has(instanceId) ? this.instances.require(instanceId) : undefined;
    // Relay-capable instances receive relay routes and their own instance
    // credential instead of any upstream endpoint or key.
    if (instance && this.usesRelayProjection(instance)) {
      return this.relayEnvironment(instance, assignment);
    }
    const firstCompatible = (app: "codex" | "claude" | "opencode") => assignment.modelEntityIds
      .find((id) => {
        const model = this.requireModel(id);
        // Mapped entities resolve exclusively through relay routes; injecting
        // their direct endpoint/key would send the external name upstream.
        return !this.isMappedModel(model) && this.modelSupportsApp(model, app);
      });
    return {
      ...this.environmentForRef("codex", firstCompatible("codex") || assignment.codexModelHash),
      ...this.environmentForRef("claude", firstCompatible("claude") || assignment.claudeModelHash),
      ...this.environmentForOpenCode(assignment),
    };
  }

  /** True when this instance consumes relay routes and the node switch is on. */
  private usesRelayProjection(instance: ControlledInstance) {
    return Boolean(this.modelRelay?.enabled() && supportsControlledInstanceModelRelay(instance.capabilities));
  }

  private relayEnvironment(instance: ControlledInstance, assignment: NodeModelAssignment) {
    const origin = this.modelRelay?.originFor(instance) || "";
    const credential = instance.registrationToken;
    const entities = assignment.modelEntityIds.map((id) => {
      const model = this.requireModel(id);
      this.validateEntityRef(id);
      return model;
    });
    const routeBaseUrl = (model: NodeModelConfig, protocol: "openai-responses" | "openai-chat-completions" | "anthropic-messages") => (
      supportsControlledInstanceModelRelayProtocol(instance.capabilities, protocol) && origin
        ? modelRelayRouteBaseUrl(origin, instance.id, model.id, protocol)
        : undefined
    );
    const environment: Record<string, string> = {};
    const claudeEntity = entities.find((model) => this.modelSupportsApp(model, "claude") && routeBaseUrl(model, "anthropic-messages"));
    if (claudeEntity && credential) {
      const baseUrl = routeBaseUrl(claudeEntity, "anthropic-messages")!;
      const name = normalizeModelNames(claudeEntity.modelNames, claudeEntity.model)
        .slice()
        .sort((left, right) => left.order - right.order || left.name.localeCompare(right.name))[0]?.name;
      if (name) {
        environment.ANTHROPIC_API_KEY = credential;
        environment.ANTHROPIC_BASE_URL = baseUrl;
        environment.TASK_HANDOFF_CLAUDE_MODEL = name;
      }
    }
    const opencodeEntities = entities.filter((model) => this.modelSupportsApp(model, "opencode") && routeBaseUrl(model, "openai-chat-completions"));
    if (opencodeEntities.length && credential) {
      const firstEntity = opencodeEntities[0];
      const firstModelName = normalizeModelNames(firstEntity.modelNames, firstEntity.model)
        .slice()
        .sort((left, right) => left.order - right.order || left.name.localeCompare(right.name))[0]?.name;
      const providers = Object.fromEntries(opencodeEntities.map((model) => [
        `task-handoff-${model.id}`,
        openCodeProvider(model, normalizeModelNames(model.modelNames, model.model).map((entry) => entry.name), {
          baseUrl: routeBaseUrl(model, "openai-chat-completions")!,
          apiKey: credential,
        }),
      ]));
      environment.TASK_HANDOFF_OPENCODE_CONFIG_CONTENT = JSON.stringify({
        $schema: "https://opencode.ai/config.json",
        model: `task-handoff-${firstEntity.id}/${firstModelName}`,
        provider: providers,
      });
    }
    return environment;
  }

  privateCatalog(instanceId: string) {
    const assignment = this.assignments.get(instanceId);
    const updatedAt = assignment?.updatedAt || now();
    const models = (assignment?.modelEntityIds || []).map((id) => {
      const model = this.requireModel(id);
      this.validateEntityRef(id);
      return model;
    });
    const instance = this.instances.has(instanceId) ? this.instances.require(instanceId) : undefined;
    if (instance && this.usesRelayProjection(instance)) {
      const origin = this.modelRelay?.originFor(instance) || "";
      return InstancePrivateModelCatalogSchema.parse({
        protocolVersion: INSTANCE_PRIVATE_MODEL_CATALOG_RELAY_PROTOCOL_VERSION,
        instanceId,
        entities: models.map((model) => {
          const protocols = model.protocols?.length ? model.protocols : defaultProtocols(model.app);
          return {
            id: model.id,
            protocols,
            modelNames: normalizeModelNames(model.modelNames, model.model),
            routes: protocols
              .filter((protocol) => supportsControlledInstanceModelRelayProtocol(instance.capabilities, protocol))
              .map((protocol) => ({ protocol, baseUrl: modelRelayRouteBaseUrl(origin, instanceId, model.id, protocol) })),
          };
        }).filter((entity) => entity.routes.length > 0),
        updatedAt,
      });
    }
    return InstancePrivateModelCatalogSchema.parse({
      protocolVersion: "2026-08-27",
      instanceId,
      entities: models.flatMap((model) => {
        // Mapped entities are only projected through the relay catalog, which
        // is materialized separately. Direct catalogs must fail closed instead
        // of leaking the upstream endpoint/key behind an external name.
        if (this.isMappedModel(model)) return [];
        return [{
          id: model.id,
          endpoint: model.endpoint,
          key: model.key,
          protocols: model.protocols?.length ? model.protocols : defaultProtocols(model.app),
          modelNames: normalizeModelNames(model.modelNames, model.model),
        }];
      }),
      updatedAt,
    });
  }

  privateSecretValues(instanceId: string) {
    // Redaction must always cover the authoritative upstream keys, including
    // relay projections that intentionally carry no key field.
    const assignment = this.assignments.get(instanceId);
    if (!assignment) return [];
    return [...new Set(this.assignmentModelIds(assignment)
      .map((id) => this.models.get(id)?.key)
      .filter((key): key is string => Boolean(key)))];
  }

  deleteInstanceMetadata(instanceId: string) {
    this.assignments.delete(instanceId);
  }

  /** Instance ids whose assignment currently references this model entity. */
  referencingInstanceIds(modelId: string) {
    this.requireModel(modelId);
    return this.referenceIds(modelId);
  }

  /**
   * Fold a superseded model entity into its successor: every instance that
   * still references the superseded id is re-pointed at the target inside one
   * transaction, then the superseded record is removed. This is the recovery
   * path for registries that accumulated detached copies before identities
   * became stable.
   */
  merge(id: string, targetModelId: string) {
    const ghost = this.requireModel(id);
    const target = this.requireModel(targetModelId);
    if (ghost.id === target.id) {
      throw Object.assign(new Error("A model cannot be merged into itself."), { statusCode: 400, code: "NODE_MODEL_MERGE_SAME" });
    }
    this.validateEntityRef(target.id);
    for (const app of ["codex", "claude", "opencode"] as const) {
      if (this.modelSupportsApp(ghost, app) && !this.modelSupportsApp(target, app)) {
        throw Object.assign(new Error(`Model ${target.id} does not support the ${app} runtime protocol required by ${ghost.id}.`), {
          statusCode: 409,
          code: "NODE_MODEL_MERGE_APP_MISMATCH",
        });
      }
    }
    const instanceIds = this.referenceIds(id);
    this.transaction(() => {
      for (const instanceId of instanceIds) {
        const instance = this.instances.require(instanceId);
        const assignment = this.assignments.get(instanceId);
        if (!assignment) continue;
        const modelEntityIds = [...new Set(assignment.modelEntityIds.map((entityId) => entityId === id ? targetModelId : entityId))];
        const resolveHash = (app: "codex" | "claude" | "opencode", currentHash?: string) => (
          currentHash && currentHash !== id
            ? currentHash
            : modelEntityIds.find((entityId) => this.modelSupportsApp(this.requireModel(entityId), app))
        );
        const codexModelHash = resolveHash("codex", assignment.codexModelHash);
        const claudeModelHash = resolveHash("claude", assignment.claudeModelHash);
        const opencodeModelHash = resolveHash("opencode", assignment.opencodeModelHash);
        this.assignments.put(NodeModelAssignmentSchema.parse({
          instanceId,
          modelEntityIds,
          codexModelHash,
          claudeModelHash,
          opencodeModelHash,
          updatedAt: now(),
        }));
        this.instances.put(ControlledInstanceSchema.parse({
          ...instance,
          modelSelection: {
            ...instance.modelSelection,
            modelEntityIds,
            codexModelHash: codexModelHash ?? null,
            claudeModelHash: claudeModelHash ?? null,
            opencodeModelHash: opencodeModelHash ?? null,
          },
          updatedAt: now(),
        }));
      }
      this.models.delete(id);
    });
    return { merged: true as const, reassignedInstances: instanceIds };
  }

  private validateRef(app: "codex" | "claude" | "opencode", modelHash?: string) {
    if (!modelHash) return;
    const model = this.requireModel(modelHash);
    if (!this.modelSupportsApp(model, app)) {
      throw Object.assign(new Error(`Model ${model.id} does not support the ${app} runtime protocol.`), { statusCode: 400, code: "NODE_MODEL_APP_MISMATCH" });
    }
    if (!model.enabled) throw Object.assign(new Error(`Model ${model.id} is disabled.`), { statusCode: 409, code: "NODE_MODEL_DISABLED" });
  }

  private modelSupportsApp(model: NodeModelConfig, app: "codex" | "claude" | "opencode") {
    const protocol = app === "claude" ? "anthropic-messages" : app === "opencode" ? "openai-chat-completions" : "openai-responses";
    return model.protocols?.length ? model.protocols.includes(protocol) : model.app === app;
  }

  private validateEntityRef(modelHash: string) {
    const model = this.requireModel(modelHash);
    if (!model.enabled) throw Object.assign(new Error(`Model ${model.id} is disabled.`), { statusCode: 409, code: "NODE_MODEL_DISABLED" });
    if (!(model.protocols?.length || defaultProtocols(model.app).length)) {
      throw Object.assign(new Error(`Model ${model.id} does not expose a supported protocol.`), { statusCode: 400, code: "NODE_MODEL_PROTOCOL_UNSUPPORTED" });
    }
  }

  private assignmentModelIds(assignment: NodeModelAssignment) {
    return [...new Set([
      ...(assignment.modelEntityIds || []),
      assignment.codexModelHash,
      assignment.claudeModelHash,
      assignment.opencodeModelHash,
    ].filter((id): id is string => Boolean(id)))];
  }

  private environmentForRef(app: "codex" | "claude", modelHash?: string) {
    if (!modelHash) return {};
    this.validateRef(app, modelHash);
    const model = this.requireModel(modelHash);
    if (this.isMappedModel(model)) return {};
    if (app === "codex") return {
      OPENAI_API_KEY: model.key,
      OPENAI_BASE_URL: model.endpoint,
      TASK_HANDOFF_CODEX_BASE_URL: model.endpoint,
      TASK_HANDOFF_CODEX_MODEL: model.model,
    };
    return {
      ANTHROPIC_API_KEY: model.key,
      ANTHROPIC_BASE_URL: model.endpoint,
      TASK_HANDOFF_CLAUDE_MODEL: model.model,
    };
  }

  private environmentForOpenCode(assignment: z.infer<typeof NodeModelAssignmentSchema>) {
    const entities = assignment.modelEntityIds
      .map((id) => this.requireModel(id))
      .filter((model) => !this.isMappedModel(model) && this.modelSupportsApp(model, "opencode"));
    if (!entities.length) return {};
    const firstEntity = entities[0];
    const firstModelName = normalizeModelNames(firstEntity.modelNames, firstEntity.model)[0].name;
    const providers = Object.fromEntries(entities.map((model) => [
      `task-handoff-${model.id}`,
      openCodeProvider(model, normalizeModelNames(model.modelNames, model.model).map((entry) => entry.name)),
    ]));
    // Compatibility for v0.0.23: sessions created from a legacy assignment
    // persist the stable `task-handoff` provider id. Keep that alias available,
    // while the ordered entity catalog remains authoritative for new choices.
    if (assignment.opencodeModelHash) {
      const legacyModel = this.requireModel(assignment.opencodeModelHash);
      if (!this.isMappedModel(legacyModel)) {
        providers["task-handoff"] = openCodeProvider(legacyModel, [legacyModel.model]);
      }
    }
    return {
      TASK_HANDOFF_OPENCODE_CONFIG_CONTENT: JSON.stringify({
        $schema: "https://opencode.ai/config.json",
        model: `task-handoff-${firstEntity.id}/${firstModelName}`,
        provider: providers,
      }),
    };
  }

  private requireModel(id: string) {
    const model = this.models.get(id);
    if (!model) throw Object.assign(new Error(`Model ${id} was not found on node ${this.nodeId}.`), { statusCode: 404, code: "NODE_MODEL_NOT_FOUND" });
    return model;
  }

  private referenceIds(modelId: string) {
    return this.instances.list().filter((instance) => {
      const assignment = this.assignments.get(instance.id);
      return assignment?.modelEntityIds.includes(modelId) || assignment?.codexModelHash === modelId || assignment?.claudeModelHash === modelId || assignment?.opencodeModelHash === modelId;
    }).map((instance) => instance.id);
  }

  private toPublic(model: NodeModelConfig, referenceCount: number): NodeModelPublicRecord {
    const { key, ...safe } = model;
    return NodeModelPublicRecordSchema.parse({
      ...safe,
      modelNames: projectModelNameEntries(model.modelNames),
      keyPreview: key.length <= 8 ? "set" : `${key.slice(0, 4)}...${key.slice(-4)}`,
      keySet: true,
      referenceCount,
      revision: modelContentRevision(model),
    });
  }

  private nextOrder() {
    return this.models.list().reduce((max, model) => Math.max(max, model.order), 0) + 100;
  }

}

function openCodeReasoningVariants() {
  return Object.fromEntries(["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]
    .map((effort) => [effort, { reasoningEffort: effort }]));
}

function openCodeProvider(
  model: NodeModelConfig,
  modelNames: string[],
  options?: { baseUrl: string; apiKey: string },
) {
  return {
    npm: "@ai-sdk/openai-compatible",
    name: model.name,
    options: options ? { baseURL: options.baseUrl, apiKey: options.apiKey } : { baseURL: model.endpoint, apiKey: model.key },
    models: Object.fromEntries(modelNames.map((name) => [name, {
      name: model.name,
      variants: openCodeReasoningVariants(),
    }])),
  };
}

function defaultProtocols(app: "codex" | "claude" | "opencode") {
  return app === "claude" ? ["anthropic-messages" as const] : app === "opencode" ? ["openai-chat-completions" as const] : ["openai-responses" as const];
}

function normalizeModelNames(entries: NodeModelConfig["modelNames"] | undefined, legacyModel: string) {
  // Duplicate external names stay in the list so the strict schema refine
  // rejects an ambiguous mapping instead of silently dropping an entry.
  return normalizeModelNameEntries(entries, legacyModel);
}
