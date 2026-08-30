import { z } from "zod";
import {
  InstanceGitCredentialAssignmentSchema,
  NodeGitCredentialAuthorizationSetSchema,
  NodeGitCredentialPayloadSchema,
  GitWorkspaceProvisioningInputSchema,
  resolveGitCredential,
  sanitizeGitCredentialPublic,
  sanitizeGitWorkspaceProvisioningInput,
  type InstanceGitCredentialAssignment,
  type NodeGitCredentialAuthorizationSet,
  type NodeGitCredentialPayload,
  type GitWorkspaceProvisioningInput,
} from "@task-handoff/protocol/managed-git-credentials";
import { JsonCollection } from "../../shared/persistence/store.ts";
import type { NodeAgentStorePaths } from "../persistence/paths.ts";

const PayloadRecordSchema = z.object({
  id: z.string().trim().min(1).max(120),
  payload: NodeGitCredentialPayloadSchema,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
}).strict();

const LegacyAssignmentRecordSchema = InstanceGitCredentialAssignmentSchema.extend({
  id: z.string().trim().min(1).max(300),
  createdAt: z.string().datetime(),
}).strict();

const AuthorizationSetRecordSchema = NodeGitCredentialAuthorizationSetSchema.extend({
  id: z.string().trim().min(1).max(120),
  createdAt: z.string().datetime(),
}).strict();

const PendingWorkspaceProvisioningRecordSchema = z.object({
  id: z.string().trim().min(1).max(120),
  status: z.literal("pending"),
  input: GitWorkspaceProvisioningInputSchema,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
}).strict();

const ConsumedWorkspaceProvisioningRecordSchema = z.object({
  id: z.string().trim().min(1).max(120),
  status: z.literal("consumed"),
  operationId: GitWorkspaceProvisioningInputSchema.shape.operationId,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
}).strict();

const WorkspaceProvisioningRecordSchema = z.discriminatedUnion("status", [
  PendingWorkspaceProvisioningRecordSchema,
  ConsumedWorkspaceProvisioningRecordSchema,
]);

const WORKSPACE_PROVISIONING_TTL_MS = 24 * 60 * 60_000;
const WORKSPACE_PROVISIONING_RECEIPT_TTL_MS = 7 * 24 * 60 * 60_000;

type PayloadRecord = z.infer<typeof PayloadRecordSchema>;
type LegacyAssignmentRecord = z.infer<typeof LegacyAssignmentRecordSchema>;
type AuthorizationSetRecord = z.infer<typeof AuthorizationSetRecordSchema>;

