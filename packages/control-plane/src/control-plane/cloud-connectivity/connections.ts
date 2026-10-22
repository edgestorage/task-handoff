import crypto from "node:crypto";
import { StandardReconnectBackoff } from "@task-handoff/core/core/reconnect";
import type { CloudConnectivityService } from "./service.ts";
import { RelaySessionStore, type PersistedRelaySession } from "./relay-session-store.ts";

type ManagedConnection = { close(reason?: string): Promise<void> | void; renew?(grant: unknown): Promise<void> | void };
type VerifiedDataAllocation = { allocationId: string; relayUrl: string; epoch: number; channelKind?: "access" | "node"; grant?: unknown };
type DataConnectionEntry = {
  epoch: number;
  channelKind: "access" | "node";
  relayUrl: string;
  verified: VerifiedDataAllocation;
  connection?: ManagedConnection;
  attempts: number;
  timer?: ReturnType<typeof setTimeout>;
  resuming?: Promise<void>;
};

const COORDINATOR_ORIGIN_COOLDOWN_MS = 5_000;
const TERMINAL_RELAY_RESUME_CODES = new Set([
  "RELAY_SESSION_NOT_FOUND",
  "RELAY_SESSION_REVOKED",
  "RELAY_SESSION_EXPIRED",
  "RELAY_SESSION_GRANT_INVALID",
  "RELAY_SESSION_ROLE_MISMATCH",
  "RELAY_SESSION_PROOF_INVALID",
  "RELAY_SESSION_REPLAYED",
  "RELAY_SESSION_GENERATION_STALE",
  "RELAY_SESSION_GENERATION_CONFLICT",
]);

export class CloudControlConnectionManager {
  private connection?: ManagedConnection;
  private connectionBindingId?: string;
  private readonly coordinatorOrigins: readonly string[];
  private readonly originCooldownMs: number;
  private readonly originCooldowns = new Map<string, number>();
  private readonly clock: () => number;
  readonly processInstanceId = `control_plane_process_${crypto.randomUUID().replaceAll("-", "_")}`;
  private readonly backoff: StandardReconnectBackoff;
  private readonly options: {
    state: CloudConnectivityService;
    connector: { connect(input: Record<string, unknown>): Promise<ManagedConnection> };
    onEvent(event: unknown): Promise<void> | void;
    backoff?: StandardReconnectBackoff;
    coordinatorOrigins?: readonly string[];
    originResolver?: {
      activeOrigin(): string;
      endpoints(): readonly string[];
      markSuccess?(origin: string): void;
      markFailure?(origin: string): void;
    };
    originCooldownMs?: number;
    clock?: () => number;
    onOriginFailover?: (entry: { fromOrigin: string; toOrigin: string; reason: string }) => void;
  };

  constructor(options: {
    state: CloudConnectivityService;
    connector: { connect(input: Record<string, unknown>): Promise<ManagedConnection> };
    onEvent(event: unknown): Promise<void> | void;
    backoff?: StandardReconnectBackoff;
    coordinatorOrigins?: readonly string[];
    originResolver?: {
      activeOrigin(): string;
      endpoints(): readonly string[];
      markSuccess?(origin: string): void;
      markFailure?(origin: string): void;
    };
    originCooldownMs?: number;
    clock?: () => number;
    onOriginFailover?: (entry: { fromOrigin: string; toOrigin: string; reason: string }) => void;
  }) {
    this.options = options;
    this.backoff = options.backoff ?? new StandardReconnectBackoff();
    this.coordinatorOrigins = options.coordinatorOrigins ?? [];
    this.originCooldownMs = options.originCooldownMs ?? COORDINATOR_ORIGIN_COOLDOWN_MS;
    this.clock = options.clock ?? Date.now;
  }

