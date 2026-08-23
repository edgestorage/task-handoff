import { z } from "zod";
import { nowIso as now } from "@task-handoff/core/core/time";
import {
  GitCredentialCreateRequestSchema,
  GitCredentialPublicSchema,
  GitCredentialSecretInputSchema,
  GitCredentialUpdateRequestSchema,
  InstanceGitCredentialAssignmentSchema,
  NodeGitCredentialPayloadSchema,
  NodeGitCredentialAuthorizationSetSchema,
  normalizeGitCredentialScope,
  resolveGitCredential,
  type GitCredentialPublic,
  type GitCredentialSecretInput,
  type InstanceGitCredentialAssignment,
  type NodeGitCredentialPayload,
} from "@task-handoff/protocol/managed-git-credentials";
import { createId, JsonCollection } from "../../shared/persistence/store.ts";
import type { ControlPlaneStorePaths } from "../persistence/paths.ts";
import { ControlPlaneSecretBox } from "../auth/secret-box.ts";

const GitCredentialRecordSchema = z.object({
  id: GitCredentialPublicSchema.shape.id,
  name: GitCredentialPublicSchema.shape.name,
  kind: GitCredentialPublicSchema.shape.kind,
  scope: GitCredentialPublicSchema.shape.scope,
  status: GitCredentialPublicSchema.shape.status,
  revision: GitCredentialPublicSchema.shape.revision,
  secretCiphertext: z.string().min(1).max(256 * 1024),
  createdAt: GitCredentialPublicSchema.shape.createdAt,
  updatedAt: GitCredentialPublicSchema.shape.updatedAt,
}).strict();

const GitCredentialAssignmentRecordSchema = InstanceGitCredentialAssignmentSchema.extend({
  id: z.string().trim().min(1).max(300),
  createdAt: GitCredentialPublicSchema.shape.createdAt,
}).strict();

const GitCredentialAuditRecordSchema = z.object({
  id: z.string().trim().min(1).max(120),
  action: z.enum(["create", "update", "delete", "authorize", "assignment-status", "revoke"]),
  credentialId: GitCredentialPublicSchema.shape.id,
  instanceId: GitCredentialPublicSchema.shape.id.optional(),
  credentialRevision: GitCredentialPublicSchema.shape.revision.optional(),
  assignmentRevision: GitCredentialPublicSchema.shape.revision.optional(),
  createdAt: GitCredentialPublicSchema.shape.createdAt,
  updatedAt: GitCredentialPublicSchema.shape.updatedAt,
}).strict();

type GitCredentialRecord = z.infer<typeof GitCredentialRecordSchema>;
type GitCredentialAssignmentRecord = z.infer<typeof GitCredentialAssignmentRecordSchema>;
type RepositoryCredentialReference = { id: string; name: string; url: string; authType: "ssh-key" | "https-token" };

function assignmentId(instanceId: string, credentialId: string) {
  return `${instanceId}:${credentialId}`;
}

function gitCredentialError(message: string, code: string, statusCode: number) {
  return Object.assign(new Error(message), { code, statusCode });
}

function sanitizeCredentialRecord(input: unknown) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return input;
  const source = input as Record<string, unknown>;
  const scope = source.scope && typeof source.scope === "object" && !Array.isArray(source.scope)
    ? source.scope as Record<string, unknown>
    : undefined;
  return {
    id: source.id,
    name: source.name,
    kind: source.kind,
    scope: scope ? {
      scheme: scope.scheme,
      host: scope.host,
      ...(scope.port === undefined ? {} : { port: scope.port }),
      pathPrefix: scope.pathPrefix,
    } : source.scope,
    status: source.status,
    revision: source.revision,
    secretCiphertext: source.secretCiphertext,
    createdAt: source.createdAt,
    updatedAt: source.updatedAt,
  };
}

function sanitizeAssignmentRecord(input: unknown) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return input;
  const source = input as Record<string, unknown>;
  return Object.fromEntries([
    "id", "instanceId", "credentialId", "credentialRevision", "assignmentRevision",
    "status", "authorizedAt", "createdAt", "updatedAt",
  ].flatMap((key) => Object.prototype.hasOwnProperty.call(source, key) ? [[key, source[key]]] : []));
}

export class ControlPlaneGitCredentialService {
  private readonly credentials: JsonCollection<GitCredentialRecord>;
  private readonly assignments: JsonCollection<GitCredentialAssignmentRecord>;
  private readonly audit: JsonCollection<z.infer<typeof GitCredentialAuditRecordSchema>>;
  private readonly secrets: ControlPlaneSecretBox;
  private readonly repositoryReferences: (credentialId: string) => RepositoryCredentialReference[];

