import { createId } from "../../shared/persistence/store.ts";
import type { ControlPlanePermissionId } from "@task-handoff/protocol/control-plane-access";
import type {
  CloudDeviceTrustRequest,
  CloudDeviceTrustRoleOption,
  CloudDeviceTrustSnapshot,
  CloudDeviceTrustedDevice,
} from "@task-handoff/protocol/device-trust";
import type {
  CloudDeviceAccessContext,
  ControlPlaneCloudDeviceTrustRepository,
  CloudDeviceTrustRoleRepository,
  ControlPlaneDeviceTrustStore,
  ControlPlaneDeviceTrustTransaction,
} from "./repository.ts";
import type {
  CloudDevicePinRecord,
  CloudDeviceTrustAuditRecord,
  CloudDeviceTrustReason,
  CloudDeviceTrustRequestRecord,
} from "../auth/database/cloud-device-trust-records.ts";
import type { CloudClientAuthContext } from "../cloud-connectivity/client-auth.ts";
import { deviceComparisonCode, fingerprintDevicePublicKey } from "../cloud-connectivity/client-auth.ts";

export const CLOUD_DEVICE_TRUST_REQUEST_TTL_MS = 24 * 60 * 60_000;
const CLOUD_DEVICE_TRUST_UPDATE_RETRIES = 3;
const SYSTEM_ACTOR: CloudDeviceTrustActor = Object.freeze({ type: "system", id: "control-plane", roleIds: [], permissionIds: [] });

export type CloudDeviceTrustResolvedRole = { roleIds: string[]; permissionIds: ControlPlanePermissionId[]; authorizationRevision: number };
export type CloudDeviceTrustRoleResolver = (
  roleId: string,
  repository: CloudDeviceTrustRoleRepository,
) => Promise<CloudDeviceTrustResolvedRole>;

export type CloudDeviceTrustActor = {
  type: "user" | "cloud-account" | "system";
  id: string;
  roleIds: string[];
  permissionIds: ControlPlanePermissionId[];
  deviceTrustPinId?: string;
};

export type CloudDeviceObservation =
  | { kind: "active"; pin: CloudDevicePinRecord; role: CloudDeviceTrustResolvedRole }
  | { kind: "pending"; request: CloudDeviceTrustRequestRecord; reason: CloudDeviceTrustReason; revokedPins?: CloudDevicePinRecord[] }
  | { kind: "rejected"; request: CloudDeviceTrustRequestRecord }
  | { kind: "expired"; request: CloudDeviceTrustRequestRecord }
  | { kind: "revoked"; pin: CloudDevicePinRecord }
  | { kind: "authorization-stale" };

export class CloudDeviceTrustError extends Error {
  readonly code: string;
  readonly statusCode: number;