  async connectOnce() {
    const snapshot = this.options.state.snapshot();
    // A pending revocation keeps the credential only so it can reconnect and
    // finish the remote revoke. Without this, a failed revoke would strand the
    // local state machine forever: no connection means no way to ask the cloud
    // to revoke, and no way to sign in again.
    const credential = snapshot.status === "pending-revocation"
      ? this.options.state.revocationCredential()
      : this.options.state.backgroundCredential();
    // An unbound Control Plane still registers so it can sign in to a Thandoff account; the
    // Coordinator rejects it if the account already holds a live binding. An active binding
    // keeps the cloud connection while either cloud-relay scope is on; only turning both off
    // stops it.
    const canRegister = snapshot.status === "unbound" || snapshot.status === "pending-claim"
      || (snapshot.status === "active" && (snapshot.scopes.deviceAccess || snapshot.scopes.nodeRelay) && Boolean(credential))
      || (snapshot.status === "pending-revocation" && Boolean(snapshot.bindingId) && Boolean(credential));
    if (!canRegister) return { status: "disabled" as const };
    // The registration carries the binding identity that was current when the
    // socket opened. Reuse it only while the local binding still matches;
    // otherwise a post-revocation request would be sent as a bound Control
    // Plane and the Coordinator would reject a new binding challenge.
    if (this.connection && this.connectionBindingId === snapshot.bindingId) return { status: "connected" as const, reused: true as const };
    if (this.connection) await this.stop("registration-changed");
    const epoch = this.options.state.nextConnectionEpoch();
    try {
      this.connection = (await this.connectAcrossOrigins({
        credential,
        bindingId: snapshot.bindingId,
        bindingRevision: snapshot.bindingRevision,
        scopes: snapshot.scopes,
        cloudControlPlaneId: snapshot.cloudControlPlaneId,
        processInstanceId: this.processInstanceId,
        epoch,
        onEvent: this.options.onEvent,
      }, snapshot.serviceOrigin)).connection;
    } catch (error) {
      // A revoked binding credential can no longer authenticate. Try an
      // unbound registration: the Coordinator only accepts that when it has no
      // live binding for this identity, which is the authoritative signal that
      // the pending revocation is already complete remotely.
      if (snapshot.status !== "pending-revocation" || !credential) throw error;
      this.connection = (await this.connectAcrossOrigins({
        credential: undefined,
        bindingId: undefined,
        bindingRevision: undefined,
        scopes: { deviceAccess: false, nodeRelay: false },
        cloudControlPlaneId: snapshot.cloudControlPlaneId,
        processInstanceId: this.processInstanceId,
        epoch,
        onEvent: this.options.onEvent,
      }, snapshot.serviceOrigin, { ignoreCooldown: true })).connection;
      this.connectionBindingId = undefined;
      this.backoff.reset();
      return { status: "connected" as const, epoch, revocationFallback: true as const };
    }
    this.connectionBindingId = snapshot.bindingId;
    this.backoff.reset();
    return { status: "connected" as const, epoch };
  }

  private async connectAcrossOrigins(
    input: Record<string, unknown>,
    canonicalOrigin: string,
    options: { ignoreCooldown?: boolean } = {},
  ): Promise<{ connection: ManagedConnection; origin: string }> {
    const activeOrigin = this.options.originResolver?.activeOrigin() ?? canonicalOrigin;
    const origins = this.orderedOrigins(activeOrigin, options.ignoreCooldown === true);
    if (!origins.length) throw Object.assign(new Error("Every Coordinator origin is cooling down."), { code: "COORDINATOR_ORIGINS_COOLING_DOWN", retryable: true });
    let lastError: unknown;
    for (const [index, origin] of origins.entries()) {
      try {
        const connection = await this.options.connector.connect({ ...input, serviceOrigin: origin });
        this.originCooldowns.delete(origin);
        this.options.originResolver?.markSuccess?.(origin);
        return { connection, origin };
      } catch (error) {
        lastError = error;
        if (!coordinatorConnectRetryable(error)) throw error;
        this.originCooldowns.set(origin, this.clock() + this.originCooldownMs);
        this.options.originResolver?.markFailure?.(origin);
        const nextOrigin = origins[index + 1];
        if (nextOrigin) {
          try { this.options.onOriginFailover?.({ fromOrigin: origin, toOrigin: nextOrigin, reason: errorCode(error) ?? "COORDINATOR_ORIGIN_UNAVAILABLE" }); }
          catch { /* observability cannot stop failover */ }
        }
      }
    }
    throw lastError;
  }

  private orderedOrigins(canonicalOrigin: string, ignoreCooldown: boolean) {
    const seen = new Set<string>();
    const origins: string[] = [];
    for (const value of [canonicalOrigin, ...(this.options.originResolver?.endpoints() ?? []), ...this.coordinatorOrigins]) {
      try {
        const origin = new URL(value).origin;
        if (!seen.has(origin)) { seen.add(origin); origins.push(origin); }
      } catch {
        // Invalid configuration must never widen the dialing set.
      }
    }
    if (ignoreCooldown) return origins;
    const now = this.clock();
    return origins.filter((origin) => (this.originCooldowns.get(origin) ?? 0) <= now);
  }

