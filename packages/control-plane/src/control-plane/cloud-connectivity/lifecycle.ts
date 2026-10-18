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

  async disconnect() {
    const before = this.options.state.snapshot();
    if (!before.bindingId) return before;
    this.options.state.beginRevocation();
    await this.options.connections.stop("binding-pending-revocation");
    this.options.nodeChannels?.closeAll("binding-pending-revocation");
    try {
      const result = await this.options.remote.revoke({ bindingId: before.bindingId });
      if (result.status === "revoked") return this.options.state.confirmRevocation();
    } catch {
      // Local disable is authoritative while the remote result is unknown.
    }
    return this.options.state.snapshot();
  }

  async setRemoteAccess(scopes: CloudRelayScopes) {
    const before = this.options.state.snapshot();
    this.options.state.setScopes(scopes);
    // Narrowing one scope closes exactly its data channels; the outbound control
    // connection is only stopped when both scopes are off. Notify the cloud
    // before stopping that connection so its directory projection reflects the
    // final scope state instead of timing out with an `unknown` result.
    if (!scopes.deviceAccess) await this.options.dataConnections?.closeByKind("access", "device-access-disabled");
    if (!scopes.nodeRelay) await this.options.dataConnections?.closeByKind("node", "node-relay-disabled");
    if (!scopes.nodeRelay) this.options.nodeChannels?.closeAll("node-relay-disabled");
    let remoteResult: "confirmed" | "unknown" = "confirmed";
    if (before.bindingId) {
      try {
        // The outbound control connection is intentionally absent while both
        // scopes are off. Re-open it before telling the cloud that a scope is
        // on again; a double-off keeps using the still-live connection.
        if (scopes.deviceAccess || scopes.nodeRelay) await this.options.connections.ensure?.();
        await this.options.remote.setRemoteAccess({ bindingId: before.bindingId, scopes });
      } catch { remoteResult = "unknown"; }
    }
    if (!scopes.deviceAccess && !scopes.nodeRelay) await this.options.connections.stop("scope-disabled");
    return { ...this.options.state.snapshot(), remoteResult };
  }
}
