import crypto from "node:crypto";
import { StandardReconnectBackoff } from "@task-handoff/core/core/reconnect";
import type { CloudConnectivityService } from "./service.ts";

type ManagedConnection = { close(reason?: string): Promise<void> | void };

export class CloudControlConnectionManager {
  private connection?: ManagedConnection;
  private connectionBindingId?: string;
  readonly processInstanceId = `control_plane_process_${crypto.randomUUID().replaceAll("-", "_")}`;
  private readonly backoff: StandardReconnectBackoff;
  private readonly options: {
    state: CloudConnectivityService;
    connector: { connect(input: Record<string, unknown>): Promise<ManagedConnection> };
    onEvent(event: unknown): Promise<void> | void;
    backoff?: StandardReconnectBackoff;
  };

  constructor(options: {
    state: CloudConnectivityService;
    connector: { connect(input: Record<string, unknown>): Promise<ManagedConnection> };
    onEvent(event: unknown): Promise<void> | void;
    backoff?: StandardReconnectBackoff;
  }) { this.options = options; this.backoff = options.backoff ?? new StandardReconnectBackoff(); }

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
      this.connection = await this.options.connector.connect({ serviceOrigin: snapshot.serviceOrigin, credential, bindingId: snapshot.bindingId, bindingRevision: snapshot.bindingRevision, scopes: snapshot.scopes, cloudControlPlaneId: snapshot.cloudControlPlaneId, processInstanceId: this.processInstanceId, epoch, onEvent: this.options.onEvent });
    } catch (error) {
      // A revoked binding credential can no longer authenticate. Try an
      // unbound registration: the Coordinator only accepts that when it has no
      // live binding for this identity, which is the authoritative signal that
      // the pending revocation is already complete remotely.
      if (snapshot.status !== "pending-revocation" || !credential) throw error;
      this.connection = await this.options.connector.connect({ serviceOrigin: snapshot.serviceOrigin, credential: undefined, bindingId: undefined, bindingRevision: undefined, scopes: { deviceAccess: false, nodeRelay: false }, cloudControlPlaneId: snapshot.cloudControlPlaneId, processInstanceId: this.processInstanceId, epoch, onEvent: this.options.onEvent });
      this.connectionBindingId = undefined;
      this.backoff.reset();
      return { status: "connected" as const, epoch, revocationFallback: true as const };
    }
    this.connectionBindingId = snapshot.bindingId;
    this.backoff.reset();
    return { status: "connected" as const, epoch };
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
  private readonly connections = new Map<string, { epoch: number; channelKind: "access" | "node"; connection: ManagedConnection }>();
  private readonly options: { verifyAllocation(allocation: unknown): Promise<{ allocationId: string; relayUrl: string; epoch: number; channelKind?: "access" | "node" }> | { allocationId: string; relayUrl: string; epoch: number; channelKind?: "access" | "node" }; connector: { connect(input: Record<string, unknown>): Promise<ManagedConnection> } };
  constructor(options: CloudRelayDataConnectionManager["options"]) { this.options = options; }

  async attach(allocation: unknown) {
    const verified = await this.options.verifyAllocation(allocation);
    const current = this.connections.get(verified.allocationId);
    if (current && verified.epoch <= current.epoch) throw connectionError("STALE_CONNECTION_EPOCH");
    const connection = await this.options.connector.connect({ relayUrl: verified.relayUrl, allocation, epoch: verified.epoch });
    await current?.connection.close("replaced-by-new-epoch");
    this.connections.set(verified.allocationId, { epoch: verified.epoch, channelKind: verified.channelKind ?? "access", connection });
    return { status: "attached" as const, allocationId: verified.allocationId, epoch: verified.epoch };
  }

  async closeAll(reason: string) {
    const active = [...this.connections.values()];
    this.connections.clear();
    await Promise.allSettled(active.map(({ connection }) => connection.close(reason)));
  }

  /** Scope narrowing closes exactly the channels of that kind. */
  async closeByKind(channelKind: "access" | "node", reason: string) {
    const matching = [...this.connections.entries()].filter(([, entry]) => entry.channelKind === channelKind);
    for (const [allocationId] of matching) this.connections.delete(allocationId);
    await Promise.allSettled(matching.map(([, entry]) => entry.connection.close(reason)));
  }
}

function connectionError(code: string) {
  return Object.assign(new Error("Cloud connection state is invalid."), { code });
}
