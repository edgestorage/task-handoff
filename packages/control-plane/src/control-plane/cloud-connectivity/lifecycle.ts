import type { CloudConnectivityService } from "./service.ts";
import type { CloudRelayScopes } from "./service.ts";

export class CloudConnectivityLifecycle {
  private readonly options: {
    state: CloudConnectivityService;
    remote: { revoke(input: { bindingId: string }): Promise<{ status: "revoked" }> ; setRemoteAccess(input: { bindingId: string; scopes: CloudRelayScopes }): Promise<void> };
    connections: { stop(reason: string): Promise<void>; ensure?(): Promise<void> };
    dataConnections?: { closeByKind(channelKind: "access" | "node", reason: string): Promise<void> };
    nodeChannels?: { closeAll(reason: string): void };
  };

  constructor(options: CloudConnectivityLifecycle["options"]) {
    this.options = options;
  }

  /** Explicit local recovery; the old cloud's binding has not been revoked. */
  async resetConflictingBinding() {
    if (!this.options.state.snapshot().originConflict) {
      throw Object.assign(new Error("Only a cloud origin conflict can be cleared locally."), { code: "BINDING_STATE_CONFLICT", statusCode: 409 });
    }
    await Promise.all([
      this.options.connections.stop("cloud-origin-conflict"),
      this.options.dataConnections?.closeByKind("access", "cloud-origin-conflict"),
      this.options.dataConnections?.closeByKind("node", "cloud-origin-conflict"),
    ]);
    this.options.nodeChannels?.closeAll("cloud-origin-conflict");
    return this.options.state.resetConflictingBinding();
  }

  async disconnect() {
    const before = this.options.state.snapshot();
    if (!before.bindingId) return before;
    this.options.state.beginRevocation();
    // Stop relay data first, but keep the outbound control connection alive:
    // it is the only channel that can deliver revoke-binding to the cloud.
    await Promise.all([
      this.options.dataConnections?.closeByKind("access", "binding-pending-revocation"),
      this.options.dataConnections?.closeByKind("node", "binding-pending-revocation"),
    ]);
    this.options.nodeChannels?.closeAll("binding-pending-revocation");
    try {
      // A previous attempt may have already closed the socket. Re-open it with
      // the retained revocation credential before asking the cloud to revoke.
      await this.options.connections.ensure?.();
      // The background runtime reconciles a pending revocation as soon as it
      // has a connection; in that case the state is already unbound here.
      const reconciled = this.options.state.snapshot();
      if (reconciled.status === "unbound") {
        await this.options.connections.stop("binding-revoked");
        return reconciled;
      }
      const result = await this.options.remote.revoke({ bindingId: before.bindingId });
      if (result.status === "revoked") {
        const confirmed = this.options.state.confirmRevocation();
        await this.options.connections.stop("binding-revoked");
        return confirmed;
      }
    } catch {
      // Local disable is authoritative while the remote result is unknown.
      // Keep the control connection (and its credential) available so the
      // background runtime can retry instead of leaving a permanent deadlock.
    }
    return this.options.state.snapshot();
  }

  async setRemoteAccess(scopes: CloudRelayScopes) {
    const before = this.options.state.snapshot();
    this.options.state.setScopes({ deviceAccess: scopes.deviceAccess });
    // Device access only narrows access channels. Node relay is implied by an
    // active binding, and the outbound control connection must stay live so the
    // node agent can keep receiving claim changes and Relay allocations.
    if (!scopes.deviceAccess) await this.options.dataConnections?.closeByKind("access", "device-access-disabled");
    let remoteResult: "confirmed" | "unknown" = "confirmed";
    if (before.bindingId) {
      try {
        await this.options.connections.ensure?.();
        // The legacy field is always true so an N-1 Coordinator never disables
        // node relay when device access is turned off.
        await this.options.remote.setRemoteAccess({ bindingId: before.bindingId, scopes: { deviceAccess: scopes.deviceAccess, nodeRelay: true } });
      } catch { remoteResult = "unknown"; }
    }
    return { ...this.options.state.snapshot(), remoteResult };
  }
}