function objectRecord(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function sanitizePayloadRecord(value: unknown) {
  const source = objectRecord(value);
  const payload = objectRecord(source?.payload);
  const credential = sanitizeGitCredentialPublic(payload?.credential);
  const secret = objectRecord(payload?.secret);
  return {
    id: source?.id,
    payload: {
      credential: credential.success ? credential.data : payload?.credential,
      secret: secret?.kind === "https-token"
        ? { kind: secret.kind, username: secret.username, token: secret.token }
        : { kind: secret?.kind, privateKey: secret?.privateKey, passphrase: secret?.passphrase, pinnedKnownHosts: secret?.pinnedKnownHosts },
    },
    createdAt: source?.createdAt,
    updatedAt: source?.updatedAt,
  };
}

function sanitizeLegacyAssignmentRecord(value: unknown) {
  const source = objectRecord(value);
  return Object.fromEntries([
    "id", "instanceId", "credentialId", "credentialRevision", "assignmentRevision",
    "status", "authorizedAt", "createdAt", "updatedAt",
  ].flatMap((key) => source && Object.prototype.hasOwnProperty.call(source, key) ? [[key, source[key]]] : []));
}

function sanitizeAuthorizationSetRecord(value: unknown) {
  const source = objectRecord(value);
  return Object.fromEntries([
    "id", "instanceId", "generation", "credentialIds", "createdAt", "updatedAt",
  ].flatMap((key) => source && Object.prototype.hasOwnProperty.call(source, key) ? [[key, source[key]]] : []));
}

function sanitizeWorkspaceProvisioningRecord(value: unknown) {
  const source = objectRecord(value);
  const updatedAt = typeof source?.updatedAt === "string" ? Date.parse(source.updatedAt) : Number.NaN;
  if (source?.status === "consumed") {
    return {
      id: source.id,
      status: "consumed",
      operationId: source.operationId,
      createdAt: source.createdAt,
      updatedAt: source.updatedAt,
      expiresAt: source.expiresAt,
    };
  }
  const input = sanitizeGitWorkspaceProvisioningInput(source?.input);
  return {
    id: source?.id,
    status: "pending",
    input: input.success ? input.data : source?.input,
    createdAt: source?.createdAt,
    updatedAt: source?.updatedAt,
    // Compatibility for pre-release records. v0.0.21 had no managed Git records.
    expiresAt: source?.expiresAt || (Number.isFinite(updatedAt) ? new Date(updatedAt + WORKSPACE_PROVISIONING_TTL_MS).toISOString() : source?.updatedAt),
  };
}

function staleRevision(kind: string, id: string) {
  return Object.assign(new Error(`Refusing stale ${kind} revision for ${id}.`), {
    code: "GIT_CREDENTIAL_REVISION_STALE",
    statusCode: 409,
  });
}

function conflictingRevision(kind: string, id: string) {
  return Object.assign(new Error(`Refusing conflicting ${kind} revision for ${id}.`), {
    code: "GIT_CREDENTIAL_REVISION_CONFLICT",
    statusCode: 409,
  });
}

export class NodeGitCredentialStore {
  private readonly payloads: JsonCollection<PayloadRecord>;
  private readonly legacyAssignments: JsonCollection<LegacyAssignmentRecord>;
  private readonly authorizationSets: JsonCollection<AuthorizationSetRecord>;
  private readonly workspaceProvisioning: JsonCollection<z.infer<typeof WorkspaceProvisioningRecordSchema>>;
  private readonly workspaceProvisioningTtlMs: number;
  private workspaceProvisioningCleanupTimer?: NodeJS.Timeout;

  constructor(paths: NodeAgentStorePaths, options: { workspaceProvisioningTtlMs?: number } = {}) {
    this.workspaceProvisioningTtlMs = options.workspaceProvisioningTtlMs ?? WORKSPACE_PROVISIONING_TTL_MS;
    this.payloads = new JsonCollection(paths.gitCredentialPayloadsDir, {
      schema: PayloadRecordSchema,
      sanitize: sanitizePayloadRecord,
      directoryMode: 0o700,
      fileMode: 0o600,
    });
    this.legacyAssignments = new JsonCollection(paths.gitCredentialAssignmentsDir, {
      schema: LegacyAssignmentRecordSchema,
      sanitize: sanitizeLegacyAssignmentRecord,
      directoryMode: 0o700,
      fileMode: 0o600,
    });
    this.authorizationSets = new JsonCollection(paths.gitCredentialAuthorizationSetsDir, {
      schema: AuthorizationSetRecordSchema,
      sanitize: sanitizeAuthorizationSetRecord,
      directoryMode: 0o700,
      fileMode: 0o600,
    });
    this.workspaceProvisioning = new JsonCollection(paths.gitWorkspaceProvisioningIntentsDir, {
      schema: WorkspaceProvisioningRecordSchema,
      sanitize: sanitizeWorkspaceProvisioningRecord,
      directoryMode: 0o700,
      fileMode: 0o600,
    });
  }

  init() {
    this.payloads.init();
    this.legacyAssignments.init();
    this.authorizationSets.init();
    this.workspaceProvisioning.init();
    for (const record of this.workspaceProvisioning.list()) {
      if ((record.status === "pending" && !isOperationOnlyProvisioning(record.input)) || Date.parse(record.expiresAt) <= Date.now()) {
        this.workspaceProvisioning.delete(record.id);
      }
    }
    this.scheduleWorkspaceProvisioningCleanup();
    // Compatibility for pre-release managed Git snapshots: collapse effective per-credential
    // assignments into one atomic desired set. v0.0.21 had no managed Git credential records.
    const instanceIds = new Set(this.legacyAssignments.list().map((item) => item.instanceId));
    for (const instanceId of instanceIds) {
      if (this.authorizationSets.get(instanceId)) continue;
      const assignments = this.legacyAssignments.list().filter((item) => item.instanceId === instanceId);
      const timestamp = new Date().toISOString();
      this.putAuthorizationSet({
        instanceId,
        generation: Math.max(0, ...assignments.map((item) => item.assignmentRevision)),
        credentialIds: assignments.filter((item) => item.status !== "revoking" && item.status !== "revoked").map((item) => item.credentialId),
        updatedAt: timestamp,
      });
    }
  }

  putPayload(value: unknown) {
    const payload = NodeGitCredentialPayloadSchema.parse(value);
    const current = this.payloads.get(payload.credential.id);
    if (current && current.payload.credential.revision > payload.credential.revision) throw staleRevision("payload", payload.credential.id);
    if (current && current.payload.credential.revision === payload.credential.revision
      && JSON.stringify(current.payload) !== JSON.stringify(payload)) throw conflictingRevision("payload", payload.credential.id);
    const timestamp = new Date().toISOString();
    return this.payloads.put({ id: payload.credential.id, payload, createdAt: current?.createdAt || timestamp, updatedAt: timestamp }).payload;
  }

  getPayload(credentialId: string) {
    return this.payloads.get(credentialId)?.payload;
  }

  putAuthorizationSet(value: unknown) {
    const desired = NodeGitCredentialAuthorizationSetSchema.parse(value);
    const current = this.authorizationSets.get(desired.instanceId);
    if (current && current.generation > desired.generation) throw staleRevision("authorization set", desired.instanceId);
    if (current && current.generation === desired.generation) {
      const currentIds = JSON.stringify(current.credentialIds);
      if (currentIds !== JSON.stringify(desired.credentialIds)) throw conflictingRevision("authorization set", desired.instanceId);
      return this.publicAuthorizationSet(current);
    }
    for (const credentialId of desired.credentialIds) {
      if (!this.payloads.get(credentialId)) {
        throw Object.assign(new Error(`Credential payload ${credentialId} is not deployed.`), {
          code: "GIT_CREDENTIAL_PAYLOAD_MISSING",
          statusCode: 409,
        });
      }
    }
    const timestamp = new Date().toISOString();
    return this.publicAuthorizationSet(this.authorizationSets.put({
      id: desired.instanceId,
      ...desired,
      createdAt: current?.createdAt || timestamp,
    }));
  }

  getAuthorizationSet(instanceId: string): NodeGitCredentialAuthorizationSet {
    const current = this.authorizationSets.get(instanceId);
    return current ? this.publicAuthorizationSet(current) : { instanceId, generation: 0, credentialIds: [], updatedAt: new Date(0).toISOString() };
  }

  resolve(instanceId: string, remoteUrl: string) {
    const authorization = this.getAuthorizationSet(instanceId);
    const payloads = authorization.credentialIds.flatMap((id) => {
      const payload = this.getPayload(id);
      return payload ? [payload] : [];
    });
    const match = resolveGitCredential(remoteUrl, payloads.map((payload) => ({
      id: payload.credential.id,
      kind: payload.credential.kind,
      scope: payload.credential.scope,
      status: payload.credential.status,
      pinnedKnownHosts: payload.secret.kind === "ssh-key" && Boolean(payload.secret.pinnedKnownHosts.trim()),
    })));
    const payload = match.status === "unique" ? payloads.find((item) => item.credential.id === match.credential.id) : undefined;
    return { match, payload };
  }

  removePayload(credentialId: string) {
    if (this.authorizationSets.list().some((set) => set.credentialIds.includes(credentialId))) {
      throw Object.assign(new Error(`Credential payload ${credentialId} is still authorized.`), { code: "GIT_CREDENTIAL_PAYLOAD_IN_USE", statusCode: 409 });
    }
    return this.payloads.delete(credentialId);
  }

  collectUnreferencedPayloads() {
    const referenced = new Set(this.authorizationSets.list().flatMap((set) => set.credentialIds));
    let removed = 0;
    for (const payload of this.payloads.list()) if (!referenced.has(payload.id) && this.payloads.delete(payload.id)) removed += 1;
    return removed;
  }

  removeInstance(instanceId: string) {
    const removed = this.authorizationSets.delete(instanceId) ? 1 : 0;
    this.workspaceProvisioning.delete(instanceId);
    this.scheduleWorkspaceProvisioningCleanup();
    for (const assignment of this.legacyAssignments.list().filter((item) => item.instanceId === instanceId)) this.legacyAssignments.delete(assignment.id);
    return removed;
  }

  putWorkspaceProvisioning(value: unknown): GitWorkspaceProvisioningInput {
    const input = GitWorkspaceProvisioningInputSchema.parse(value);
    if (!isOperationOnlyProvisioning(input)) {
      throw Object.assign(new Error("Only operation-only Git provisioning may be persisted."), {
        code: "GIT_CREDENTIAL_PROVISIONING_RETENTION_INVALID",
        statusCode: 400,
      });
    }
    const current = this.workspaceProvisioning.get(input.instanceId);
    if (current?.status === "consumed" && current.operationId === input.operationId) return input;
    const timestamp = new Date().toISOString();
    const stored = PendingWorkspaceProvisioningRecordSchema.parse(this.workspaceProvisioning.put({
      id: input.instanceId,
      status: "pending",
      input,
      createdAt: current?.createdAt || timestamp,
      updatedAt: timestamp,
      expiresAt: new Date(Date.now() + this.workspaceProvisioningTtlMs).toISOString(),
    })).input;
    this.scheduleWorkspaceProvisioningCleanup();
    return stored;
  }

  getWorkspaceProvisioning(instanceId: string) {
    const record = this.workspaceProvisioning.get(instanceId);
    if (!record || record.status !== "pending") return undefined;
    if (!isOperationOnlyProvisioning(record.input) || Date.parse(record.expiresAt) <= Date.now()) {
      this.workspaceProvisioning.delete(instanceId);
      this.scheduleWorkspaceProvisioningCleanup();
      return undefined;
    }
    return record.input;
  }

  removeWorkspaceProvisioning(instanceId: string) {
    const removed = this.workspaceProvisioning.delete(instanceId);
    this.scheduleWorkspaceProvisioningCleanup();
    return removed;
  }

  discardPendingWorkspaceProvisioning(instanceId: string) {
    const record = this.workspaceProvisioning.get(instanceId);
    if (!record || record.status !== "pending") return false;
    return this.removeWorkspaceProvisioning(instanceId);
  }

  completeWorkspaceProvisioning(instanceId: string, operationId: string) {
    const current = this.workspaceProvisioning.get(instanceId);
    if (!current || current.status !== "pending" || current.input.operationId !== operationId) return false;
    const timestamp = new Date().toISOString();
    this.workspaceProvisioning.put({
      id: instanceId,
      status: "consumed",
      operationId,
      createdAt: current.createdAt,
      updatedAt: timestamp,
      expiresAt: new Date(Date.now() + WORKSPACE_PROVISIONING_RECEIPT_TTL_MS).toISOString(),
    });
    this.scheduleWorkspaceProvisioningCleanup();
    return true;
  }

  workspaceProvisioningStatus(instanceId: string) {
    const record = this.workspaceProvisioning.get(instanceId);
    if (!record) return undefined;
    if (Date.parse(record.expiresAt) <= Date.now()) {
      this.removeWorkspaceProvisioning(instanceId);
      return undefined;
    }
    return record.status === "pending"
      ? { status: record.status, operationId: record.input.operationId } as const
      : { status: record.status, operationId: record.operationId } as const;
  }

  private scheduleWorkspaceProvisioningCleanup() {
    if (this.workspaceProvisioningCleanupTimer) clearTimeout(this.workspaceProvisioningCleanupTimer);
    this.workspaceProvisioningCleanupTimer = undefined;
    const deadline = Math.min(...this.workspaceProvisioning.list().map((record) => Date.parse(record.expiresAt)));
    if (!Number.isFinite(deadline)) return;
    this.workspaceProvisioningCleanupTimer = setTimeout(() => {
      this.workspaceProvisioningCleanupTimer = undefined;
      const timestamp = Date.now();
      for (const record of this.workspaceProvisioning.list()) {
        if (Date.parse(record.expiresAt) <= timestamp) this.workspaceProvisioning.delete(record.id);
      }
      this.scheduleWorkspaceProvisioningCleanup();
    }, Math.max(0, deadline - Date.now()));
    this.workspaceProvisioningCleanupTimer.unref?.();
  }

  // Temporary compatibility surface for tests and an in-flight pre-release control-plane.
  listAssignments(instanceId?: string): InstanceGitCredentialAssignment[] {
    return this.legacyAssignments.list()
      .filter((item) => !instanceId || item.instanceId === instanceId)
      .map(({ id: _id, createdAt: _createdAt, ...item }) => InstanceGitCredentialAssignmentSchema.parse(item));
  }

  private publicAuthorizationSet(record: AuthorizationSetRecord): NodeGitCredentialAuthorizationSet {
    const { id: _id, createdAt: _createdAt, ...value } = record;
    return NodeGitCredentialAuthorizationSetSchema.parse(value);
  }
}

function isOperationOnlyProvisioning(input: GitWorkspaceProvisioningInput) {
  return input.credentials.length > 0 && input.credentials.every((credential) => credential.retention === "operation-only");
}

export type { NodeGitCredentialPayload };
