import { ModelConfigSchema, type ModelConfig } from "@task-handoff/protocol/control-plane";
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
      keyCiphertext: this.secrets.seal(key, secretContext(model.id)),
    };
  }

  private fromRecord(record: ModelRecord) {
    const { keyCiphertext, ...metadata } = record;
    return ModelConfigSchema.parse({
      ...metadata,
      key: this.secrets.open(keyCiphertext, secretContext(record.id)),
    });
  }
}