  constructor(code: string, message: string, statusCode = 400) {
    super(message);
    this.name = "CloudDeviceTrustError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

export class CloudDeviceTrustService {
  private readonly store: ControlPlaneDeviceTrustStore;
  private readonly resolveRole: CloudDeviceTrustRoleResolver;
  private readonly options: {
    clock?: () => number;
    requestTtlMs?: number;
    closePinSessions?: (pin: CloudDevicePinRecord, reason: string) => Promise<void> | void;
    closeAllSessions?: (reason: string) => Promise<void> | void;
    onChanged?: (change: { bindingId: string; revision: number }) => Promise<void> | void;
  };
  private readonly closePinSessions: (pin: CloudDevicePinRecord, reason: string) => Promise<void> | void;

  constructor(
    store: ControlPlaneDeviceTrustStore,
    resolveRole: CloudDeviceTrustRoleResolver,
    options: {
      clock?: () => number;
      requestTtlMs?: number;
      closePinSessions?: (pin: CloudDevicePinRecord, reason: string) => Promise<void> | void;
      closeAllSessions?: (reason: string) => Promise<void> | void;
      onChanged?: (change: { bindingId: string; revision: number }) => Promise<void> | void;
    } = {},
  ) {
    this.store = store;
    this.resolveRole = resolveRole;
    this.options = options;
    this.closePinSessions = options.closePinSessions ?? (() => undefined);
  }

  async observeClient(input: CloudClientAuthContext, options: { explicitRetry?: boolean } = {}): Promise<CloudDeviceObservation> {
    const now = this.clock();
    let result: { observation: CloudDeviceObservation; revision?: number } | undefined;
    for (let attempt = 0; attempt < CLOUD_DEVICE_TRUST_UPDATE_RETRIES; attempt += 1) {
      try {
        result = await this.store.transaction(async (repository) => {
          const observed = await this.observeInRepository(repository, input, now, options.explicitRetry === true);
          const revision = observed.changed && observed.observation.kind !== "authorization-stale"
            ? await repository.cloudDeviceTrust.advanceRevision(input.accessContext.bindingId, Date.parse(observationTimestamp(observed.observation)))
            : undefined;
          return { observation: observed.observation, revision };
        });
        break;
      } catch (error) {
        if (!isDeviceTrustRevisionConflict(error) || attempt === CLOUD_DEVICE_TRUST_UPDATE_RETRIES - 1) throw error;
      }
    }
    if (!result) throw new CloudDeviceTrustError("CLOUD_DEVICE_TRUST_REVISION_CONFLICT", "The device trust state changed while it was being read.", 409);
    const { observation, revision } = result;
    if (observation.kind === "pending") {
      for (const pin of observation.revokedPins ?? []) await this.closePinSessions(pin, "device-trust-reapproval-required");
    }
    if (revision !== undefined) await this.publishChanged(input.accessContext.bindingId, revision);
    return observation;
  }

  async approve(input: {
    requestId: string;
    expectedFingerprint: string;
    roleId: string;
    expectedRevision: number;
    actor: CloudDeviceTrustActor;
    label?: string;
    reason?: string;
  }): Promise<{ request: CloudDeviceTrustRequestRecord; pin: CloudDevicePinRecord }> {
    const now = this.clock();
    const decided = await this.store.transaction(async (repository) => {
      await this.assertAdmin(repository, input.actor);
      const role = await this.resolveApprovalRole(repository, input.roleId);
      const decided = await this.approveInRepository(repository, { ...input, role, now });
      const revision = await repository.cloudDeviceTrust.advanceRevision(decided.request.bindingId, Date.parse(decided.request.updatedAt));
      return { ...decided, revision };
    });
    if (decided.previousPin) await this.closePinSessions(decided.previousPin, "device-trust-role-changed");
    await this.publishChanged(decided.request.bindingId, decided.revision);
    return { request: decided.request, pin: decided.pin };
  }

  async reject(input: { requestId: string; expectedFingerprint: string; expectedRevision: number; actor: CloudDeviceTrustActor; reason?: string }): Promise<CloudDeviceTrustRequestRecord> {
    const now = this.clock();
    const decided = await this.store.transaction(async (repository) => {
      await this.assertAdmin(repository, input.actor);
      const request = await this.requirePending(repository.cloudDeviceTrust, input.requestId, now);
      await this.assertAdmin(repository, input.actor, request.bindingId);
      await this.assertNotSelfApproval(repository.cloudDeviceTrust, input.actor, request);
      this.assertExpectedFingerprint(request.devicePublicKey, input.expectedFingerprint);
      this.assertExpectedRevision(request, input.expectedRevision);
      const updated = {
        ...request,
        status: "rejected" as const,
        decidedAt: now.toISOString(),
        decidedByActorType: input.actor.type,
        decidedByActorId: input.actor.id,
        ...(input.reason ? { decisionReason: input.reason } : {}),
        revision: request.revision + 1,
        updatedAt: now.toISOString(),
      };
      if (!await repository.cloudDeviceTrust.putRequestIfStatus(updated, "pending", request.revision)) {
        throw new CloudDeviceTrustError("CLOUD_DEVICE_TRUST_REQUEST_NOT_PENDING", "The device approval request is no longer pending.", 409);
      }
      await this.audit(repository.cloudDeviceTrust, "request-rejected", request, input.actor, input.reason);
      const revision = await repository.cloudDeviceTrust.advanceRevision(updated.bindingId, Date.parse(updated.updatedAt));
      return { rejected: updated, revision };
    });
    await this.publishChanged(decided.rejected.bindingId, decided.revision);
    return decided.rejected;
  }

  async revokePin(input: { pinId: string; expectedRevision: number; actor: CloudDeviceTrustActor; reason?: string }): Promise<CloudDevicePinRecord> {
    const now = this.clock();
    const decided = await this.store.transaction(async (repository) => {
      await this.assertAdmin(repository, input.actor);
      const pin = await repository.cloudDeviceTrust.getPin(input.pinId);
      if (!pin) throw new CloudDeviceTrustError("CLOUD_DEVICE_PIN_NOT_FOUND", "The trusted device was not found.", 404);
      if (pin.status !== "active") throw new CloudDeviceTrustError("CLOUD_DEVICE_PIN_NOT_ACTIVE", "The trusted device is already revoked.", 409);
      await this.assertAdmin(repository, input.actor, pin.bindingId);
      this.assertExpectedRevision(pin, input.expectedRevision);
      const updated: CloudDevicePinRecord = {
        ...pin,
        status: "revoked",
        revokedAt: now.toISOString(),
        ...(input.reason ? { revokeReason: input.reason } : {}),
        authorizationRevision: pin.authorizationRevision + 1,
        revision: pin.revision + 1,
        updatedAt: now.toISOString(),
      };
      if (!await repository.cloudDeviceTrust.putPinIfStatus(updated, "active", pin.revision)) {
        throw new CloudDeviceTrustError("CLOUD_DEVICE_PIN_NOT_ACTIVE", "The trusted device was already revoked.", 409);
      }
      await this.audit(repository.cloudDeviceTrust, "pin-revoked", updated, input.actor, input.reason, { pinId: pin.id });
      const revision = await repository.cloudDeviceTrust.advanceRevision(updated.bindingId, Date.parse(updated.updatedAt));
      return { updated, revision };
    });
    const updated = decided.updated;
    await this.closePinSessions(updated, "device-trust-revoked");
    await this.publishChanged(updated.bindingId, decided.revision);
    return updated;
  }

  async expire(bindingId: string): Promise<number> {
    const now = this.clock();
    const result = await this.store.transaction(async (repository) => {
      const requests = await repository.cloudDeviceTrust.listRequests(bindingId);
      let count = 0;
      for (const request of requests) {
        if (request.status !== "pending" || Date.parse(request.expiresAt) > now.getTime()) continue;
        if (await this.expireRequestInRepository(repository.cloudDeviceTrust, request, now)) count += 1;
      }
      const revision = count ? await repository.cloudDeviceTrust.advanceRevision(bindingId, now.getTime()) : undefined;
      return { count, revision };
    });
    if (result.revision !== undefined) await this.publishChanged(bindingId, result.revision);
    return result.count;
  }

  async list(bindingId: string) {
    return this.store.transaction(async (repository) => ({
      pins: await repository.cloudDeviceTrust.listPins(bindingId),
      requests: await repository.cloudDeviceTrust.listRequests(bindingId),
      audit: await repository.cloudDeviceTrust.listAudit(bindingId),
    }));
  }

  async assertTrustedAdmin(actor: CloudDeviceTrustActor): Promise<void> {
    await this.store.transaction(async (repository) => {
      await this.assertAdmin(repository, actor);
    });
  }

  async snapshot(bindingId: string | undefined, roles: readonly CloudDeviceTrustRoleOption[]): Promise<CloudDeviceTrustSnapshot> {
    if (!bindingId) return { revision: 0, requests: [], trustedDevices: [], roles: [...roles] };
    await this.expire(bindingId);
    return this.store.transaction(async (repository) => {
      const [pins, requests, persistedRevision] = await Promise.all([
        repository.cloudDeviceTrust.listPins(bindingId),
        repository.cloudDeviceTrust.listRequests(bindingId),
        repository.cloudDeviceTrust.getRevision(bindingId),
      ]);
      const revision = Math.max(persistedRevision, [
        ...pins.map((pin) => pin.updatedAt),
        ...requests.map((request) => request.updatedAt),
      ].reduce((current, timestamp) => Math.max(current, Date.parse(timestamp) || 0), 0));
      const roleNames = new Map(roles.map((role) => [role.roleId, role.name]));
      return {
        revision,
        requests: requests
          .slice()
          .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id))
          .map(projectRequest),
        trustedDevices: pins
          .slice()
          .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id))
          .map((pin) => projectTrustedDevice(pin, roleNames.get(pin.roleId))),
        roles: [...roles],
      };
    });
  }

  async closeAllSessions(reason: string): Promise<void> {
    await this.options.closeAllSessions?.(reason);
  }

  private async observeInRepository(
    repository: ControlPlaneDeviceTrustTransaction,
    input: CloudClientAuthContext,
    now: Date,
    explicitRetry: boolean,
  ): Promise<{ observation: CloudDeviceObservation; changed: boolean }> {
    const devices = repository.cloudDeviceTrust;
    const active = await devices.findActivePin(input.accessContext);
    if (active) {
      let role: CloudDeviceTrustResolvedRole;
      try {
        role = await this.resolveRole(active.roleId, repository);
      } catch (error) {
        if (!isRoleUnavailable(error)) throw error;
        const revoked = await this.revokePinForReapproval(devices, active, now, "local-role-unavailable");
        const { request } = await this.createOrRefreshRequest(devices, input, now, "role-changed");
        return { observation: { kind: "pending", request, reason: request.reason, revokedPins: [revoked] }, changed: true };
      }
      if (role.roleIds.length === 0 || role.authorizationRevision > active.authorizationRevision) {
        const revoked = await this.revokePinForReapproval(devices, active, now, "local-role-changed");
        const { request } = await this.createOrRefreshRequest(devices, input, now, "role-changed");
        return { observation: { kind: "pending", request, reason: request.reason, revokedPins: [revoked] }, changed: true };
      }
      const incomingRevision = input.ticket.shareRevision;
      if (active.accessMode === "shared" && incomingRevision !== undefined) {
        if (active.shareRevision !== undefined && incomingRevision < active.shareRevision) {
          return { observation: { kind: "authorization-stale" }, changed: false };
        }
        if (active.shareRevision === undefined || incomingRevision > active.shareRevision) {
          const converged = {
            ...active,
            shareRevision: incomingRevision,
            reportedName: input.device.name,
            clientKind: input.device.kind,
            clientPlatform: input.device.platform,
            ...(input.device.version ? { clientVersion: input.device.version } : {}),
            lastSeenAt: now.toISOString(),
            revision: active.revision + 1,
            updatedAt: now.toISOString(),
          };
          if (!await devices.putPinIfStatus(converged, "active", active.revision)) {
            throw new CloudDeviceTrustError("CLOUD_DEVICE_TRUST_REVISION_CONFLICT", "The trusted device changed while its share revision was converging.", 409);
          }
          await this.audit(devices, "pin-revision-converged", converged, SYSTEM_ACTOR, "share-revision-forward", {
            previousShareRevision: active.shareRevision,
            shareRevision: incomingRevision,
          });
          return { observation: { kind: "active", pin: converged, role }, changed: true };
        }
      }
      const refreshed = this.touchPin(active, input, now);
      if (!await devices.putPinIfStatus(refreshed.pin, "active", active.revision)) {
        throw new CloudDeviceTrustError("CLOUD_DEVICE_TRUST_REVISION_CONFLICT", "The trusted device changed while it was being refreshed.", 409);
      }
      return { observation: { kind: "active", pin: refreshed.pin, role }, changed: refreshed.changed };
    }

    const latest = await devices.latestRequest(input.accessContext);
    if (latest && isStaleShareRevision(latest, input)) return { observation: { kind: "authorization-stale" }, changed: false };
    if (latest?.status === "pending") {
      if (Date.parse(latest.expiresAt) <= now.getTime()) {
        const expired = await this.expireRequestInRepository(devices, latest, now);
        if (!expired) throw new CloudDeviceTrustError("CLOUD_DEVICE_TRUST_REVISION_CONFLICT", "The device approval request changed while expiring.", 409);
        return { observation: { kind: "expired", request: expired }, changed: true };
      }
      const refreshed = this.touchRequest(latest, input, now);
      if (!await devices.putRequestIfStatus(refreshed.request, "pending", latest.revision)) {
        throw new CloudDeviceTrustError("CLOUD_DEVICE_TRUST_REVISION_CONFLICT", "The device approval request changed while it was being refreshed.", 409);
      }
      if (refreshed.changed) await this.audit(devices, "request-refreshed", refreshed.request, SYSTEM_ACTOR);
      return { observation: { kind: "pending", request: refreshed.request, reason: refreshed.request.reason }, changed: refreshed.changed };
    }
    if (latest?.status === "expired" && !explicitRetry) return { observation: { kind: "expired", request: latest }, changed: false };
    if (latest?.status === "rejected" && !explicitRetry) return { observation: { kind: "rejected", request: latest }, changed: false };
    if (latest?.status === "approved") {
      const pin = latest.approvedPinId ? await devices.getPin(latest.approvedPinId) : undefined;
      if (pin?.status === "revoked" && !explicitRetry) return { observation: { kind: "revoked", pin }, changed: false };
    }
    const requests = await devices.listRequests(input.accessContext.bindingId);
    const revoked = requests.find((request) => request.status === "approved" && matchContext(request, input.accessContext));
    if (revoked?.approvedPinId && !explicitRetry) {
      const pin = await devices.getPin(revoked.approvedPinId);
      if (pin?.status === "revoked") return { observation: { kind: "revoked", pin }, changed: false };
    }
    const pins = await devices.listPins(input.accessContext.bindingId);
    const reason = this.reapprovalReason(pins, input);
    const revokedPins = reason === "first-seen"
      ? []
      : await Promise.all(this.supersededPins(pins, input).map((pin) => this.revokePinForReapproval(devices, pin, now, reason)));
    const refreshed = await this.createOrRefreshRequest(devices, input, now, reason);
    return {
      observation: { kind: "pending", request: refreshed.request, reason: refreshed.request.reason, ...(revokedPins.length ? { revokedPins } : {}) },
      changed: refreshed.changed || revokedPins.length > 0,
    };
  }

  private async approveInRepository(
    repository: ControlPlaneDeviceTrustTransaction,
    input: { requestId: string; expectedFingerprint: string; expectedRevision: number; roleId: string; actor: CloudDeviceTrustActor; label?: string; reason?: string; role: CloudDeviceTrustResolvedRole; now: Date },
  ): Promise<{ request: CloudDeviceTrustRequestRecord; pin: CloudDevicePinRecord; previousPin?: CloudDevicePinRecord }> {
    const devices = repository.cloudDeviceTrust;
    const request = await this.requirePending(devices, input.requestId, input.now);
    await this.assertAdmin(repository, input.actor, request.bindingId);
    await this.assertNotSelfApproval(devices, input.actor, request);
    this.assertExpectedRevision(request, input.expectedRevision);
    this.assertExpectedFingerprint(request.devicePublicKey, input.expectedFingerprint);
    const context = requestContext(request);
    const previous = await devices.findActivePin(context);
    const timestamp = input.now.toISOString();
    const label = input.label ?? previous?.label;
    const pin: CloudDevicePinRecord = {
      id: createId("devpin"),
      ...context,
      shareRevision: request.shareRevision,
      reportedName: request.reportedName,
      clientKind: request.clientKind,
      clientPlatform: request.clientPlatform,
      ...(request.clientVersion ? { clientVersion: request.clientVersion } : {}),
      roleId: input.roleId,
      status: "active",
      ...(label ? { label } : {}),
      approvedByActorType: input.actor.type,
      approvedByActorId: input.actor.id,
      approvedAt: timestamp,
      lastSeenAt: timestamp,
      // Keep the role revision itself so a later role edit is always observable.
      // A new pin has a new id, so it does not need to outrank the superseded
      // pin's revocation fence.
      authorizationRevision: input.role.authorizationRevision,
      revision: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    // approvedPinId is a foreign key, so the pin must exist before the request
    // can become approved. Stage it as revoked to avoid occupying the active
    // context uniqueness slot until the request has been claimed.
    const stagedPin: CloudDevicePinRecord = { ...pin, status: "revoked", revokedAt: timestamp };
    await devices.putPin(stagedPin);
    const approved: CloudDeviceTrustRequestRecord = {
      ...request,
      status: "approved",
      decidedAt: timestamp,
      decidedByActorType: input.actor.type,
      decidedByActorId: input.actor.id,
      decidedRoleId: input.roleId,
      ...(input.reason ? { decisionReason: input.reason } : {}),
      approvedPinId: pin.id,
      revision: request.revision + 1,
      updatedAt: timestamp,
    };
    if (!await devices.putRequestIfStatus(approved, "pending", request.revision)) {
      throw new CloudDeviceTrustError("CLOUD_DEVICE_TRUST_REQUEST_NOT_PENDING", "The device approval request is no longer pending.", 409);
    }
    if (previous) {
      await this.revokePinForReapproval(devices, previous, input.now, "superseded-by-approval");
    }
    if (!await devices.putPinIfStatus(pin, "revoked", stagedPin.revision)) {
      throw new CloudDeviceTrustError("CLOUD_DEVICE_TRUST_REVISION_CONFLICT", "The trusted device changed while approval was being applied.", 409);
    }
    await this.audit(devices, "request-approved", approved, input.actor, input.reason, { pinId: pin.id, roleId: input.roleId });
    return { request: approved, pin, ...(previous ? { previousPin: previous } : {}) };
  }

  private async createOrRefreshRequest(
    devices: ControlPlaneCloudDeviceTrustRepository,
    input: CloudClientAuthContext,
    now: Date,
    reason: CloudDeviceTrustReason,
  ): Promise<{ request: CloudDeviceTrustRequestRecord; changed: boolean }> {
    const existing = await devices.findPendingRequest(input.accessContext);
    if (existing) {
      if (Date.parse(existing.expiresAt) > now.getTime()) {
        const refreshed = this.touchRequest(existing, input, now, reason);
        if (!await devices.putRequestIfStatus(refreshed.request, "pending", existing.revision)) {
          throw new CloudDeviceTrustError("CLOUD_DEVICE_TRUST_REVISION_CONFLICT", "The device approval request changed while it was being refreshed.", 409);
        }
        if (refreshed.changed) await this.audit(devices, "request-refreshed", refreshed.request, SYSTEM_ACTOR);
        return refreshed;
      }
      if (!await this.expireRequestInRepository(devices, existing, now)) {
        throw new CloudDeviceTrustError("CLOUD_DEVICE_TRUST_REVISION_CONFLICT", "The device approval request changed while expiring.", 409);
      }
    }
    const timestamp = now.toISOString();
    const context = input.accessContext;
    const record: CloudDeviceTrustRequestRecord = {
      id: createId("devtrust"),
      ...context,
      shareRevision: input.ticket.shareRevision,
      reportedName: input.device.name,
      clientKind: input.device.kind,
      clientPlatform: input.device.platform,
      ...(input.device.version ? { clientVersion: input.device.version } : {}),
      status: "pending",
      reason,
      requestedAt: timestamp,
      lastSeenAt: timestamp,
      expiresAt: new Date(now.getTime() + (this.options.requestTtlMs ?? CLOUD_DEVICE_TRUST_REQUEST_TTL_MS)).toISOString(),
      createdAt: timestamp,
      revision: 1,
      updatedAt: timestamp,
    };
    await devices.putRequest(record);
    await this.audit(devices, "request-created", record, SYSTEM_ACTOR, reason);
    return { request: record, changed: true };
  }

  private touchRequest(
    request: CloudDeviceTrustRequestRecord,
    input: CloudClientAuthContext,
    now: Date,
    reason = request.reason,
  ): { request: CloudDeviceTrustRequestRecord; changed: boolean } {
    const timestamp = now.toISOString();
    const shareRevision = input.ticket.shareRevision ?? request.shareRevision;
    const changed = request.shareRevision !== shareRevision
      || request.reportedName !== input.device.name
      || request.clientKind !== input.device.kind
      || request.clientPlatform !== input.device.platform
      || request.clientVersion !== input.device.version
      || request.reason !== reason;
    if (!changed) return { request: { ...request, lastSeenAt: timestamp }, changed: false };
    return {
      request: {
        ...request,
        shareRevision,
        reportedName: input.device.name,
        clientKind: input.device.kind,
        clientPlatform: input.device.platform,
        clientVersion: input.device.version,
        reason,
        lastSeenAt: timestamp,
        revision: request.revision + 1,
        updatedAt: timestamp,
      },
      changed: true,
    };
  }

  private touchPin(
    pin: CloudDevicePinRecord,
    input: CloudClientAuthContext,
    now: Date,
  ): { pin: CloudDevicePinRecord; changed: boolean } {
    const timestamp = now.toISOString();
    const changed = pin.reportedName !== input.device.name
      || pin.clientKind !== input.device.kind
      || pin.clientPlatform !== input.device.platform
      || pin.clientVersion !== input.device.version;
    if (!changed) return { pin: { ...pin, lastSeenAt: timestamp }, changed: false };
    return {
      pin: {
        ...pin,
        reportedName: input.device.name,
        clientKind: input.device.kind,
        clientPlatform: input.device.platform,
        clientVersion: input.device.version,
        lastSeenAt: timestamp,
        revision: pin.revision + 1,
        updatedAt: timestamp,
      },
      changed: true,
    };
  }

  private async expireRequestInRepository(
    devices: ControlPlaneCloudDeviceTrustRepository,
    request: CloudDeviceTrustRequestRecord,
    now: Date,
  ): Promise<CloudDeviceTrustRequestRecord | undefined> {
    if (request.status !== "pending" || Date.parse(request.expiresAt) > now.getTime()) return undefined;
    const expired: CloudDeviceTrustRequestRecord = {
      ...request,
      status: "expired",
      decidedAt: now.toISOString(),
      decidedByActorType: "system",
      decidedByActorId: "control-plane",
      revision: request.revision + 1,
      updatedAt: now.toISOString(),
    };
    if (!await devices.putRequestIfStatus(expired, "pending", request.revision)) return undefined;
    await this.audit(devices, "request-expired", expired, SYSTEM_ACTOR, "request-expired");
    return expired;
  }

  private async revokePinForReapproval(
    devices: ControlPlaneCloudDeviceTrustRepository,
    pin: CloudDevicePinRecord,
    now: Date,
    reason: string,
  ): Promise<CloudDevicePinRecord> {
    const revoked: CloudDevicePinRecord = {
      ...pin,
      status: "revoked",
      revokedAt: now.toISOString(),
      revokeReason: reason,
      authorizationRevision: pin.authorizationRevision + 1,
      revision: pin.revision + 1,
      updatedAt: now.toISOString(),
    };
    if (!await devices.putPinIfStatus(revoked, "active", pin.revision)) {
      throw new CloudDeviceTrustError("CLOUD_DEVICE_TRUST_REVISION_CONFLICT", "The trusted device changed while reapproval was required.", 409);
    }
    await this.audit(devices, "pin-revoked", revoked, SYSTEM_ACTOR, reason, { pinId: pin.id });
    return revoked;
  }

  private async requirePending(devices: ControlPlaneCloudDeviceTrustRepository, requestId: string, now: Date) {
    const request = await devices.getRequest(requestId);
    if (!request) throw new CloudDeviceTrustError("CLOUD_DEVICE_TRUST_REQUEST_NOT_FOUND", "The device approval request was not found.", 404);
    if (request.status !== "pending") throw new CloudDeviceTrustError("CLOUD_DEVICE_TRUST_REQUEST_NOT_PENDING", "The device approval request is no longer pending.", 409);
    if (Date.parse(request.expiresAt) <= now.getTime()) throw new CloudDeviceTrustError("CLOUD_DEVICE_TRUST_REQUEST_EXPIRED", "The device approval request has expired.", 409);
    return request;
  }

  private async assertAdmin(repository: ControlPlaneDeviceTrustTransaction, actor: CloudDeviceTrustActor, bindingId?: string) {
    const devices = repository.cloudDeviceTrust;
    if (actor.type !== "system" && !actor.permissionIds.includes("settings:manage")) {
      throw new CloudDeviceTrustError("CLOUD_DEVICE_TRUST_ADMIN_REQUIRED", "An admin role is required.", 403);
    }
    if (actor.type === "cloud-account") {
      const pin = actor.deviceTrustPinId ? await devices.getPin(actor.deviceTrustPinId) : undefined;
      let role: CloudDeviceTrustResolvedRole | undefined;
      if (pin?.status === "active") {
        try {
          role = await this.resolveRole(pin.roleId, repository);
        } catch (error) {
          if (!isRoleUnavailable(error)) throw error;
        }
      }
      if (!pin || pin.status !== "active" || !role?.permissionIds.includes("settings:manage") || (bindingId !== undefined && pin.bindingId !== bindingId)) {
        throw new CloudDeviceTrustError("CLOUD_DEVICE_TRUST_ADMIN_REQUIRED", "The calling device is not a trusted admin.", 403);
      }
    }
  }

  private async resolveApprovalRole(repository: ControlPlaneDeviceTrustTransaction, roleId: string) {
    try {
      const role = await this.resolveRole(roleId, repository);
      if (role.roleIds.length === 0) throw new CloudDeviceTrustError("CLOUD_DEVICE_TRUST_ROLE_UNAVAILABLE", "The selected local role is not available.");
      return role;
    } catch (error) {
      if (isRoleUnavailable(error)) throw new CloudDeviceTrustError("CLOUD_DEVICE_TRUST_ROLE_UNAVAILABLE", "The selected local role is not available.");
      throw error;
    }
  }

  private assertExpectedRevision(record: Pick<CloudDevicePinRecord | CloudDeviceTrustRequestRecord, "revision">, expectedRevision: number) {
    if (record.revision !== expectedRevision) {
      throw new CloudDeviceTrustError("CLOUD_DEVICE_TRUST_REVISION_CONFLICT", "The device trust record changed before this decision.", 409);
    }
  }

  private assertExpectedFingerprint(devicePublicKey: string, expectedFingerprint: string) {
    if (fingerprintDevicePublicKey(devicePublicKey) !== expectedFingerprint) {
      throw new CloudDeviceTrustError("CLOUD_DEVICE_TRUST_FINGERPRINT_CONFLICT", "The device fingerprint changed before this decision.", 409);
    }
  }

  private async assertNotSelfApproval(
    devices: ControlPlaneCloudDeviceTrustRepository,
    actor: CloudDeviceTrustActor,
    request: Pick<CloudDeviceTrustRequestRecord, "devicePublicKey">,
  ) {
    if (actor.type !== "cloud-account" || !actor.deviceTrustPinId) return;
    const actorPin = await devices.getPin(actor.deviceTrustPinId);
    if (actorPin?.status === "active" && actorPin.devicePublicKey === request.devicePublicKey) {
      throw new CloudDeviceTrustError("CLOUD_DEVICE_TRUST_SELF_APPROVAL_FORBIDDEN", "A device cannot decide its own trust request.", 403);
    }
  }

  private reapprovalReason(pins: CloudDevicePinRecord[], input: CloudClientAuthContext): CloudDeviceTrustReason {
    const previous = this.supersededPins(pins, input)[0];
    if (!previous) return "first-seen";
    if (previous.shareGrantId !== input.accessContext.shareGrantId) return "share-role-changed";
    return "role-changed";
  }

  private supersededPins(pins: CloudDevicePinRecord[], input: CloudClientAuthContext) {
    return pins.filter((pin) => pin.status === "active"
      && pin.bindingId === input.accessContext.bindingId
      && pin.accountId === input.accessContext.accountId
      && pin.ownerAccountId === input.accessContext.ownerAccountId
      && pin.devicePublicKey === input.accessContext.devicePublicKey
      && !sameAccessContext(pin, input.accessContext));
  }

  private async audit(
    devices: ControlPlaneCloudDeviceTrustRepository,
    action: CloudDeviceTrustAuditRecord["action"],
    record: Pick<CloudDeviceTrustRequestRecord, "id" | "bindingId" | "accountId" | "devicePublicKey"> | CloudDevicePinRecord,
    actor: CloudDeviceTrustActor,
    reason?: string,
    details: Record<string, unknown> = {},
  ) {
    await devices.appendAudit({
      id: createId("devtrustaudit"),
      action,
      bindingId: record.bindingId,
      requestId: "requestedAt" in record ? record.id : undefined,
      pinId: "approvedAt" in record ? record.id : (typeof details.pinId === "string" ? details.pinId : undefined),
      accountId: record.accountId,
      devicePublicKey: record.devicePublicKey,
      deviceFingerprint: fingerprintDevicePublicKey(record.devicePublicKey),
      actorType: actor.type,
      actorId: actor.id,
      ...(actor.roleIds[0] ? { actorRoleId: actor.roleIds[0] } : {}),
      details: {
        ...details,
        ...(actor.type === "cloud-account" && actor.deviceTrustPinId ? { actorDevicePinId: actor.deviceTrustPinId } : {}),
      },
      ...(reason ? { reason } : {}),
      createdAt: this.clock().toISOString(),
    });
  }

  private clock() {
    return new Date((this.options.clock ?? Date.now)());
  }

  private async publishChanged(bindingId: string, revision: number) {
    await this.options.onChanged?.({ bindingId, revision });
  }
}