  reconnectDelay() { return this.backoff.next().delay; }

  disconnected() { this.connection = undefined; this.connectionBindingId = undefined; }

  async stop(reason: string) {
    const current = this.connection;
    this.connection = undefined;
    this.connectionBindingId = undefined;
    await current?.close(reason);
  }
}

export class CloudRelayDataConnectionManager {
  private readonly connections = new Map<string, DataConnectionEntry>();
  private readonly sessionStore?: RelaySessionStore;
  private readonly clock: () => number;
  private readonly options: {
    verifyAllocation(allocation: unknown): Promise<VerifiedDataAllocation> | VerifiedDataAllocation;
    verifyGrant?(grant: unknown): Promise<VerifiedDataAllocation> | VerifiedDataAllocation;
    connector: {
      connect(input: Record<string, unknown>): Promise<ManagedConnection>;
      resume?(input: { relayUrl: string; grant: unknown; onDisconnected?: () => void }): Promise<ManagedConnection>;
    };
    sessionStatePath?: string;
    clock?: () => number;
  };
  constructor(options: CloudRelayDataConnectionManager["options"]) {
    this.options = options;
    this.clock = options.clock ?? Date.now;
    if (options.sessionStatePath && options.verifyGrant && options.connector.resume) {
      this.sessionStore = new RelaySessionStore(options.sessionStatePath, { clock: this.clock });
      for (const entry of this.sessionStore.load()) {
        this.connections.set(entry.allocationId, {
          epoch: entry.epoch,
          channelKind: entry.channelKind,
          relayUrl: entry.relayUrl,
          verified: { allocationId: entry.allocationId, relayUrl: entry.relayUrl, epoch: entry.epoch, channelKind: entry.channelKind, grant: entry.grant },
          attempts: 0,
        });
      }
    }
  }

  get resumeSupported() { return Boolean(this.sessionStore && this.options.connector.resume); }

  async attach(allocation: unknown) {
    const verified = await this.options.verifyAllocation(allocation);
    const current = this.connections.get(verified.allocationId);
    if (current && verified.epoch < current.epoch) throw connectionError("STALE_CONNECTION_EPOCH");
    if (current && verified.epoch === current.epoch) {
      // The Coordinator may replay an allocation whose acknowledgement was
      // ambiguous. Returning the established channel is what makes that retry
      // idempotent instead of creating a second Control Plane Relay connection.
      if (verified.relayUrl !== current.relayUrl || (verified.channelKind ?? "access") !== current.channelKind) throw connectionError("STALE_CONNECTION_EPOCH");
      const currentGeneration = Number((current.verified.grant as { generation?: unknown } | undefined)?.generation ?? 0);
      const nextGeneration = Number((verified.grant as { generation?: unknown } | undefined)?.generation ?? 0);
      if (nextGeneration < currentGeneration) throw connectionError("STALE_CONNECTION_EPOCH");
      if (current.verified.grant && verified.grant && nextGeneration === currentGeneration
        && (current.verified.grant as { grantId?: unknown }).grantId !== (verified.grant as { grantId?: unknown }).grantId) throw connectionError("RELAY_SESSION_GENERATION_CONFLICT");
      current.verified = { ...current.verified, ...verified };
      await this.persist(current);
      if (current.connection?.renew && verified.grant) await current.connection.renew(verified.grant);
      return { status: "attached" as const, allocationId: verified.allocationId, epoch: verified.epoch, replayed: true as const };
    }
    const connection = await this.options.connector.connect({ relayUrl: verified.relayUrl, allocation, epoch: verified.epoch, onDisconnected: () => this.disconnected(verified.allocationId) });
    await current?.connection.close("replaced-by-new-epoch");
    if (current?.timer) clearTimeout(current.timer);
    const entry: DataConnectionEntry = {
      epoch: verified.epoch,
      channelKind: verified.channelKind ?? "access",
      relayUrl: verified.relayUrl,
      verified,
      connection,
      attempts: 0,
    };
    try { await this.persist(entry); }
    catch (error) {
      await connection.close("grant-persistence-failed");
      throw error;
    }
    this.connections.set(verified.allocationId, entry);
    return { status: "attached" as const, allocationId: verified.allocationId, epoch: verified.epoch };
  }

