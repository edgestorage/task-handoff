import type { DatabaseSync } from "node:sqlite";
import {
  ControlledInstanceSchema,
  NodeLocalFolderSchema,
  NodeRuntimeSchema,
  sanitizeStoredControlledInstance,
  sanitizeStoredNodeLocalFolder,
  type ControlledInstance,
  type NodeLocalFolder,
  type NodeRuntime,
} from "@task-handoff/protocol/control-plane";

type Row = Record<string, unknown>;

const observationFields = [
  "health", "connectionStatus", "agentStatus", "targetStatus", "uiAccessStatus", "ready",
  "protocolVersion", "instanceVersion", "build", "runtimeVersion", "capabilities", "appInventory",
  "target", "access", "apps", "aiSessions", "triggers", "runtime", "lastHeartbeatAt",
] as const satisfies readonly (keyof ControlledInstance)[];

function json(value: unknown) {
  return JSON.stringify(value ?? null);
}

function parseJson<T>(value: unknown): T {
  return JSON.parse(String(value)) as T;
}

function runImmediate<T>(client: DatabaseSync, operation: () => T): T {
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
}

export class NodeIdentityRepository {
  private readonly client: DatabaseSync;
  constructor(client: DatabaseSync) { this.client = client; }

  get() {
    return this.client.prepare("SELECT node_id, created_at, updated_at FROM na_node_identity WHERE singleton_key = 1").get() as {
      node_id: string; created_at: string; updated_at: string;
    } | undefined;
  }

  ensure(nodeId: string, timestamp: string) {
    const current = this.get();
    if (current && current.node_id !== nodeId) {
      throw persistenceError("NODE_AGENT_IDENTITY_MISMATCH", `Stored node identity ${current.node_id} does not match ${nodeId}.`);
    }
    if (!current) {
      this.client.prepare("INSERT INTO na_node_identity (singleton_key, node_id, created_at, updated_at) VALUES (1, ?, ?, ?)").run(nodeId, timestamp, timestamp);
    }
    return this.get()!;
  }
}

export class LocalFolderRepository {
  private readonly client: DatabaseSync;
  constructor(client: DatabaseSync) { this.client = client; }

  list(): NodeLocalFolder[] {
    return (this.client.prepare("SELECT * FROM na_local_folders ORDER BY id").all() as Row[]).map(folderFromRow);
  }

  get(id: string): NodeLocalFolder | undefined {
    const row = this.client.prepare("SELECT * FROM na_local_folders WHERE id = ?").get(id) as Row | undefined;
    return row ? folderFromRow(row) : undefined;
  }

  put(input: NodeLocalFolder): NodeLocalFolder {
    const value = NodeLocalFolderSchema.parse(sanitizeStoredNodeLocalFolder(input));
    this.client.prepare(`INSERT INTO na_local_folders (id, node_id, name, path, labels_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET node_id=excluded.node_id, name=excluded.name, path=excluded.path,
        labels_json=excluded.labels_json, updated_at=excluded.updated_at`)
      .run(value.id, value.nodeId, value.name, value.path, json(value.labels), value.createdAt, value.updatedAt);
    return value;
  }

  delete(id: string) {
    return Number(this.client.prepare("DELETE FROM na_local_folders WHERE id = ?").run(id).changes) > 0;
  }
}

export class RuntimeRepository {
  private readonly client: DatabaseSync;
  constructor(client: DatabaseSync) { this.client = client; }

  list(): NodeRuntime[] {
    return (this.client.prepare("SELECT * FROM na_runtimes ORDER BY id").all() as Row[]).map(runtimeFromRow);
  }

  get(id: string): NodeRuntime | undefined {
    const row = this.client.prepare("SELECT * FROM na_runtimes WHERE id = ?").get(id) as Row | undefined;
    return row ? runtimeFromRow(row) : undefined;
  }

  put(input: NodeRuntime): NodeRuntime {
    const value = NodeRuntimeSchema.parse(input);
    this.client.prepare(`INSERT INTO na_runtimes (id, node_id, name, type, status, access_strategy, capabilities_json, labels_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET node_id=excluded.node_id, name=excluded.name, type=excluded.type,
        status=excluded.status, access_strategy=excluded.access_strategy, capabilities_json=excluded.capabilities_json,
        labels_json=excluded.labels_json, updated_at=excluded.updated_at`)
      .run(value.id, value.nodeId, value.name, value.type, value.status, value.accessStrategy, json(value.capabilities), json(value.labels), value.createdAt, value.updatedAt);
    return value;
  }

