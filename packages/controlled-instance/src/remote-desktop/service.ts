import { EventEmitter } from "node:events";
import { DesktopComponentHost, type ComponentCommand, type ComponentEvent } from "./component-host";
import { DesktopSettings } from "./settings";
import { unsupportedRemoteDesktopCapabilities, normalizeRemoteDesktopCapabilities, type RemoteDesktopCapabilities } from "@task-handoff/protocol/remote-desktop";

export type DesktopPackage = { binary: string; version: string };
export type DesktopServiceOptions = {
  dataDir: string;
  mode: "local" | "virtual";
  // Derived from App ownership/detection. Never search PATH or adopt a process.
  installedPackage(): DesktopPackage | undefined;
  canStart(): boolean;
  requestUpdate?(): void | Promise<void>;
};
/** Serializes component ownership, not business session state. Events and replies
 * remain component-authoritative; crashes never restart the instance core. */
export class DesktopService extends EventEmitter {
  readonly settings: DesktopSettings;
  private host?: DesktopComponentHost;
  private disposed=false;
  private projected?: RemoteDesktopCapabilities;
  private failure?: string;
  private protocolUpdateRequested = false;
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private readonly options: DesktopServiceOptions) {
    super(); this.settings = new DesktopSettings(options.dataDir);
  }
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work);
    this.queue = next.catch(() => undefined);
    return next;
  }
  componentRunning() { return Boolean(this.host && !this.host.closed); }
  status(): RemoteDesktopCapabilities {
    const closed=(reason:string)=>({...unsupportedRemoteDesktopCapabilities(reason),runtimeKind:this.options.mode === "virtual" ? "docker" : "local",platform:process.platform,desktopSource:this.options.mode === "virtual" ? "instance-virtual-display" : "host-desktop"});
    let installed: DesktopPackage | undefined;
    try { installed = this.options.installedPackage(); } catch { return closed("REMOTE_DESKTOP_PACKAGE_INVALID"); }
    if (!installed) return closed("REMOTE_DESKTOP_NOT_INSTALLED");
    if (!this.settings.get().enabled) return closed("REMOTE_DESKTOP_DISABLED");
    if (this.disposed || !this.options.canStart()) return closed("REMOTE_DESKTOP_UPDATING");
    return this.projected ?? closed(this.failure ?? "REMOTE_DESKTOP_NOT_PROBED");
  }
  /** Compatibility is owned by the IPC handshake. A semver difference never
   * blocks or replaces a protocol-compatible component. */
  reconcile() { return this.refresh(); }
  /** Startup, explicit preflight and package terminal events only; never polling. */
  refresh() { return this.serial(async()=>{const status=await this.refreshInside();this.maybeRequestProtocolUpdate(status);return status;}); }
  private maybeRequestProtocolUpdate(status: RemoteDesktopCapabilities) {
    if (status.reason !== "REMOTE_DESKTOP_PROTOCOL_MISMATCH" || this.protocolUpdateRequested || !this.options.requestUpdate) return;
    this.protocolUpdateRequested = true;
    // The App queue stops this service before changing files, so never await
    // the request from inside the service's serialized section.
    queueMicrotask(()=>{void Promise.resolve(this.options.requestUpdate?.()).catch(()=>undefined);});
  }
  private async refreshInside() {
    if (this.status().reason && ["REMOTE_DESKTOP_NOT_INSTALLED","REMOTE_DESKTOP_PACKAGE_INVALID","REMOTE_DESKTOP_DISABLED","REMOTE_DESKTOP_UPDATING"].includes(this.status().reason!)) { this.emit("changed"); return this.status(); }
    try {
      const reply=await (await this.ensure()).request("preflight",{type:"probe"});
      if(reply.type!=="capability")throw new Error("REMOTE_DESKTOP_COMPONENT_UNAVAILABLE");
      this.projected=normalizeRemoteDesktopCapabilities(reply.capability);this.failure=undefined;this.protocolUpdateRequested=false;
    } catch(error) {
      this.projected=undefined;this.failure=error instanceof Error && /^REMOTE_DESKTOP_[A-Z_]+$/.test(error.message) ? error.message : "REMOTE_DESKTOP_COMPONENT_UNAVAILABLE";
    }
    this.emit("changed");return this.status();
  }
  setEnabled(enabled: boolean) {
    return this.serial(async () => {
      if (this.disposed || !this.options.canStart()) throw new Error("REMOTE_DESKTOP_UPDATING");
      const settings = this.settings.set(enabled);
      if (!enabled) await this.stop();
      else {const status=await this.refreshInside();this.maybeRequestProtocolUpdate(status);}
      this.emit("changed"); return settings;
    });
  }
  private async ensure() {
    const installed = this.options.installedPackage();
    if (!installed) throw new Error("REMOTE_DESKTOP_NOT_INSTALLED");
    if (!this.settings.get().enabled) throw new Error("REMOTE_DESKTOP_DISABLED");
    if (this.disposed || !this.options.canStart()) throw new Error("REMOTE_DESKTOP_UPDATING");
    if (this.host && !this.host.closed) return this.host;
    const host = await DesktopComponentHost.spawn(installed.binary,this.options.mode);
    // An install operation may have entered its queue during the handshake.
    if (!this.options.canStart() || !this.settings.get().enabled) { await host.close(); throw new Error("REMOTE_DESKTOP_UPDATING"); }
    this.host = host;this.projected=host.capability;this.failure=undefined;
    host.on("session", (event: ComponentEvent) => { if (this.host === host) this.emit("session",event); });
    host.once("closed", () => { if (this.host === host) { this.host = undefined; this.projected=undefined;this.failure="REMOTE_DESKTOP_COMPONENT_UNAVAILABLE"; this.emit("changed"); } });
    this.emit("changed"); return host;
  }
  request(id: string, command: ComponentCommand, expectedBootId?: string) {
    return this.serial(async () => {
      if (expectedBootId !== undefined) {
        if (!this.host || this.host.closed || this.host.bootId !== expectedBootId) throw new Error("REMOTE_DESKTOP_COMPONENT_UNAVAILABLE");
        return this.host.request(id,command);
      }
      return (await this.ensure()).request(id,command);
    });
  }
  /** The component owns the loopback endpoint and bearer. The instance only
   * proxies it after its own trusted boundary has authorized the viewer. */
  fallbackEndpoint() {
    return this.serial(async () => (await this.ensure()).fallbackEndpoint);
  }
  /** Called under the existing App queue before changing package files. */
  beforePackageChange() { return this.serial(() => this.stop()); }
  packageChanged(operation: string, succeeded: boolean) {
    return this.serial(async () => {
      if (operation === "uninstall" && succeeded) this.settings.clear();
      this.protocolUpdateRequested=false;
      this.emit("changed");
    });
  }
  close() { this.disposed=true; return this.serial(() => this.stop()); }
  private async stop() {
    const host = this.host; this.host = undefined;this.projected=undefined;this.failure=undefined;
    if (host) await host.close();
    this.emit("changed");
  }
}