  constructor(paths: ControlPlaneStorePaths, options: {
    repositoryReferences?: (credentialId: string) => RepositoryCredentialReference[];
  } = {}) {
    this.credentials = new JsonCollection(paths.gitCredentialsDir, {
      schema: GitCredentialRecordSchema,
      sanitize: sanitizeCredentialRecord,
      directoryMode: 0o700,
      fileMode: 0o600,
    });
    this.assignments = new JsonCollection(paths.gitCredentialAssignmentsDir, {
      schema: GitCredentialAssignmentRecordSchema,
      sanitize: sanitizeAssignmentRecord,
      directoryMode: 0o700,
      fileMode: 0o600,
    });
    this.audit = new JsonCollection(paths.gitCredentialAuditDir, {
      schema: GitCredentialAuditRecordSchema,
      directoryMode: 0o700,
      fileMode: 0o600,
    });
    this.secrets = new ControlPlaneSecretBox(paths.gitCredentialEncryptionKeyPath);
    this.repositoryReferences = options.repositoryReferences || (() => []);
  }

  init() {
    this.secrets.init();
    this.credentials.init();
    this.assignments.init();
    this.audit.init();
  }

  list(): GitCredentialPublic[] {
    return this.credentials.list().map((record) => this.publicCredential(record));
  }

  get(id: string) {
    const record = this.credentials.get(id);
    return record ? this.publicCredential(record) : undefined;
  }

  requirePublic(id: string) {
    return this.publicCredential(this.require(id));
  }

  require(id: string) {
    const record = this.credentials.get(id);
    if (!record) throw gitCredentialError(`Git credential ${id} was not found.`, "GIT_CREDENTIAL_NOT_FOUND", 404);
    return record;
  }

