import type { CloudConnectivityService } from "./service.ts";

export class CloudConnectivityLifecycle {
  private readonly options: {
    state: CloudConnectivityService;
    remote: { revoke(input: { bindingId: string }): Promise<{ status: "revoked" }> ; setRemoteAccess(input: { bindingId: string; enabled: boolean }): Promise<void> };
    connections: { stop(reason: string): Promise<void> };
  };

  constructor(options: CloudConnectivityLifecycle["options"]) {
    this.options = options;
  }

  async disconnect() {
    const before = this.options.state.snapshot();
    if (!before.bindingId) return before;
    this.options.state.beginRevocation();
    await this.options.connections.stop("binding-pending-revocation");
    try {
      const result = await this.options.remote.revoke({ bindingId: before.bindingId });
      if (result.status === "revoked") return this.options.state.confirmRevocation();
    } catch {
      // Local disable is authoritative while the remote result is unknown.
    }
    return this.options.state.snapshot();
  }

  async setRemoteAccess(enabled: boolean) {
    const before = this.options.state.snapshot();
    this.options.state.setRemoteAccess(enabled);
    if (!enabled) await this.options.connections.stop("remote-access-disabled");
    if (before.bindingId) {
      try { await this.options.remote.setRemoteAccess({ bindingId: before.bindingId, enabled }); } catch {
        return { ...this.options.state.snapshot(), remoteResult: "unknown" as const };
      }
    }
    return { ...this.options.state.snapshot(), remoteResult: "confirmed" as const };
  }
}