  /**
   * Applies a Coordinator grant update. A live channel renews in place; after a
   * Control Plane restart (or a lost Relay socket) the same grant is enough to
   * resume without another ticket, allocation, or confirm flow.
   */
  async applyGrant(rawGrant: unknown) {
    if (!this.options.verifyGrant) throw connectionError("RELAY_SESSION_VERIFIER_UNAVAILABLE");
    const verified = await this.options.verifyGrant(rawGrant);
    const current = this.connections.get(verified.allocationId);
    if (current) {
      const currentGeneration = Number((current.verified.grant as { generation?: unknown } | undefined)?.generation ?? 0);
      const nextGeneration = Number((verified.grant as { generation?: unknown } | undefined)?.generation ?? 0);
      if (nextGeneration < currentGeneration) return { status: "stale" as const, allocationId: verified.allocationId };
      current.verified = { ...current.verified, ...verified };
      current.relayUrl = verified.relayUrl;
      current.epoch = Math.max(current.epoch, verified.epoch);
      await this.persist(current);
      if (current.connection?.renew) {
        try {
          await current.connection.renew(verified.grant);
          return { status: "renewed" as const, allocationId: verified.allocationId };
        } catch {
          this.disconnected(verified.allocationId);
        }
      }
      if (!await this.resumeGrant(verified.allocationId)) return { status: "discarded" as const, allocationId: verified.allocationId };
      return { status: "resumed" as const, allocationId: verified.allocationId };
    }
    const entry: DataConnectionEntry = {
      epoch: verified.epoch,
      channelKind: verified.channelKind ?? "access",
      relayUrl: verified.relayUrl,
      verified,
      attempts: 0,
    };
    await this.persist(entry);
    this.connections.set(verified.allocationId, entry);
    if (!await this.resumeGrant(verified.allocationId)) return { status: "discarded" as const, allocationId: verified.allocationId };
    return { status: "resumed" as const, allocationId: verified.allocationId };
  }

  /** Reopens locally persisted grants without waiting for a Coordinator event. */
  async resumePersistedSessions() {
    if (!this.sessionStore || !this.options.verifyGrant || !this.options.connector.resume) return [];
    const resumed: string[] = [];
    await Promise.all([...this.connections.entries()].map(async ([allocationId, entry]) => {
      if (entry.connection) return;
      let verified: VerifiedDataAllocation;
      try {
        verified = await this.options.verifyGrant!({ type: "relay-session-grant", grant: entry.verified.grant });
        if (verified.allocationId !== allocationId) throw connectionError("RELAY_SESSION_GRANT_INVALID");
      } catch {
        this.connections.delete(allocationId);
        this.sessionStore!.remove(allocationId);
        return;
      }
      entry.verified = verified;
      entry.relayUrl = verified.relayUrl;
      entry.epoch = verified.epoch;
      entry.channelKind = verified.channelKind ?? "access";
      try {
        await this.persist(entry);
        await this.resume(allocationId);
        if (entry.connection) resumed.push(allocationId);
      } catch {
        // resume() retains and backs off transient failures, and removes terminal ones.
      }
    }));
    return resumed;
  }

  async closeAll(reason: string, options: { preserveSessions?: boolean } = {}) {
    const active = [...this.connections.values()];
    this.connections.clear();
    for (const entry of active) if (entry.timer) clearTimeout(entry.timer);
    if (!options.preserveSessions) this.sessionStore?.clear();
    await Promise.allSettled(active.map(({ connection }) => connection?.close(reason)));
  }

  /** Scope narrowing closes exactly the channels of that kind. */
  async closeByKind(channelKind: "access" | "node", reason: string) {
    const matching = [...this.connections.entries()].filter(([, entry]) => entry.channelKind === channelKind);
    for (const [allocationId] of matching) this.connections.delete(allocationId);
    for (const [, entry] of matching) if (entry.timer) clearTimeout(entry.timer);
    if (channelKind === "access") for (const [allocationId] of matching) this.sessionStore?.remove(allocationId);
    await Promise.allSettled(matching.map(([, entry]) => entry.connection?.close(reason)));
  }

