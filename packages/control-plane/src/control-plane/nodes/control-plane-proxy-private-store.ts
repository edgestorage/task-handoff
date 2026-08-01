import path from "node:path";
import { z } from "zod";
import {
  PendingProxyClaimSchema,
  ProxyNodeCredentialSchema,
  type PendingProxyClaim,
  type ProxyNodeCredential,
  type PublicPendingProxyClaim,
} from "@task-handoff/protocol/control-plane-proxy";
import { createId, JsonCollection, JsonFile } from "../../shared/persistence/store.ts";

export type ControlPlaneProxyPrivateStorePaths = {
  pendingClaimsDir: string;
  nodeCredentialsDir: string;
  identityPath: string;
};

export type ControlPlaneProxyPrivateStoreLogger = (message: string, details: Record<string, unknown>) => void;

const pendingClaimFields = new Set(Object.keys(PendingProxyClaimSchema.shape));
const nodeCredentialFields = new Set(Object.keys(ProxyNodeCredentialSchema.shape));

function sanitizeStoredObject(input: unknown, fields: Set<string>, onWarning?: (fields: string[]) => void) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return input;
  const source = input as Record<string, unknown>;
  const unknown = Object.keys(source).filter((key) => !fields.has(key));
  if (unknown.length) onWarning?.(unknown);
  return Object.fromEntries([...fields].filter((key) => key in source).map((key) => [key, source[key]]));
}

export function sanitizeStoredPendingProxyClaim(input: unknown, onWarning?: (fields: string[]) => void) {
  return sanitizeStoredObject(input, pendingClaimFields, onWarning);
}

export function sanitizeStoredProxyNodeCredential(input: unknown, onWarning?: (fields: string[]) => void) {
  return sanitizeStoredObject(input, nodeCredentialFields, onWarning);
}

export function publicPendingProxyClaim(record: PendingProxyClaim): PublicPendingProxyClaim {
  const { credential: _credential, ...receipt } = record;
  return receipt;
}

export function controlPlaneProxyPrivateStorePaths(dataDir: string): ControlPlaneProxyPrivateStorePaths {
  const root = path.resolve(dataDir, "control-plane-proxy");
  return {
    pendingClaimsDir: path.join(root, "pending-claims"),
    nodeCredentialsDir: path.join(root, "node-credentials"),
    identityPath: path.join(root, "identity.json"),
  };
}

export class ControlPlaneProxyPrivateStore {
  readonly pendingClaims: JsonCollection<PendingProxyClaim>;
  readonly nodeCredentials: JsonCollection<ProxyNodeCredential>;
  readonly identity: JsonFile<{ controlPlaneId: string }>;

  constructor(paths: ControlPlaneProxyPrivateStorePaths, logger?: ControlPlaneProxyPrivateStoreLogger) {
    this.pendingClaims = new JsonCollection(paths.pendingClaimsDir, {
      schema: PendingProxyClaimSchema,
      sanitize: (input) => sanitizeStoredPendingProxyClaim(input, (fields) => logger?.("unknown stored pending proxy claim fields were ignored", { fields })),
      logger,
      directoryMode: 0o700,
      fileMode: 0o600,
    });
    this.nodeCredentials = new JsonCollection(paths.nodeCredentialsDir, {
      schema: ProxyNodeCredentialSchema,
      sanitize: (input) => sanitizeStoredProxyNodeCredential(input, (fields) => logger?.("unknown stored proxy node credential fields were ignored", { fields })),
      logger,
      directoryMode: 0o700,
      fileMode: 0o600,
    });
    this.identity = new JsonFile(paths.identityPath, () => ({ controlPlaneId: createId("control_plane") }), {
      schema: z.object({ controlPlaneId: z.string().trim().min(1).max(160) }).strip(),
      logger,
      directoryMode: 0o700,
      fileMode: 0o600,
    });
  }

  init(now = Date.now()) {
    this.pendingClaims.init();
    this.nodeCredentials.init();
    this.identity.init();
    return this.gcPendingClaims(now);
  }

  controlPlaneId() {
    return this.identity.get().controlPlaneId;
  }

  pendingClaimByClaimId(claimId: string) {
    return this.pendingClaims.list().find((record) => record.claimId === claimId);
  }

