import {
  ClaimProxyInviteResultSchema,
  CONTROL_PLANE_PROXY_PROTOCOL_VERSION,
  ControlPlaneProxyErrorCode,
  ControlPlaneProxyOriginSchema,
  PublicProxyBindingSchema,
  type ControlPlaneProxyError,
  type PendingProxyClaim,
  type ProxyNodeCredential,
  type ProxyTargetEvent,
  type ProxyTargetSnapshot,
} from "@task-handoff/protocol/control-plane-proxy";
import { NodeSchema, type Node } from "@task-handoff/protocol/control-plane";
import { z } from "zod";
import { createId, createSecret, type JsonCollection } from "../../shared/persistence/store.ts";
import { publicNode } from "../public-records.ts";
import { now, throwNotFound } from "../application/helpers.ts";
import { controlPlaneProxyAuthenticationHeaders } from "./control-plane-proxy-transport.ts";
import type { ControlPlaneProxyPrivateStore } from "./control-plane-proxy-private-store.ts";

const CreateProxyNodeClaimInputSchema = z.object({
  proxyOrigin: ControlPlaneProxyOriginSchema,
  inviteToken: z.string().trim().min(24).max(512),
  name: z.string().trim().min(1).max(160).optional(),
}).strict();

const ProxyBindingRevocationResponseSchema = z.object({
  data: z.object({
    binding: PublicProxyBindingSchema,
    closed: z.object({
      abortedRequests: z.number().int().nonnegative(),
      closedSockets: z.number().int().nonnegative(),
    }).strict(),
  }).strict(),
}).strict();

type ProxyIdentityPatch = Pick<Partial<Node>, "connectionMode" | "connectionPath" | "auth">;

type ControlPlaneProxyLifecycleOptions = {
  nodes: JsonCollection<Node>;
  privateStore: ControlPlaneProxyPrivateStore;
  fetchImpl: typeof fetch;
  requireNode: (id: string) => Node;
  deleteNode: (id: string) => boolean;
};

export class ControlPlaneProxyLifecycle {
  private readonly claimOperations = new Map<string, Promise<unknown>>();
  private readonly options: ControlPlaneProxyLifecycleOptions;

  constructor(options: ControlPlaneProxyLifecycleOptions) {
    this.options = options;
  }

  listPendingClaims() {
    return this.options.privateStore.publicPendingClaims();
  }

