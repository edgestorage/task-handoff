import type { DatabaseSync } from "node:sqlite";
import {
  GitWorkspaceProvisioningInputSchema,
  NodeGitCredentialAuthorizationSetSchema,
  NodeGitCredentialPayloadSchema,
  type GitWorkspaceProvisioningInput,
  type NodeGitCredentialAuthorizationSet,
  type NodeGitCredentialPayload,
} from "@task-handoff/protocol/managed-git-credentials";

type Row = Record<string, unknown>;
export type GitPayloadRecord = { id: string; payload: NodeGitCredentialPayload; createdAt: string; updatedAt: string };
export type GitAuthorizationRecord = NodeGitCredentialAuthorizationSet & { id: string; createdAt: string };
export type GitProvisioningRecord =
  | { id: string; status: "pending"; input: GitWorkspaceProvisioningInput; createdAt: string; updatedAt: string; expiresAt: string }
  | { id: string; status: "consumed"; operationId: string; createdAt: string; updatedAt: string; expiresAt: string };

export class GitPersistenceRepository {
  private readonly client: DatabaseSync;
  constructor(client: DatabaseSync) { this.client = client; }

  listPayloads(): GitPayloadRecord[] {
    return (this.client.prepare("SELECT * FROM na_git_credential_payloads ORDER BY credential_id").all() as Row[]).map(payloadFromRow);
  }

  getPayload(id: string): GitPayloadRecord | undefined {
    const row = this.client.prepare("SELECT * FROM na_git_credential_payloads WHERE credential_id = ?").get(id) as Row | undefined;
    return row ? payloadFromRow(row) : undefined;
  }

  putPayload(record: GitPayloadRecord) {
    const payload = NodeGitCredentialPayloadSchema.parse(record.payload);
    this.client.prepare(`INSERT INTO na_git_credential_payloads
      (credential_id, revision, public_json, secret_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(credential_id) DO UPDATE SET revision=excluded.revision, public_json=excluded.public_json,
        secret_json=excluded.secret_json, updated_at=excluded.updated_at`)
      .run(record.id, payload.credential.revision, JSON.stringify(payload.credential), JSON.stringify(payload.secret), record.createdAt, record.updatedAt);
    return { ...record, payload };
  }

  deletePayload(id: string) {
    return Number(this.client.prepare("DELETE FROM na_git_credential_payloads WHERE credential_id = ?").run(id).changes) > 0;
  }

  collectUnreferencedPayloads() {
    return Number(this.client.prepare(`DELETE FROM na_git_credential_payloads
      WHERE NOT EXISTS (SELECT 1 FROM na_git_authorization_members m WHERE m.credential_id = na_git_credential_payloads.credential_id)`).run().changes);
  }

  listAuthorizations(): GitAuthorizationRecord[] {
    return (this.client.prepare("SELECT * FROM na_git_authorization_sets ORDER BY instance_id").all() as Row[]).map((row) => this.authorizationFromRow(row));
  }

  getAuthorization(instanceId: string): GitAuthorizationRecord | undefined {
    const row = this.client.prepare("SELECT * FROM na_git_authorization_sets WHERE instance_id = ?").get(instanceId) as Row | undefined;
    return row ? this.authorizationFromRow(row) : undefined;
  }

  putAuthorization(record: GitAuthorizationRecord) {
    const value = NodeGitCredentialAuthorizationSetSchema.parse({
      instanceId: record.instanceId,
      generation: record.generation,
      credentialIds: record.credentialIds,
      updatedAt: record.updatedAt,
    });
    return this.transaction(() => {
      this.client.prepare(`INSERT INTO na_git_authorization_sets (instance_id, generation, created_at, updated_at)
        VALUES (?, ?, ?, ?) ON CONFLICT(instance_id) DO UPDATE SET generation=excluded.generation, updated_at=excluded.updated_at`)
        .run(value.instanceId, value.generation, record.createdAt, value.updatedAt);
      this.client.prepare("DELETE FROM na_git_authorization_members WHERE instance_id = ?").run(value.instanceId);
      const insert = this.client.prepare("INSERT INTO na_git_authorization_members (instance_id, credential_id, display_order) VALUES (?, ?, ?)");
      for (const [displayOrder, credentialId] of value.credentialIds.entries()) insert.run(value.instanceId, credentialId, displayOrder);
      return this.getAuthorization(value.instanceId)!;
    });
  }