  delete(id: string) {
    try {
      return Number(this.client.prepare("DELETE FROM na_runtimes WHERE id = ?").run(id).changes) > 0;
    } catch (error) {
      if (String(error).includes("FOREIGN KEY constraint failed")) {
        throw persistenceError("NODE_RUNTIME_IN_USE", `Runtime ${id} is used by a controlled instance.`, 409);
      }
      throw error;
    }
  }
}

export class InstanceRepository {
  private readonly client: DatabaseSync;
  constructor(client: DatabaseSync) { this.client = client; }

  list(): ControlledInstance[] {
    return (this.client.prepare(`SELECT i.*, o.health, o.connection_status, o.ready, o.observed_json,
      o.last_heartbeat_at, o.updated_at AS observation_updated_at
      FROM na_instances i LEFT JOIN na_instance_observations o ON o.instance_id = i.id ORDER BY i.id`).all() as Row[])
      .map((row) => instanceFromRow(this.client, row));
  }

  get(id: string): ControlledInstance | undefined {
    const row = this.client.prepare(`SELECT i.*, o.health, o.connection_status, o.ready, o.observed_json,
      o.last_heartbeat_at, o.updated_at AS observation_updated_at
      FROM na_instances i LEFT JOIN na_instance_observations o ON o.instance_id = i.id WHERE i.id = ?`).get(id) as Row | undefined;
    return row ? instanceFromRow(this.client, row) : undefined;
  }

  put(input: ControlledInstance): ControlledInstance {
    const parsed = ControlledInstanceSchema.parse(sanitizeStoredControlledInstance(input));
    return runImmediate(this.client, () => {
      const current = this.client.prepare("SELECT state_revision, registration_credential FROM na_instances WHERE id = ?").get(parsed.id) as Row | undefined;
      const stateRevision = Math.max(parsed.stateRevision || 0, Number(current?.state_revision) || 0) + 1;
      const registrationCredential = parsed.registrationToken || (current?.registration_credential as string | undefined);
      const desired = desiredProjection({ ...parsed, stateRevision });
      const observed = observationProjection(parsed);
      const sourceLocalFolderId = parsed.source.type === "local-folder" ? parsed.source.localFolderId : undefined;
      this.client.prepare(`INSERT INTO na_instances
        (id, node_id, runtime_id, source_local_folder_id, name, status, state_revision, process_incarnation_id,
         registration_credential, desired_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET node_id=excluded.node_id, runtime_id=excluded.runtime_id,
          source_local_folder_id=excluded.source_local_folder_id, name=excluded.name, status=excluded.status,
          state_revision=excluded.state_revision, process_incarnation_id=excluded.process_incarnation_id,
          registration_credential=excluded.registration_credential, desired_json=excluded.desired_json,
          updated_at=excluded.updated_at`)
        .run(parsed.id, parsed.nodeId, parsed.runtimeId, sourceLocalFolderId ?? null, parsed.name, parsed.status, stateRevision,
          parsed.processIncarnationId ?? null, registrationCredential ?? null, json(desired), parsed.createdAt, parsed.updatedAt);
      this.client.prepare(`INSERT INTO na_instance_observations
        (instance_id, health, connection_status, ready, observed_json, last_heartbeat_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(instance_id) DO UPDATE SET health=excluded.health, connection_status=excluded.connection_status,
          ready=excluded.ready, observed_json=excluded.observed_json, last_heartbeat_at=excluded.last_heartbeat_at,
          updated_at=excluded.updated_at`)
        .run(parsed.id, parsed.health, parsed.connectionStatus, parsed.ready ? 1 : 0, json(observed), parsed.lastHeartbeatAt ?? null, parsed.updatedAt);
      return this.get(parsed.id)!;
    });
  }