  async claimNode(input: unknown) {
    const parsed = CreateProxyNodeClaimInputSchema.parse(input);
    const timestamp = now();
    const claimId = createId("proxy_claim");
    const pending: PendingProxyClaim = {
      id: claimId,
      claimId,
      proxyOrigin: parsed.proxyOrigin,
      ...(parsed.name ? { requestedName: parsed.name } : {}),
      sourceControlPlaneId: this.options.privateStore.controlPlaneId(),
      bindingKeyId: createId("proxy_key"),
      credential: createSecret(),
      status: "pending",
      createdAt: timestamp,
      updatedAt: timestamp,
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1_000).toISOString(),
    };
    this.options.privateStore.putPendingClaim(pending);
    return this.withClaimLock(pending.claimId, () => this.completeClaim(pending, parsed.inviteToken));
  }

  async resumeClaim(claimId: string) {
    return this.withClaimLock(claimId, async () => {
      const pending = this.options.privateStore.pendingClaimByClaimId(claimId);
      if (!pending) throwNotFound("CONTROL_PLANE_PROXY_CLAIM_NOT_FOUND", `Proxy claim ${claimId} was not found.`);
      return this.completeClaim(pending);
    });
  }

  async cancelClaim(claimId: string) {
    return this.withClaimLock(claimId, async () => {
      const pending = this.options.privateStore.pendingClaimByClaimId(claimId);
      if (!pending) return { deleted: false, compensationRequired: false, remoteRevoke: "not-required" as const };
      if (pending.status === "pending") {
        return { ...this.options.privateStore.cancelPendingClaim(claimId, false), remoteRevoke: "not-required" as const };
      }

      let response: Response;
      try {
        response = await this.requestClaim(pending);
      } catch (cause) {
        throw this.compensationError(pending, "Trusted control-plane proxy is unavailable; claim cancellation requires retry.", cause);
      }
      const payload = await this.responsePayload(response);
      if (!response.ok) {
        const code = payload?.error?.code;
        if (code === ControlPlaneProxyErrorCode.InviteInvalid || code === ControlPlaneProxyErrorCode.BindingRevoked) {
          return {
            deleted: this.options.privateStore.completePendingClaimCompensation(claimId),
            compensationRequired: false,
            remoteRevoke: code === ControlPlaneProxyErrorCode.BindingRevoked ? "already-revoked" as const : "not-created" as const,
          };
        }
        throw this.compensationError(
          pending,
          payload?.error?.message || `Proxy claim recovery failed with HTTP ${response.status}.`,
          undefined,
          response.status,
          code,
          payload?.error?.retryable,
        );
      }

      const result = ClaimProxyInviteResultSchema.parse(payload?.data);
      this.requireClaimResultIdentity(pending, result);
      const credential = this.compensationCredential(pending, result);
      let revoke: Response;
      try {
        revoke = await this.revokeBinding(credential);
      } catch (cause) {
        throw this.compensationError(pending, "Trusted control-plane proxy is unavailable; binding revocation requires retry.", cause);
      }
      const revokePayload = await this.responsePayload(revoke);
      if (!revoke.ok && revokePayload?.error?.code !== ControlPlaneProxyErrorCode.BindingRevoked) {
        throw this.compensationError(
          pending,
          revokePayload?.error?.message || `Proxy binding revoke failed with HTTP ${revoke.status}.`,
          undefined,
          revoke.status,
          revokePayload?.error?.code,
          revokePayload?.error?.retryable,
        );
      }
      if (revoke.ok) {
        try {
          this.requireRevocationReceipt(revokePayload, credential);
        } catch (cause) {
          throw this.compensationError(
            pending,
            "Proxy binding revocation returned an invalid receipt; compensation requires retry.",
            cause,
            502,
            ControlPlaneProxyErrorCode.TransportFailed,
            true,
          );
        }
      }
      return {
        deleted: this.options.privateStore.completePendingClaimCompensation(claimId),
        compensationRequired: false,
        remoteRevoke: revoke.ok ? "revoked" as const : "already-revoked" as const,
      };
    });
  }

  applyTargetSnapshot(nodeId: string, snapshot: ProxyTargetSnapshot) {
    const node = this.requireProxyNodeIdentity(nodeId, snapshot.binding.id, snapshot.binding.targetNodeId);
    return this.putTargetState(node, snapshot.target, {
      reachability: "reachable",
      bindingStatus: snapshot.binding.status,
      bindingRevision: snapshot.binding.revision,
      streamId: snapshot.streamId,
      revision: snapshot.revision,
      observedAt: snapshot.observedAt,
    });
  }

  applyTargetEvent(nodeId: string, event: ProxyTargetEvent) {
    const node = this.requireProxyNodeIdentity(nodeId, undefined, event.targetNodeId);
    const state = node.proxyState;
    if (!state?.streamId || state.streamId !== event.streamId || state.revision === undefined || event.revision !== state.revision + 1) {
      const error = new Error("Proxy target event does not continue the authoritative snapshot cursor.");
      Object.assign(error, { code: ControlPlaneProxyErrorCode.SnapshotRequired, statusCode: 409, retryable: true });
      throw error;
    }
    return this.putTargetState(node, event.target, {
      ...state,
      reachability: "reachable",
      bindingStatus: state.bindingStatus === "revoked" ? "revoked" : "active",
      revision: event.revision,
      observedAt: event.event.createdAt,
    });
  }

  markUnavailable(nodeId: string, error: ControlPlaneProxyError) {
    const node = this.requireProxyNodeIdentity(nodeId);
    const timestamp = now();
    return this.options.nodes.put(NodeSchema.parse({
      ...node,
      status: "degraded",
      health: "degraded",
      proxyState: {
        ...node.proxyState,
        reachability: "unreachable",
        bindingStatus: node.proxyState?.bindingStatus ?? "unknown",
        lastError: error,
        updatedAt: timestamp,
      },
      updatedAt: timestamp,
    }));
  }

  markBindingRevoked(nodeId: string, error: ControlPlaneProxyError) {
    const node = this.requireProxyNodeIdentity(nodeId);
    const timestamp = now();
    return this.options.nodes.put(NodeSchema.parse({
      ...node,
      status: "degraded",
      health: "degraded",
      proxyState: {
        ...node.proxyState,
        reachability: "reachable",
        bindingStatus: "revoked",
        lastError: error,
        updatedAt: timestamp,
      },
      updatedAt: timestamp,
    }));
  }

  assertIdentityPatch(current: Node, input: ProxyIdentityPatch) {
    const nextMode = input.connectionMode ?? current.connectionMode;
    const nextPath = input.connectionPath ?? current.connectionPath;
    const nextAuth = input.auth ?? current.auth;
    const currentIsProxy = current.connectionMode === "control-plane-proxy"
      || current.connectionPath.kind === "control-plane-proxy"
      || current.auth.mode === "proxy-binding";
    const nextIsProxy = nextMode === "control-plane-proxy"
      || nextPath.kind === "control-plane-proxy"
      || nextAuth.mode === "proxy-binding";
    const changed = nextMode !== current.connectionMode
      || JSON.stringify(nextPath) !== JSON.stringify(current.connectionPath)
      || JSON.stringify(nextAuth) !== JSON.stringify(current.auth);
    if ((currentIsProxy || nextIsProxy) && changed) {
      const error = new Error("Proxy node connection identity can only be changed through the control-plane proxy lifecycle API.");
      Object.assign(error, { statusCode: 409, code: "CONTROL_PLANE_PROXY_IDENTITY_IMMUTABLE", retryable: false });
      throw error;
    }
  }

  async deleteNode(node: Node, force = false) {
    if (node.connectionMode !== "control-plane-proxy") {
      return { deleted: this.options.deleteNode(node.id), revoke: { mode: "not-proxied" as const, orphanRisk: false } };
    }
    const credential = this.options.privateStore.nodeCredential(node.id);
    if (!credential) {
      if (!force) {
        const error = new Error("Proxy node credential is missing; remote binding cannot be revoked.");
        Object.assign(error, {
          statusCode: 409,
          code: "CONTROL_PLANE_PROXY_CREDENTIAL_REQUIRED",
          retryable: false,
          details: { forceDeleteAllowed: true, forceDeleteReason: "credential-missing" },
        });
        throw error;
      }
      return this.forceDeleteNode(node.id);
    }

    let response: Response;
    try {
      response = await this.revokeBinding(credential);
    } catch (cause) {
      if (force) return this.forceDeleteNode(node.id);
      const error = new Error("Trusted control-plane proxy is unavailable; the binding was not revoked.", { cause });
      Object.assign(error, {
        statusCode: 503,
        code: "CONTROL_PLANE_PROXY_REVOKE_UNAVAILABLE",
        retryable: true,
        details: { forceDeleteAllowed: true, forceDeleteReason: "proxy-unavailable" },
      });
      throw error;
    }

    const payload = await this.responsePayload(response);
    if (!response.ok) {
      if (payload?.error?.code === ControlPlaneProxyErrorCode.BindingRevoked) {
        const bindingId = (payload.error.details as { bindingId?: unknown } | undefined)?.bindingId;
        if (bindingId === credential.proxyBindingId) return this.finishRevokedNodeDelete(node.id);
      }
      const error = new Error(payload?.error?.message || `Proxy binding revoke failed with HTTP ${response.status}.`);
      Object.assign(error, {
        statusCode: response.status,
        code: payload?.error?.code || "CONTROL_PLANE_PROXY_REVOKE_FAILED",
        retryable: payload?.error?.retryable ?? response.status >= 500,
        details: { ...objectDetails(payload?.error?.details), forceDeleteAllowed: false },
      });
      throw error;
    }

    try {
      this.requireRevocationReceipt(payload, credential);
    } catch (cause) {
      if (cause && typeof cause === "object") {
        const current = cause as { details?: Record<string, unknown> };
        current.details = { ...(current.details || {}), forceDeleteAllowed: false };
      }
      throw cause;
    }
    return this.finishRevokedNodeDelete(node.id);
  }

  private async completeClaim(pending: PendingProxyClaim, inviteToken?: string) {
    this.options.privateStore.markCompensationRequired(pending.claimId);
    let response: Response;
    try {
      response = await this.requestClaim(pending, inviteToken);
    } catch (cause) {
      const error = new Error(`Trusted control-plane proxy ${pending.proxyOrigin} is unavailable.`, { cause });
      Object.assign(error, { statusCode: 503, code: "CONTROL_PLANE_PROXY_UNAVAILABLE", retryable: true, claimId: pending.claimId });
      throw error;
    }
    const payload = await this.responsePayload(response);
    if (!response.ok) {
      const retryable = payload?.error?.retryable ?? response.status >= 500;
      if (!retryable) this.options.privateStore.completePendingClaimCompensation(pending.claimId);
      const error = new Error(payload?.error?.message || `Proxy claim failed with HTTP ${response.status}.`);
      Object.assign(error, {
        statusCode: response.status,
        code: payload?.error?.code || "CONTROL_PLANE_PROXY_CLAIM_FAILED",
        retryable,
        details: payload?.error?.details,
        claimId: pending.claimId,
      });
      throw error;
    }
    const result = ClaimProxyInviteResultSchema.parse(payload?.data);
    this.requireClaimResultIdentity(pending, result);
    const current = this.options.nodes.get(result.target.id);
    const sameIdentity = current?.connectionMode === "control-plane-proxy"
      && current.connectionPath.kind === "control-plane-proxy"
      && current.connectionPath.proxyBindingId === result.binding.id
      && current.connectionPath.targetNodeId === result.target.id;
    if (current && !sameIdentity) {
      this.options.privateStore.markCompensationRequired(pending.claimId);
      const error = new Error(`Node ${result.target.id} already exists with another connection identity.`);
      Object.assign(error, { statusCode: 409, code: "CONTROL_PLANE_PROXY_NODE_IDENTITY_CONFLICT", claimId: pending.claimId });
      throw error;
    }
    const credential: ProxyNodeCredential = {
      id: `proxy_credential_${result.target.id}`,
      nodeId: result.target.id,
      proxyOrigin: pending.proxyOrigin,
      proxyBindingId: result.binding.id,
      targetNodeId: result.target.id,
      sourceControlPlaneId: pending.sourceControlPlaneId,
      bindingKeyId: pending.bindingKeyId,
      credential: pending.credential,
      createdAt: pending.createdAt,
      updatedAt: now(),
    };
    const node = current || NodeSchema.parse({
      id: result.target.id,
      name: pending.requestedName || result.target.name,
      connectionMode: "control-plane-proxy",
      connectionPath: {
        kind: "control-plane-proxy",
        proxyId: new URL(pending.proxyOrigin).host,
        proxyBindingId: result.binding.id,
        targetNodeId: result.target.id,
      },
      connectionEnabled: true,
      auth: { mode: "proxy-binding" },
      status: result.target.status,
      health: result.target.health,
      capabilities: result.target.capabilities,
      proxyState: {
        reachability: "reachable",
        bindingStatus: result.binding.status,
        bindingRevision: result.binding.revision,
        observedAt: now(),
        target: result.target,
        updatedAt: now(),
      },
      labels: {},
      lastSeenAt: result.target.lastSeenAt,
      createdAt: now(),
      updatedAt: now(),
    });
    if (!current) this.options.nodes.put(node);
    try {
      this.options.privateStore.promotePendingClaim(pending.claimId, credential);
    } catch (error) {
      if (!current) this.options.nodes.delete(node.id);
      throw error;
    }
    return { node: publicNode(node), binding: result.binding };
  }

  private requireProxyNodeIdentity(nodeId: string, bindingId?: string, targetNodeId?: string) {
    const node = this.options.requireNode(nodeId);
    if (node.connectionMode !== "control-plane-proxy"
      || node.connectionPath.kind !== "control-plane-proxy"
      || (bindingId !== undefined && node.connectionPath.proxyBindingId !== bindingId)
      || (targetNodeId !== undefined && node.connectionPath.targetNodeId !== targetNodeId)) {
      const error = new Error("Proxy state identity does not match the node connection path.");
      Object.assign(error, { code: ControlPlaneProxyErrorCode.BindingIdentityConflict, statusCode: 409, retryable: false });
      throw error;
    }
    return node;
  }

  private putTargetState(
    node: Node,
    target: ProxyTargetSnapshot["target"],
    proxyState: Omit<NonNullable<Node["proxyState"]>, "target" | "lastError" | "updatedAt">,
  ) {
    const timestamp = now();
    return this.options.nodes.put(NodeSchema.parse({
      ...node,
      name: target.name,
      status: target.status,
      health: target.health,
      capabilities: target.capabilities,
      lastSeenAt: target.lastSeenAt,
      proxyState: { ...proxyState, target, updatedAt: timestamp },
      updatedAt: timestamp,
    }));
  }

  private requestClaim(pending: PendingProxyClaim, inviteToken?: string) {
    return this.options.fetchImpl(new URL("/api/node-proxy/claims", pending.proxyOrigin), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        protocolVersion: CONTROL_PLANE_PROXY_PROTOCOL_VERSION,
        ...(inviteToken ? { inviteToken } : {}),
        claimId: pending.claimId,
        sourceControlPlaneId: pending.sourceControlPlaneId,
        ...(pending.targetNodeId ? { targetNodeId: pending.targetNodeId } : {}),
        bindingKeyId: pending.bindingKeyId,
        credential: pending.credential,
      }),
    });
  }

  private revokeBinding(credential: ProxyNodeCredential) {
    return this.options.fetchImpl(new URL(`/api/node-proxy/bindings/${encodeURIComponent(credential.proxyBindingId)}`, credential.proxyOrigin), {
      method: "DELETE",
      headers: controlPlaneProxyAuthenticationHeaders(credential),
    });
  }

  private async responsePayload(response: Response) {
    return response.json().catch(() => undefined) as Promise<{
      data?: unknown;
      error?: { code?: string; message?: string; retryable?: boolean; details?: unknown };
    } | undefined>;
  }

  private requireRevocationReceipt(payload: unknown, credential: ProxyNodeCredential) {
    const parsed = ProxyBindingRevocationResponseSchema.safeParse(payload);
    const binding = parsed.success ? parsed.data.data.binding : undefined;
    if (!binding
      || binding.id !== credential.proxyBindingId
      || binding.sourceControlPlaneId !== credential.sourceControlPlaneId
      || binding.targetNodeId !== credential.targetNodeId
      || binding.bindingKeyId !== credential.bindingKeyId
      || binding.status !== "revoked") {
      const error = new Error("Proxy binding revocation receipt does not match the local binding identity.");
      Object.assign(error, {
        statusCode: 502,
        code: ControlPlaneProxyErrorCode.TransportFailed,
        retryable: true,
        details: { bindingId: credential.proxyBindingId },
      });
      throw error;
    }
    return binding;
  }

  private requireClaimResultIdentity(pending: PendingProxyClaim, result: ReturnType<typeof ClaimProxyInviteResultSchema.parse>) {
    if (result.binding.claimId !== pending.claimId
      || result.binding.sourceControlPlaneId !== pending.sourceControlPlaneId
      || result.binding.bindingKeyId !== pending.bindingKeyId
      || result.binding.targetNodeId !== result.target.id
      || (pending.targetNodeId !== undefined && result.binding.targetNodeId !== pending.targetNodeId)) {
      const error = new Error("Proxy claim response does not match the persisted pending identity.");
      Object.assign(error, {
        statusCode: 409,
        code: ControlPlaneProxyErrorCode.BindingIdentityConflict,
        retryable: false,
        claimId: pending.claimId,
        compensationRequired: true,
      });
      throw error;
    }
  }

  private compensationCredential(
    pending: PendingProxyClaim,
    result: ReturnType<typeof ClaimProxyInviteResultSchema.parse>,
  ): ProxyNodeCredential {
    return {
      id: `proxy_compensation_${result.binding.id}`,
      nodeId: result.target.id,
      proxyOrigin: pending.proxyOrigin,
      proxyBindingId: result.binding.id,
      targetNodeId: result.target.id,
      sourceControlPlaneId: pending.sourceControlPlaneId,
      bindingKeyId: pending.bindingKeyId,
      credential: pending.credential,
      createdAt: pending.createdAt,
      updatedAt: now(),
    };
  }

  private compensationError(
    pending: PendingProxyClaim,
    message: string,
    cause?: unknown,
    statusCode = 503,
    code = "CONTROL_PLANE_PROXY_COMPENSATION_REQUIRED",
    retryable = true,
  ) {
    const error = new Error(message, cause === undefined ? undefined : { cause });
    Object.assign(error, { statusCode, code, retryable, claimId: pending.claimId, compensationRequired: true });
    return error;
  }

  private async withClaimLock<T>(claimId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.claimOperations.get(claimId) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    this.claimOperations.set(claimId, current);
    try {
      return await current;
    } finally {
      if (this.claimOperations.get(claimId) === current) this.claimOperations.delete(claimId);
    }
  }

  private finishRevokedNodeDelete(id: string) {
    const deleted = this.options.deleteNode(id);
    this.options.privateStore.deleteNodeCredential(id);
    return { deleted, revoke: { mode: "revoked" as const, orphanRisk: false } };
  }

  private forceDeleteNode(id: string) {
    const deleted = this.options.deleteNode(id);
    this.options.privateStore.deleteNodeCredential(id);
    return { deleted, revoke: { mode: "forced" as const, orphanRisk: true } };
  }
}

function objectDetails(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
