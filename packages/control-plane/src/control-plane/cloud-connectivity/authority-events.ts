import type { CloudConnectivityService } from "./service.ts";

export class CloudAuthorityEventConsumer {
  private revision = 0;
  private readonly options: { state: CloudConnectivityService; connections: { stop(reason: string): Promise<void> }; dataConnections: { closeAll(reason: string): Promise<void>; closeByKind?(channelKind: "access" | "node", reason: string): Promise<void> }; nodeChannels?: { closeAll(reason: string): void } };
  constructor(options: CloudAuthorityEventConsumer["options"]) { this.options = options; }

  async apply(event: { type: string; bindingRevision: number; enabled?: boolean }) {
    if (!Number.isSafeInteger(event.bindingRevision) || event.bindingRevision < this.revision) return { applied: false, reason: "stale-revision" };
    this.revision = event.bindingRevision;
    if (event.type === "binding-revoked" || event.type === "account-disabled" || event.type === "background-credential-revoked") {
      this.options.state.beginRevocation();
      await Promise.all([this.options.connections.stop(event.type), this.options.dataConnections.closeAll(event.type)]);
      this.options.nodeChannels?.closeAll(event.type);
      this.options.state.confirmRevocation();
    } else if (event.type === "remote-access-changed") {
      // New Coordinators send both scopes; a legacy single-switch event only
      // carries `enabled`, which maps to the device-access scope.
      const scopes = (event as { scopes?: { deviceAccess?: boolean; nodeRelay?: boolean } }).scopes ?? { deviceAccess: event.enabled === true, nodeRelay: false };
      const narrowed = { deviceAccess: scopes.deviceAccess === true, nodeRelay: scopes.nodeRelay === true };
      this.options.state.setScopes(narrowed);
      if (!narrowed.deviceAccess && !narrowed.nodeRelay) await Promise.all([this.options.connections.stop("scope-disabled"), this.options.dataConnections.closeAll("scope-disabled")]);
      else {
        // Narrowing one scope closes exactly that kind of data channel and leaves
        // the other scope, and the outbound control connection, untouched.
        if (!narrowed.deviceAccess) await this.options.dataConnections.closeByKind?.("access", "device-access-disabled");
        if (!narrowed.nodeRelay) await this.options.dataConnections.closeByKind?.("node", "node-relay-disabled");
        if (!narrowed.nodeRelay) this.options.nodeChannels?.closeAll("node-relay-disabled");
      }
    } else if (event.type === "identity-clone-detected") {
      this.options.state.markCloneConflict();
      await Promise.all([this.options.connections.stop(event.type), this.options.dataConnections.closeAll(event.type)]);
      this.options.nodeChannels?.closeAll(event.type);
    } else return { applied: false, reason: "unsupported-event" };
    return { applied: true };
  }
}