function requestContext(request: CloudDeviceTrustRequestRecord): CloudDeviceAccessContext {
  return {
    bindingId: request.bindingId,
    accountId: request.accountId,
    ownerAccountId: request.ownerAccountId,
    accessMode: request.accessMode,
    ...(request.shareGrantId === undefined ? {} : { shareGrantId: request.shareGrantId }),
    cloudAccessRoleId: request.cloudAccessRoleId,
    devicePublicKey: request.devicePublicKey,
  };
}

function matchContext(request: CloudDeviceTrustRequestRecord, context: CloudDeviceAccessContext) {
  return request.bindingId === context.bindingId
    && request.accountId === context.accountId
    && request.ownerAccountId === context.ownerAccountId
    && request.accessMode === context.accessMode
    && request.shareGrantId === context.shareGrantId
    && request.cloudAccessRoleId === context.cloudAccessRoleId
    && request.devicePublicKey === context.devicePublicKey;
}

function sameAccessContext(pin: CloudDevicePinRecord, context: CloudDeviceAccessContext) {
  return pin.bindingId === context.bindingId
    && pin.accountId === context.accountId
    && pin.ownerAccountId === context.ownerAccountId
    && pin.accessMode === context.accessMode
    && pin.shareGrantId === context.shareGrantId
    && pin.cloudAccessRoleId === context.cloudAccessRoleId
    && pin.devicePublicKey === context.devicePublicKey;
}