  create(input: unknown) {
    const parsed = GitCredentialCreateRequestSchema.parse(input);
    const timestamp = now();
    const record = this.credentials.put({
      id: createId("gitcred"),
      name: parsed.name,
      kind: parsed.secret.kind,
      scope: normalizeGitCredentialScope(parsed.scope),
      status: "enabled",
      revision: 1,
      secretCiphertext: this.secrets.seal(JSON.stringify(parsed.secret)),
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    this.auditEvent("create", record.id, { credentialRevision: record.revision });
    return this.publicCredential(record);
  }

  update(id: string, input: unknown) {
    const parsed = GitCredentialUpdateRequestSchema.parse(input);
    const current = this.require(id);
    const nextScope = parsed.scope ? normalizeGitCredentialScope(parsed.scope) : current.scope;
    if ((nextScope.scheme === "https") !== (current.kind === "https-token")) {
      throw gitCredentialError("Credential kind must match the remote scheme.", "GIT_CREDENTIAL_SCOPE_KIND_MISMATCH", 400);
    }
    if (parsed.secret && parsed.secret.kind !== current.kind) {
      throw gitCredentialError("Credential kind cannot be changed during secret rotation.", "GIT_CREDENTIAL_KIND_IMMUTABLE", 409);
    }
    const changedSecret = parsed.secret !== undefined;
    const candidate = {
      ...current,
      ...(parsed.name === undefined ? {} : { name: parsed.name }),
      ...(parsed.scope === undefined ? {} : { scope: nextScope }),
      ...(parsed.status === undefined ? {} : { status: parsed.status }),
      ...(changedSecret ? { secretCiphertext: this.secrets.seal(JSON.stringify(parsed.secret)) } : {}),
      revision: current.revision + 1,
      updatedAt: now(),
    };
    this.assertRepositoryCompatibility(this.publicCredential(candidate));
    const record = this.credentials.put(candidate);
    this.auditEvent("update", record.id, { credentialRevision: record.revision });
    return this.publicCredential(record);
  }

  disable(id: string) {
    return this.update(id, { status: "disabled" });
  }

  remove(id: string) {
    this.require(id);
    const references = this.assignments.list().filter((assignment) => assignment.credentialId === id && assignment.status !== "revoked");
    const repositories = this.repositoryReferences(id);
    if (references.length > 0 || repositories.length > 0) {
      throw Object.assign(gitCredentialError("Git credential is referenced by one or more repositories or instances.", "GIT_CREDENTIAL_IN_USE", 409), {
        details: {
          instances: references.map((assignment) => assignment.instanceId).sort(),
          repositories: repositories.map((repository) => ({ id: repository.id, name: repository.name })),
        },
      });
    }
    const deleted = this.credentials.delete(id);
    if (deleted) this.auditEvent("delete", id);
    return deleted;
  }

  payload(id: string, options: { allowDisabled?: boolean } = {}): NodeGitCredentialPayload {
    const record = this.require(id);
    if (record.status !== "enabled" && !options.allowDisabled) throw gitCredentialError(`Git credential ${id} is disabled.`, "GIT_CREDENTIAL_DISABLED", 409);
    let secret: GitCredentialSecretInput;
    try {
      secret = GitCredentialSecretInputSchema.parse(JSON.parse(this.secrets.open(record.secretCiphertext)));
    } catch {
      throw gitCredentialError(`Git credential ${id} secret could not be opened.`, "GIT_CREDENTIAL_SECRET_INVALID", 500);
    }
    return NodeGitCredentialPayloadSchema.parse({ credential: this.publicCredential(record), secret });
  }

  listAssignments(instanceId?: string): InstanceGitCredentialAssignment[] {
    return this.assignments.list()
      .filter((assignment) => assignment.status !== "revoked" && (!instanceId || assignment.instanceId === instanceId))
      .map(({ id: _id, createdAt: _createdAt, ...assignment }) => InstanceGitCredentialAssignmentSchema.parse(assignment));
  }

  authorize(instanceId: string, credentialId: string, options: { allowDisabled?: boolean } = {}) {
    const credential = this.require(credentialId);
    if (credential.status !== "enabled" && !options.allowDisabled) throw gitCredentialError(`Git credential ${credentialId} is disabled.`, "GIT_CREDENTIAL_DISABLED", 409);
    const id = assignmentId(instanceId, credentialId);
    const current = this.assignments.get(id);
    const timestamp = now();
    const record = this.assignments.put({
      id,
      instanceId,
      credentialId,
      credentialRevision: credential.revision,
      assignmentRevision: (current?.assignmentRevision || 0) + 1,
      status: "pending",
      authorizedAt: current?.authorizedAt || timestamp,
      createdAt: current?.createdAt || timestamp,
      updatedAt: timestamp,
    });
    this.auditEvent("authorize", credentialId, { instanceId, credentialRevision: record.credentialRevision, assignmentRevision: record.assignmentRevision });
    const { id: _id, createdAt: _createdAt, ...assignment } = record;
    return InstanceGitCredentialAssignmentSchema.parse(assignment);
  }

  markAssignmentStatus(instanceId: string, credentialId: string, status: "synced" | "deferred" | "revoking") {
    const id = assignmentId(instanceId, credentialId);
    const current = this.assignments.get(id);
    if (!current) throw gitCredentialError("Git credential assignment was not found.", "GIT_CREDENTIAL_ASSIGNMENT_NOT_FOUND", 404);
    const record = this.assignments.put({ ...current, status, assignmentRevision: current.assignmentRevision + 1, updatedAt: now() });
    this.auditEvent("assignment-status", credentialId, { instanceId, credentialRevision: record.credentialRevision, assignmentRevision: record.assignmentRevision });
    const { id: _id, createdAt: _createdAt, ...assignment } = record;
    return InstanceGitCredentialAssignmentSchema.parse(assignment);
  }

  revoke(instanceId: string, credentialId: string) {
    const current = this.assignments.get(assignmentId(instanceId, credentialId));
    if (!current || current.status === "revoked") return false;
    this.assignments.put({ ...current, status: "revoked", assignmentRevision: current.assignmentRevision + 1, updatedAt: now() });
    this.auditEvent("revoke", credentialId, { instanceId, credentialRevision: current.credentialRevision, assignmentRevision: current.assignmentRevision });
    return true;
  }

  desiredAuthorizationSet(instanceId: string) {
    const records = this.assignments.list().filter((item) => item.instanceId === instanceId);
    return NodeGitCredentialAuthorizationSetSchema.parse({
      instanceId,
      generation: records.reduce((sum, item) => sum + item.assignmentRevision, 0),
      credentialIds: records.filter((item) => item.status !== "revoking" && item.status !== "revoked").map((item) => item.credentialId),
      updatedAt: now(),
    });
  }

  revokeInstance(instanceId: string) {
    let removed = 0;
    for (const assignment of this.assignments.list().filter((item) => item.instanceId === instanceId)) {
      if (this.assignments.delete(assignment.id)) removed += 1;
    }
    return removed;
  }

  private publicCredential(record: GitCredentialRecord) {
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

  private assertRepositoryCompatibility(credential: GitCredentialPublic) {
    for (const repository of this.repositoryReferences(credential.id)) {
      if (repository.authType !== credential.kind) {
        throw gitCredentialError(`Credential kind no longer matches repository ${repository.id}.`, "GIT_CREDENTIAL_REPOSITORY_KIND_MISMATCH", 409);
      }
      const match = resolveGitCredential(repository.url, [{ ...credential, status: "enabled" }]);
      if (match.status !== "unique") {
        throw gitCredentialError(`Credential scope no longer covers repository ${repository.id}.`, "GIT_CREDENTIAL_REPOSITORY_SCOPE_MISMATCH", 409);
      }
    }
  }

  private auditEvent(action: z.infer<typeof GitCredentialAuditRecordSchema>["action"], credentialId: string, details: { instanceId?: string; credentialRevision?: number; assignmentRevision?: number } = {}) {
    const timestamp = now();
    this.audit.put({ id: createId("gitaudit"), action, credentialId, ...details, createdAt: timestamp, updatedAt: timestamp });
  }
}