  private disconnected(allocationId: string) {
    const entry = this.connections.get(allocationId);
    if (!entry) return;
    entry.connection = undefined;
    this.scheduleResume(allocationId);
  }

  private scheduleResume(allocationId: string) {
    const entry = this.connections.get(allocationId);
    if (!entry || entry.timer || entry.resuming || !this.options.connector.resume) return;
    const expiresAt = Date.parse(String((entry.verified.grant as { expiresAt?: unknown } | undefined)?.expiresAt ?? ""));
    if (Number.isFinite(expiresAt) && expiresAt <= Date.now()) {
      this.connections.delete(allocationId);
      this.sessionStore?.remove(allocationId);
      return;
    }
    entry.attempts += 1;
    const delay = Math.min(5_000, 250 * 2 ** Math.min(entry.attempts - 1, 5));
    entry.timer = setTimeout(() => {
      entry.timer = undefined;
      void this.resume(allocationId).catch(() => undefined);
    }, delay);
    entry.timer.unref?.();
  }

  private resume(allocationId: string) {
    const entry = this.connections.get(allocationId);
    if (!entry || entry.connection || entry.resuming) return entry?.resuming ?? Promise.resolve();
    if (!this.options.connector.resume) return Promise.resolve();
    if (entry.timer) { clearTimeout(entry.timer); entry.timer = undefined; }
    entry.resuming = (async () => {
      try {
        const grant = entry.verified.grant;
        const connection = await this.options.connector.resume!({ relayUrl: entry.relayUrl, grant, onDisconnected: () => this.disconnected(allocationId) });
        const current = this.connections.get(allocationId);
        if (current !== entry) { await connection.close("session-removed"); return; }
        entry.connection = connection;
        entry.attempts = 0;
      } catch (error) {
        if (terminalResumeFailure(error)) {
          this.connections.delete(allocationId);
          this.sessionStore?.remove(allocationId);
        }
        throw error;
      } finally {
        entry.resuming = undefined;
        if (!entry.connection && this.connections.get(allocationId) === entry) this.scheduleResume(allocationId);
      }
    })();
    return entry.resuming;
  }

  private async resumeGrant(allocationId: string) {
    try {
      await this.resume(allocationId);
      return true;
    } catch (error) {
      // Relays describe session rejection in the WebSocket close reason while the
      // transport error itself stays generic. A missing session is terminal, so it
      // must not close the Coordinator event stream or keep backing off forever.
      if (terminalResumeFailure(error)) return false;
      throw error;
    }
  }

  private async persist(entry: DataConnectionEntry) {
    if (!this.sessionStore || !entry.verified.grant) return;
    const grant = entry.verified.grant as { allocationId?: unknown };
    if (grant.allocationId !== entry.verified.allocationId) throw connectionError("RELAY_SESSION_GRANT_INVALID");
    try {
      this.sessionStore.upsert({
        allocationId: entry.verified.allocationId,
        relayUrl: entry.relayUrl,
        epoch: entry.epoch,
        channelKind: "access",
        grant: entry.verified.grant,
      } as PersistedRelaySession);
    } catch {
      throw connectionError("RELAY_SESSION_PERSISTENCE_FAILED");
    }
  }
}

function connectionError(code: string) {
  return Object.assign(new Error("Cloud connection state is invalid."), { code });
}

function terminalResumeFailure(error: unknown) {
  if (error === null || typeof error !== "object") return false;
  const { code, relayCloseReason } = error as { code?: unknown; relayCloseReason?: unknown };
  return [code, relayCloseReason].some((value) => value !== undefined && TERMINAL_RELAY_RESUME_CODES.has(String(value)));
}

function coordinatorConnectRetryable(error: unknown) {
  if ((error as { retryable?: unknown } | null)?.retryable === false) return false;
  const status = Number((error as { status?: unknown; statusCode?: unknown } | null)?.status
    ?? (error as { statusCode?: unknown } | null)?.statusCode);
  if (Number.isFinite(status)) return status >= 500 || status === 408 || status === 425 || status === 429;
  const code = String((error as { code?: unknown } | null)?.code ?? "");
  return !["REGISTRATION_REJECTED", "BINDING_NOT_FOUND", "BACKGROUND_CREDENTIAL_INVALID"].includes(code);
}

function errorCode(error: unknown) {
  return error !== null && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : undefined;
}
