import {
  ModelConfigSchema,
  normalizeModelNameEntries,
  normalizeModelRequestMappings,
  projectModelNameEntries,
  sanitizeModelNameEntries,
  sanitizeModelRequestMappings,
  UpdateModelInputSchema,
  type ModelConfig,
} from "@task-handoff/protocol/control-plane";
import type { z } from "zod";
import type { ControlPlaneDatabase } from "../persistence/database/index.ts";
import type { ModelPendingNodeEditRecord, ModelRecord } from "../persistence/database/p0-records.ts";
import type { SecretEnvelopeService } from "../persistence/secret-envelope.ts";

function secretContext(modelId: string) {
  return `model:${modelId}:key`;
}

function pendingNodeEditId(modelId: string, nodeId: string) {
  return `${modelId}\u001f${nodeId}`;
}

function pendingNodeEditSecretContext(modelId: string, nodeId: string) {
  return `model:${modelId}:pending-node-edit:${nodeId}`;
}

type ModelUpdatePatch = z.infer<typeof UpdateModelInputSchema>;

export type PendingNodeOwnedEdit = {
  modelId: string;
  nodeId: string;
  patch: ModelUpdatePatch;
  updatedAt: string;
  // Opaque optimistic token for compare-and-delete. It is the sealed envelope,
  // so a newer write to the same model and node naturally invalidates it.
  token: string;
};

export class ControlPlaneModelRepository {
  private readonly database: ControlPlaneDatabase;
  private readonly secrets: SecretEnvelopeService;

  constructor(database: ControlPlaneDatabase, secrets: SecretEnvelopeService) {
    this.database = database;
    this.secrets = secrets;
  }

  async list() {
    return Promise.all((await this.database.models.list()).map((record) => this.fromRecord(record)));
  }

  async get(id: string) {
    const record = await this.database.models.get(id);
    return record ? this.fromRecord(record) : undefined;
  }

  async put(input: ModelConfig) {
    const model = ModelConfigSchema.parse(input);
    await this.database.models.put(this.toRecord(model));
    return model;
  }

  delete(id: string) {
    return this.database.models.delete(id);
  }

  async listPendingNodeEdits(): Promise<PendingNodeOwnedEdit[]> {
    return Promise.all((await this.database.modelPendingNodeEdits.list()).map((record) => this.pendingNodeEditFromRecord(record)));
  }

  async putPendingNodeEdit(input: { modelId: string; nodeId: string; patch: ModelUpdatePatch; updatedAt: string }): Promise<PendingNodeOwnedEdit> {
    const validated = UpdateModelInputSchema.parse(input.patch);
    // PATCH semantics are key-based; the create schema's defaults must not
    // become persisted fields that the caller never sent.
    const patch = Object.fromEntries(Object.entries(validated).filter(([field]) => Object.hasOwn(input.patch, field))) as ModelUpdatePatch;
    const record: ModelPendingNodeEditRecord = {
      id: pendingNodeEditId(input.modelId, input.nodeId),
      modelId: input.modelId,
      nodeId: input.nodeId,
      patchCiphertext: this.secrets.seal(JSON.stringify(patch), pendingNodeEditSecretContext(input.modelId, input.nodeId)),
      updatedAt: input.updatedAt,
    };
    const stored = await this.database.modelPendingNodeEdits.put(record);
    return this.pendingNodeEditFromRecord(stored);
  }

  async deletePendingNodeEdit(modelId: string, nodeId: string) {
    return this.database.modelPendingNodeEdits.delete(modelId, nodeId);
  }

  async deletePendingNodeEditIfCurrent(modelId: string, nodeId: string, token: string) {
    return this.database.modelPendingNodeEdits.deleteIfCiphertext(modelId, nodeId, token);
  }

  deletePendingNodeEditsForNode(nodeId: string) {
    return this.database.modelPendingNodeEdits.deleteForNode(nodeId);
  }

  transaction<T>(operation: (repository: ControlPlaneModelRepository) => Promise<T>) {
    return this.database.transaction((database) => operation(new ControlPlaneModelRepository(database, this.secrets)));
  }

  private toRecord(model: ModelConfig): ModelRecord {
    const { key, ...metadata } = model;
    return {
      ...metadata,
      modelNames: projectModelNameEntries(model.modelNames),
      mappings: normalizeModelRequestMappings(model.mappings),
      keyCiphertext: this.secrets.seal(key, secretContext(model.id)),
    };
  }

  private fromRecord(record: ModelRecord) {
    const { keyCiphertext, ...metadata } = record;
    const parsed = ModelConfigSchema.parse({
      ...metadata,
      modelNames: sanitizeModelNameEntries(metadata.modelNames, (warning) => {
        console.warn(JSON.stringify({ message: "unknown stored control plane model name entry field was ignored", modelId: record.id, field: warning.field }));
      }),
      mappings: sanitizeModelRequestMappings(metadata.mappings, (warning) => {
        console.warn(JSON.stringify({ message: "unknown stored control plane model request mapping field was ignored", modelId: record.id, field: warning.field }));
      }),
      key: this.secrets.open(keyCiphertext, secretContext(record.id)),
    });
    // Read path: normalize upstreamName without rewriting stored order values.
    return {
      ...parsed,
      modelNames: normalizeModelNameEntries(parsed.modelNames, parsed.model, { renumber: false }),
      mappings: normalizeModelRequestMappings(parsed.mappings, { renumber: false }),
    };
  }

  private pendingNodeEditFromRecord(record: ModelPendingNodeEditRecord): PendingNodeOwnedEdit {
    const raw = JSON.parse(this.secrets.open(record.patchCiphertext, pendingNodeEditSecretContext(record.modelId, record.nodeId))) as unknown;
    const parsed = UpdateModelInputSchema.parse(raw);
    const patch = raw && typeof raw === "object" && !Array.isArray(raw)
      ? Object.fromEntries(Object.entries(parsed).filter(([field]) => Object.hasOwn(raw, field))) as ModelUpdatePatch
      : parsed;
    return {
      modelId: record.modelId,
      nodeId: record.nodeId,
      patch,
      updatedAt: record.updatedAt,
      token: record.patchCiphertext,
    };
  }
}