function observationTimestamp(observation: Exclude<CloudDeviceObservation, { kind: "authorization-stale" }>) {
  return observation.kind === "active" || observation.kind === "revoked"
    ? observation.pin.updatedAt
    : observation.request.updatedAt;
}

function projectRequest(request: CloudDeviceTrustRequestRecord): CloudDeviceTrustRequest {
  return {
    source: "control-plane-device",
    requestId: request.id,
    status: request.status,
    reason: request.reason,
    device: {
      name: request.reportedName,
      kind: request.clientKind,
      platform: request.clientPlatform,
      ...(request.clientVersion ? { version: request.clientVersion } : {}),
    },
    fingerprint: fingerprintDevicePublicKey(request.devicePublicKey),
    comparisonCode: deviceComparisonCode(request.bindingId, request.devicePublicKey),
    bindingId: request.bindingId,
    accountId: request.accountId,
    ownerAccountId: request.ownerAccountId,
    accessMode: request.accessMode,
    ...(request.shareGrantId ? { shareGrantId: request.shareGrantId } : {}),
    cloudAccessRoleId: request.cloudAccessRoleId,
    requestedAt: request.requestedAt,
    lastSeenAt: request.lastSeenAt,
    expiresAt: request.expiresAt,
    ...(request.decidedAt ? { decidedAt: request.decidedAt } : {}),
    ...(request.decidedRoleId ? { decidedRoleId: request.decidedRoleId } : {}),
    ...(request.decisionReason ? { decisionReason: request.decisionReason } : {}),
    revision: request.revision,
  };
}

