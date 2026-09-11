import { z } from "zod";
import {
  NodeGitCredentialAuthorizationSetSchema,
  NodeGitCredentialPayloadSchema,
  GitWorkspaceProvisioningInputSchema,
  resolveGitCredential,
  type NodeGitCredentialAuthorizationSet,
  type NodeGitCredentialPayload,
  type GitWorkspaceProvisioningInput,
} from "@task-handoff/protocol/managed-git-credentials";
import type { NodeAgentStorePaths } from "../persistence/paths.ts";
import type { GitAuthorizationRecord, GitPayloadRecord, GitPersistenceRepository, GitProvisioningRecord } from "../persistence/git-repository.ts";
import { createNodeAgentRepository } from "../persistence/repository.ts";
import { openNodeAgentDatabaseSync } from "../persistence/database.ts";

const PendingWorkspaceProvisioningRecordSchema = z.object({
  id: z.string().trim().min(1).max(120),
  status: z.literal("pending"),
  input: GitWorkspaceProvisioningInputSchema,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
}).strict();

const WORKSPACE_PROVISIONING_TTL_MS = 24 * 60 * 60_000;
const WORKSPACE_PROVISIONING_RECEIPT_TTL_MS = 7 * 24 * 60 * 60_000;
const MAX_TIMER_DELAY_MS = 2_147_483_647;

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
  private readonly repository: GitPersistenceRepository;
  private readonly workspaceProvisioningTtlMs: number;
  private workspaceProvisioningCleanupTimer?: NodeJS.Timeout;

  constructor(paths: NodeAgentStorePaths, options: { workspaceProvisioningTtlMs?: number; repository?: GitPersistenceRepository } = {}) {
    this.workspaceProvisioningTtlMs = options.workspaceProvisioningTtlMs ?? WORKSPACE_PROVISIONING_TTL_MS;
    this.repository = options.repository || createNodeAgentRepository(openNodeAgentDatabaseSync(paths)).git;
  }

  init() {
    this.repository.deleteExpiredProvisioning(new Date().toISOString());
    this.scheduleWorkspaceProvisioningCleanup();
  }

  putPayload(value: unknown) {
    const payload = NodeGitCredentialPayloadSchema.parse(value);
    const current = this.repository.getPayload(payload.credential.id);
    if (current && current.payload.credential.revision > payload.credential.revision) throw staleRevision("payload", payload.credential.id);
    if (current && current.payload.credential.revision === payload.credential.revision
      && JSON.stringify(current.payload) !== JSON.stringify(payload)) throw conflictingRevision("payload", payload.credential.id);
    const timestamp = new Date().toISOString();
    return this.repository.putPayload({ id: payload.credential.id, payload, createdAt: current?.createdAt || timestamp, updatedAt: timestamp }).payload;
  }

  getPayload(credentialId: string) {
    return this.repository.getPayload(credentialId)?.payload;
  }

  putAuthorizationSet(value: unknown) {
    const desired = NodeGitCredentialAuthorizationSetSchema.parse(value);
    const current = this.repository.getAuthorization(desired.instanceId);
    const timestamp = new Date().toISOString();
    return this.publicAuthorizationSet(this.repository.putAuthorizationCas({
      id: desired.instanceId,
      ...desired,
      createdAt: current?.createdAt || timestamp,
    }));
  }

  getAuthorizationSet(instanceId: string): NodeGitCredentialAuthorizationSet {
    const current = this.repository.getAuthorization(instanceId);
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
    if (this.repository.listAuthorizations().some((set) => set.credentialIds.includes(credentialId))) {
      throw Object.assign(new Error(`Credential payload ${credentialId} is still authorized.`), { code: "GIT_CREDENTIAL_PAYLOAD_IN_USE", statusCode: 409 });
    }
    return this.repository.deletePayload(credentialId);
  }

  collectUnreferencedPayloads() {
    return this.repository.collectUnreferencedPayloads();
  }

  removeInstance(instanceId: string) {
    const removed = this.repository.deleteAuthorization(instanceId) ? 1 : 0;
    this.repository.deleteProvisioning(instanceId);
    this.scheduleWorkspaceProvisioningCleanup();
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
    const current = this.repository.getProvisioning(input.instanceId);
    if (current?.status === "consumed" && current.operationId === input.operationId) return input;
    const timestamp = new Date().toISOString();
    const stored = PendingWorkspaceProvisioningRecordSchema.parse(this.repository.putProvisioning({
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
    const record = this.repository.getProvisioning(instanceId);
    if (!record || record.status !== "pending") return undefined;
    if (!isOperationOnlyProvisioning(record.input) || Date.parse(record.expiresAt) <= Date.now()) {
      this.repository.deleteProvisioning(instanceId);
      this.scheduleWorkspaceProvisioningCleanup();
      return undefined;
    }
    return record.input;
  }

  removeWorkspaceProvisioning(instanceId: string) {
    const removed = this.repository.deleteProvisioning(instanceId);
    this.scheduleWorkspaceProvisioningCleanup();
    return removed;
  }

  discardPendingWorkspaceProvisioning(instanceId: string) {
    const record = this.repository.getProvisioning(instanceId);
    if (!record || record.status !== "pending") return false;
    return this.removeWorkspaceProvisioning(instanceId);
  }

  completeWorkspaceProvisioning(instanceId: string, operationId: string) {
    const timestamp = new Date().toISOString();
    const completed = this.repository.consumeProvisioning(
      instanceId,
      operationId,
      timestamp,
      new Date(Date.now() + WORKSPACE_PROVISIONING_RECEIPT_TTL_MS).toISOString(),
    );
    this.scheduleWorkspaceProvisioningCleanup();
    return completed;
  }

  workspaceProvisioningStatus(instanceId: string) {
    const record = this.repository.getProvisioning(instanceId);
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
    const deadline = Math.min(...this.repository.listProvisioning().map((record) => Date.parse(record.expiresAt)));
    if (!Number.isFinite(deadline)) return;
    this.workspaceProvisioningCleanupTimer = setTimeout(() => {
      this.workspaceProvisioningCleanupTimer = undefined;
      const timestamp = Date.now();
      this.repository.deleteExpiredProvisioning(new Date(timestamp).toISOString());
      this.scheduleWorkspaceProvisioningCleanup();
    }, Math.min(MAX_TIMER_DELAY_MS, Math.max(0, deadline - Date.now())));
    this.workspaceProvisioningCleanupTimer.unref?.();
  }

  private publicAuthorizationSet(record: GitAuthorizationRecord): NodeGitCredentialAuthorizationSet {
    const { id: _id, createdAt: _createdAt, ...value } = record;
    return NodeGitCredentialAuthorizationSetSchema.parse(value);
  }
}

function isOperationOnlyProvisioning(input: GitWorkspaceProvisioningInput) {
  return input.credentials.length > 0 && input.credentials.every((credential) => credential.retention === "operation-only");
}

export type { NodeGitCredentialPayload };