  putPendingClaim(record: PendingProxyClaim) {
    const existing = this.pendingClaimByClaimId(record.claimId);
    if (!existing) return this.pendingClaims.put(record);
    const sameIdentity = existing.proxyOrigin === record.proxyOrigin
      && existing.requestedName === record.requestedName
      && existing.sourceControlPlaneId === record.sourceControlPlaneId
      && existing.targetNodeId === record.targetNodeId
      && existing.bindingKeyId === record.bindingKeyId
      && existing.credential === record.credential;
    if (!sameIdentity) {
      const error = new Error("Pending proxy claim identity conflicts with an existing claim.");
      Object.assign(error, { code: "CONTROL_PLANE_PROXY_BINDING_IDENTITY_CONFLICT", statusCode: 409 });
      throw error;
    }
    return existing;
  }

  publicPendingClaims() {
    return this.pendingClaims.list().map(publicPendingProxyClaim);
  }

  nodeCredential(nodeId: string) {
    return this.nodeCredentials.list().find((record) => record.nodeId === nodeId);
  }

  putNodeCredential(record: ProxyNodeCredential) {
    const existing = this.nodeCredential(record.nodeId);
    if (existing && (existing.proxyOrigin !== record.proxyOrigin
      || existing.proxyBindingId !== record.proxyBindingId
      || existing.targetNodeId !== record.targetNodeId
      || existing.sourceControlPlaneId !== record.sourceControlPlaneId
      || existing.bindingKeyId !== record.bindingKeyId
      || existing.credential !== record.credential)) {
      const error = new Error("Proxy node credential conflicts with the existing node identity.");
      Object.assign(error, { code: "CONTROL_PLANE_PROXY_NODE_IDENTITY_CONFLICT", statusCode: 409 });
      throw error;
    }
    return existing || this.nodeCredentials.put(record);
  }

  deleteNodeCredential(nodeId: string) {
    const credential = this.nodeCredential(nodeId);
    return credential ? this.nodeCredentials.delete(credential.id) : false;
  }

  gcNodeCredentials(isCurrent: (credential: ProxyNodeCredential) => boolean) {
    const deleted: string[] = [];
    for (const credential of this.nodeCredentials.list()) {
      if (isCurrent(credential)) continue;
      this.nodeCredentials.delete(credential.id);
      deleted.push(credential.id);
    }
    return deleted;
  }

  promotePendingClaim(claimId: string, credential: ProxyNodeCredential) {
    const pending = this.pendingClaimByClaimId(claimId);
    if (!pending) return undefined;
    if (pending.proxyOrigin !== credential.proxyOrigin
      || pending.sourceControlPlaneId !== credential.sourceControlPlaneId
      || (pending.targetNodeId !== undefined && pending.targetNodeId !== credential.targetNodeId)
      || pending.bindingKeyId !== credential.bindingKeyId
      || pending.credential !== credential.credential) {
      const error = new Error("Proxy node credential does not match the pending claim identity.");
      Object.assign(error, { code: "CONTROL_PLANE_PROXY_BINDING_IDENTITY_CONFLICT", statusCode: 409 });
      throw error;
    }
    const saved = this.putNodeCredential(credential);
    this.pendingClaims.delete(pending.id);
    return saved;
  }

  markCompensationRequired(claimId: string) {
    const pending = this.pendingClaimByClaimId(claimId);
    if (!pending) return undefined;
    return this.pendingClaims.patch(pending.id, { status: "compensation-required" });
  }

  cancelPendingClaim(claimId: string, remoteCommitPossible: boolean) {
    const pending = this.pendingClaimByClaimId(claimId);
    if (!pending) return { deleted: false, compensationRequired: false };
    if (remoteCommitPossible) {
      this.pendingClaims.patch(pending.id, { status: "compensation-required" });
      return { deleted: false, compensationRequired: true };
    }
    return { deleted: this.pendingClaims.delete(pending.id), compensationRequired: false };
  }

  completePendingClaimCompensation(claimId: string) {
    const pending = this.pendingClaimByClaimId(claimId);
    if (!pending || pending.status !== "compensation-required") return false;
    return this.pendingClaims.delete(pending.id);
  }

  gcPendingClaims(now = Date.now()) {
    const deleted: string[] = [];
    for (const pending of this.pendingClaims.list()) {
      if (pending.status === "compensation-required") continue;
      const expiresAt = Date.parse(pending.expiresAt);
      if (!Number.isFinite(expiresAt) || expiresAt > now) continue;
      this.pendingClaims.delete(pending.id);
      deleted.push(pending.id);
    }
    return deleted;
  }
}
