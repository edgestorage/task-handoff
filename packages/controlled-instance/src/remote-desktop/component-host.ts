/** Instance-private IPC only. Never export credentials or internal models from
 * the public protocol package. No session registry or state machine lives here. */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { RemoteDesktopCapabilitiesSchema } from "@task-handoff/protocol/remote-desktop";

export const DESKTOP_IPC_VERSION = "2026-11-11";
export const MAX_DESKTOP_IPC_FRAME = 1024 * 1024;
const DEADLINE = 5000;
// Commands that create capture/peer state can legitimately outlive the IPC
// liveness window. The component's own negotiation deadline is 5s; leave
// ample headroom so the host never kills a peer before its reply is framed.
const LONG_COMMAND_DEADLINE = 20_000;
const COMMAND_DEADLINE = new Set(["probe", "reserve", "takeover", "attach", "offer", "listSources"]);
const Capability = RemoteDesktopCapabilitiesSchema;
// Older components omit fallback fields; absence only disables fallback and
// must not invalidate the WebRTC capability document.
const Welcome = z.object({
  protocolVersion: z.string(),
  bootId: z.string().min(1),
  capability: Capability,
  fallbackUrl: z.string().max(4096).default(""),
  fallbackToken: z.string().max(4096).default(""),
});
const Snapshot = z.object({ viewerSessionId: z.string(), sessionRevision: z.number().int().nonnegative(), phase: z.string() }).passthrough();
const Event = z.object({ bootId: z.string(), snapshot: Snapshot });
export type ComponentEvent = z.infer<typeof Event>;
export type ComponentCapability = z.infer<typeof Capability>;
export type ComponentReply = Record<string, unknown> & { type: string };
export type ComponentCommand = Record<string, unknown> & { type: string };

export function desktopIpcFrame(value: unknown) {
  const body = Buffer.from(JSON.stringify(value));
  if (!body.length || body.length > MAX_DESKTOP_IPC_FRAME) throw new Error("REMOTE_DESKTOP_IPC_LIMIT");
  const header = Buffer.alloc(4); header.writeUInt32BE(body.length);
  return Buffer.concat([header, body]);
}

/** Parses one frame at a time so coalesced frames don't count as one oversized
 * message. Allocation bounds apply to the length header before reading a body. */
export class DesktopFrameReader {
  private header = Buffer.alloc(4);
  private headerUsed = 0;
  private body?: Buffer;
  private bodyUsed = 0;
  push(chunk: Buffer, receive: (value: unknown) => void) {
    let offset = 0;
    while (offset < chunk.length) {
      if (!this.body) {
        const count = Math.min(4 - this.headerUsed, chunk.length - offset);
        chunk.copy(this.header, this.headerUsed, offset, offset + count);
        this.headerUsed += count; offset += count;
        if (this.headerUsed !== 4) continue;
        const size = this.header.readUInt32BE();
        if (!size || size > MAX_DESKTOP_IPC_FRAME) throw new Error("REMOTE_DESKTOP_IPC_LIMIT");
        this.body = Buffer.allocUnsafe(size); this.bodyUsed = 0;
      }
      const count = Math.min(this.body.length - this.bodyUsed, chunk.length - offset);
      chunk.copy(this.body, this.bodyUsed, offset, offset + count);
      this.bodyUsed += count; offset += count;
      if (this.bodyUsed === this.body.length) {
        const bytes = this.body;
        this.body = undefined; this.headerUsed = 0;
        receive(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
      }
    }
  }
}

type Call = { id: string; command: ComponentCommand; resolve: (value: ComponentReply) => void; reject: (error: Error) => void };
export class DesktopComponentHost extends EventEmitter {
  private socket?: net.Socket;
  private child?: ChildProcessWithoutNullStreams;
  private server?: net.Server;
  private directory?: string;
  private queue: Call[] = [];
  private pending?: Call;
  private timer?: ReturnType<typeof setTimeout>;
  private ended = false;
  private welcome?: z.infer<typeof Welcome>;
  private exit?: Promise<void>;
  private exitDrainTimer?: ReturnType<typeof setTimeout>;
  get bootId() { return this.welcome?.bootId; }
  get capability() { return this.welcome?.capability; }
  get fallbackEndpoint() {
    const token = this.welcome?.fallbackToken.trim();
    if (!token) return undefined;
    try {
      const url = new URL(this.welcome?.fallbackUrl.trim() ?? "");
      if (url.protocol !== "ws:" || url.username || url.password || url.search || url.hash
        || !["127.0.0.1", "[::1]", "localhost"].includes(url.hostname)) return undefined;
      return { url: url.origin, token };
    } catch { return undefined; }
  }
  get closed() { return this.ended; }