  putAuthorizationCas(record: GitAuthorizationRecord) {
    const value = NodeGitCredentialAuthorizationSetSchema.parse({
      instanceId: record.instanceId,
      generation: record.generation,
      credentialIds: record.credentialIds,
      updatedAt: record.updatedAt,
    });
    return this.transaction(() => {
      const current = this.getAuthorization(value.instanceId);
      if (current && current.generation > value.generation) {
        throw gitError("GIT_CREDENTIAL_REVISION_STALE", `Refusing stale authorization set revision for ${value.instanceId}.`);
      }
      if (current && current.generation === value.generation) {
        if (JSON.stringify(current.credentialIds) !== JSON.stringify(value.credentialIds)) {
          throw gitError("GIT_CREDENTIAL_REVISION_CONFLICT", `Refusing conflicting authorization set revision for ${value.instanceId}.`);
        }
        return current;
      }
      for (const credentialId of value.credentialIds) {
        if (!this.getPayload(credentialId)) {
          throw gitError("GIT_CREDENTIAL_PAYLOAD_MISSING", `Credential payload ${credentialId} is not deployed.`);
        }
      }
      if (current) {
        const changed = this.client.prepare(`UPDATE na_git_authorization_sets
          SET generation = ?, updated_at = ? WHERE instance_id = ? AND generation < ?`)
          .run(value.generation, value.updatedAt, value.instanceId, value.generation).changes;
        if (Number(changed) !== 1) throw gitError("GIT_CREDENTIAL_REVISION_STALE", `Authorization set ${value.instanceId} changed concurrently.`);
      } else {
        this.client.prepare(`INSERT INTO na_git_authorization_sets (instance_id, generation, created_at, updated_at)
          VALUES (?, ?, ?, ?)`)
          .run(value.instanceId, value.generation, record.createdAt, value.updatedAt);
      }
      this.client.prepare("DELETE FROM na_git_authorization_members WHERE instance_id = ?").run(value.instanceId);
      const insert = this.client.prepare("INSERT INTO na_git_authorization_members (instance_id, credential_id, display_order) VALUES (?, ?, ?)");
      for (const [displayOrder, credentialId] of value.credentialIds.entries()) insert.run(value.instanceId, credentialId, displayOrder);
      return this.getAuthorization(value.instanceId)!;
    });
  }

  deleteAuthorization(instanceId: string) {
    return Number(this.client.prepare("DELETE FROM na_git_authorization_sets WHERE instance_id = ?").run(instanceId).changes) > 0;
  }

  listProvisioning(): GitProvisioningRecord[] {
    return (this.client.prepare("SELECT * FROM na_git_workspace_provisioning ORDER BY instance_id").all() as Row[]).map(provisioningFromRow);
  }

  getProvisioning(instanceId: string): GitProvisioningRecord | undefined {
    const row = this.client.prepare("SELECT * FROM na_git_workspace_provisioning WHERE instance_id = ?").get(instanceId) as Row | undefined;
    return row ? provisioningFromRow(row) : undefined;
  }

  putProvisioning(record: GitProvisioningRecord) {
    const operationId = record.status === "pending" ? record.input.operationId : record.operationId;
    this.client.prepare(`INSERT INTO na_git_workspace_provisioning
      (instance_id, status, operation_id, input_json, created_at, updated_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(instance_id) DO UPDATE SET status=excluded.status, operation_id=excluded.operation_id,
        input_json=excluded.input_json, updated_at=excluded.updated_at, expires_at=excluded.expires_at`)
      .run(record.id, record.status, operationId, record.status === "pending" ? JSON.stringify(record.input) : null,
        record.createdAt, record.updatedAt, record.expiresAt);
    return this.getProvisioning(record.id)!;
  }

  deleteProvisioning(instanceId: string) {
    return Number(this.client.prepare("DELETE FROM na_git_workspace_provisioning WHERE instance_id = ?").run(instanceId).changes) > 0;
  }

  deleteExpiredProvisioning(timestamp: string) {
    return Number(this.client.prepare("DELETE FROM na_git_workspace_provisioning WHERE expires_at <= ?").run(timestamp).changes);
  }

  consumeProvisioning(instanceId: string, operationId: string, updatedAt: string, expiresAt: string) {
    return this.transaction(() => {
      const changed = this.client.prepare(`UPDATE na_git_workspace_provisioning
        SET status = 'consumed', input_json = NULL, updated_at = ?, expires_at = ?
        WHERE instance_id = ? AND operation_id = ? AND status = 'pending'`)
        .run(updatedAt, expiresAt, instanceId, operationId).changes;
      if (Number(changed) === 1) return true;
      const current = this.getProvisioning(instanceId);
      return current?.status === "consumed" && current.operationId === operationId;
    });
  }

  private authorizationFromRow(row: Row): GitAuthorizationRecord {
    const credentialIds = (this.client.prepare("SELECT credential_id FROM na_git_authorization_members WHERE instance_id = ? ORDER BY display_order").all(String(row.instance_id)) as Row[])
      .map((member) => String(member.credential_id));
    return {
      id: String(row.instance_id), instanceId: String(row.instance_id), generation: Number(row.generation), credentialIds,
      createdAt: String(row.created_at), updatedAt: String(row.updated_at),
    };
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

function gitError(code: string, message: string) {
  return Object.assign(new Error(message), { code, statusCode: 409 });
}

function payloadFromRow(row: Row): GitPayloadRecord {
  return {
    id: String(row.credential_id),
    payload: NodeGitCredentialPayloadSchema.parse({
      credential: JSON.parse(String(row.public_json)), secret: JSON.parse(String(row.secret_json)),
    }),
    createdAt: String(row.created_at), updatedAt: String(row.updated_at),
  };
}

function provisioningFromRow(row: Row): GitProvisioningRecord {
  const common = {
    id: String(row.instance_id), createdAt: String(row.created_at), updatedAt: String(row.updated_at), expiresAt: String(row.expires_at),
  };
  return row.status === "pending"
    ? { ...common, status: "pending", input: GitWorkspaceProvisioningInputSchema.parse(JSON.parse(String(row.input_json))) }
    : { ...common, status: "consumed", operationId: String(row.operation_id) };
}
