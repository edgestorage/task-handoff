import crypto from "node:crypto";
import {
  GitCredentialPublicSchema,
  GitCredentialSecretInputSchema,
  type GitCredentialPublic,
  type GitCredentialSecretInput,
} from "@task-handoff/protocol/managed-git-credentials";
import type { ControlPlaneDatabase } from "../persistence/database/index.ts";
import type {
  GitAssignmentRecord,
  GitAuditRecord,
  GitCredentialRecord,
  GitProvisioningIntentRecord,
} from "../persistence/database/p0-records.ts";
export type { GitAssignmentRecord, GitAuditRecord, GitProvisioningIntentRecord } from "../persistence/database/p0-records.ts";
import type { SecretEnvelopeService } from "../persistence/secret-envelope.ts";

export type GitCredentialEntity = GitCredentialPublic & { secret: GitCredentialSecretInput };

function credentialContext(id: string) {
  return `git:${id}:secret`;
}

export function gitProvisioningInputDigest(input: Pick<GitProvisioningIntentRecord, "instanceId" | "credentialId" | "operationId" | "remoteUrl" | "ref" | "clone">) {
  return crypto.createHash("sha256").update(JSON.stringify(input)).digest("hex");
}

export class ControlPlaneGitRepository {
  private readonly database: ControlPlaneDatabase;
  private readonly secrets: SecretEnvelopeService;

  constructor(database: ControlPlaneDatabase, secrets: SecretEnvelopeService) {
    this.database = database;
    this.secrets = secrets;
  }

  async listCredentials() {
    return (await this.database.gitCredentials.list()).map(publicCredential);
  }

  async getCredential(id: string) {
    const record = await this.database.gitCredentials.get(id);
    return record ? publicCredential(record) : undefined;
  }

  async getCredentialEntity(id: string): Promise<GitCredentialEntity | undefined> {
    const record = await this.database.gitCredentials.get(id);
    if (!record) return undefined;
    return {
      ...publicCredential(record),
      secret: GitCredentialSecretInputSchema.parse(JSON.parse(this.secrets.open(record.secretCiphertext, credentialContext(record.id)))),
    };
  }

  async putCredential(entity: GitCredentialEntity) {
    const { secretSet: _secretSet, secret, ...metadata } = { ...entity, secretSet: true as const };
    const record: GitCredentialRecord = {
      ...metadata,
      secretCiphertext: this.secrets.seal(JSON.stringify(GitCredentialSecretInputSchema.parse(secret)), credentialContext(entity.id)),
    };
    await this.database.gitCredentials.put(record);
    return publicCredential(record);
  }

  deleteCredential(id: string) {
    return this.database.gitCredentials.delete(id);
  }

  listAssignments() {
    return this.database.gitAssignments.list();
  }

  getAssignment(id: string) {
    return this.database.gitAssignments.get(id);
  }

  async putAssignment(record: GitAssignmentRecord, expectedRevision: number | undefined) {
    const committed = await this.database.gitAssignments.putIfRevision(record, expectedRevision);
    if (!committed) {
      throw Object.assign(new Error("Git credential assignment revision changed."), {
        code: "GIT_CREDENTIAL_ASSIGNMENT_REVISION_CONFLICT",
        statusCode: 409,
        details: { assignmentId: record.id, expectedRevision },
      });
    }
    return record;
  }

  deleteAssignment(id: string) {
    return this.database.gitAssignments.delete(id);
  }

  listProvisioningIntents() {
    return this.database.gitProvisioningIntents.list();
  }

  getProvisioningIntent(id: string) {
    return this.database.gitProvisioningIntents.get(id);
  }

  async rememberProvisioningIntent(input: Omit<GitProvisioningIntentRecord, "inputDigest">) {
    const record = { ...input, inputDigest: gitProvisioningInputDigest(input) };
    if (await this.database.gitProvisioningIntents.insert(record)) return record;
    const current = await this.database.gitProvisioningIntents.get(record.id);
    if (current?.operationId === record.operationId && current.inputDigest === record.inputDigest) return current;
    throw Object.assign(new Error("Git workspace provisioning operation conflicts with an existing intent."), {
      code: "GIT_CREDENTIAL_PROVISIONING_OPERATION_CONFLICT",
      statusCode: 409,
      details: { instanceId: record.instanceId, operationId: record.operationId },
    });
  }

  deleteProvisioningIntent(id: string) {
    return this.database.gitProvisioningIntents.delete(id);
  }

  appendAudit(record: GitAuditRecord) {
    return this.database.gitAudit.append(record);
  }

  transaction<T>(operation: (repository: ControlPlaneGitRepository) => Promise<T>) {
    return this.database.transaction((database) => operation(new ControlPlaneGitRepository(database, this.secrets)));
  }
}

function publicCredential(record: GitCredentialRecord) {
  return GitCredentialPublicSchema.parse({
    id: record.id,
    name: record.name,
    kind: record.kind,
    scope: record.scope,
    secretSet: true,
    status: record.status,
    revision: record.revision,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  });
}
