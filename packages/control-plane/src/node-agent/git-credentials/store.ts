import { z } from "zod";
import {
  InstanceGitCredentialAssignmentSchema,
  NodeGitCredentialAuthorizationSetSchema,
  NodeGitCredentialPayloadSchema,
  resolveGitCredential,
  sanitizeGitCredentialPublic,
  type InstanceGitCredentialAssignment,
  type NodeGitCredentialAuthorizationSet,
  type NodeGitCredentialPayload,
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

  constructor(paths: NodeAgentStorePaths) {
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
  }

  init() {
    this.payloads.init();
    this.legacyAssignments.init();
    this.authorizationSets.init();
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
    for (const assignment of this.legacyAssignments.list().filter((item) => item.instanceId === instanceId)) this.legacyAssignments.delete(assignment.id);
    return removed;
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

export type { NodeGitCredentialPayload };
