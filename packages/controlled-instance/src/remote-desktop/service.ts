import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import { DesktopComponentHost, type ComponentCommand, type ComponentEvent } from "./component-host";
import { DesktopSettings } from "./settings";
import {
  DesktopNativePermissionsSchema,
  unsupportedRemoteDesktopCapabilities,
  normalizeRemoteDesktopCapabilities,
  type DesktopNativePermissionKind,
  type DesktopNativePermissions,
  type RemoteDesktopCapabilities,
} from "@task-handoff/protocol/remote-desktop";
import { z } from "zod";

const NativePermissionProbeSchema = z.object({
  screenCaptureAllowed: z.boolean(),
  inputAllowed: z.boolean(),
}).strip();
const NativeScreenPermissionRequestSchema = z.object({ screenCaptureAllowed: z.boolean() }).strip();
const NativeInputPermissionRequestSchema = z.object({ inputAllowed: z.boolean() }).strip();
const NATIVE_PERMISSION_OUTPUT_LIMIT = 64 * 1024;
const NATIVE_PERMISSION_COMMAND_DEADLINE_MS = 10_000;
function parseNativePermissionOutput<T extends z.ZodTypeAny>(schema: T, output: string): z.infer<T> {
  try { return schema.parse(JSON.parse(output) as unknown); }
  catch { throw new Error("REMOTE_DESKTOP_PERMISSION_UNAVAILABLE"); }
}

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
  /** macOS TCC state belongs to the installed component binary, not to the
   * running streaming host. The settings surface can therefore inspect it
   * while desktop streaming is disabled. */
  permissions(): Promise<DesktopNativePermissions> {
    return this.serial(() => this.readNativePermissionsInside());
  }
  requestPermission(kind: DesktopNativePermissionKind): Promise<DesktopNativePermissions> {
    return this.serial(async () => {
      this.assertNativePermissionsSupported();
      const output = await this.runNativePermissionCommand(kind === "screen-capture"
        ? "--request-screen-permission"
        : "--request-input-permission");
      if (kind === "screen-capture") parseNativePermissionOutput(NativeScreenPermissionRequestSchema, output);
      else parseNativePermissionOutput(NativeInputPermissionRequestSchema, output);
      return this.readNativePermissionsInside();
    });
  }
  private assertNativePermissionsSupported() {
    if (process.platform !== "darwin") throw new Error("REMOTE_DESKTOP_PERMISSIONS_UNSUPPORTED");
    try {
      if (!this.options.installedPackage()) throw new Error("REMOTE_DESKTOP_NOT_INSTALLED");
    } catch (error) {
      if (error instanceof Error && error.message === "REMOTE_DESKTOP_NOT_INSTALLED") throw error;
      throw new Error("REMOTE_DESKTOP_PACKAGE_INVALID");
    }
  }
  private async readNativePermissionsInside(): Promise<DesktopNativePermissions> {
    if (process.platform !== "darwin") return DesktopNativePermissionsSchema.parse({
      platform: process.platform,
      supported: false,
      screenCapture: "unknown",
      inputControl: "unknown",
    });
    this.assertNativePermissionsSupported();
    const output = await this.runNativePermissionCommand("--check-native-permissions");
    const probe = parseNativePermissionOutput(NativePermissionProbeSchema, output);
    return DesktopNativePermissionsSchema.parse({
      platform: process.platform,
      supported: true,
      screenCapture: probe.screenCaptureAllowed ? "granted" : "required",
      inputControl: probe.inputAllowed ? "granted" : "required",
    });
  }
  /** Only fixed internal arguments reach the component. Native errors and
   * executable paths stay inside the instance boundary. */
  private runNativePermissionCommand(argument: string): Promise<string> {
    const installed = this.options.installedPackage();
    if (!installed) return Promise.reject(new Error("REMOTE_DESKTOP_NOT_INSTALLED"));
    return new Promise((resolve, reject) => {
      const child = spawn(installed.binary, [argument], { stdio: ["ignore", "pipe", "pipe"] });
      let output = "";
      let settled = false;
      const finish = (error?: Error, value?: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error);
        else resolve(value ?? "");
      };
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        finish(new Error("REMOTE_DESKTOP_PERMISSION_UNAVAILABLE"));
      }, NATIVE_PERMISSION_COMMAND_DEADLINE_MS);
      child.stdout.setEncoding("utf8");
      child.stderr.resume();
      child.stdout.on("data", (chunk: string) => {
        output += chunk;
        if (Buffer.byteLength(output, "utf8") > NATIVE_PERMISSION_OUTPUT_LIMIT) {
          child.kill("SIGKILL");
          finish(new Error("REMOTE_DESKTOP_PERMISSION_UNAVAILABLE"));
        }
      });
      child.once("error", (error: NodeJS.ErrnoException) => {
        finish(new Error(error.code === "ENOENT" ? "REMOTE_DESKTOP_PACKAGE_INVALID" : "REMOTE_DESKTOP_PERMISSION_UNAVAILABLE"));
      });
      child.once("close", (code) => {
        if (code !== 0) return finish(new Error("REMOTE_DESKTOP_PERMISSION_UNAVAILABLE"));
        finish(undefined, output);
      });
    });
  }
  private async ensure() {
    const installed = this.options.installedPackage();
    if (!installed) throw new Error("REMOTE_DESKTOP_NOT_INSTALLED");
    if (!this.settings.get().enabled) throw new Error("REMOTE_DESKTOP_DISABLED");
    if (this.disposed || !this.options.canStart()) throw new Error("REMOTE_DESKTOP_UPDATING");
    if (this.host && !this.host.closed) return this.host;
    const host = await DesktopComponentHost.spawn(installed.binary,this.options.mode,this.options.dataDir);
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
      // Installation is an explicit user intent to use the component. Persist
      // enable before the App terminal refresh starts it; updates preserve the
      // existing intent so a manually disabled desktop stays disabled.
      if (operation === "install" && succeeded) this.settings.set(true);
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
