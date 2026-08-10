import type { CloudConnectivityService } from "./service.ts";

export class CloudAuthorityEventConsumer {
  private revision = 0;
  private readonly options: { state: CloudConnectivityService; connections: { stop(reason: string): Promise<void> }; dataConnections: { closeAll(reason: string): Promise<void> } };
  constructor(options: CloudAuthorityEventConsumer["options"]) { this.options = options; }

  async apply(event: { type: string; bindingRevision: number; enabled?: boolean }) {
    if (!Number.isSafeInteger(event.bindingRevision) || event.bindingRevision < this.revision) return { applied: false, reason: "stale-revision" };
    this.revision = event.bindingRevision;
    if (event.type === "binding-revoked" || event.type === "account-disabled" || event.type === "background-credential-revoked") {
      this.options.state.beginRevocation();
      await Promise.all([this.options.connections.stop(event.type), this.options.dataConnections.closeAll(event.type)]);
      this.options.state.confirmRevocation();
    } else if (event.type === "remote-access-changed") {
      this.options.state.setRemoteAccess(event.enabled === true);
      if (!event.enabled) await Promise.all([this.options.connections.stop("remote-access-disabled"), this.options.dataConnections.closeAll("remote-access-disabled")]);
    } else if (event.type === "identity-clone-detected") {
      this.options.state.markCloneConflict();
      await Promise.all([this.options.connections.stop(event.type), this.options.dataConnections.closeAll(event.type)]);
    } else return { applied: false, reason: "unsupported-event" };
    return { applied: true };
  }
}
