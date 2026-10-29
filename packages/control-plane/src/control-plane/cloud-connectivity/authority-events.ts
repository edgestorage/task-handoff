import type { CloudConnectivityService } from "./service.ts";

export class CloudAuthorityEventConsumer {
  private revision = 0;
  private readonly options: { state: CloudConnectivityService; connections: { stop(reason: string): Promise<void> }; dataConnections: { closeAll(reason: string): Promise<void>; closeByKind?(channelKind: "access" | "node", reason: string): Promise<void> }; nodeChannels?: { closeAll(reason: string): void } };
  constructor(options: CloudAuthorityEventConsumer["options"]) { this.options = options; }

  async apply(event: { type: string; bindingRevision: number; enabled?: boolean; scopes?: { deviceAccess?: boolean; nodeRelay?: boolean } }) {
    if (!Number.isSafeInteger(event.bindingRevision) || event.bindingRevision < this.revision) return { applied: false, reason: "stale-revision" };
    this.revision = event.bindingRevision;
    if (event.type === "binding-revoked" || event.type === "account-disabled" || event.type === "background-credential-revoked") {
      this.options.state.beginRevocation();
      await Promise.all([this.options.connections.stop(event.type), this.options.dataConnections.closeAll(event.type)]);
      this.options.nodeChannels?.closeAll(event.type);
      this.options.state.confirmRevocation();
    } else if (event.type === "remote-access-changed") {
      // `nodeRelay` is accepted for N-1 Coordinators but is no longer a switch.
      // A legacy event without scopes carries only the device-access value.
      const deviceAccess = event.scopes?.deviceAccess ?? event.enabled === true;
      this.options.state.setScopes({ deviceAccess });
      if (!deviceAccess) await this.options.dataConnections.closeByKind?.("access", "device-access-disabled");
    } else if (event.type === "identity-clone-detected") {
      this.options.state.markCloneConflict();
      await Promise.all([this.options.connections.stop(event.type), this.options.dataConnections.closeAll(event.type)]);
      this.options.nodeChannels?.closeAll(event.type);
    } else return { applied: false, reason: "unsupported-event" };
    return { applied: true };
  }
}
