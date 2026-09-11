import { nowIso as now } from "@task-handoff/core/core/time";
import {
  GitCredentialCreateRequestSchema,
  GitCredentialUpdateRequestSchema,
  GitWorkspaceProvisioningInputSchema,
  InstanceGitCredentialAssignmentSchema,
  NodeGitCredentialAuthorizationSetSchema,
  NodeGitCredentialPayloadSchema,
  normalizeGitCredentialScope,
  resolveGitCredential,
  type GitCredentialPublic,
  type GitWorkspaceProvisioningInput,
  type InstanceGitCredentialAssignment,
  type NodeGitCredentialPayload,
} from "@task-handoff/protocol/managed-git-credentials";
import { createId } from "../../shared/persistence/store.ts";
import { ControlPlaneGitRepository, type GitAssignmentRecord, type GitAuditRecord, type GitProvisioningIntentRecord } from "./repository.ts";

type RepositoryCredentialReference = { id: string; name: string; url: string; authType: "ssh-key" | "https-token" };

function assignmentId(instanceId: string, credentialId: string) {
  return `${instanceId}:${credentialId}`;
}

function gitCredentialError(message: string, code: string, statusCode: number) {
  return Object.assign(new Error(message), { code, statusCode });
}

export class ControlPlaneGitCredentialService {
  private readonly repository: ControlPlaneGitRepository;
  private readonly repositoryReferences: (credentialId: string) => RepositoryCredentialReference[];
  private readonly credentials = new Map<string, GitCredentialPublic>();
  private readonly assignments = new Map<string, GitAssignmentRecord>();
  private readonly provisioningIntents = new Map<string, GitProvisioningIntentRecord>();

  constructor(repository: ControlPlaneGitRepository, options: {
    repositoryReferences?: (credentialId: string) => RepositoryCredentialReference[];
  } = {}) {
    this.repository = repository;
    this.repositoryReferences = options.repositoryReferences || (() => []);
  }

  async init() {
    this.credentials.clear();
    this.assignments.clear();
    this.provisioningIntents.clear();
    for (const credential of await this.repository.listCredentials()) this.credentials.set(credential.id, credential);
    for (const assignment of await this.repository.listAssignments()) this.assignments.set(assignment.id, assignment);
    for (const intent of await this.repository.listProvisioningIntents()) this.provisioningIntents.set(intent.id, intent);
  }

  list() { return [...this.credentials.values()].sort((a, b) => a.id.localeCompare(b.id)); }
  get(id: string) { return this.credentials.get(id); }

  requirePublic(id: string) {
    const credential = this.credentials.get(id);
    if (!credential) throw gitCredentialError(`Git credential ${id} was not found.`, "GIT_CREDENTIAL_NOT_FOUND", 404);
    return credential;
  }

  async create(input: unknown) {
    const parsed = GitCredentialCreateRequestSchema.parse(input);
    const timestamp = now();
    const entity = {
      id: createId("gitcred"), name: parsed.name, kind: parsed.secret.kind,
      scope: normalizeGitCredentialScope(parsed.scope), secretSet: true as const, status: "enabled" as const,
      revision: 1, secret: parsed.secret, createdAt: timestamp, updatedAt: timestamp,
    };
    const record = await this.repository.transaction(async (repository) => {
      const stored = await repository.putCredential(entity);
      await repository.appendAudit(this.audit("create", stored.id, timestamp, { credentialRevision: stored.revision }));
      return stored;
    });
    this.credentials.set(record.id, record);
    return record;
  }

  async update(id: string, input: unknown) {
    const parsed = GitCredentialUpdateRequestSchema.parse(input);
    const currentPublic = this.requirePublic(id);
    const current = await this.repository.getCredentialEntity(id);
    if (!current) throw gitCredentialError(`Git credential ${id} was not found.`, "GIT_CREDENTIAL_NOT_FOUND", 404);
    const nextScope = parsed.scope ? normalizeGitCredentialScope(parsed.scope) : current.scope;
    if ((nextScope.scheme === "https") !== (current.kind === "https-token")) throw gitCredentialError("Credential kind must match the remote scheme.", "GIT_CREDENTIAL_SCOPE_KIND_MISMATCH", 400);
    if (parsed.secret && parsed.secret.kind !== current.kind) throw gitCredentialError("Credential kind cannot be changed during secret rotation.", "GIT_CREDENTIAL_KIND_IMMUTABLE", 409);
    const entity = {
      ...current,
      ...(parsed.name === undefined ? {} : { name: parsed.name }),
      ...(parsed.scope === undefined ? {} : { scope: nextScope }),
      ...(parsed.status === undefined ? {} : { status: parsed.status }),
      ...(parsed.secret === undefined ? {} : { secret: parsed.secret }),
      revision: currentPublic.revision + 1,
      updatedAt: now(),
    };
    this.assertRepositoryCompatibility({ ...entity, secretSet: true });
    const record = await this.repository.transaction(async (repository) => {
      const stored = await repository.putCredential(entity);
      await repository.appendAudit(this.audit("update", id, stored.updatedAt, { credentialRevision: stored.revision }));
      return stored;
    });
    this.credentials.set(id, record);
    return record;
  }

