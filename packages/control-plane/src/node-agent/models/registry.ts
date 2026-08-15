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

type InstanceAccess = {
  has(id: string): boolean;
  list(): ControlledInstance[];
  require(id: string): ControlledInstance;
  put(instance: ControlledInstance): ControlledInstance;
};

function now() {
  return new Date().toISOString();
}

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
      for (const modelHash of [assignment?.codexModelHash, assignment?.claudeModelHash]) {
        if (modelHash) referenceCounts.set(modelHash, (referenceCounts.get(modelHash) || 0) + 1);
      }
    }
    return this.models.list().map((model) => this.toPublic(model, referenceCounts.get(model.id) || 0));
  }

  create(input: z.infer<typeof CreateNodeModelSchema>) {
    const timestamp = now();
    const id = modelConfigHash(input);
    const current = this.models.get(id);
    const model = NodeModelConfigSchema.parse({
      ...input,
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
    const stored = this.models.get(input.id) || this.models.put(NodeModelConfigSchema.parse(input));
    return this.toPublic(stored, this.referenceIds(stored.id).length);
  }

  update(id: string, input: z.infer<typeof UpdateNodeModelSchema>) {
    const current = this.requireModel(id);
    const candidate = NodeModelConfigSchema.parse({
      ...current,
      ...input,
      key: input.key?.trim() ? input.key : current.key,
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
    this.validateRef("codex", input.codexModelHash);
    this.validateRef("claude", input.claudeModelHash);
    if (input.modelSelection.codexModelHash !== undefined && (input.modelSelection.codexModelHash ?? undefined) !== input.codexModelHash) {
      throw Object.assign(new Error("Codex model selection does not match its node assignment."), { statusCode: 400, code: "NODE_MODEL_SELECTION_MISMATCH" });
    }
    if (input.modelSelection.claudeModelHash !== undefined && (input.modelSelection.claudeModelHash ?? undefined) !== input.claudeModelHash) {
      throw Object.assign(new Error("Claude model selection does not match its node assignment."), { statusCode: 400, code: "NODE_MODEL_SELECTION_MISMATCH" });
    }
    const previous = this.assignments.get(instanceId);
    const assignment = NodeModelAssignmentSchema.parse({ instanceId, codexModelHash: input.codexModelHash, claudeModelHash: input.claudeModelHash, updatedAt: now() });
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
    return {
      ...this.environmentForRef("codex", assignment.codexModelHash),
      ...this.environmentForRef("claude", assignment.claudeModelHash),
    };
  }

  deleteInstanceMetadata(instanceId: string) {
    this.assignments.delete(instanceId);
    this.legacyEnvironments.delete(instanceId);
  }

  private validateRef(app: "codex" | "claude", modelHash?: string) {
    if (!modelHash) return;
    const model = this.requireModel(modelHash);
    if (model.app !== app) throw Object.assign(new Error(`Model ${model.id} belongs to ${model.app}, not ${app}.`), { statusCode: 400, code: "NODE_MODEL_APP_MISMATCH" });
    if (!model.enabled) throw Object.assign(new Error(`Model ${model.id} is disabled.`), { statusCode: 409, code: "NODE_MODEL_DISABLED" });
  }

  private environmentForRef(app: "codex" | "claude", modelHash?: string) {
    if (!modelHash) return {};
    this.validateRef(app, modelHash);
    const model = this.requireModel(modelHash);
    return app === "codex" ? {
      OPENAI_API_KEY: model.key,
      OPENAI_BASE_URL: model.endpoint,
      TASK_HANDOFF_CODEX_BASE_URL: model.endpoint,
      TASK_HANDOFF_CODEX_MODEL: model.model,
    } : {
      ANTHROPIC_API_KEY: model.key,
      ANTHROPIC_BASE_URL: model.endpoint,
      TASK_HANDOFF_CLAUDE_MODEL: model.model,
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
      return assignment?.codexModelHash === modelId || assignment?.claudeModelHash === modelId;
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
        const modelSelection = { ...(codex ? { codexModelHash: codex } : {}), ...(claude ? { claudeModelHash: claude } : {}) };
        this.assign(instanceId, { modelSelection, codexModelHash: codex, claudeModelHash: claude });
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