  putObservation(input: ControlledInstance): ControlledInstance {
    const parsed = ControlledInstanceSchema.parse(sanitizeStoredControlledInstance(input));
    return runImmediate(this.client, () => {
      const current = this.client.prepare("SELECT state_revision, registration_credential FROM na_instances WHERE id = ?").get(parsed.id) as Row | undefined;
      if (!current) throw persistenceError("NODE_INSTANCE_NOT_FOUND", `Instance ${parsed.id} was not found.`, 404);
      const stateRevision = Math.max(parsed.stateRevision || 0, Number(current.state_revision) || 0) + 1;
      const registrationCredential = parsed.registrationToken || (current.registration_credential as string | undefined);
      this.client.prepare(`UPDATE na_instances SET status = ?, state_revision = ?, process_incarnation_id = ?,
        registration_credential = ?, updated_at = ? WHERE id = ?`)
        .run(parsed.status, stateRevision, parsed.processIncarnationId ?? null, registrationCredential ?? null, parsed.updatedAt, parsed.id);
      this.client.prepare(`INSERT INTO na_instance_observations
        (instance_id, health, connection_status, ready, observed_json, last_heartbeat_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(instance_id) DO UPDATE SET health=excluded.health, connection_status=excluded.connection_status,
          ready=excluded.ready, observed_json=excluded.observed_json, last_heartbeat_at=excluded.last_heartbeat_at,
          updated_at=excluded.updated_at`)
        .run(parsed.id, parsed.health, parsed.connectionStatus, parsed.ready ? 1 : 0, json(observationProjection(parsed)), parsed.lastHeartbeatAt ?? null, parsed.updatedAt);
      return this.get(parsed.id)!;
    });
  }

  delete(id: string) {
    return Number(this.client.prepare("DELETE FROM na_instances WHERE id = ?").run(id).changes) > 0;
  }
}

export function createTopologyRepositories(client: DatabaseSync) {
  return {
    nodeIdentity: new NodeIdentityRepository(client),
    localFolders: new LocalFolderRepository(client),
    runtimes: new RuntimeRepository(client),
    instances: new InstanceRepository(client),
  };
}

function desiredProjection(instance: ControlledInstance) {
  const result = { ...instance } as Record<string, unknown>;
  for (const field of observationFields) delete result[field];
  for (const field of ["id", "nodeId", "runtimeId", "name", "status", "stateRevision", "processIncarnationId", "registrationToken", "createdAt", "updatedAt"]) delete result[field];
  return result;
}

function observationProjection(instance: ControlledInstance) {
  return Object.fromEntries(observationFields.flatMap((field) => instance[field] === undefined ? [] : [[field, instance[field]]]));
}

function folderFromRow(row: Row): NodeLocalFolder {
  return NodeLocalFolderSchema.parse({
    id: row.id, nodeId: row.node_id, name: row.name, path: row.path,
    labels: parseJson(row.labels_json), createdAt: row.created_at, updatedAt: row.updated_at,
  });
}

function runtimeFromRow(row: Row): NodeRuntime {
  return NodeRuntimeSchema.parse({
    id: row.id, nodeId: row.node_id, name: row.name, type: row.type, status: row.status,
    accessStrategy: row.access_strategy, capabilities: parseJson(row.capabilities_json), labels: parseJson(row.labels_json),
    createdAt: row.created_at, updatedAt: row.updated_at,
  });
}

function instanceFromRow(client: DatabaseSync, row: Row): ControlledInstance {
  const desired = parseJson<Record<string, unknown>>(row.desired_json);
  const observed = row.observed_json ? parseJson<Record<string, unknown>>(row.observed_json) : {};
  const assignment = client.prepare("SELECT * FROM na_instance_model_assignments WHERE instance_id = ?").get(String(row.id)) as Row | undefined;
  const modelEntityIds = assignment
    ? (client.prepare("SELECT model_id FROM na_instance_model_entities WHERE instance_id = ? ORDER BY display_order").all(String(row.id)) as Row[]).map((member) => String(member.model_id))
    : undefined;
  const modelSelection = assignment ? {
    modelEntityIds,
    ...(assignment.legacy_codex_model_id ? { codexModelHash: String(assignment.legacy_codex_model_id) } : {}),
    ...(assignment.legacy_claude_model_id ? { claudeModelHash: String(assignment.legacy_claude_model_id) } : {}),
    ...(assignment.legacy_opencode_model_id ? { opencodeModelHash: String(assignment.legacy_opencode_model_id) } : {}),
  } : desired.modelSelection;
  return ControlledInstanceSchema.parse({
    ...desired,
    ...observed,
    modelSelection,
    id: row.id,
    nodeId: row.node_id,
    runtimeId: row.runtime_id,
    name: row.name,
    status: row.status,
    stateRevision: row.state_revision,
    processIncarnationId: row.process_incarnation_id || undefined,
    registrationToken: row.registration_credential || undefined,
    health: row.health || "unknown",
    connectionStatus: row.connection_status || "unknown",
    ready: Boolean(row.ready),
    lastHeartbeatAt: row.last_heartbeat_at || undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

function persistenceError(code: string, message: string, statusCode = 409) {
  return Object.assign(new Error(message), { code, statusCode });
}