  disable(id: string) { return this.update(id, { status: "disabled" }); }

  async remove(id: string) {
    this.requirePublic(id);
    const activeAssignments = [...this.assignments.values()].filter((assignment) => assignment.credentialId === id && assignment.status !== "revoked");
    const repositories = this.repositoryReferences(id);
    const provisioningInstances = [...this.provisioningIntents.values()].filter((intent) => intent.credentialId === id).map((intent) => intent.instanceId);
    if (activeAssignments.length || repositories.length || provisioningInstances.length) {
      throw Object.assign(gitCredentialError("Git credential is referenced by one or more repositories or instances.", "GIT_CREDENTIAL_IN_USE", 409), {
        details: {
          instances: [...new Set([...activeAssignments.map((assignment) => assignment.instanceId), ...provisioningInstances])].sort(),
          repositories: repositories.map((repository) => ({ id: repository.id, name: repository.name })),
        },
      });
    }
    const timestamp = now();
    const revokedAssignments = [...this.assignments.values()].filter((assignment) => assignment.credentialId === id && assignment.status === "revoked");
    const deleted = await this.repository.transaction(async (repository) => {
      for (const assignment of revokedAssignments) await repository.deleteAssignment(assignment.id);
      const result = await repository.deleteCredential(id);
      if (result) await repository.appendAudit(this.audit("delete", id, timestamp));
      return result;
    });
    if (deleted) {
      this.credentials.delete(id);
      for (const assignment of revokedAssignments) this.assignments.delete(assignment.id);
    }
    return deleted;
  }

  async payload(id: string, options: { allowDisabled?: boolean } = {}): Promise<NodeGitCredentialPayload> {
    const entity = await this.repository.getCredentialEntity(id);
    if (!entity) throw gitCredentialError(`Git credential ${id} was not found.`, "GIT_CREDENTIAL_NOT_FOUND", 404);
    if (entity.status !== "enabled" && !options.allowDisabled) throw gitCredentialError(`Git credential ${id} is disabled.`, "GIT_CREDENTIAL_DISABLED", 409);
    return NodeGitCredentialPayloadSchema.parse({ credential: this.requirePublic(id), secret: entity.secret });
  }

  async rememberOperationProvisioning(input: GitWorkspaceProvisioningInput) {
    const parsed = GitWorkspaceProvisioningInputSchema.parse(input);
    const credential = parsed.credentials.length === 1 && parsed.credentials[0].retention === "operation-only" ? parsed.credentials[0] : undefined;
    if (!credential) throw gitCredentialError("Operation-only provisioning requires exactly one credential.", "GIT_CREDENTIAL_PROVISIONING_INVALID", 400);
    const timestamp = now();
    const current = this.provisioningIntents.get(parsed.instanceId);
    const record = await this.repository.rememberProvisioningIntent({
      id: parsed.instanceId, instanceId: parsed.instanceId, credentialId: credential.payload.credential.id,
      operationId: parsed.operationId, remoteUrl: parsed.remoteUrl, ref: parsed.ref, clone: parsed.clone,
      createdAt: current?.createdAt || timestamp, updatedAt: timestamp,
    });
    this.provisioningIntents.set(record.id, record);
    return record;
  }

  async operationProvisioning(instanceId: string): Promise<GitWorkspaceProvisioningInput | undefined> {
    const intent = this.provisioningIntents.get(instanceId);
    if (!intent) return undefined;
    return GitWorkspaceProvisioningInputSchema.parse({
      operationId: intent.operationId, instanceId, remoteUrl: intent.remoteUrl, ref: intent.ref, clone: intent.clone,
      credentials: [{ operationId: intent.operationId, retention: "operation-only", payload: await this.payload(intent.credentialId) }],
    });
  }

  async forgetOperationProvisioning(instanceId: string) {
    const deleted = await this.repository.deleteProvisioningIntent(instanceId);
    if (deleted) this.provisioningIntents.delete(instanceId);
    return deleted;
  }

  listAssignments(instanceId?: string): InstanceGitCredentialAssignment[] {
    return [...this.assignments.values()]
      .filter((assignment) => assignment.status !== "revoked" && (!instanceId || assignment.instanceId === instanceId))
      .sort((a, b) => a.id.localeCompare(b.id))
      .map(({ id: _id, createdAt: _createdAt, ...assignment }) => InstanceGitCredentialAssignmentSchema.parse(assignment));
  }

