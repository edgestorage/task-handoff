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
  modelConfigHash,
  type ControlledInstance,
  type NodeModelConfig,
  type NodeModelPublicRecord,
} from "@task-handoff/protocol/control-plane";
import type { NodeAgentStorePaths } from "../persistence/paths.ts";
import {
  InstanceModelAssignmentStore,
  InstanceModelEnvironmentStore,
  LEGACY_MODEL_ENV_KEYS,
  NodeModelStore,
} from "./stores.ts";
import { nowIso as now } from "@task-handoff/core/core/time";
import { InstancePrivateModelCatalogSchema } from "./private-catalog.ts";

type InstanceAccess = {
  has(id: string): boolean;
  list(): ControlledInstance[];
  require(id: string): ControlledInstance;
  put(instance: ControlledInstance): ControlledInstance;
};

export class NodeModelRegistry {
  private readonly models: NodeModelStore;
  private readonly assignments: InstanceModelAssignmentStore;
  private readonly legacyEnvironments: InstanceModelEnvironmentStore;
  private readonly nodeId: string;
  private readonly instances: InstanceAccess;

  constructor(
    paths: NodeAgentStorePaths,
    nodeId: string,
    instances: InstanceAccess,
  ) {
    this.nodeId = nodeId;
    this.instances = instances;
    this.models = new NodeModelStore(paths.nodeModelsDir, nodeId);
    this.assignments = new InstanceModelAssignmentStore(paths.modelAssignmentsDir);
    this.legacyEnvironments = new InstanceModelEnvironmentStore(paths.modelEnvironmentsDir);
  }

  init() {
    this.models.init();
    this.assignments.init();
    this.migrateLegacyEnvironments();
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
    const normalizedInput = { ...input, model: modelNames[0].name, modelNames, protocols: input.protocols?.length ? input.protocols : defaultProtocols(input.app) };
    const id = modelConfigHash(normalizedInput);
    const current = this.models.get(id);
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
    if (input.id !== expectedHash) {
      throw Object.assign(new Error(`Model content hash ${expectedHash} does not match ${input.id}.`), { statusCode: 400, code: "NODE_MODEL_HASH_MISMATCH" });
    }
    const modelNames = normalizeModelNames(input.modelNames, input.model);
    const stored = this.models.get(input.id) || this.models.put(NodeModelConfigSchema.parse({ ...input, model: modelNames[0].name, modelNames, protocols: input.protocols?.length ? input.protocols : defaultProtocols(input.app) }));
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
    const candidate = NodeModelConfigSchema.parse({
      ...current,
      ...input,
      key: input.key?.trim() ? input.key : current.key,
      protocols,
      model: modelNames[0].name,
      modelNames,
      createdAt: current.createdAt,
      updatedAt: now(),
    });
    const nextId = modelConfigHash(candidate);
    const stored = this.models.put(NodeModelConfigSchema.parse({ ...candidate, id: nextId }));
    return this.toPublic(stored, this.referenceIds(nextId).length);
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
    for (const modelEntityId of input.modelEntityIds) this.validateEntityRef(modelEntityId);
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
    const previous = this.assignments.get(instanceId);
    const assignment = NodeModelAssignmentSchema.parse({ instanceId, modelEntityIds: input.modelEntityIds, codexModelHash: input.codexModelHash, claudeModelHash: input.claudeModelHash, opencodeModelHash: input.opencodeModelHash, updatedAt: now() });
    this.assignments.put(assignment);
    try {
      const instance = this.instances.put(ControlledInstanceSchema.parse({ ...current, modelSelection: input.modelSelection, updatedAt: now() }));
      return { assignment, instance };
    } catch (error) {
      if (previous) this.assignments.put(previous);
      else this.assignments.delete(instanceId);
      throw error;
    }
  }

  resolvedEnvironment(instanceId: string) {
    const assignment = this.assignments.get(instanceId);
    if (!assignment) {
      if (this.legacyEnvironments.has(instanceId)) {
        throw Object.assign(new Error(`Legacy model environment for instance ${instanceId} requires manual migration.`), { statusCode: 409, code: "NODE_MODEL_MIGRATION_REQUIRED" });
      }
      return {};
    }
    const firstCompatible = (app: "codex" | "claude" | "opencode") => assignment.modelEntityIds
      .find((id) => this.modelSupportsApp(this.requireModel(id), app));
    return {
      ...this.environmentForRef("codex", firstCompatible("codex") || assignment.codexModelHash),
      ...this.environmentForRef("claude", firstCompatible("claude") || assignment.claudeModelHash),
      ...this.environmentForOpenCode(assignment),
    };
  }

