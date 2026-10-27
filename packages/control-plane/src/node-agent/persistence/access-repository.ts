import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { NodeAgentIdentity } from "../identity/types.ts";
import type { NodeAgentCloudRelayBinding, NodeAgentCloudRelayStoredError } from "../cloud-relay/types.ts";
import type {
  NodeAgentCloudControlPlanePin,
  NodeAgentCloudControlPlaneRevokeInput,
  NodeAgentCloudControlPlaneTrustContext,
  NodeAgentCloudControlPlaneTrustDecision,
  NodeAgentCloudControlPlaneTrustDecisionResult,
  NodeAgentCloudControlPlaneTrustObservation,
  NodeAgentCloudControlPlaneTrustRequest,
  NodeAgentControlPlaneTrustActor,
} from "../cloud-relay/trust-types.ts";
import { createId } from "../../shared/persistence/store.ts";

type Row = Record<string, unknown>;

export type ControlPlaneConnectionOperation = {
  id: string;
  kind: string;
  phase: "prepared" | "remote-accepted" | "committed" | "failed";
  requested: Record<string, unknown>;
  pairingKeyId?: string;
  connectionId?: string;
  replacedConnections: Array<Record<string, unknown>>;
  error?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

export class AccessRepository {
  private readonly client: DatabaseSync;
  constructor(client: DatabaseSync) { this.client = client; }

  readIdentity(): NodeAgentIdentity | undefined {
    const identity = this.client.prepare("SELECT node_id, created_at, updated_at FROM na_node_identity WHERE singleton_key = 1").get() as Row | undefined;
    if (!identity) return undefined;
    const controlPlanePairings = (this.client.prepare("SELECT * FROM na_control_plane_pairings ORDER BY updated_at, key_id").all() as Row[]).map((row) => ({
      id: String(row.control_plane_id),
      keyId: String(row.key_id),
      ...(row.name ? { name: String(row.name) } : {}),
      secret: String(row.secret),
      pairedAt: String(row.paired_at),
      ...(row.revoked_at ? { revokedAt: String(row.revoked_at) } : {}),
      updatedAt: String(row.updated_at),
    }));
    const controlPlaneConnections = (this.client.prepare("SELECT * FROM na_control_plane_connections ORDER BY updated_at, id").all() as Row[]).map((row) => ({
      id: String(row.id),
      pairingKeyId: String(row.pairing_key_id),
      ...(row.name ? { name: String(row.name) } : {}),
      url: String(row.normalized_url),
      enabled: Boolean(row.enabled),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    }));
    return {
      nodeId: String(identity.node_id),
      createdAt: String(identity.created_at),
      updatedAt: String(identity.updated_at),
      controlPlanePairings,
      controlPlaneConnections,
    };
  }

  readCloudRelayBinding(): NodeAgentCloudRelayBinding | undefined {
    const row = this.client.prepare("SELECT * FROM na_cloud_relay_bindings WHERE singleton_key = 1").get() as Row | undefined;
    if (!row) return undefined;
    const paired = parseJsonArray(row.paired_control_planes_json);
    const lastError = parseJsonObject(row.last_error_json);
    return {
      status: row.status === "rebind-required" ? "rebind-required" : "active",
      nodeHandle: String(row.node_handle),
      accountId: String(row.account_id),
      cloudOrigin: String(row.cloud_origin),
      serviceOrigin: String(row.service_origin),
      credential: String(row.credential),
      credentialExpiresAt: String(row.credential_expires_at),
      ...(row.signing_kid && row.signing_public_key
        ? { serviceSigningKey: { kid: String(row.signing_kid), publicKey: String(row.signing_public_key) } }
        : {}),
      relayPublicKey: String(row.relay_public_key),
      relayPrivateKey: String(row.relay_private_key),
      pairedControlPlaneIds: paired,
      ...(lastError ? { lastError: lastError as NodeAgentCloudRelayStoredError } : {}),
      boundAt: String(row.bound_at),
      updatedAt: String(row.updated_at),
    };
  }

  writeCloudRelayBinding(binding: NodeAgentCloudRelayBinding): NodeAgentCloudRelayBinding {
    this.client.prepare(`INSERT INTO na_cloud_relay_bindings
      (singleton_key, status, node_handle, account_id, cloud_origin, service_origin, credential, credential_expires_at,
       signing_kid, signing_public_key, relay_public_key, relay_private_key, paired_control_planes_json, last_error_json, bound_at, updated_at)
      VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(singleton_key) DO UPDATE SET status=excluded.status, node_handle=excluded.node_handle, account_id=excluded.account_id,
        cloud_origin=excluded.cloud_origin, service_origin=excluded.service_origin, credential=excluded.credential,
        credential_expires_at=excluded.credential_expires_at, signing_kid=excluded.signing_kid, signing_public_key=excluded.signing_public_key,
        relay_public_key=excluded.relay_public_key, relay_private_key=excluded.relay_private_key,
        paired_control_planes_json=excluded.paired_control_planes_json, last_error_json=excluded.last_error_json,
        bound_at=excluded.bound_at, updated_at=excluded.updated_at`)
      .run(
        binding.status, binding.nodeHandle, binding.accountId, binding.cloudOrigin, binding.serviceOrigin,
        binding.credential, binding.credentialExpiresAt,
        binding.serviceSigningKey?.kid ?? null, binding.serviceSigningKey?.publicKey ?? null,
        binding.relayPublicKey, binding.relayPrivateKey, JSON.stringify(binding.pairedControlPlaneIds),
        binding.lastError ? JSON.stringify(binding.lastError) : null,
        binding.boundAt, binding.updatedAt,
      );
    return this.readCloudRelayBinding()!;
  }

  listCloudControlPlaneTrust(now = new Date().toISOString()) {
    return this.transaction(() => {
      this.expireCloudControlPlaneTrustRequests(now, { type: "system", id: "node-agent" });
      return {
        pins: (this.client.prepare("SELECT * FROM na_cloud_control_plane_pins ORDER BY created_at DESC, id DESC").all() as Row[])
          .map(controlPlanePinFromRow),
        requests: (this.client.prepare("SELECT * FROM na_cloud_control_plane_trust_requests ORDER BY requested_at DESC, id DESC").all() as Row[])
          .map(controlPlaneTrustRequestFromRow),
      };
    });
  }

  observeCloudControlPlaneTrust(input: {
    context: NodeAgentCloudControlPlaneTrustContext;
    fingerprint: string;
    now: string;
    ttlMs: number;
  }): NodeAgentCloudControlPlaneTrustObservation {
    return this.transaction(() => {
      this.expireCloudControlPlaneTrustRequests(input.now, { type: "system", id: "node-agent" });
      const context = input.context;
      const pin = this.findActiveCloudControlPlanePin(context);
      if (pin) {
        const shareRevisionForward = context.accessMode === "shared"
          && context.shareRevision !== undefined
          && (pin.shareRevision ?? 0) < context.shareRevision;
        const bindingChanged = pin.bindingRevision !== context.bindingRevision;
        const revisionChanged = bindingChanged || shareRevisionForward;
        const updated: NodeAgentCloudControlPlanePin = {
          ...pin,
          bindingRevision: context.bindingRevision,
          ...(shareRevisionForward ? { shareRevision: context.shareRevision } : {}),
          lastSeenAt: input.now,
          updatedAt: revisionChanged || pin.lastSeenAt !== input.now ? input.now : pin.updatedAt,
        };
        this.client.prepare(`UPDATE na_cloud_control_plane_pins SET binding_revision = ?, share_revision = ?, last_seen_at = ?, updated_at = ? WHERE id = ?`)
          .run(updated.bindingRevision, updated.shareRevision ?? null, updated.lastSeenAt, updated.updatedAt, pin.id);
        if (shareRevisionForward) {
          this.appendCloudControlPlaneTrustAudit({
            action: "share-revision-update",
            actor: { type: "system", id: "node-agent" },
            pinId: pin.id,
            controlPlaneId: pin.controlPlaneId,
            fingerprint: input.fingerprint,
            accessMode: pin.accessMode,
            shareRole: pin.shareRole,
            reason: `${pin.shareRevision ?? 0}->${context.shareRevision}`,
            now: input.now,
          });
        }
        return { kind: "active", pin: updated };
      }
      if (context.accessMode === "shared" && context.shareRevision !== undefined) {
        const stalePin = this.findCloudControlPlanePin(context);
        if (stalePin && (stalePin.shareRevision ?? 0) > context.shareRevision) return this.pendingObservation(context, input, "access-context-changed");
      }
      const pending = this.findCloudControlPlaneTrustRequest(context, "pending");
      if (pending) {
        const bindingChanged = pending.bindingRevision !== context.bindingRevision;
        const shareRevisionChanged = context.accessMode === "shared" && pending.shareRevision !== context.shareRevision;
        const timestamp = input.now;
        const revision = bindingChanged || shareRevisionChanged ? pending.revision + 1 : pending.revision;
        this.client.prepare(`UPDATE na_cloud_control_plane_trust_requests
          SET binding_revision = ?, share_revision = ?, last_seen_at = ?, revision = ?, updated_at = ? WHERE id = ?`)
          .run(context.bindingRevision, context.shareRevision ?? null, timestamp, revision, timestamp, pending.id);
        return {
          kind: "pending",
          request: { ...pending, bindingRevision: context.bindingRevision, shareRevision: context.shareRevision, lastSeenAt: timestamp, revision, updatedAt: timestamp },
          reason: this.pendingReason(context),
        };
      }
      const rejected = this.findCloudControlPlaneTrustRequest(context, "rejected");
      if (rejected) {
        this.client.prepare("UPDATE na_cloud_control_plane_trust_requests SET last_seen_at = ?, updated_at = ? WHERE id = ?")
          .run(input.now, input.now, rejected.id);
        return { kind: "rejected", request: { ...rejected, lastSeenAt: input.now, updatedAt: input.now } };
      }
      return this.pendingObservation(context, input, this.pendingReason(context));
    });
  }

  decideCloudControlPlaneTrust(input: NodeAgentCloudControlPlaneTrustDecision, inputContext: {
    now: string;
  }): NodeAgentCloudControlPlaneTrustDecisionResult {
    return this.transaction(() => {
      this.expireCloudControlPlaneTrustRequests(inputContext.now, { type: "system", id: "node-agent" });
      const request = this.requireCloudControlPlaneTrustRequest(input.requestId);
      const fingerprint = this.controlPlaneFingerprint(request.controlPlanePublicKey);
      if (fingerprint !== input.expectedFingerprint) {
        throw controlPlaneTrustError("NODE_AGENT_CONTROL_PLANE_TRUST_FINGERPRINT_CONFLICT", "The Control Plane fingerprint changed before this decision.", 409);
      }
      if (input.action === "approve" && request.status === "approved" && request.pinId) {
        const existing = this.readCloudControlPlanePin(request.pinId);
        if (existing) return { request, pin: existing, revokedPins: [] };
      }
      if (input.action === "reject" && request.status === "rejected") return { request, revokedPins: [] };
      if (request.revision !== input.expectedRevision) {
        throw controlPlaneTrustError("NODE_AGENT_CONTROL_PLANE_TRUST_REVISION_CONFLICT", "The Control Plane trust request changed before this decision.", 409);
      }
      if (input.action === "reject") {
        if (request.status !== "pending") {
          throw controlPlaneTrustError("NODE_AGENT_CONTROL_PLANE_TRUST_ALREADY_DECIDED", "The Control Plane trust request is no longer pending.", 409);
        }
        const rejected: NodeAgentCloudControlPlaneTrustRequest = {
          ...request,
          status: "rejected",
          decidedAt: inputContext.now,
          decidedByActorType: input.actor.type,
          decidedByActorId: input.actor.id,
          ...(input.reason ? { decisionReason: input.reason } : {}),
          revision: request.revision + 1,
          updatedAt: inputContext.now,
        };
        this.writeCloudControlPlaneTrustRequest(rejected);
        this.appendCloudControlPlaneTrustAudit({
          action: "reject",
          actor: input.actor,
          requestId: request.id,
          controlPlaneId: request.controlPlaneId,
          fingerprint,
          accessMode: request.accessMode,
          shareRole: request.shareRole,
          reason: input.reason,
          now: inputContext.now,
        });
        return { request: rejected, revokedPins: [] };
      }
      if (request.status !== "pending") {
        throw controlPlaneTrustError("NODE_AGENT_CONTROL_PLANE_TRUST_ALREADY_DECIDED", "The Control Plane trust request is no longer pending.", 409);
      }
      const pin: NodeAgentCloudControlPlanePin = {
        id: createId("cptpin"),
        nodeId: request.nodeId,
        nodeHandle: request.nodeHandle,
        controlPlaneId: request.controlPlaneId,
        controlPlanePublicKey: request.controlPlanePublicKey,
        bindingId: request.bindingId,
        bindingRevision: request.bindingRevision,
        accessAccountId: request.accessAccountId,
        ownerAccountId: request.ownerAccountId,
        accessMode: request.accessMode,
        ...(request.shareGrantId ? { shareGrantId: request.shareGrantId } : {}),
        ...(request.shareRole ? { shareRole: request.shareRole } : {}),
        ...(request.shareRevision ? { shareRevision: request.shareRevision } : {}),
        status: "active",
        approvedByActorType: input.actor.type,
        approvedByActorId: input.actor.id,
        approvedAt: inputContext.now,
        lastSeenAt: request.lastSeenAt,
        authorizationRevision: 1,
        createdAt: inputContext.now,
        updatedAt: inputContext.now,
      };
      this.writeCloudControlPlanePin(pin);
      const approved: NodeAgentCloudControlPlaneTrustRequest = {
        ...request,
        status: "approved",
        decidedAt: inputContext.now,
        decidedByActorType: input.actor.type,
        decidedByActorId: input.actor.id,
        ...(input.reason ? { decisionReason: input.reason } : {}),
        pinId: pin.id,
        revision: request.revision + 1,
        updatedAt: inputContext.now,
      };
      this.writeCloudControlPlaneTrustRequest(approved);
      this.appendCloudControlPlaneTrustAudit({
        action: "approve",
        actor: input.actor,
        requestId: request.id,
        pinId: pin.id,
        controlPlaneId: request.controlPlaneId,
        fingerprint,
        accessMode: request.accessMode,
        shareRole: request.shareRole,
        reason: input.reason,
        now: inputContext.now,
      });
      const revokedPins = input.retainPreviousKey ? [] : this.revokeSupersededCloudControlPlanePins(pin, input, fingerprint, inputContext.now);
      return { request: approved, pin, revokedPins };
    });
  }

  revokeCloudControlPlaneTrustPin(input: NodeAgentCloudControlPlaneRevokeInput, now: string) {
    return this.transaction(() => {
      const pin = this.readCloudControlPlanePin(input.pinId);
      if (!pin) throw controlPlaneTrustError("NODE_AGENT_CONTROL_PLANE_TRUST_PIN_NOT_FOUND", "The trusted Control Plane pin was not found.", 404);
      const fingerprint = this.controlPlaneFingerprint(pin.controlPlanePublicKey);
      if (fingerprint !== input.expectedFingerprint) {
        throw controlPlaneTrustError("NODE_AGENT_CONTROL_PLANE_TRUST_FINGERPRINT_CONFLICT", "The Control Plane fingerprint changed before this decision.", 409);
      }
      if (pin.authorizationRevision !== input.expectedRevision) {
        throw controlPlaneTrustError("NODE_AGENT_CONTROL_PLANE_TRUST_REVISION_CONFLICT", "The trusted Control Plane pin changed before this decision.", 409);
      }
      if (pin.status === "revoked") return pin;
      const revoked: NodeAgentCloudControlPlanePin = {
        ...pin,
        status: "revoked",
        revokedAt: now,
        ...(input.reason ? { revokeReason: input.reason } : {}),
        authorizationRevision: pin.authorizationRevision + 1,
        updatedAt: now,
      };
      this.writeCloudControlPlanePin(revoked);
      this.appendCloudControlPlaneTrustAudit({
        action: "revoke",
        actor: input.actor,
        pinId: pin.id,
        controlPlaneId: pin.controlPlaneId,
        fingerprint,
        accessMode: pin.accessMode,
        shareRole: pin.shareRole,
        reason: input.reason,
        now,
      });
      return revoked;
    });
  }

  retryCloudControlPlaneTrustRequest(input: {
    requestId: string;
    now: string;
    ttlMs: number;
    actor: NodeAgentControlPlaneTrustActor;
  }) {
    return this.transaction(() => {
      this.expireCloudControlPlaneTrustRequests(input.now, { type: "system", id: "node-agent" });
      const request = this.requireCloudControlPlaneTrustRequest(input.requestId);
      if (request.status === "pending") return request;
      if (request.status === "approved") {
        throw controlPlaneTrustError("NODE_AGENT_CONTROL_PLANE_TRUST_ALREADY_APPROVED", "The Control Plane trust request is already approved.", 409);
      }
      const existingContext = this.findCloudControlPlaneTrustRequest({
        nodeId: request.nodeId,
        nodeHandle: request.nodeHandle,
        controlPlaneId: request.controlPlaneId,
        controlPlanePublicKey: request.controlPlanePublicKey,
        bindingId: request.bindingId,
        bindingRevision: request.bindingRevision,
        accountId: request.accessAccountId,
        ownerAccountId: request.ownerAccountId,
        accessMode: request.accessMode,
        ...(request.shareGrantId ? { shareGrantId: request.shareGrantId } : {}),
        ...(request.shareRole ? { shareRole: request.shareRole } : {}),
        ...(request.shareRevision ? { shareRevision: request.shareRevision } : {}),
      }, "pending");
      if (existingContext) return existingContext;
      const retried: NodeAgentCloudControlPlaneTrustRequest = {
        ...request,
        id: createId("cptreq"),
        status: "pending",
        requestedAt: input.now,
        lastSeenAt: input.now,
        expiresAt: new Date(Date.parse(input.now) + input.ttlMs).toISOString(),
        revision: 1,
        createdAt: input.now,
        updatedAt: input.now,
      };
      delete retried.decidedAt;
      delete retried.decidedByActorType;
      delete retried.decidedByActorId;
      delete retried.decisionReason;
      delete retried.pinId;
      this.writeCloudControlPlaneTrustRequest(retried);
      this.appendCloudControlPlaneTrustAudit({
        action: "retry",
        actor: input.actor,
        requestId: retried.id,
        controlPlaneId: retried.controlPlaneId,
        fingerprint: this.controlPlaneFingerprint(retried.controlPlanePublicKey),
        accessMode: retried.accessMode,
        shareRole: retried.shareRole,
        reason: `explicit-retry:${request.id}`,
        now: input.now,
      });
      return retried;
    });
  }

  activeCloudControlPlanePinCount(controlPlaneId: string) {
    const row = this.client.prepare("SELECT COUNT(*) AS count FROM na_cloud_control_plane_pins WHERE control_plane_id = ? AND status = 'active'").get(controlPlaneId) as { count?: number } | undefined;
    return Number(row?.count ?? 0);
  }

  cloudControlPlaneTrustFingerprint(publicKey: string) {
    return this.controlPlaneFingerprint(publicKey);
  }

  cloudControlPlaneTrustRequestReason(request: NodeAgentCloudControlPlaneTrustRequest) {
    if (request.status === "approved") return "approved" as const;
    if (request.status === "rejected") return "rejected" as const;
    if (request.status === "expired") return "expired" as const;
    return this.pendingReason({
      nodeId: request.nodeId,
      nodeHandle: request.nodeHandle,
      controlPlaneId: request.controlPlaneId,
      controlPlanePublicKey: request.controlPlanePublicKey,
      bindingId: request.bindingId,
      bindingRevision: request.bindingRevision,
      accountId: request.accessAccountId,
      ownerAccountId: request.ownerAccountId,
      accessMode: request.accessMode,
      ...(request.shareGrantId ? { shareGrantId: request.shareGrantId } : {}),
      ...(request.shareRole ? { shareRole: request.shareRole } : {}),
      ...(request.shareRevision ? { shareRevision: request.shareRevision } : {}),
    });
  }

  private pendingObservation(
    context: NodeAgentCloudControlPlaneTrustContext,
    input: { fingerprint: string; now: string; ttlMs: number },
    _reason: string,
  ): NodeAgentCloudControlPlaneTrustObservation {
    const timestamp = input.now;
    const expiresAt = new Date(Date.parse(timestamp) + input.ttlMs).toISOString();
    const request: NodeAgentCloudControlPlaneTrustRequest = {
      id: createId("cptreq"),
      nodeId: context.nodeId,
      nodeHandle: context.nodeHandle,
      controlPlaneId: context.controlPlaneId,
      controlPlanePublicKey: context.controlPlanePublicKey,
      bindingId: context.bindingId,
      bindingRevision: context.bindingRevision,
      accessAccountId: context.accountId,
      ownerAccountId: context.ownerAccountId,
      accessMode: context.accessMode,
      ...(context.shareGrantId ? { shareGrantId: context.shareGrantId } : {}),
      ...(context.shareRole ? { shareRole: context.shareRole } : {}),
      ...(context.shareRevision ? { shareRevision: context.shareRevision } : {}),
      status: "pending",
      requestedAt: timestamp,
      lastSeenAt: timestamp,
      expiresAt,
      revision: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.writeCloudControlPlaneTrustRequest(request);
    return { kind: "pending", request, reason: this.pendingReason(context) };
  }

  private pendingReason(context: NodeAgentCloudControlPlaneTrustContext) {
    const sameKey = this.client.prepare(`SELECT id FROM na_cloud_control_plane_pins WHERE status = 'active'
      AND node_id = ? AND node_handle = ? AND control_plane_id = ? AND control_plane_public_key = ?
      AND binding_id = ? AND access_account_id = ? AND owner_account_id = ? AND access_mode = ?
      AND COALESCE(share_grant_id, '') = ? AND COALESCE(share_role, '') = ?
      LIMIT 1`).get(
      context.nodeId, context.nodeHandle, context.controlPlaneId, context.controlPlanePublicKey,
      context.bindingId, context.accountId, context.ownerAccountId, context.accessMode,
      context.shareGrantId ?? "", context.shareRole ?? "",
    );
    if (sameKey) return "access-context-changed";
    const sameContext = this.client.prepare(`SELECT id FROM na_cloud_control_plane_pins WHERE status = 'active'
      AND node_id = ? AND node_handle = ? AND control_plane_id = ? AND binding_id = ?
      AND access_account_id = ? AND owner_account_id = ? AND access_mode = ?
      AND COALESCE(share_grant_id, '') = ? AND COALESCE(share_role, '') = ?
      LIMIT 1`).get(
      context.nodeId, context.nodeHandle, context.controlPlaneId, context.bindingId,
      context.accountId, context.ownerAccountId, context.accessMode, context.shareGrantId ?? "", context.shareRole ?? "",
    );
    return sameContext ? "key-changed" : "first-seen";
  }

  private findActiveCloudControlPlanePin(context: NodeAgentCloudControlPlaneTrustContext) {
    const pin = this.findCloudControlPlanePin(context);
    if (!pin) return undefined;
    if (context.accessMode === "shared" && context.shareRevision !== undefined && (pin.shareRevision ?? 0) > context.shareRevision) return undefined;
    return pin;
  }

  private findCloudControlPlanePin(context: NodeAgentCloudControlPlaneTrustContext) {
    const row = this.client.prepare(`SELECT * FROM na_cloud_control_plane_pins WHERE status = 'active'
      AND node_id = ? AND node_handle = ? AND control_plane_id = ? AND control_plane_public_key = ?
      AND binding_id = ? AND access_account_id = ? AND owner_account_id = ? AND access_mode = ?
      AND COALESCE(share_grant_id, '') = ? AND COALESCE(share_role, '') = ?
      ORDER BY share_revision DESC, updated_at DESC LIMIT 1`).get(
      context.nodeId, context.nodeHandle, context.controlPlaneId, context.controlPlanePublicKey,
      context.bindingId, context.accountId, context.ownerAccountId, context.accessMode,
      context.shareGrantId ?? "", context.shareRole ?? "",
    ) as Row | undefined;
    return row ? controlPlanePinFromRow(row) : undefined;
  }

  private findCloudControlPlaneTrustRequest(context: NodeAgentCloudControlPlaneTrustContext, status: "pending" | "rejected") {
    const row = this.client.prepare(`SELECT * FROM na_cloud_control_plane_trust_requests WHERE status = ?
      AND node_id = ? AND node_handle = ? AND control_plane_id = ? AND control_plane_public_key = ?
      AND binding_id = ? AND access_account_id = ? AND owner_account_id = ? AND access_mode = ?
      AND COALESCE(share_grant_id, '') = ? AND COALESCE(share_role, '') = ?
      ORDER BY requested_at DESC, id DESC LIMIT 1`).get(
      status, context.nodeId, context.nodeHandle, context.controlPlaneId, context.controlPlanePublicKey,
      context.bindingId, context.accountId, context.ownerAccountId, context.accessMode,
      context.shareGrantId ?? "", context.shareRole ?? "",
    ) as Row | undefined;
    return row ? controlPlaneTrustRequestFromRow(row) : undefined;
  }

  private readCloudControlPlanePin(id: string) {
    const row = this.client.prepare("SELECT * FROM na_cloud_control_plane_pins WHERE id = ?").get(id) as Row | undefined;
    return row ? controlPlanePinFromRow(row) : undefined;
  }

  private requireCloudControlPlaneTrustRequest(id: string) {
    const row = this.client.prepare("SELECT * FROM na_cloud_control_plane_trust_requests WHERE id = ?").get(id) as Row | undefined;
    if (!row) throw controlPlaneTrustError("NODE_AGENT_CONTROL_PLANE_TRUST_REQUEST_NOT_FOUND", "The Control Plane trust request was not found.", 404);
    return controlPlaneTrustRequestFromRow(row);
  }

  private writeCloudControlPlanePin(pin: NodeAgentCloudControlPlanePin) {
    this.client.prepare(`INSERT INTO na_cloud_control_plane_pins
      (id, node_id, node_handle, control_plane_id, control_plane_public_key, binding_id, binding_revision,
       access_account_id, owner_account_id, access_mode, share_grant_id, share_role, share_revision,
       status, approved_by_actor_type, approved_by_actor_id, approved_at, last_seen_at, revoked_at, revoke_reason,
       authorization_revision, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET binding_revision=excluded.binding_revision, share_revision=excluded.share_revision,
        status=excluded.status, last_seen_at=excluded.last_seen_at, revoked_at=excluded.revoked_at,
        revoke_reason=excluded.revoke_reason, authorization_revision=excluded.authorization_revision, updated_at=excluded.updated_at`)
      .run(pin.id, pin.nodeId, pin.nodeHandle, pin.controlPlaneId, pin.controlPlanePublicKey, pin.bindingId,
        pin.bindingRevision, pin.accessAccountId, pin.ownerAccountId, pin.accessMode, pin.shareGrantId ?? null,
        pin.shareRole ?? null, pin.shareRevision ?? null, pin.status, pin.approvedByActorType, pin.approvedByActorId,
        pin.approvedAt, pin.lastSeenAt, pin.revokedAt ?? null, pin.revokeReason ?? null, pin.authorizationRevision,
        pin.createdAt, pin.updatedAt);
  }

  private writeCloudControlPlaneTrustRequest(request: NodeAgentCloudControlPlaneTrustRequest) {
    this.client.prepare(`INSERT INTO na_cloud_control_plane_trust_requests
      (id, node_id, node_handle, control_plane_id, control_plane_public_key, binding_id, binding_revision,
       access_account_id, owner_account_id, access_mode, share_grant_id, share_role, share_revision,
       status, requested_at, last_seen_at, expires_at, decided_at, decided_by_actor_type, decided_by_actor_id,
       decision_reason, pin_id, revision, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET binding_revision=excluded.binding_revision, share_revision=excluded.share_revision,
        status=excluded.status, last_seen_at=excluded.last_seen_at, decided_at=excluded.decided_at,
        decided_by_actor_type=excluded.decided_by_actor_type, decided_by_actor_id=excluded.decided_by_actor_id,
        decision_reason=excluded.decision_reason, pin_id=excluded.pin_id, revision=excluded.revision, updated_at=excluded.updated_at`)
      .run(request.id, request.nodeId, request.nodeHandle, request.controlPlaneId, request.controlPlanePublicKey,
        request.bindingId, request.bindingRevision, request.accessAccountId, request.ownerAccountId, request.accessMode,
        request.shareGrantId ?? null, request.shareRole ?? null, request.shareRevision ?? null, request.status,
        request.requestedAt, request.lastSeenAt, request.expiresAt, request.decidedAt ?? null,
        request.decidedByActorType ?? null, request.decidedByActorId ?? null, request.decisionReason ?? null,
        request.pinId ?? null, request.revision, request.createdAt, request.updatedAt);
  }

  private revokeSupersededCloudControlPlanePins(pin: NodeAgentCloudControlPlanePin, input: NodeAgentCloudControlPlaneTrustDecision, fingerprint: string, now: string) {
    const rows = this.client.prepare(`SELECT * FROM na_cloud_control_plane_pins WHERE status = 'active' AND id <> ?
      AND node_id = ? AND node_handle = ? AND control_plane_id = ? AND binding_id = ?
      AND access_account_id = ? AND owner_account_id = ? AND access_mode = ?
      AND COALESCE(share_grant_id, '') = ? AND COALESCE(share_role, '') = ?`).all(
      pin.id, pin.nodeId, pin.nodeHandle, pin.controlPlaneId, pin.bindingId, pin.accessAccountId,
      pin.ownerAccountId, pin.accessMode, pin.shareGrantId ?? "", pin.shareRole ?? "",
    ) as Row[];
    return rows.map(controlPlanePinFromRow).map((oldPin) => {
      const revoked: NodeAgentCloudControlPlanePin = {
        ...oldPin,
        status: "revoked",
        revokedAt: now,
        revokeReason: "superseded-by-key-rotation",
        authorizationRevision: oldPin.authorizationRevision + 1,
        updatedAt: now,
      };
      this.writeCloudControlPlanePin(revoked);
      this.appendCloudControlPlaneTrustAudit({
        action: "revoke",
        actor: input.actor,
        pinId: oldPin.id,
        requestId: input.requestId,
        controlPlaneId: oldPin.controlPlaneId,
        fingerprint,
        accessMode: oldPin.accessMode,
        shareRole: oldPin.shareRole,
        reason: "superseded-by-key-rotation",
        now,
      });
      return revoked;
    });
  }

  private expireCloudControlPlaneTrustRequests(now: string, actor: NodeAgentControlPlaneTrustActor) {
    const rows = this.client.prepare("SELECT * FROM na_cloud_control_plane_trust_requests WHERE status = 'pending' AND expires_at <= ?").all(now) as Row[];
    for (const row of rows) {
      const request = controlPlaneTrustRequestFromRow(row);
      const expired: NodeAgentCloudControlPlaneTrustRequest = {
        ...request,
        status: "expired",
        decidedAt: now,
        decidedByActorType: actor.type,
        decidedByActorId: actor.id,
        revision: request.revision + 1,
        updatedAt: now,
      };
      this.writeCloudControlPlaneTrustRequest(expired);
      this.appendCloudControlPlaneTrustAudit({
        action: "expire",
        actor,
        requestId: request.id,
        controlPlaneId: request.controlPlaneId,
        fingerprint: this.controlPlaneFingerprint(request.controlPlanePublicKey),
        accessMode: request.accessMode,
        shareRole: request.shareRole,
        reason: "pending-ttl-expired",
        now,
      });
    }
    return rows.length;
  }

  private appendCloudControlPlaneTrustAudit(input: {
    action: "approve" | "reject" | "revoke" | "expire" | "retry" | "share-revision-update";
    actor: NodeAgentControlPlaneTrustActor;
    requestId?: string;
    pinId?: string;
    controlPlaneId: string;
    fingerprint: string;
    accessMode: "owner" | "shared";
    shareRole?: string;
    reason?: string;
    now: string;
  }) {
    this.client.prepare(`INSERT INTO na_cloud_control_plane_trust_audit
      (id, action, actor_type, actor_id, connection_type, request_id, pin_id, control_plane_id,
       control_plane_public_key_fingerprint, access_mode, share_role, reason, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(createId("cptaudit"), input.action, input.actor.type, input.actor.id, input.actor.connectionType ?? null,
        input.requestId ?? null, input.pinId ?? null, input.controlPlaneId, input.fingerprint, input.accessMode,
        input.shareRole ?? null, input.reason ?? null, input.now);
  }

  private controlPlaneFingerprint(publicKey: string) {
    return `sha256:${createHash("sha256").update(Buffer.from(publicKey, "base64url")).digest("base64url")}`;
  }

  deleteCloudRelayBinding() {
    return Number(this.client.prepare("DELETE FROM na_cloud_relay_bindings WHERE singleton_key = 1").run().changes) > 0;
  }

  writeIdentity(identity: NodeAgentIdentity): NodeAgentIdentity {
    return this.transaction(() => {
      const current = this.readIdentity();
      if (current && current.nodeId !== identity.nodeId) {
        throw accessError("NODE_AGENT_IDENTITY_MISMATCH", `Stored node identity ${current.nodeId} does not match ${identity.nodeId}.`);
      }
      this.client.prepare(`INSERT INTO na_node_identity (singleton_key, node_id, created_at, updated_at) VALUES (1, ?, ?, ?)
        ON CONFLICT(singleton_key) DO UPDATE SET updated_at=excluded.updated_at`)
        .run(identity.nodeId, identity.createdAt, identity.updatedAt);

      const pairingIds = (identity.controlPlanePairings || []).map((pairing) => pairing.keyId);
      const connectionIds = (identity.controlPlaneConnections || []).map((connection) => connection.id);
      deleteExcept(this.client, "na_control_plane_connections", "id", connectionIds);
      deleteExcept(this.client, "na_control_plane_pairings", "key_id", pairingIds);

      const pairingUpsert = this.client.prepare(`INSERT INTO na_control_plane_pairings
        (key_id, control_plane_id, name, secret, paired_at, revoked_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(key_id) DO UPDATE SET control_plane_id=excluded.control_plane_id, name=excluded.name,
          secret=excluded.secret, paired_at=excluded.paired_at, revoked_at=excluded.revoked_at, updated_at=excluded.updated_at`);
      for (const pairing of identity.controlPlanePairings || []) {
        pairingUpsert.run(pairing.keyId, pairing.id, pairing.name ?? null, pairing.secret, pairing.pairedAt, pairing.revokedAt ?? null, pairing.updatedAt);
      }

      const connectionUpsert = this.client.prepare(`INSERT INTO na_control_plane_connections
        (id, pairing_key_id, name, normalized_url, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET pairing_key_id=excluded.pairing_key_id, name=excluded.name,
          normalized_url=excluded.normalized_url, enabled=excluded.enabled, updated_at=excluded.updated_at`);
      for (const connection of identity.controlPlaneConnections || []) {
        connectionUpsert.run(connection.id, connection.pairingKeyId, connection.name ?? null,
          normalizeControlPlaneUrl(connection.url), connection.enabled ? 1 : 0, connection.createdAt, connection.updatedAt);
      }
      return this.readIdentity()!;
    });
  }

  listOperations(phases?: ControlPlaneConnectionOperation["phase"][]) {
    const rows = phases?.length
      ? this.client.prepare(`SELECT * FROM na_control_plane_connection_operations WHERE phase IN (${phases.map(() => "?").join(",")}) ORDER BY created_at`).all(...phases)
      : this.client.prepare("SELECT * FROM na_control_plane_connection_operations ORDER BY created_at").all();
    return (rows as Row[]).map(operationFromRow);
  }

  putOperation(value: ControlPlaneConnectionOperation) {
    this.client.prepare(`INSERT INTO na_control_plane_connection_operations
      (id, kind, phase, requested_json, pairing_key_id, connection_id, replaced_connections_json, error_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET phase=excluded.phase, pairing_key_id=excluded.pairing_key_id,
        connection_id=excluded.connection_id, replaced_connections_json=excluded.replaced_connections_json,
        error_json=excluded.error_json, updated_at=excluded.updated_at`)
      .run(value.id, value.kind, value.phase, JSON.stringify(value.requested), value.pairingKeyId ?? null,
        value.connectionId ?? null, JSON.stringify(value.replacedConnections), value.error ? JSON.stringify(value.error) : null,
        value.createdAt, value.updatedAt);
    return value;
  }

  deleteOperation(id: string) {
    return Number(this.client.prepare("DELETE FROM na_control_plane_connection_operations WHERE id = ?").run(id).changes) > 0;
  }

  transaction<T>(operation: () => T): T {
    if ((this.client as DatabaseSync & { isTransaction?: boolean }).isTransaction) return operation();
    this.client.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.client.exec("COMMIT");
      return result;
    } catch (error) {
      this.client.exec("ROLLBACK");
      throw error;
    }
  }
}

export function normalizeControlPlaneUrl(value: string) {
  return new URL(value).toString().replace(/\/$/, "");
}

function parseJsonArray(value: unknown): string[] {
  if (typeof value !== "string" || !value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function parseJsonObject(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "string" || !value) return undefined;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

function deleteExcept(client: DatabaseSync, table: string, column: string, ids: string[]) {
  if (!ids.length) client.exec(`DELETE FROM ${table}`);
  else client.prepare(`DELETE FROM ${table} WHERE ${column} NOT IN (${ids.map(() => "?").join(",")})`).run(...ids);
}

function operationFromRow(row: Row): ControlPlaneConnectionOperation {
  return {
    id: String(row.id), kind: String(row.kind), phase: row.phase as ControlPlaneConnectionOperation["phase"],
    requested: JSON.parse(String(row.requested_json)),
    ...(row.pairing_key_id ? { pairingKeyId: String(row.pairing_key_id) } : {}),
    ...(row.connection_id ? { connectionId: String(row.connection_id) } : {}),
    replacedConnections: JSON.parse(String(row.replaced_connections_json)),
    ...(row.error_json ? { error: JSON.parse(String(row.error_json)) } : {}),
    createdAt: String(row.created_at), updatedAt: String(row.updated_at),
  };
}

function controlPlanePinFromRow(row: Row): NodeAgentCloudControlPlanePin {
  return {
    id: String(row.id),
    nodeId: String(row.node_id),
    nodeHandle: String(row.node_handle),
    controlPlaneId: String(row.control_plane_id),
    controlPlanePublicKey: String(row.control_plane_public_key),
    bindingId: String(row.binding_id),
    bindingRevision: Number(row.binding_revision),
    accessAccountId: String(row.access_account_id),
    ownerAccountId: String(row.owner_account_id),
    accessMode: row.access_mode === "shared" ? "shared" : "owner",
    ...(row.share_grant_id ? { shareGrantId: String(row.share_grant_id) } : {}),
    ...(row.share_role ? { shareRole: String(row.share_role) as "use" } : {}),
    ...(row.share_revision !== null && row.share_revision !== undefined ? { shareRevision: Number(row.share_revision) } : {}),
    status: row.status === "revoked" ? "revoked" : "active",
    approvedByActorType: String(row.approved_by_actor_type) as NodeAgentCloudControlPlanePin["approvedByActorType"],
    approvedByActorId: String(row.approved_by_actor_id),
    approvedAt: String(row.approved_at),
    lastSeenAt: String(row.last_seen_at),
    ...(row.revoked_at ? { revokedAt: String(row.revoked_at) } : {}),
    ...(row.revoke_reason ? { revokeReason: String(row.revoke_reason) } : {}),
    authorizationRevision: Number(row.authorization_revision),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function controlPlaneTrustRequestFromRow(row: Row): NodeAgentCloudControlPlaneTrustRequest {
  return {
    id: String(row.id),
    nodeId: String(row.node_id),
    nodeHandle: String(row.node_handle),
    controlPlaneId: String(row.control_plane_id),
    controlPlanePublicKey: String(row.control_plane_public_key),
    bindingId: String(row.binding_id),
    bindingRevision: Number(row.binding_revision),
    accessAccountId: String(row.access_account_id),
    ownerAccountId: String(row.owner_account_id),
    accessMode: row.access_mode === "shared" ? "shared" : "owner",
    ...(row.share_grant_id ? { shareGrantId: String(row.share_grant_id) } : {}),
    ...(row.share_role ? { shareRole: String(row.share_role) as "use" } : {}),
    ...(row.share_revision !== null && row.share_revision !== undefined ? { shareRevision: Number(row.share_revision) } : {}),
    status: String(row.status) as NodeAgentCloudControlPlaneTrustRequest["status"],
    requestedAt: String(row.requested_at),
    lastSeenAt: String(row.last_seen_at),
    expiresAt: String(row.expires_at),
    ...(row.decided_at ? { decidedAt: String(row.decided_at) } : {}),
    ...(row.decided_by_actor_type ? { decidedByActorType: String(row.decided_by_actor_type) as NodeAgentCloudControlPlaneTrustRequest["decidedByActorType"] } : {}),
    ...(row.decided_by_actor_id ? { decidedByActorId: String(row.decided_by_actor_id) } : {}),
    ...(row.decision_reason ? { decisionReason: String(row.decision_reason) } : {}),
    ...(row.pin_id ? { pinId: String(row.pin_id) } : {}),
    revision: Number(row.revision),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function controlPlaneTrustError(code: string, message: string, statusCode: number) {
  return Object.assign(new Error(message), { code, statusCode });
}

function accessError(code: string, message: string) {
  return Object.assign(new Error(message), { code, statusCode: 409 });
}