  async authorize(instanceId: string, credentialId: string, options: { allowDisabled?: boolean } = {}) {
    const credential = this.requirePublic(credentialId);
    if (credential.status !== "enabled" && !options.allowDisabled) throw gitCredentialError(`Git credential ${credentialId} is disabled.`, "GIT_CREDENTIAL_DISABLED", 409);
    const id = assignmentId(instanceId, credentialId);
    const current = this.assignments.get(id);
    const timestamp = now();
    const candidate: GitAssignmentRecord = {
      id, instanceId, credentialId, credentialRevision: credential.revision,
      assignmentRevision: (current?.assignmentRevision || 0) + 1, status: "pending",
      authorizedAt: current?.authorizedAt || timestamp, createdAt: current?.createdAt || timestamp, updatedAt: timestamp,
    };
    const record = await this.repository.transaction(async (repository) => {
      const stored = await repository.putAssignment(candidate, current?.assignmentRevision);
      await repository.appendAudit(this.audit("authorize", credentialId, timestamp, { instanceId, credentialRevision: stored.credentialRevision, assignmentRevision: stored.assignmentRevision }));
      return stored;
    });
    this.assignments.set(id, record);
    return this.publicAssignment(record);
  }

  async markAssignmentStatus(instanceId: string, credentialId: string, status: "synced" | "deferred" | "revoking") {
    const id = assignmentId(instanceId, credentialId);
    const current = this.assignments.get(id);
    if (!current) throw gitCredentialError("Git credential assignment was not found.", "GIT_CREDENTIAL_ASSIGNMENT_NOT_FOUND", 404);
    const timestamp = now();
    const candidate: GitAssignmentRecord = { ...current, status, assignmentRevision: current.assignmentRevision + 1, updatedAt: timestamp };
    const record = await this.repository.transaction(async (repository) => {
      const stored = await repository.putAssignment(candidate, current.assignmentRevision);
      await repository.appendAudit(this.audit("assignment-status", credentialId, timestamp, { instanceId, credentialRevision: stored.credentialRevision, assignmentRevision: stored.assignmentRevision }));
      return stored;
    });
    this.assignments.set(id, record);
    return this.publicAssignment(record);
  }

  async revoke(instanceId: string, credentialId: string) {
    const id = assignmentId(instanceId, credentialId);
    const current = this.assignments.get(id);
    if (!current || current.status === "revoked") return false;
    const timestamp = now();
    const candidate: GitAssignmentRecord = { ...current, status: "revoked", assignmentRevision: current.assignmentRevision + 1, updatedAt: timestamp };
    const record = await this.repository.transaction(async (repository) => {
      const stored = await repository.putAssignment(candidate, current.assignmentRevision);
      await repository.appendAudit(this.audit("revoke", credentialId, timestamp, { instanceId, credentialRevision: stored.credentialRevision, assignmentRevision: stored.assignmentRevision }));
      return stored;
    });
    this.assignments.set(id, record);
    return true;
  }

  desiredAuthorizationSet(instanceId: string) {
    const records = [...this.assignments.values()].filter((item) => item.instanceId === instanceId);
    return NodeGitCredentialAuthorizationSetSchema.parse({
      instanceId, generation: records.reduce((sum, item) => sum + item.assignmentRevision, 0),
      credentialIds: records.filter((item) => item.status !== "revoking" && item.status !== "revoked").map((item) => item.credentialId).sort(),
      updatedAt: now(),
    });
  }

  async revokeInstance(instanceId: string) {
    const records = [...this.assignments.values()].filter((item) => item.instanceId === instanceId);
    await this.repository.transaction(async (repository) => {
      for (const assignment of records) {
        await repository.deleteAssignment(assignment.id);
        await repository.appendAudit(this.audit("revoke", assignment.credentialId, now(), {
          instanceId, credentialRevision: assignment.credentialRevision, assignmentRevision: assignment.assignmentRevision + 1,
        }));
      }
      await repository.deleteProvisioningIntent(instanceId);
    });
    for (const assignment of records) this.assignments.delete(assignment.id);
    this.provisioningIntents.delete(instanceId);
    return records.length;
  }

  private publicAssignment(record: GitAssignmentRecord) {
    const { id: _id, createdAt: _createdAt, ...assignment } = record;
    return InstanceGitCredentialAssignmentSchema.parse(assignment);
  }

  private assertRepositoryCompatibility(credential: GitCredentialPublic) {
    const provisioning = [...this.provisioningIntents.values()]
      .filter((intent) => intent.credentialId === credential.id)
      .map((intent) => ({ id: intent.instanceId, name: intent.instanceId, url: intent.remoteUrl, authType: credential.kind }));
    for (const repository of [...this.repositoryReferences(credential.id), ...provisioning]) {
      if (repository.authType !== credential.kind) throw gitCredentialError(`Credential kind no longer matches repository ${repository.id}.`, "GIT_CREDENTIAL_REPOSITORY_KIND_MISMATCH", 409);
      const match = resolveGitCredential(repository.url, [{ ...credential, status: "enabled" }]);
      if (match.status !== "unique") throw gitCredentialError(`Credential scope no longer covers repository ${repository.id}.`, "GIT_CREDENTIAL_REPOSITORY_SCOPE_MISMATCH", 409);
    }
  }

  private audit(action: GitAuditRecord["action"], credentialId: string, timestamp: string, details: Pick<GitAuditRecord, "instanceId" | "credentialRevision" | "assignmentRevision"> = {}) {
    return { id: createId("gitaudit"), action, credentialId, ...details, createdAt: timestamp, updatedAt: timestamp };
  }
}
