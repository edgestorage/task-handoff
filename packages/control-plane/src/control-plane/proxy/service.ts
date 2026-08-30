import crypto from "node:crypto";
import {
  ClaimProxyInviteInputSchema,
  ClaimProxyInviteResultSchema,
  CONTROL_PLANE_PROXY_PROTOCOL_VERSION,
  ControlPlaneProxyErrorCode,
  ControlPlaneProxyOriginSchema,
  CreateProxyInviteInputSchema,
  CreateProxyInviteResultSchema,
  ProxyBindingAuthenticationSchema,
  ProxyTargetSnapshotSchema,
  type ProxyTargetSnapshot,
  type PublicProxyBinding,
  type PublicProxyInvite,
} from "@task-handoff/protocol/control-plane-proxy";
import { createId } from "../../shared/persistence/store.ts";
import { EphemeralTokenStore } from "../../shared/security/ephemeral-token-store.ts";
import { publicProxyBinding, publicProxyInvite, type ProxyBindingRecord, type ProxyInviteRecord } from "./records.ts";
import { ControlPlaneProxyStore } from "./store.ts";
import type { ControlPlaneProxyTarget } from "./target-projector.ts";

export type ControlPlaneProxyTargetDirectory = {
  get(nodeId: string): ControlPlaneProxyTarget | undefined;
};

export type ControlPlaneProxyServiceOptions = {
  proxyOrigin?: string;
  proxyOriginProvider?: () => string | undefined;
  now?: () => Date;
  createToken?: () => string;
};

export class ControlPlaneProxyServiceError extends Error {
  readonly code: string;
  readonly statusCode: number;
  readonly retryable: boolean;
  readonly details: Record<string, unknown>;

  constructor(code: string, message: string, statusCode: number, retryable = false, details: Record<string, unknown> = {}) {
    super(message);
    this.name = "ControlPlaneProxyServiceError";
    this.code = code;
    this.statusCode = statusCode;
    this.retryable = retryable;
    this.details = details;
  }
}

const hashSecret = (value: string) => crypto.createHash("sha256").update(value).digest("base64url");
const defaultCreateToken = () => crypto.randomBytes(32).toString("base64url");
const DEFAULT_PROXY_INVITE_TTL_MS = 10 * 60 * 1_000;