function projectTrustedDevice(pin: CloudDevicePinRecord, roleName: string | undefined): CloudDeviceTrustedDevice {
  return {
    pinId: pin.id,
    source: "control-plane-device",
    status: pin.status,
    device: {
      name: pin.reportedName,
      kind: pin.clientKind,
      platform: pin.clientPlatform,
      ...(pin.clientVersion ? { version: pin.clientVersion } : {}),
    },
    fingerprint: fingerprintDevicePublicKey(pin.devicePublicKey),
    comparisonCode: deviceComparisonCode(pin.bindingId, pin.devicePublicKey),
    bindingId: pin.bindingId,
    accountId: pin.accountId,
    ownerAccountId: pin.ownerAccountId,
    accessMode: pin.accessMode,
    ...(pin.shareGrantId ? { shareGrantId: pin.shareGrantId } : {}),
    ...(pin.shareRevision ? { shareRevision: pin.shareRevision } : {}),
    cloudAccessRoleId: pin.cloudAccessRoleId,
    roleId: pin.roleId,
    ...(roleName ? { roleName } : {}),
    approvedAt: pin.approvedAt,
    approvedByActorType: pin.approvedByActorType,
    approvedByActorId: pin.approvedByActorId,
    lastSeenAt: pin.lastSeenAt,
    ...(pin.revokedAt ? { revokedAt: pin.revokedAt } : {}),
    ...(pin.revokeReason ? { revokeReason: pin.revokeReason } : {}),
    revision: pin.revision,
  };
}

function isDeviceTrustRevisionConflict(error: unknown) {
  return error instanceof CloudDeviceTrustError && error.code === "CLOUD_DEVICE_TRUST_REVISION_CONFLICT";
}

function isRoleUnavailable(error: unknown) {
  return Boolean(error) && typeof error === "object" && (error as { code?: unknown }).code === "CONTROL_PLANE_ROLE_INACTIVE";
}

function isStaleShareRevision(request: CloudDeviceTrustRequestRecord, input: CloudClientAuthContext) {
  return input.accessContext.accessMode === "shared"
    && request.shareRevision !== undefined
    && input.ticket.shareRevision !== undefined
    && input.ticket.shareRevision < request.shareRevision;
}
