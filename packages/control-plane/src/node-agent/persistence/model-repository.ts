import type { DatabaseSync } from "node:sqlite";
import {
  NodeModelAssignmentSchema,
  NodeModelConfigSchema,
  type NodeModelAssignment,
  type NodeModelConfig,
} from "@task-handoff/protocol/control-plane";

type Row = Record<string, unknown>;

function json(value: unknown) { return JSON.stringify(value ?? null); }
function parseJson<T>(value: unknown): T { return JSON.parse(String(value)) as T; }

export class ModelRepository {
  private readonly client: DatabaseSync;
  constructor(client: DatabaseSync) { this.client = client; }

  list(): NodeModelConfig[] {
    return (this.client.prepare("SELECT * FROM na_models ORDER BY display_order, id").all() as Row[]).map(modelFromRow);
  }

  get(id: string): NodeModelConfig | undefined {
    const row = this.client.prepare("SELECT * FROM na_models WHERE id = ?").get(id) as Row | undefined;
    return row ? modelFromRow(row) : undefined;
  }

  put(input: NodeModelConfig): NodeModelConfig {
    const value = NodeModelConfigSchema.parse(input);
    this.client.prepare(`INSERT INTO na_models
      (id, name, endpoint, key, model, app, enabled, display_order, model_names_json, protocols_json, labels_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET name=excluded.name, endpoint=excluded.endpoint, key=excluded.key,
        model=excluded.model, app=excluded.app, enabled=excluded.enabled, display_order=excluded.display_order,
        model_names_json=excluded.model_names_json, protocols_json=excluded.protocols_json,
        labels_json=excluded.labels_json, updated_at=excluded.updated_at`)
      .run(value.id, value.name, value.endpoint, value.key, value.model, value.app, value.enabled ? 1 : 0, value.order,
        json(value.modelNames), json(value.protocols), json(value.labels), value.createdAt, value.updatedAt);
    return value;
  }

  delete(id: string) {
    try {
      return Number(this.client.prepare("DELETE FROM na_models WHERE id = ?").run(id).changes) > 0;
    } catch (error) {
      if (String(error).includes("FOREIGN KEY constraint failed")) {
        const instanceIds = this.referenceIds(id);
        throw Object.assign(new Error(`Model ${id} is assigned to ${instanceIds.length} instance${instanceIds.length === 1 ? "" : "s"}.`), {
          statusCode: 409, code: "NODE_MODEL_IN_USE", instanceIds,
        });
      }
      throw error;
    }
  }

  referenceIds(id: string) {
    return (this.client.prepare(`SELECT DISTINCT instance_id FROM (
      SELECT instance_id FROM na_instance_model_entities WHERE model_id = ?
      UNION ALL SELECT instance_id FROM na_instance_model_assignments WHERE legacy_codex_model_id = ?
      UNION ALL SELECT instance_id FROM na_instance_model_assignments WHERE legacy_claude_model_id = ?
      UNION ALL SELECT instance_id FROM na_instance_model_assignments WHERE legacy_opencode_model_id = ?
    ) ORDER BY instance_id`).all(id, id, id, id) as Row[]).map((row) => String(row.instance_id));
  }
}

export class ModelAssignmentRepository {
  private readonly client: DatabaseSync;
  constructor(client: DatabaseSync) { this.client = client; }

  get(instanceId: string): NodeModelAssignment | undefined {
    const row = this.client.prepare("SELECT * FROM na_instance_model_assignments WHERE instance_id = ?").get(instanceId) as Row | undefined;
    if (!row) return undefined;
    const modelEntityIds = (this.client.prepare("SELECT model_id FROM na_instance_model_entities WHERE instance_id = ? ORDER BY display_order").all(instanceId) as Row[])
      .map((member) => String(member.model_id));
    return NodeModelAssignmentSchema.parse({
      instanceId,
      modelEntityIds,
      codexModelHash: row.legacy_codex_model_id || undefined,
      claudeModelHash: row.legacy_claude_model_id || undefined,
      opencodeModelHash: row.legacy_opencode_model_id || undefined,
      updatedAt: row.updated_at,
    });
  }

  put(input: NodeModelAssignment): NodeModelAssignment {
    const value = NodeModelAssignmentSchema.parse(input);
    this.transaction(() => {
      this.client.prepare(`INSERT INTO na_instance_model_assignments
        (instance_id, legacy_codex_model_id, legacy_claude_model_id, legacy_opencode_model_id, updated_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(instance_id) DO UPDATE SET legacy_codex_model_id=excluded.legacy_codex_model_id,
          legacy_claude_model_id=excluded.legacy_claude_model_id,
          legacy_opencode_model_id=excluded.legacy_opencode_model_id, updated_at=excluded.updated_at`)
        .run(value.instanceId, value.codexModelHash ?? null, value.claudeModelHash ?? null, value.opencodeModelHash ?? null, value.updatedAt);
      this.client.prepare("DELETE FROM na_instance_model_entities WHERE instance_id = ?").run(value.instanceId);
      const insert = this.client.prepare("INSERT INTO na_instance_model_entities (instance_id, model_id, display_order) VALUES (?, ?, ?)");
      for (const [displayOrder, modelId] of value.modelEntityIds.entries()) insert.run(value.instanceId, modelId, displayOrder);
    });
    return this.get(value.instanceId)!;
  }

  delete(instanceId: string) {
    return Number(this.client.prepare("DELETE FROM na_instance_model_assignments WHERE instance_id = ?").run(instanceId).changes) > 0;
  }

  private transaction<T>(operation: () => T): T {
    if ((this.client as DatabaseSync & { isTransaction?: boolean }).isTransaction) return operation();
    this.client.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.client.exec("COMMIT");
      return result;
    } catch (error) {
      this.client.exec("ROLLBACK");
      throw error;
    }
  }
}

export function createModelRepositories(client: DatabaseSync) {
  return {
    models: new ModelRepository(client),
    assignments: new ModelAssignmentRepository(client),
    transaction<T>(operation: () => T): T {
      if ((client as DatabaseSync & { isTransaction?: boolean }).isTransaction) return operation();
      client.exec("BEGIN IMMEDIATE");
      try {
        const result = operation();
        client.exec("COMMIT");
        return result;
      } catch (error) {
        client.exec("ROLLBACK");
        throw error;
      }
    },
  };
}

function modelFromRow(row: Row): NodeModelConfig {
  const modelNames = parseJson<Array<{ name: string; order: number }>>(row.model_names_json);
  return NodeModelConfigSchema.parse({
    id: row.id,
    name: row.name,
    endpoint: row.endpoint,
    key: row.key,
    model: row.model,
    modelNames,
    protocols: parseJson(row.protocols_json),
    app: row.app,
    enabled: Boolean(row.enabled),
    order: row.display_order,
    labels: parseJson(row.labels_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}
