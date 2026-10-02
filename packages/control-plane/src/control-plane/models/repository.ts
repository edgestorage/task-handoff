import {
  ModelConfigSchema,
  normalizeModelNameEntries,
  normalizeModelRequestMappings,
  projectModelNameEntries,
  sanitizeModelNameEntries,
  sanitizeModelRequestMappings,
  type ModelConfig,
} from "@task-handoff/protocol/control-plane";
import type { ControlPlaneDatabase } from "../persistence/database/index.ts";
import type { ModelRecord } from "../persistence/database/p0-records.ts";
import type { SecretEnvelopeService } from "../persistence/secret-envelope.ts";

function secretContext(modelId: string) {
  return `model:${modelId}:key`;
}

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

  listLegacyProjections() {
    return this.database.modelLegacyProjections.list();
  }

  async putLegacyProjection(projectionId: string, modelId: string) {
    const existing = await this.database.modelLegacyProjections.get(projectionId);
    const timestamp = new Date().toISOString();
    await this.database.modelLegacyProjections.put({
      id: projectionId,
      modelId,
      createdAt: existing?.createdAt || timestamp,
      updatedAt: timestamp,
    });
  }

  async deleteLegacyProjections(projectionIds: string[]) {
    for (const projectionId of projectionIds) await this.database.modelLegacyProjections.delete(projectionId);
  }

  delete(id: string) {
    return this.database.models.delete(id);
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
}
