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
  type ProxyBinding,
  type ProxyTargetSnapshot,
  type PublicProxyBinding,
  type PublicProxyInvite,
} from "@task-handoff/protocol/control-plane-proxy";
import { createId } from "../../shared/persistence/store.ts";
import { publicProxyBinding, publicProxyInvite, type ProxyInviteRecord } from "./records.ts";
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
    this.expireInvites();
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
      expiresAt: new Date(this.now().getTime() + input.expiresInSeconds * 1_000).toISOString(),
      createdAt: timestamp,
      updatedAt: timestamp,
    } as ProxyInviteRecord;
    const result = CreateProxyInviteResultSchema.parse({
      invite: publicProxyInvite(invite),
      token,
      proxyOrigin,
      protocolVersion: CONTROL_PLANE_PROXY_PROTOCOL_VERSION,
    });
    this.store.transaction((draft) => draft.invites.push(invite));
    return result;
  }

  private resolveProxyOrigin() {
    const candidate = this.configuredProxyOrigin ?? this.proxyOriginProvider?.();
    if (!candidate) return undefined;
    const parsed = ControlPlaneProxyOriginSchema.safeParse(candidate);
    return parsed.success ? parsed.data : undefined;
  }

  listInvites(): PublicProxyInvite[] {
    this.expireInvites();
    return this.store.listInvites().map(publicProxyInvite);
  }

  revokeInvite(id: string): PublicProxyInvite {
    const invite = this.requireInvite(id);
    if (invite.status === "consumed") {
      proxyError(ControlPlaneProxyErrorCode.InviteConsumed, "A consumed proxy invite cannot be revoked independently of its binding.", 409, false, { inviteId: id });
    }
    if (invite.status === "revoked" || invite.status === "expired") return publicProxyInvite(invite);
    const timestamp = this.nowIso();
    const updated: ProxyInviteRecord = {
      ...invite,
      status: "revoked",
      revokedAt: timestamp,
      updatedAt: timestamp,
    };
    this.store.transaction((draft) => {
      draft.invites[draft.invites.findIndex((candidate) => candidate.id === id)] = updated;
    });
    return publicProxyInvite(updated);
  }

  claimInvite(raw: unknown) {
    const input = ClaimProxyInviteInputSchema.parse(raw);
    this.requireCurrentProtocol(input.protocolVersion);
    this.expireInvites();

    const credentialHash = hashSecret(input.credential);
    return this.store.transaction((draft) => {
      const recovered = draft.bindings.find((binding) => binding.claimId === input.claimId);
      if (!input.inviteToken) {
        if (!recovered) proxyError(ControlPlaneProxyErrorCode.InviteInvalid, "Proxy invite token is required for the first claim.", 401);
        if (recovered.sourceControlPlaneId !== input.sourceControlPlaneId
          || recovered.bindingKeyId !== input.bindingKeyId
          || recovered.credentialHash !== credentialHash
          || (input.targetNodeId !== undefined && recovered.targetNodeId !== input.targetNodeId)) {
          proxyError(ControlPlaneProxyErrorCode.BindingIdentityConflict, "Proxy claim conflicts with an existing binding identity.", 409, false, { claimId: input.claimId });
        }
        if (recovered.status === "revoked") proxyError(ControlPlaneProxyErrorCode.BindingRevoked, "Proxy binding is revoked.", 403, false, { bindingId: recovered.id });
        return this.claimResult(recovered, this.requireKnownTarget(recovered.targetNodeId));
      }
      const invite = draft.invites.find((candidate) => secretMatches(candidate.tokenHash, input.inviteToken!));
      if (!invite) proxyError(ControlPlaneProxyErrorCode.InviteInvalid, "Proxy invite is invalid.", 401);
      if (input.targetNodeId && input.targetNodeId !== invite.targetNodeId) {
        proxyError(ControlPlaneProxyErrorCode.TargetMismatch, "Proxy invite is bound to a different target.", 409, false, {
          inviteId: invite.id,
          targetNodeId: input.targetNodeId,
        });
      }

      const bindingId = bindingIdForInvite(invite.id);
      const byInvite = draft.bindings.find((binding) => binding.id === bindingId);
      const byClaim = draft.bindings.find((binding) => binding.claimId === input.claimId);
      const existing = byInvite ?? byClaim;
      if (byInvite && byClaim && byInvite.id !== byClaim.id) {
        proxyError(ControlPlaneProxyErrorCode.BindingIdentityConflict, "Proxy claim conflicts with an existing binding identity.", 409, false, { claimId: input.claimId });
      }
      if (existing) {
        this.requireExactIdentity(existing, bindingId, invite.targetNodeId, input, credentialHash);
        if (existing.status === "revoked") {
          proxyError(ControlPlaneProxyErrorCode.BindingRevoked, "Proxy binding is revoked.", 403, false, { bindingId: existing.id });
        }
        if (invite.status !== "consumed" || invite.consumedByClaimId !== input.claimId) {
          proxyError(ControlPlaneProxyErrorCode.BindingIdentityConflict, "Proxy binding and invite authority are inconsistent.", 409, false, { claimId: input.claimId });
        }
        return this.claimResult(existing, this.requireKnownTarget(existing.targetNodeId));
      }

      this.requireClaimableInvite(invite);
      const target = this.requireManageableTarget(invite.targetNodeId);
      const timestamp = this.nowIso();
      const binding: ProxyBinding = {
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
      Object.assign(invite, {
        status: "consumed",
        consumedByClaimId: input.claimId,
        consumedAt: timestamp,
        updatedAt: timestamp,
      });
      return this.claimResult(binding, target);
    });
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
    const updated: ProxyBinding = {
      ...binding,
      status: "revoked",
      revision: binding.revision + 1,
      revokedAt: timestamp,
      updatedAt: timestamp,
    };
    this.store.transaction((draft) => {
      draft.bindings[draft.bindings.findIndex((candidate) => candidate.id === id)] = updated;
    });
    return publicProxyBinding(updated);
  }

  revokeTarget(targetNodeId: string) {
    return this.store.transaction((draft) => {
      const timestamp = this.nowIso();
      const bindings = draft.bindings
        .filter((binding) => binding.targetNodeId === targetNodeId && binding.status === "active")
        .map((binding) => {
          Object.assign(binding, {
            status: "revoked",
            revision: binding.revision + 1,
            revokedAt: timestamp,
            updatedAt: timestamp,
          });
          return publicProxyBinding(binding);
        });
      const invites = draft.invites
        .filter((invite) => invite.targetNodeId === targetNodeId && invite.status === "active")
        .map((invite) => {
          Object.assign(invite, { status: "revoked", revokedAt: timestamp, updatedAt: timestamp });
          return publicProxyInvite(invite);
        });
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

  private requireInvite(id: string) {
    const invite = this.store.getInvite(id);
    if (!invite) proxyError(ControlPlaneProxyErrorCode.InviteInvalid, "Proxy invite is unknown.", 404, false, { inviteId: id });
    return invite;
  }

  private requireBinding(id: string) {
    const binding = this.store.getBinding(id);
    if (!binding) proxyError(ControlPlaneProxyErrorCode.BindingUnknown, "Proxy binding is unknown.", 404, false, { bindingId: id });
    return binding;
  }

  private requireClaimableInvite(invite: ProxyInviteRecord) {
    if (invite.status === "active") return;
    const codes = {
      expired: ControlPlaneProxyErrorCode.InviteExpired,
      consumed: ControlPlaneProxyErrorCode.InviteConsumed,
      revoked: ControlPlaneProxyErrorCode.InviteRevoked,
    } as const;
    proxyError(codes[invite.status], `Proxy invite is ${invite.status}.`, invite.status === "expired" ? 410 : 409, false, { inviteId: invite.id });
  }

  private requireExactIdentity(
    binding: ProxyBinding,
    expectedBindingId: string,
    targetNodeId: string,
    input: ReturnType<typeof ClaimProxyInviteInputSchema.parse>,
    credentialHash: string,
  ) {
    if (binding.id !== expectedBindingId
      || binding.claimId !== input.claimId
      || binding.sourceControlPlaneId !== input.sourceControlPlaneId
      || binding.targetNodeId !== targetNodeId
      || binding.bindingKeyId !== input.bindingKeyId
      || binding.credentialHash !== credentialHash) {
      proxyError(ControlPlaneProxyErrorCode.BindingIdentityConflict, "Proxy claim conflicts with an existing binding identity.", 409, false, {
        claimId: input.claimId,
      });
    }
  }

  private claimResult(binding: ProxyBinding, target: ControlPlaneProxyTarget) {
    const { manageable: _manageable, ...publicTarget } = target;
    return ClaimProxyInviteResultSchema.parse({
      protocolVersion: CONTROL_PLANE_PROXY_PROTOCOL_VERSION,
      binding: publicProxyBinding(binding),
      target: publicTarget,
    });
  }

  private expireInvites() {
    const now = this.now().getTime();
    if (!this.store.listInvites().some((invite) => invite.status === "active" && Date.parse(invite.expiresAt) <= now)) return;
    this.store.transaction((draft) => {
      const timestamp = this.nowIso();
      for (const invite of draft.invites) {
        if (invite.status === "active" && Date.parse(invite.expiresAt) <= now) {
          invite.status = "expired";
          invite.updatedAt = timestamp;
        }
      }
    });
  }
}