  static async spawn(binary: string, mode: "local" | "virtual" | "control") {
    if (process.platform === "win32") throw new Error("REMOTE_DESKTOP_PLATFORM_UNSUPPORTED");
    if (!path.isAbsolute(binary)) throw new Error("REMOTE_DESKTOP_PACKAGE_INVALID");
    const host = new DesktopComponentHost();
    try { await host.start(binary, mode); return host; }
    catch (error) {
      await host.close();
      if (error instanceof Error && (error.message === "REMOTE_DESKTOP_PROTOCOL_MISMATCH" || error.message === "REMOTE_DESKTOP_IPC_AUTH_FAILED")) throw error;
      throw new Error("REMOTE_DESKTOP_COMPONENT_START_FAILED");
    }
  }
  private async start(binary: string, mode: "local" | "virtual" | "control") {
    this.directory = fs.mkdtempSync(path.join(process.platform === "darwin" ? "/private/tmp" : os.tmpdir(), "th-desktop-host-"));
    fs.chmodSync(this.directory, 0o700);
    const endpoint = path.join(this.directory, "host.sock");
    const nonce = randomBytes(32).toString("hex");
    const hello = { protocolVersion: DESKTOP_IPC_VERSION, nonce };
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("REMOTE_DESKTOP_IPC_TIMEOUT")), DEADLINE);
      const settle = (error?: Error) => { clearTimeout(timer); error ? reject(error) : resolve(); };
      this.server = net.createServer((socket) => {
        // Never adopt another connection after the inherited nonce handshake.
        if (this.socket) { socket.destroy(); return; }
        this.socket = socket;
        const reader = new DesktopFrameReader();
        let authenticated = false;
        socket.on("data", (bytes: Buffer) => {
          try { reader.push(bytes, (value) => {
            if (!authenticated) {
              const received = z.object({ protocolVersion: z.string(), nonce: z.string() }).parse(value);
              if (received.protocolVersion !== DESKTOP_IPC_VERSION) throw new Error("REMOTE_DESKTOP_PROTOCOL_MISMATCH");
              const actual = Buffer.from(received.nonce); const expected = Buffer.from(nonce);
              if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error("REMOTE_DESKTOP_IPC_AUTH_FAILED");
              authenticated = true; socket.write(desktopIpcFrame(hello));
            } else if (!this.welcome) {
              const welcome = Welcome.parse(value);
              if (welcome.protocolVersion !== DESKTOP_IPC_VERSION) throw new Error("REMOTE_DESKTOP_PROTOCOL_MISMATCH");
              this.welcome = welcome; this.server?.close(); settle();
            } else { this.receive(value); }
          }); } catch (cause) {
            const error = cause instanceof Error && (cause.message === "REMOTE_DESKTOP_PROTOCOL_MISMATCH" || cause.message === "REMOTE_DESKTOP_IPC_AUTH_FAILED")
              ? cause
              : new Error("REMOTE_DESKTOP_IPC_INVALID");
            settle(error); void this.close();
          }
        });
        socket.on("error", () => { settle(new Error("REMOTE_DESKTOP_IPC_CLOSED")); void this.close(); });
        socket.on("close", () => { settle(new Error("REMOTE_DESKTOP_IPC_CLOSED")); void this.close(); });
      });
      this.server.on("error", () => settle(new Error("REMOTE_DESKTOP_IPC_CLOSED")));
      this.server.listen(endpoint, () => {
        if (this.ended) return;
        const args = mode === "control"
          ? ["--ipc", endpoint]
          : [mode === "local" ? "--native" : "--virtual", "--ipc", endpoint, "--system-cursor"];
        this.child = spawn(binary, args, { stdio: ["pipe", "pipe", "pipe"] });
        this.child.stdout.resume(); this.child.stderr.resume();
        this.child.stdin.on("error", () => { settle(new Error("REMOTE_DESKTOP_IPC_CLOSED")); void this.close(); });
        this.exit = new Promise<void>((resolveExit) => {
          this.child!.once("exit", () => {
            resolveExit(); settle(new Error("REMOTE_DESKTOP_COMPONENT_EXITED"));
            // Drain final IPC bytes before socket EOF; process exit may arrive
            // first. Bound cleanup if an invalid child keeps that stream open.
            if(!this.ended)this.exitDrainTimer=setTimeout(()=>{void this.close();},DEADLINE);
          });
          this.child!.once("error", () => { resolveExit(); settle(new Error("REMOTE_DESKTOP_COMPONENT_EXITED")); void this.close(); });
        });
        this.child.stdin.write(desktopIpcFrame(hello));
      });
    });
  }
  request(id: string, command: ComponentCommand): Promise<ComponentReply> {
    if (this.ended || !this.welcome || this.queue.length >= 32) return Promise.reject(new Error("REMOTE_DESKTOP_COMPONENT_UNAVAILABLE"));
    // Validate framing before enqueue so an oversized call cannot kill the host.
    desktopIpcFrame({ ...command, requestId: id, bootId: this.welcome.bootId });
    return new Promise((resolve, reject) => { this.queue.push({ id, command, resolve, reject }); this.flush(); });
  }
  private flush() {
    if (this.pending || this.ended || !this.welcome) return;
    const call = this.queue.shift(); if (!call) return;
    this.pending = call;
    this.timer = setTimeout(() => { void this.close(); }, COMMAND_DEADLINE.has(call.command.type) ? LONG_COMMAND_DEADLINE : DEADLINE);
    this.socket!.write(desktopIpcFrame({ ...call.command, requestId: call.id, bootId: this.welcome.bootId }));
  }
  private receive(value: unknown) {
    const packet = z.object({ kind: z.string(), payload: z.record(z.string(), z.unknown()) }).parse(value);
    if (packet.payload.bootId !== this.welcome!.bootId) throw new Error("REMOTE_DESKTOP_IPC_INVALID");
    if (packet.kind === "event") { this.emit("session", Event.parse(packet.payload)); return; }
    if (packet.kind !== "response" || !this.pending || packet.payload.requestId !== this.pending.id || typeof packet.payload.type !== "string") throw new Error("REMOTE_DESKTOP_IPC_INVALID");
    clearTimeout(this.timer);
    const call = this.pending; this.pending = undefined;
    call.resolve(packet.payload as ComponentReply); this.flush();
  }
  private closing?: Promise<void>;
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.ended = true; clearTimeout(this.timer); clearTimeout(this.exitDrainTimer);
    const error = new Error("REMOTE_DESKTOP_COMPONENT_UNAVAILABLE");
    this.pending?.reject(error); this.pending = undefined;
    for (const call of this.queue.splice(0)) call.reject(error);
    this.closing = (async () => {
      this.socket?.destroy(); this.server?.close(); this.child?.stdin.end();
      if (this.child && this.exit) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([this.exit, new Promise<void>((resolve) => { timer = setTimeout(resolve, DEADLINE); })]);
        clearTimeout(timer);
        if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill("SIGKILL");
        await this.exit;
      }
      if (this.directory) fs.rmSync(this.directory, { force: true, recursive: true });
      this.emit("closed");
    })();
    return this.closing;
  }
}