function secretMatches(expectedHash: string, value: string) {
  const actualHash = hashSecret(value);
  const expected = Buffer.from(expectedHash);
  const actual = Buffer.from(actualHash);
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

function proxyError(
  code: string,
  message: string,
  statusCode: number,
  retryable = false,
  details: Record<string, unknown> = {},
): never {
  throw new ControlPlaneProxyServiceError(code, message, statusCode, retryable, details);
}

function bindingIdForInvite(inviteId: string) {
  return `proxy_binding_${hashSecret(inviteId).slice(0, 32)}`;
}

export class ControlPlaneProxyService {
  readonly store: ControlPlaneProxyStore;
  private readonly targets: ControlPlaneProxyTargetDirectory;
  private readonly configuredProxyOrigin: string | undefined;
  private readonly proxyOriginProvider: (() => string | undefined) | undefined;
  private readonly now: () => Date;
  private readonly createTokenValue: () => string;
  private readonly invites = new EphemeralTokenStore<ProxyInviteRecord>();

  constructor(
    store: ControlPlaneProxyStore,
    targets: ControlPlaneProxyTargetDirectory,
    options: ControlPlaneProxyServiceOptions,
  ) {
    this.store = store;
    this.targets = targets;
    this.configuredProxyOrigin = options.proxyOrigin;
    this.proxyOriginProvider = options.proxyOriginProvider;
    this.now = options.now ?? (() => new Date());
    this.createTokenValue = options.createToken ?? defaultCreateToken;
  }

  init() {
    this.store.init();
  }

  createInvite(raw: unknown, createdBy: string) {
    const proxyOrigin = this.resolveProxyOrigin();
    if (!proxyOrigin) {
      proxyError(
        ControlPlaneProxyErrorCode.Unavailable,
        "Configure an externally reachable HTTPS control-plane proxy origin before creating an invite.",
        409,
        false,
      );
    }
    const input = CreateProxyInviteInputSchema.parse(raw);
    this.requireManageableTarget(input.targetNodeId);
    const token = this.createTokenValue();
    const timestamp = this.nowIso();
    const invite = {
      id: createId("proxy_invite"),
      targetNodeId: input.targetNodeId,
      tokenHash: hashSecret(token),
      status: "active",
      createdBy,
      expiresAt: new Date(this.now().getTime() + Math.min(input.expiresInSeconds * 1_000, DEFAULT_PROXY_INVITE_TTL_MS)).toISOString(),
      createdAt: timestamp,
      updatedAt: timestamp,
    } as ProxyInviteRecord;
    const result = CreateProxyInviteResultSchema.parse({
      invite: publicProxyInvite(invite),
      token,
      proxyOrigin,
      protocolVersion: CONTROL_PLANE_PROXY_PROTOCOL_VERSION,
    });
    this.invites.put(invite.tokenHash, invite, this.now().getTime());
    return result;
  }

  private resolveProxyOrigin() {
    const candidate = this.configuredProxyOrigin ?? this.proxyOriginProvider?.();
    if (!candidate) return undefined;
    const parsed = ControlPlaneProxyOriginSchema.safeParse(candidate);
    return parsed.success ? parsed.data : undefined;
  }

  listInvites(): PublicProxyInvite[] {
    return this.invites.list(this.now().getTime()).map(publicProxyInvite);
  }

  revokeInvite(id: string): PublicProxyInvite {
    const invite = this.listInviteRecords().find((candidate) => candidate.id === id);
    if (!invite) proxyError(ControlPlaneProxyErrorCode.InviteInvalid, "Proxy invite is unknown.", 404, false, { inviteId: id });
    const timestamp = this.nowIso();
    const updated: ProxyInviteRecord = {
      ...invite,
      status: "revoked",
      revokedAt: timestamp,
      updatedAt: timestamp,
    };
    this.invites.delete(invite.tokenHash, this.now().getTime());
    return publicProxyInvite(updated);
  }

  claimInvite(raw: unknown) {
    const input = ClaimProxyInviteInputSchema.parse(raw);
    this.requireCurrentProtocol(input.protocolVersion);
    const credentialHash = hashSecret(input.credential);
    const recovered = this.store.listBindings().find((binding) => binding.claimId === input.claimId);
    if (recovered) {
      this.requireRecoveredIdentity(recovered, input, credentialHash);
      return this.claimResult(recovered, this.requireKnownTarget(recovered.targetNodeId));
    }
    if (!input.inviteToken) proxyError(ControlPlaneProxyErrorCode.InviteInvalid, "Proxy invite token is required for the first claim.", 401);
    const inviteTokenHash = hashSecret(input.inviteToken);
    const invite = this.invites.peek(inviteTokenHash, this.now().getTime());
    if (!invite) proxyError(ControlPlaneProxyErrorCode.InviteInvalid, "Proxy invite is invalid or expired.", 401);
    if (input.targetNodeId && input.targetNodeId !== invite.targetNodeId) {
      proxyError(ControlPlaneProxyErrorCode.TargetMismatch, "Proxy invite is bound to a different target.", 409, false, {
        inviteId: invite.id,
        targetNodeId: input.targetNodeId,
      });
    }
    const target = this.requireManageableTarget(invite.targetNodeId);
    const result = this.store.transaction((draft) => {
      const bindingId = bindingIdForInvite(invite.id);
      const timestamp = this.nowIso();
      const binding: ProxyBindingRecord = {
        id: bindingId,
        claimId: input.claimId,
        sourceControlPlaneId: input.sourceControlPlaneId,
        targetNodeId: invite.targetNodeId,
        bindingKeyId: input.bindingKeyId,
        credentialHash,
        status: "active",
        revision: 1,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      draft.bindings.push(binding);
      return this.claimResult(binding, target);
    });
    // Consume only after every deterministic validation and the durable binding
    // transaction succeeds. A rejected claim must not burn a legitimate token.
    this.invites.delete(inviteTokenHash, this.now().getTime());
    return result;
  }

  listBindings(): PublicProxyBinding[] {
    return this.store.listBindings().map(publicProxyBinding);
  }

  authenticateBinding(bindingId: string, raw: unknown): PublicProxyBinding {
    const input = ProxyBindingAuthenticationSchema.parse(raw);
    const binding = this.store.getBinding(bindingId);
    if (!binding) proxyError(ControlPlaneProxyErrorCode.BindingUnknown, "Proxy binding is unknown.", 404, false, { bindingId });
    if (binding.status !== "active") {
      proxyError(ControlPlaneProxyErrorCode.BindingRevoked, "Proxy binding is revoked.", 403, false, { bindingId });
    }
    if (binding.sourceControlPlaneId !== input.sourceControlPlaneId
      || binding.bindingKeyId !== input.bindingKeyId
      || !secretMatches(binding.credentialHash, input.credential)) {
      proxyError(ControlPlaneProxyErrorCode.AuthenticationFailed, "Proxy binding authentication failed.", 401, false, { bindingId });
    }
    return publicProxyBinding(binding);
  }

  revokeBinding(id: string): PublicProxyBinding {
    const binding = this.requireBinding(id);
    if (binding.status === "revoked") return publicProxyBinding(binding);
    const timestamp = this.nowIso();
    const updated: ProxyBindingRecord = {
      ...binding,
      status: "revoked",
      revision: binding.revision + 1,
      revokedAt: timestamp,
      updatedAt: timestamp,
    };
    this.store.transaction((draft) => {
      draft.bindings = draft.bindings.filter((candidate) => candidate.id !== id);
    });
    return publicProxyBinding(updated);
  }

  revokeTarget(targetNodeId: string) {
    return this.store.transaction((draft) => {
      const timestamp = this.nowIso();
      const bindings = draft.bindings
        .filter((binding) => binding.targetNodeId === targetNodeId && binding.status === "active")
        .map((binding) => publicProxyBinding({
          ...binding,
            status: "revoked",
            revision: binding.revision + 1,
            revokedAt: timestamp,
            updatedAt: timestamp,
        }));
      draft.bindings = draft.bindings.filter((binding) => binding.targetNodeId !== targetNodeId);
      const invites = this.revokeTargetInvites(targetNodeId, timestamp);
      return { bindings, invites };
    });
  }

  private nowIso() {
    return this.now().toISOString();
  }

  private requireCurrentProtocol(version: string) {
    if (version !== CONTROL_PLANE_PROXY_PROTOCOL_VERSION) {
      proxyError(ControlPlaneProxyErrorCode.ProtocolUnsupported, "Control-plane proxy protocol version is unsupported.", 426, false, {
        requestedVersion: version,
        supportedVersion: CONTROL_PLANE_PROXY_PROTOCOL_VERSION,
      });
    }
  }

  private requireKnownTarget(nodeId: string) {
    const target = this.targets.get(nodeId);
    if (!target) proxyError(ControlPlaneProxyErrorCode.TargetUnavailable, "Proxy target no longer exists.", 404, false, { targetNodeId: nodeId });
    return target;
  }

  private requireManageableTarget(nodeId: string) {
    const target = this.requireKnownTarget(nodeId);
    if (!target.manageable || target.status !== "online") {
      proxyError(ControlPlaneProxyErrorCode.TargetUnavailable, "Proxy target is not currently manageable.", 503, true, { targetNodeId: nodeId });
    }
    return target;
  }

  private requireBinding(id: string) {
    const binding = this.store.getBinding(id);
    if (!binding) proxyError(ControlPlaneProxyErrorCode.BindingUnknown, "Proxy binding is unknown.", 404, false, { bindingId: id });
    return binding;
  }

  private requireRecoveredIdentity(
    binding: ProxyBindingRecord,
    input: ReturnType<typeof ClaimProxyInviteInputSchema.parse>,
    credentialHash: string,
  ) {
    if (binding.claimId !== input.claimId
      || binding.sourceControlPlaneId !== input.sourceControlPlaneId
      || (input.targetNodeId !== undefined && binding.targetNodeId !== input.targetNodeId)
      || binding.bindingKeyId !== input.bindingKeyId
      || binding.credentialHash !== credentialHash) {
      proxyError(ControlPlaneProxyErrorCode.BindingIdentityConflict, "Proxy claim conflicts with an existing binding identity.", 409, false, {
        claimId: input.claimId,
      });
    }
  }

  private claimResult(binding: ProxyBindingRecord, target: ControlPlaneProxyTarget) {
    const { manageable: _manageable, ...publicTarget } = target;
    return ClaimProxyInviteResultSchema.parse({
      protocolVersion: CONTROL_PLANE_PROXY_PROTOCOL_VERSION,
      binding: publicProxyBinding(binding),
      target: publicTarget,
    });
  }

  private listInviteRecords() {
    return this.invites.list(this.now().getTime());
  }

  private revokeTargetInvites(targetNodeId: string, timestamp: string) {
    const invites = this.listInviteRecords().filter((invite) => invite.targetNodeId === targetNodeId);
    for (const invite of invites) this.invites.delete(invite.tokenHash, this.now().getTime());
    return invites.map((invite) => publicProxyInvite({ ...invite, status: "revoked", revokedAt: timestamp, updatedAt: timestamp }));
  }
}
