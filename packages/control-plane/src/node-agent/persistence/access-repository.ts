import type { DatabaseSync } from "node:sqlite";
import type { NodeAgentIdentity } from "../identity/types.ts";

type Row = Record<string, unknown>;

export type ControlPlaneConnectionOperation = {
  id: string;
  kind: string;
  phase: "prepared" | "remote-accepted" | "committed" | "failed";
  requested: Record<string, unknown>;
  pairingKeyId?: string;
  connectionId?: string;
  replacedConnections: Array<Record<string, unknown>>;
  error?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

export class AccessRepository {
  private readonly client: DatabaseSync;
  constructor(client: DatabaseSync) { this.client = client; }

  readIdentity(): NodeAgentIdentity | undefined {
    const identity = this.client.prepare("SELECT node_id, created_at, updated_at FROM na_node_identity WHERE singleton_key = 1").get() as Row | undefined;
    if (!identity) return undefined;
    const controlPlanePairings = (this.client.prepare("SELECT * FROM na_control_plane_pairings ORDER BY updated_at, key_id").all() as Row[]).map((row) => ({
      id: String(row.control_plane_id),
      keyId: String(row.key_id),
      ...(row.name ? { name: String(row.name) } : {}),
      secret: String(row.secret),
      pairedAt: String(row.paired_at),
      ...(row.revoked_at ? { revokedAt: String(row.revoked_at) } : {}),
      updatedAt: String(row.updated_at),
    }));
    const controlPlaneConnections = (this.client.prepare("SELECT * FROM na_control_plane_connections ORDER BY updated_at, id").all() as Row[]).map((row) => ({
      id: String(row.id),
      pairingKeyId: String(row.pairing_key_id),
      ...(row.name ? { name: String(row.name) } : {}),
      url: String(row.normalized_url),
      enabled: Boolean(row.enabled),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    }));
    return {
      nodeId: String(identity.node_id),
      createdAt: String(identity.created_at),
      updatedAt: String(identity.updated_at),
      controlPlanePairings,
      controlPlaneConnections,
    };
  }

  writeIdentity(identity: NodeAgentIdentity): NodeAgentIdentity {
    return this.transaction(() => {
      const current = this.readIdentity();
      if (current && current.nodeId !== identity.nodeId) {
        throw accessError("NODE_AGENT_IDENTITY_MISMATCH", `Stored node identity ${current.nodeId} does not match ${identity.nodeId}.`);
      }
      this.client.prepare(`INSERT INTO na_node_identity (singleton_key, node_id, created_at, updated_at) VALUES (1, ?, ?, ?)
        ON CONFLICT(singleton_key) DO UPDATE SET updated_at=excluded.updated_at`)
        .run(identity.nodeId, identity.createdAt, identity.updatedAt);

      const pairingIds = (identity.controlPlanePairings || []).map((pairing) => pairing.keyId);
      const connectionIds = (identity.controlPlaneConnections || []).map((connection) => connection.id);
      deleteExcept(this.client, "na_control_plane_connections", "id", connectionIds);
      deleteExcept(this.client, "na_control_plane_pairings", "key_id", pairingIds);

      const pairingUpsert = this.client.prepare(`INSERT INTO na_control_plane_pairings
        (key_id, control_plane_id, name, secret, paired_at, revoked_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(key_id) DO UPDATE SET control_plane_id=excluded.control_plane_id, name=excluded.name,
          secret=excluded.secret, paired_at=excluded.paired_at, revoked_at=excluded.revoked_at, updated_at=excluded.updated_at`);
      for (const pairing of identity.controlPlanePairings || []) {
        pairingUpsert.run(pairing.keyId, pairing.id, pairing.name ?? null, pairing.secret, pairing.pairedAt, pairing.revokedAt ?? null, pairing.updatedAt);
      }

      const connectionUpsert = this.client.prepare(`INSERT INTO na_control_plane_connections
        (id, pairing_key_id, name, normalized_url, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET pairing_key_id=excluded.pairing_key_id, name=excluded.name,
          normalized_url=excluded.normalized_url, enabled=excluded.enabled, updated_at=excluded.updated_at`);
      for (const connection of identity.controlPlaneConnections || []) {
        connectionUpsert.run(connection.id, connection.pairingKeyId, connection.name ?? null,
          normalizeControlPlaneUrl(connection.url), connection.enabled ? 1 : 0, connection.createdAt, connection.updatedAt);
      }
      return this.readIdentity()!;
    });
  }

  listOperations(phases?: ControlPlaneConnectionOperation["phase"][]) {
    const rows = phases?.length
      ? this.client.prepare(`SELECT * FROM na_control_plane_connection_operations WHERE phase IN (${phases.map(() => "?").join(",")}) ORDER BY created_at`).all(...phases)
      : this.client.prepare("SELECT * FROM na_control_plane_connection_operations ORDER BY created_at").all();
    return (rows as Row[]).map(operationFromRow);
  }

  putOperation(value: ControlPlaneConnectionOperation) {
    this.client.prepare(`INSERT INTO na_control_plane_connection_operations
      (id, kind, phase, requested_json, pairing_key_id, connection_id, replaced_connections_json, error_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET phase=excluded.phase, pairing_key_id=excluded.pairing_key_id,
        connection_id=excluded.connection_id, replaced_connections_json=excluded.replaced_connections_json,
        error_json=excluded.error_json, updated_at=excluded.updated_at`)
      .run(value.id, value.kind, value.phase, JSON.stringify(value.requested), value.pairingKeyId ?? null,
        value.connectionId ?? null, JSON.stringify(value.replacedConnections), value.error ? JSON.stringify(value.error) : null,
        value.createdAt, value.updatedAt);
    return value;
  }

  deleteOperation(id: string) {
    return Number(this.client.prepare("DELETE FROM na_control_plane_connection_operations WHERE id = ?").run(id).changes) > 0;
  }

  transaction<T>(operation: () => T): T {
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

export function normalizeControlPlaneUrl(value: string) {
  return new URL(value).toString().replace(/\/$/, "");
}

function deleteExcept(client: DatabaseSync, table: string, column: string, ids: string[]) {
  if (!ids.length) client.exec(`DELETE FROM ${table}`);
  else client.prepare(`DELETE FROM ${table} WHERE ${column} NOT IN (${ids.map(() => "?").join(",")})`).run(...ids);
}

function operationFromRow(row: Row): ControlPlaneConnectionOperation {
  return {
    id: String(row.id), kind: String(row.kind), phase: row.phase as ControlPlaneConnectionOperation["phase"],
    requested: JSON.parse(String(row.requested_json)),
    ...(row.pairing_key_id ? { pairingKeyId: String(row.pairing_key_id) } : {}),
    ...(row.connection_id ? { connectionId: String(row.connection_id) } : {}),
    replacedConnections: JSON.parse(String(row.replaced_connections_json)),
    ...(row.error_json ? { error: JSON.parse(String(row.error_json)) } : {}),
    createdAt: String(row.created_at), updatedAt: String(row.updated_at),
  };
}

function accessError(code: string, message: string) {
  return Object.assign(new Error(message), { code, statusCode: 409 });
}