  privateCatalog(instanceId: string) {
    const assignment = this.assignments.get(instanceId);
    return InstancePrivateModelCatalogSchema.parse({
      protocolVersion: "2026-08-27",
      instanceId,
      entities: (assignment?.modelEntityIds || []).map((id) => {
        const model = this.requireModel(id);
        this.validateEntityRef(id);
        return {
          id: model.id,
          endpoint: model.endpoint,
          key: model.key,
          protocols: model.protocols?.length ? model.protocols : defaultProtocols(model.app),
          modelNames: normalizeModelNames(model.modelNames, model.model),
        };
      }),
      updatedAt: assignment?.updatedAt || now(),
    });
  }

  deleteInstanceMetadata(instanceId: string) {
    this.assignments.delete(instanceId);
    this.legacyEnvironments.delete(instanceId);
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

  private environmentForRef(app: "codex" | "claude" | "opencode", modelHash?: string) {
    if (!modelHash) return {};
    this.validateRef(app, modelHash);
    const model = this.requireModel(modelHash);
    if (app === "codex") return {
      OPENAI_API_KEY: model.key,
      OPENAI_BASE_URL: model.endpoint,
      TASK_HANDOFF_CODEX_BASE_URL: model.endpoint,
      TASK_HANDOFF_CODEX_MODEL: model.model,
    };
    if (app === "claude") return {
      ANTHROPIC_API_KEY: model.key,
      ANTHROPIC_BASE_URL: model.endpoint,
      TASK_HANDOFF_CLAUDE_MODEL: model.model,
    };
    const definition = {
      npm: "@ai-sdk/openai-compatible",
      name: "TaskHandoff",
      options: { baseURL: model.endpoint, apiKey: model.key },
      models: { [model.model]: { name: model.name, variants: openCodeReasoningVariants() } },
    };
    const providerId = `task-handoff-${model.id}`;
    return {
      TASK_HANDOFF_OPENCODE_CONFIG_CONTENT: JSON.stringify({
        $schema: "https://opencode.ai/config.json",
        model: `${providerId}/${model.model}`,
        provider: { [providerId]: definition },
      }),
    };
  }

  private environmentForOpenCode(assignment: z.infer<typeof NodeModelAssignmentSchema>) {
    // Compatibility for v0.0.23: legacy assignments use the stable `task-handoff`
    // provider identity so existing OpenCode sessions remain resumable.
    if (assignment.opencodeModelHash) return this.environmentForRef("opencode", assignment.opencodeModelHash);
    const entities = assignment.modelEntityIds
      .map((id) => this.requireModel(id))
      .filter((model) => this.modelSupportsApp(model, "opencode"));
    if (!entities.length) return {};
    const firstEntity = entities[0];
    const firstModelName = normalizeModelNames(firstEntity.modelNames, firstEntity.model)[0].name;
    const providers = Object.fromEntries(entities.map((model) => [
      `task-handoff-${model.id}`,
      {
        npm: "@ai-sdk/openai-compatible",
        name: model.name,
        options: { baseURL: model.endpoint, apiKey: model.key },
        models: Object.fromEntries(normalizeModelNames(model.modelNames, model.model).map((entry) => [entry.name, { name: model.name, variants: openCodeReasoningVariants() }])),
      },
    ]));
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
    if (modelConfigHash(model) !== model.id) throw Object.assign(new Error(`Stored model ${id} does not match its content hash.`), { statusCode: 409, code: "NODE_MODEL_HASH_INVALID" });
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
    return NodeModelPublicRecordSchema.parse({ ...safe, keyPreview: key.length <= 8 ? "set" : `${key.slice(0, 4)}...${key.slice(-4)}`, keySet: true, referenceCount });
  }

  private nextOrder() {
    return this.models.list().reduce((max, model) => Math.max(max, model.order), 0) + 100;
  }

  private migrateLegacyEnvironments() {
    for (const instanceId of this.legacyEnvironments.listInstanceIds()) {
      if (!this.instances.has(instanceId)) {
        this.warnMigration(instanceId, "instance-not-found");
        continue;
      }
      const existingAssignment = this.assignments.get(instanceId);
      if (existingAssignment) {
        try {
          this.resolvedEnvironment(instanceId);
          this.legacyEnvironments.delete(instanceId);
        } catch {
          this.warnMigration(instanceId, "existing-assignment-invalid");
        }
        continue;
      }
      let environment: Record<string, string>;
      try {
        environment = this.legacyEnvironments.get(instanceId);
      } catch {
        this.warnMigration(instanceId, "sidecar-invalid");
        continue;
      }
      if (!Object.keys(environment).length) {
        this.legacyEnvironments.delete(instanceId);
        continue;
      }
      if (Object.keys(environment).some((key) => !LEGACY_MODEL_ENV_KEYS.has(key))) {
        this.warnMigration(instanceId, "unknown-fields");
        continue;
      }
      const createdModelIds: string[] = [];
      try {
        const codex = this.migrateApp(environment, "codex", createdModelIds);
        const claude = this.migrateApp(environment, "claude", createdModelIds);
        if (!codex && !claude) throw new Error("no complete model configuration");
        const modelEntityIds = [...new Set([codex, claude].filter((id): id is string => Boolean(id)))];
        const modelSelection = { modelEntityIds, ...(codex ? { codexModelHash: codex } : {}), ...(claude ? { claudeModelHash: claude } : {}) };
        this.assign(instanceId, { modelSelection, modelEntityIds, codexModelHash: codex, claudeModelHash: claude });
        this.resolvedEnvironment(instanceId);
        this.legacyEnvironments.delete(instanceId);
      } catch {
        this.assignments.delete(instanceId);
        for (const modelId of createdModelIds) this.models.delete(modelId);
        this.warnMigration(instanceId, "mapping-failed");
      }
    }
  }

  private migrateApp(environment: Record<string, string>, app: "codex" | "claude", createdModelIds: string[]) {
    const key = environment[app === "codex" ? "OPENAI_API_KEY" : "ANTHROPIC_API_KEY"];
    const endpoint = app === "codex" ? environment.TASK_HANDOFF_CODEX_BASE_URL || environment.OPENAI_BASE_URL : environment.ANTHROPIC_BASE_URL;
    const modelName = app === "codex" ? environment.TASK_HANDOFF_CODEX_MODEL || environment.CODEX_MODEL : environment.TASK_HANDOFF_CLAUDE_MODEL || environment.CLAUDE_MODEL;
    if (!key && !endpoint && !modelName) return undefined;
    if (!key || !endpoint || !modelName) throw new Error("model configuration incomplete");
    const modelId = modelConfigHash({ app, endpoint, key, model: modelName });
    const existing = this.models.get(modelId);
    if (existing) {
      if (existing.app !== app || existing.key !== key || existing.endpoint !== endpoint || existing.model !== modelName || !existing.enabled) throw new Error("existing model conflicts with legacy environment");
      return modelId;
    }
    const timestamp = now();
    this.models.put(NodeModelConfigSchema.parse({
      id: modelId,
      name: `Migrated ${app === "codex" ? "Codex" : "Claude"} model`,
      endpoint,
      key,
      model: modelName,
      app,
      enabled: true,
      order: this.nextOrder(),
      labels: { migratedFrom: "instance-model-environment" },
      createdAt: timestamp,
      updatedAt: timestamp,
    }));
    createdModelIds.push(modelId);
    return modelId;
  }

  private warnMigration(instanceId: string, reason: string) {
    console.warn(JSON.stringify({
      message: "legacy model environment was preserved because it could not be migrated",
      nodeId: this.nodeId,
      instanceId,
      reason,
    }));
  }
}

function openCodeReasoningVariants() {
  return Object.fromEntries(["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]
    .map((effort) => [effort, { reasoningEffort: effort }]));
}

function defaultProtocols(app: "codex" | "claude" | "opencode") {
  return app === "claude" ? ["anthropic-messages" as const] : app === "opencode" ? ["openai-chat-completions" as const] : ["openai-responses" as const];
}

function normalizeModelNames(entries: NodeModelConfig["modelNames"] | undefined, legacyModel: string) {
  const source = entries?.length ? entries : [{ name: legacyModel, order: 100 }];
  const names = new Set<string>();
  return source
    .map((entry) => ({ name: entry.name.trim(), order: entry.order }))
    .filter((entry) => {
      if (!entry.name || names.has(entry.name)) return false;
      names.add(entry.name);
      return true;
    })
    .sort((left, right) => left.order - right.order || left.name.localeCompare(right.name))
    .map((entry, index) => ({ name: entry.name, order: (index + 1) * 100 }));
}
