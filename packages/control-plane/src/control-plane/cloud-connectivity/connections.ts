import crypto from "node:crypto";
import type { CloudConnectivityService } from "./service.ts";

export class BoundedReconnectBackoff {
  private attempt = 0;
  private readonly minimumMs: number;
  private readonly maximumMs: number;
  private readonly random: () => number;
  constructor(minimumMs = 250, maximumMs = 30_000, random: () => number = Math.random) {
    this.minimumMs = minimumMs; this.maximumMs = maximumMs; this.random = random;
  }
  next() {
    const ceiling = Math.min(this.maximumMs, this.minimumMs * (2 ** this.attempt++));
    return Math.max(this.minimumMs, Math.floor(ceiling * (0.5 + this.random() * 0.5)));
  }
  reset() { this.attempt = 0; }
}

type ManagedConnection = { close(reason?: string): Promise<void> | void };

export class CloudControlConnectionManager {
  private connection?: ManagedConnection;
  readonly processInstanceId = `control_plane_process_${crypto.randomUUID().replaceAll("-", "_")}`;
  private readonly backoff: BoundedReconnectBackoff;
  private readonly options: {
    state: CloudConnectivityService;
    connector: { connect(input: Record<string, unknown>): Promise<ManagedConnection> };
    onEvent(event: unknown): Promise<void> | void;
    backoff?: BoundedReconnectBackoff;
  };

  constructor(options: {
    state: CloudConnectivityService;
    connector: { connect(input: Record<string, unknown>): Promise<ManagedConnection> };
    onEvent(event: unknown): Promise<void> | void;
    backoff?: BoundedReconnectBackoff;
  }) { this.options = options; this.backoff = options.backoff ?? new BoundedReconnectBackoff(); }

  async connectOnce() {
    const credential = this.options.state.backgroundCredential();
    const snapshot = this.options.state.snapshot();
    const canRegister = snapshot.remoteAccessEnabled && (snapshot.status === "pending-claim" || (snapshot.status === "active" && Boolean(credential)));
    if (!canRegister) return { status: "disabled" as const };
    if (this.connection) return { status: "connected" as const, reused: true as const };
    const epoch = this.options.state.nextConnectionEpoch();
    const previous = this.connection;
    this.connection = await this.options.connector.connect({ serviceOrigin: snapshot.serviceOrigin, credential, bindingId: snapshot.bindingId, bindingRevision: snapshot.bindingRevision, controlPlaneId: snapshot.identity.controlPlaneId, processInstanceId: this.processInstanceId, epoch, onEvent: this.options.onEvent });
    await previous?.close("replaced-by-new-epoch");
    this.backoff.reset();
    return { status: "connected" as const, epoch };
  }

  reconnectDelay() { return this.backoff.next(); }

  disconnected() { this.connection = undefined; }

  async stop(reason: string) {
    const current = this.connection;
    this.connection = undefined;
    await current?.close(reason);
  }
}

export class CloudRelayDataConnectionManager {
  private readonly connections = new Map<string, { epoch: number; connection: ManagedConnection }>();
  private readonly options: { verifyAllocation(allocation: unknown): Promise<{ allocationId: string; relayUrl: string; epoch: number }> | { allocationId: string; relayUrl: string; epoch: number }; connector: { connect(input: Record<string, unknown>): Promise<ManagedConnection> } };
  constructor(options: CloudRelayDataConnectionManager["options"]) { this.options = options; }

  async attach(allocation: unknown) {
    const verified = await this.options.verifyAllocation(allocation);
    const current = this.connections.get(verified.allocationId);
    if (current && verified.epoch <= current.epoch) throw connectionError("STALE_CONNECTION_EPOCH");
    const connection = await this.options.connector.connect({ relayUrl: verified.relayUrl, allocation, epoch: verified.epoch });
    await current?.connection.close("replaced-by-new-epoch");
    this.connections.set(verified.allocationId, { epoch: verified.epoch, connection });
    return { status: "attached" as const, allocationId: verified.allocationId, epoch: verified.epoch };
  }

  async closeAll(reason: string) {
    const active = [...this.connections.values()];
    this.connections.clear();
    await Promise.allSettled(active.map(({ connection }) => connection.close(reason)));
  }
}

function connectionError(code: string) {
  return Object.assign(new Error("Cloud connection state is invalid."), { code });
}
