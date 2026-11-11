import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import type { DesktopCaptureSelection, DesktopIceConfig } from "@task-handoff/protocol/remote-desktop";
import { DesktopSessionSnapshotSchema, DesktopSignalSchema, desktopSdpAllowed } from "@task-handoff/protocol/remote-desktop";
import type { ControlPlaneActor } from "../auth/authorization.ts";
import type { DesktopManagedOperation } from "@task-handoff/runtime-shared/remote-desktop-managed";
import { DESKTOP_FALLBACK_SELECTION_HEADER } from "@task-handoff/runtime-shared/remote-desktop-managed";
import type { NodeAgentWebSocket } from "../nodes/client.ts";

export type DesktopPrincipal = { actor: ControlPlaneActor; deviceSessionId: string; expiresAt?: number };
export function desktopPrincipalKey(principal: DesktopPrincipal) {
  // Full authorization context binds applicable user, cloud binding/share and
  // owner revisions. Device is separately bound for local authenticated users.
  return JSON.stringify([principal.actor, principal.deviceSessionId]);
}
export function desktopOwner(principal: DesktopPrincipal) {
  const actor = principal.actor;
  const actorId = actor.type === "user" ? `user:${actor.userId}` : actor.type === "cloud-account" ? `cloud-account:${actor.ownerAccountId}:${actor.accountId}` : undefined;
  if (!actorId) throw failure("REMOTE_DESKTOP_UNAUTHORIZED", 403);
  return { actorId, deviceSessionId: principal.deviceSessionId };
}
export function failure(code: string, statusCode = 409) { return Object.assign(new Error("Remote desktop operation failed."), { code, statusCode }); }
function isRemoteDesktopNotFound(error: unknown) {
  return Boolean(error && typeof error === "object" && (error as { code?: unknown }).code === "REMOTE_DESKTOP_NOT_FOUND");
}
type Entry = {
  principal: DesktopPrincipal; key: string; instanceId: string; nodeId: string; viewerSessionId: string;
  captureSelection: DesktopCaptureSelection; attachToken?: string; ticket?: string; ticketExpiresAt: number;
  ice: DesktopIceConfig; socket?: NodeAgentWebSocket; release?: () => void;
  timers: Set<ReturnType<typeof setTimeout>>; closed: boolean;
  transportLossTimer?: ReturnType<typeof setTimeout>;
  upstreamHeartbeat?: ReturnType<typeof setInterval>;
  closeUpstream?: () => void;
  fallback?: {
    generation: string;
    issuedAt: number;
    bitrate: number;
    tickets: Map<string, { role: "media" | "control"; expiresAt: number }>;
    sockets: Map<"media" | "control", NodeAgentWebSocket>;
  };
};
type FallbackRole = "media" | "control";
type FallbackCapacity = { maxSessions: number; maxTotalBitrate: number };
/** A Relay reconnect can close every browser tunnel in the same tick, in any
 * order. Keep the component reservation long enough for the viewer to obtain a
 * fresh signal or fallback pair instead of turning a transport interruption
 * into a session stop. */
const TRANSPORT_LOSS_GRACE_MS = 15_000;
/** The component expires its signaling lease after six seconds. The browser
 * socket may disappear independently of the Control Plane -> component attach
 * channel, so keep that upstream channel alive from the Control Plane while the
 * viewer obtains its fallback pair. */
const UPSTREAM_SIGNAL_ALIVE_MS = 2_000;
type Options = {
  request(instanceId: string, operation: DesktopManagedOperation, input: unknown): Promise<unknown>;
  attach(instanceId: string, socket: NodeAgentWebSocket): Promise<void>;
  fallback?(instanceId: string, role: FallbackRole, socket: NodeAgentWebSocket, headers: Record<string, string>): Promise<void>;
  renewAuthorization(principal: DesktopPrincipal): Promise<boolean>;
  issueIce(): DesktopIceConfig;
  watch?(principal: DesktopPrincipal, close: () => void): () => void;
  fallbackCapacity?: FallbackCapacity;
  now?: () => number;
};
/** Only authorization/ticket/connection indexes live here. The component is the
 * sole session authority: no copied lifecycle state or synthesized revisions. */
export class DesktopAccess {
  private readonly entries = new Map<string, Entry>();
  private readonly tickets = new Map<string, Entry>();
  private readonly retries = new Map<string, { until: number; input: string; promise: Promise<unknown>; principalKey: string }>();
  private readonly rates = new Map<string, number[]>();
  private readonly fallbackCapacity: FallbackCapacity;
  private readonly now: () => number;
  private readonly options: Options;
  constructor(options: Options) {
    this.options = options;
    this.now = options.now ?? Date.now;
    this.fallbackCapacity = options.fallbackCapacity ?? { maxSessions: 8, maxTotalBitrate: 32_000_000 };
  }
  private timer(entry: Entry, delay: number, callback: () => void) {
    const timer = setTimeout(() => { entry.timers.delete(timer); callback(); }, Math.max(0, delay)); timer.unref?.(); entry.timers.add(timer); return timer;
  }
  private clearTransportLoss(entry: Entry) {
    if (!entry.transportLossTimer) return;
    clearTimeout(entry.transportLossTimer);
    entry.timers.delete(entry.transportLossTimer);
    entry.transportLossTimer = undefined;
  }
  private retainAfterTransportLoss(entry: Entry, delay: number) {
    if (entry.closed) return;
    this.clearTransportLoss(entry);
    entry.transportLossTimer = this.timer(entry, delay, () => {
      entry.transportLossTimer = undefined;
      if (!entry.closed && !entry.socket && !entry.fallback) void this.close(entry);
    });
  }
  private purge() {
    const now = this.now();
    for (const [key, value] of this.retries) if (value.until <= now) this.retries.delete(key);
    for (const [key, values] of this.rates) { const recent = values.filter(at => at > now - 60_000); if (recent.length) this.rates.set(key, recent); else this.rates.delete(key); }
  }
  async mutate(principal: DesktopPrincipal, instanceId: string, requestId: string, input: unknown, run: () => Promise<unknown>) {
    this.purge();
    const key = JSON.stringify([desktopPrincipalKey(principal), instanceId, requestId]);
    const encoded = JSON.stringify(input); const previous = this.retries.get(key);
    if (previous) { if (previous.input !== encoded) throw failure("REMOTE_DESKTOP_REQUEST_CONFLICT"); return previous.promise; }
    const rateKeys = [`actor:${desktopOwner(principal).actorId}`, `instance:${instanceId}`];
    if (this.retries.size >= 4096 || this.rates.size >= 8192) throw failure("REMOTE_DESKTOP_RATE_LIMIT", 429);
    for (const rate of rateKeys) if ((this.rates.get(rate)?.length ?? 0) >= 12) throw failure("REMOTE_DESKTOP_RATE_LIMIT", 429);
    for (const rate of rateKeys) this.rates.set(rate, [...(this.rates.get(rate) ?? []), this.now()]);
    const promise = run(); this.retries.set(key, { until: this.now() + 30_000, input: encoded, promise, principalKey: desktopPrincipalKey(principal) }); return promise;
  }
  async create(principal: DesktopPrincipal, instanceId: string, nodeId: string, requestId: string, captureSelection: DesktopCaptureSelection, takeoverId?: string, ice = this.options.issueIce()) {
    const result = await this.options.request(instanceId, takeoverId ? "takeover" : "reserve", {
      requestId, owner: desktopOwner(principal), captureSelection, ...(takeoverId ? { viewerSessionId: takeoverId } : {}),
    }) as Record<string, unknown>;
    const snapshot = DesktopSessionSnapshotSchema.parse(result.snapshot);
    if (result.type !== "reserved" || typeof result.attachToken !== "string") throw failure("REMOTE_DESKTOP_RESERVATION_INVALID", 502);
    if (takeoverId) { const old = this.entries.get(takeoverId); if (old) await this.close(old, false); }
    if (this.entries.size >= 4096) {
      await this.options.request(instanceId, "stop", { requestId: randomBytes(16).toString("hex"), owner: desktopOwner(principal), viewerSessionId: snapshot.viewerSessionId });
      throw failure("REMOTE_DESKTOP_RATE_LIMIT", 429);
    }
    // Component starting deadline is 30s from reserve. Start timing BEFORE the
    // roundtrip in the caller; authority may additionally expose a shorter one.
    const authorityDeadline = typeof result.attachExpiresAt === "number" ? result.attachExpiresAt : this.now();
    const expires = Math.min(this.now() + 30_000, authorityDeadline, principal.expiresAt ?? Infinity);
    const entry: Entry = { principal, key: desktopPrincipalKey(principal), instanceId, nodeId, viewerSessionId: snapshot.viewerSessionId, captureSelection, attachToken: result.attachToken, ticketExpiresAt: expires, ice, timers: new Set(), closed: false };
    const ticket = randomBytes(32).toString("base64url"); entry.ticket = ticket;
    entry.release = this.options.watch?.(principal, () => void this.close(entry));
    this.entries.set(entry.viewerSessionId, entry); this.tickets.set(ticket, entry);
    this.timer(entry, expires - this.now(), () => { if (entry.ticket) void this.close(entry); });
    if (principal.expiresAt !== undefined) this.timer(entry, principal.expiresAt - this.now(), () => void this.close(entry));
    return { snapshot, ticket, ticketExpiresAt: expires, ...ice };
  }
  ownerEntry(principal: DesktopPrincipal, instanceId: string, id: string) {
    const entry = this.entries.get(id);
    if (!entry || entry.instanceId !== instanceId || entry.key !== desktopPrincipalKey(principal) || entry.closed) throw failure("REMOTE_DESKTOP_NOT_FOUND", 404);
    return entry;
  }
  async snapshot(principal: DesktopPrincipal, instanceId: string, id: string) {
    const response = await this.options.request(instanceId, "snapshot", { requestId: randomBytes(16).toString("hex"), owner: desktopOwner(principal), viewerSessionId: id }) as Record<string, unknown>;
    return DesktopSessionSnapshotSchema.parse(response.snapshot);
  }
  async stop(principal: DesktopPrincipal, instanceId: string, id: string, requestId: string) {
    // Always ask the authority so owner checks survive loss of the HTTP
    // response or a CP restart. A component restart intentionally drops its
    // ephemeral session registry, so NotFound means this cleanup already won.
    let result: unknown;
    try {
      result = await this.options.request(instanceId, "stop", { requestId, owner: desktopOwner(principal), viewerSessionId: id });
    } catch (error) {
      if (!isRemoteDesktopNotFound(error)) throw error;
      result = { type: "stopped" };
    }
    const entry = this.entries.get(id); if (entry) await this.close(entry, false); return result;
  }
  async forceStop(instanceId: string, id: string, requestId: string) {
    const result = await this.options.request(instanceId, "force-stop", { requestId, viewerSessionId: id });
    const entry = this.entries.get(id); if (entry?.instanceId === instanceId) await this.close(entry, false); return result;
  }
  consume(principal: DesktopPrincipal, instanceId: string, id: string, ticket: string) {
    const entry = this.tickets.get(ticket);
    if (!entry || entry.instanceId !== instanceId || entry.viewerSessionId !== id || entry.key !== desktopPrincipalKey(principal) || entry.closed || entry.ticketExpiresAt <= this.now()) throw failure("REMOTE_DESKTOP_TICKET_INVALID", 401);
    this.tickets.delete(ticket); entry.ticket = undefined;
    return entry;
  }
  issueFallback(principal: DesktopPrincipal, instanceId: string, id: string, bitrate = 4_000_000) {
    const entry = this.ownerEntry(principal, instanceId, id);
    // Progressive mode requests fallback while WebRTC is still negotiating.
    // The session creation time is not evidence that negotiation has settled;
    // ticket issuance is authenticated and the fallback endpoints stay bound
    // to this exact viewer/session generation.
    const active = [...this.entries.values()].filter(candidate => candidate !== entry && !candidate.closed && candidate.fallback);
    if (active.length >= this.fallbackCapacity.maxSessions
      || active.reduce((total, candidate) => total + (candidate.fallback?.bitrate ?? 0), bitrate) > this.fallbackCapacity.maxTotalBitrate) {
      throw failure("REMOTE_DESKTOP_FALLBACK_CAPACITY", 503);
    }
    this.clearTransportLoss(entry);
    this.closeFallback(entry);
    const generation = `fgen_${randomBytes(12).toString("base64url")}`;
    const expiresAt = this.now() + 30_000;
    const tickets = new Map<string, { role: FallbackRole; expiresAt: number }>();
    for (const role of ["media", "control"] as const) tickets.set(randomBytes(32).toString("base64url"), { role, expiresAt });
    const fallback = { generation, issuedAt: this.now(), bitrate, tickets, sockets: new Map() };
    entry.fallback = fallback;
    this.timer(entry, 10_000, () => {
      if (entry.fallback === fallback && fallback.sockets.size < 2) this.closeFallback(entry);
    });
    this.timer(entry, expiresAt - this.now(), () => {
      if (entry.fallback === fallback && fallback.sockets.size === 0) entry.fallback = undefined;
    });
    const base = `/api/controlled-instances/${encodeURIComponent(instanceId)}/remote-desktop-sessions/${encodeURIComponent(id)}/fallback`;
    const url = (role: FallbackRole) => {
      const ticket = [...tickets].find(([, value]) => value.role === role)?.[0] ?? "";
      return `${base}/${role}?ticket=${encodeURIComponent(ticket)}`;
    };
    return { generation, mediaUrl: url("media"), controlUrl: url("control"), ticketExpiresAt: expiresAt };
  }
  consumeFallback(principal: DesktopPrincipal, instanceId: string, id: string, role: FallbackRole, ticket: string) {
    const entry = this.ownerEntry(principal, instanceId, id);
    const fallback = entry.fallback;
    if (!fallback) throw failure("REMOTE_DESKTOP_FALLBACK_TICKET_INVALID", 401);
    const value = fallback.tickets.get(ticket);
    if (!value || value.role !== role || value.expiresAt <= this.now()) throw failure("REMOTE_DESKTOP_FALLBACK_TICKET_INVALID", 401);
    fallback.tickets.delete(ticket);
    return { entry, generation: fallback.generation };
  }
  async connectFallback(entry: Entry, role: FallbackRole, generation: string, socket: NodeAgentWebSocket) {
    const fallback = entry.fallback;
    if (entry.closed || !fallback || fallback.generation !== generation) throw failure("REMOTE_DESKTOP_FALLBACK_TICKET_INVALID", 401);
    this.clearTransportLoss(entry);
    const previous = fallback.sockets.get(role);
    fallback.sockets.set(role, socket);
    // Install the replacement before closing the old socket so a synchronous
    // close cannot look like the current pair ending.
    if (previous && previous !== socket) previous.close(1000, "Remote desktop fallback replaced.");
    socket.on("close", () => {
      // A replacement generation may close an older socket after the new pair
      // has already been installed. Only the currently owned generation may
      // invalidate fallback state.
      if (entry.fallback !== fallback || fallback.sockets.get(role) !== socket) return;
      entry.fallback = undefined;
      fallback.sockets.delete(role);
      for (const [otherRole, other] of fallback.sockets) {
        fallback.sockets.delete(otherRole);
        other.close(1000, "Remote desktop fallback ended.");
      }
      // With no signaling socket either, both transports are gone and the
      // reservation must survive the same Relay interruption long enough for
      // the viewer to replace the pair.
      if (!entry.socket) this.retainAfterTransportLoss(entry, TRANSPORT_LOSS_GRACE_MS);
    });
    socket.on("error", () => socket.close(1011, "REMOTE_DESKTOP_FALLBACK_SOCKET_ERROR"));
    const headers = {
      "x-task-handoff-desktop-viewer": entry.viewerSessionId,
      "x-task-handoff-desktop-generation": generation,
      "x-task-handoff-desktop-actor": desktopOwner(entry.principal).actorId,
      "x-task-handoff-desktop-device": entry.principal.deviceSessionId,
      [DESKTOP_FALLBACK_SELECTION_HEADER]: JSON.stringify(entry.captureSelection),
    };
    try {
      if (!this.options.fallback) throw new Error("fallback transport unavailable");
      await this.options.fallback(entry.instanceId, role, socket, headers);
    } catch {
      socket.close(1011, "REMOTE_DESKTOP_FALLBACK_UPSTREAM_UNAVAILABLE");
      if (entry.fallback === fallback) this.closeFallback(entry);
    }
  }
  private closeFallback(entry: Entry) {
    const fallback = entry.fallback;
    if (!fallback) return;
    entry.fallback = undefined;
    const sockets = [...fallback.sockets.values()];
    fallback.sockets.clear();
    for (const socket of sockets) socket.close(1000, "Remote desktop fallback replaced.");
  }
  async connect(entry: Entry, socket: NodeAgentWebSocket) {
    if (entry.closed || !entry.attachToken) throw failure("REMOTE_DESKTOP_TICKET_INVALID", 401);
    this.clearTransportLoss(entry);
    entry.socket = socket;
    let closed = false, ready = false, count = 0, candidates = 0, rateAt = performance.now(), lastRevision = -1;
    let configuring: string | undefined; let negotiation: string | undefined; let renewal: DesktopIceConfig | undefined;
    let browserRecovered = false;
    let lastTransportGeneration = -1; let renewalTransportGeneration = -1;
    let expiryTimer: ReturnType<typeof setTimeout> | undefined;
    const send = (value: unknown) => { if (!closed && socket.readyState === 1) socket.send(JSON.stringify(value)); };
    const fail = (code = "REMOTE_DESKTOP_SIGNAL_INVALID") => { send({ type: "error", code }); void this.close(entry); };
    const relay = new EventEmitter() as EventEmitter & NodeAgentWebSocket;
    relay.readyState = 1;
    relay.close = () => { relay.readyState = 3; void this.close(entry); };
    // The browser socket and the upstream attach channel have independent
    // lifetimes. A Relay outage closes the browser-facing socket first; the
    // component must keep receiving liveness until fallback attaches or the
    // transport-loss grace expires.
    entry.closeUpstream = () => {
      if (relay.readyState === 3) return;
      relay.readyState = 3;
      relay.emit("close", 1000, "Remote desktop session ended.");
    };
    const forwardUpstream = (value: unknown) => {
      if (entry.closed || relay.readyState !== 1) return;
      relay.emit("message", Buffer.from(JSON.stringify(value)), false);
    };
    const forward = (value: unknown) => { if (!closed) forwardUpstream(value); };
    const installExpiry = (ice: DesktopIceConfig) => {
      if (expiryTimer) { clearTimeout(expiryTimer); entry.timers.delete(expiryTimer); }
      if (ice.iceCredentialsExpiresAt !== null) expiryTimer = this.timer(entry, ice.iceCredentialsExpiresAt - this.now(), () => void this.close(entry));
    };
    const scheduleRenewal = () => {
      if (entry.ice.iceCredentialsExpiresAt === null) return;
      this.timer(entry, entry.ice.iceCredentialsExpiresAt - this.now() - 120_000, () => {
        void (async () => {
          if (closed || negotiation || configuring || !(await this.options.renewAuthorization(entry.principal))) throw failure("REMOTE_DESKTOP_AUTHORIZATION_CHANGED");
          renewal = this.options.issueIce();
          configuring = randomBytes(16).toString("hex");
          forward({ type: "configureIce", requestId: configuring, ...renewal });
          send({ type: "configureIce", requestId: configuring, ...renewal });
        })().catch(() => void this.close(entry));
      });
    };
    // Credential renewal is two-sided: the browser must observe its restored
    // candidate pair, and the component must advance its own transport
    // generation after the restarted ICE generation connects. A snapshot
    // revision alone is not proof because input suspension also advances it.
    const completeRenewal = () => {
      if (!renewal || negotiation || configuring || !browserRecovered || lastTransportGeneration <= renewalTransportGeneration) return false;
      entry.ice = renewal; renewal = undefined; browserRecovered = false;
      installExpiry(entry.ice); scheduleRenewal();
      send({ type: "iceRenewed", ...entry.ice });
      return true;
    };
    relay.send = (data: unknown, options?: { binary?: boolean }) => {
      try {
        if (closed) return;
        const text = String(data); if (options?.binary || Buffer.byteLength(text) > 512 * 1024) throw new Error();
        const message = JSON.parse(text) as Record<string, any>;
        if (message.type === "snapshot") {
          const generation = (message.snapshot as Record<string, unknown> | undefined)?.transportGeneration;
          if (typeof generation === "number" && Number.isSafeInteger(generation) && generation >= 0) lastTransportGeneration = Math.max(lastTransportGeneration, generation);
          const snapshot = DesktopSessionSnapshotSchema.parse(message.snapshot);
          if (snapshot.viewerSessionId !== entry.viewerSessionId) throw new Error();
          if (snapshot.sessionRevision <= lastRevision) return;
          lastRevision = snapshot.sessionRevision; send({ type: "snapshot", snapshot });
          if (!ready) {
            ready = true; configuring = randomBytes(16).toString("hex");
            renewalTransportGeneration = lastTransportGeneration; browserRecovered = false;
            forward({ type: "configureIce", requestId: configuring, ...entry.ice });
            // The browser and component each receive the same short-lived
            // configuration. The attach token remains only in `forward`.
            send({ type: "configureIce", requestId: configuring, ...entry.ice });
          }
          if (snapshot.phase === "stopped" || snapshot.phase === "failed") void this.close(entry, false);
          else if (browserRecovered) completeRenewal();
        } else if (message.type === "acknowledged" && message.requestId === configuring) {
          configuring = undefined;
          if (renewal) {
            renewalTransportGeneration = lastTransportGeneration; browserRecovered = false;
            send({ type: "iceConfiguration", ...renewal });
          }
          else { send({ type: "ready" }); scheduleRenewal(); }
        } else if (message.type === "answer") {
          if (message.requestId !== negotiation || typeof message.sdp !== "string" || !desktopSdpAllowed(message.sdp)) throw new Error();
          negotiation = undefined; send({ type: "answer", requestId: message.requestId, sdp: message.sdp });
          // A new allocation is only committed after component reports recovered
          // ICE, never from a client-provided success boolean or config ACK.
        } else if (message.type === "error") {
          const code = typeof message.code === "string" && /^REMOTE_DESKTOP_[A-Z0-9_]+$/.test(message.code)
            ? message.code : "REMOTE_DESKTOP_OPERATION_FAILED";
          if (message.requestId === configuring) configuring = undefined;
          if (message.requestId === negotiation) negotiation = undefined;
          // Component errors are stable codes, not malformed signaling. Keep
          // the entry alive so the viewer can switch to the fallback transport
          // on the same authoritative session.
          send({ type: "error", code });
        }
        else if (message.type !== "acknowledged") throw new Error();
      } catch { fail(); }
    };
    const signalLost = () => {
      if (entry.socket === socket) entry.socket = undefined;
      if (entry.closed) return;
      this.retainAfterTransportLoss(entry, TRANSPORT_LOSS_GRACE_MS);
    };
    socket.on("close", () => { closed = true; signalLost(); });
    socket.on("error", signalLost);
    socket.on("message", (data: unknown, binary: unknown) => {
      try {
        if (closed) return;
        const now = performance.now(); if (now - rateAt >= 1000) { rateAt = now; count = 0; }
        const text = String(data); if (binary || Buffer.byteLength(text) > 512 * 1024 || ++count > 64) throw new Error();
        const message = DesktopSignalSchema.parse(JSON.parse(text));
        // Liveness may arrive immediately after the socket opens, before the
        // component has sent its first snapshot. Accept it instead of failing
        // the viewer, but only relay it once the upstream binding is ready so
        // the component can renew its own six-second signal lease.
        if (message.type === "signalAlive") {
          if (ready) forward(message);
          return;
        }
        if (!ready || configuring) throw new Error();
        if (message.type === "stop") { void this.close(entry); return; }
        // Browser acknowledgements are transport-local. The component's own
        // configuration acknowledgement is the authority used by relay.send.
        if (message.type === "acknowledged") return;
        if (message.type === "iceRestarted") {
          if (!renewal) return;
          browserRecovered = true;
          completeRenewal();
          return;
        }
        if (message.type === "candidate" && ++candidates > 256) throw new Error();
        if (message.type === "offer") { if (negotiation) throw new Error(); negotiation = message.requestId; }
        forward(message);
      } catch { fail(); }
    });
    try {
      await this.options.attach(entry.instanceId, relay);
      if (entry.closed || closed) return;
      forward({ requestId: randomBytes(16).toString("hex"), owner: desktopOwner(entry.principal), viewerSessionId: entry.viewerSessionId, captureSelection: entry.captureSelection, attachToken: entry.attachToken });
      entry.attachToken = undefined;
      const heartbeat = () => forwardUpstream({ type: "signalAlive", requestId: randomBytes(16).toString("hex") });
      heartbeat();
      entry.upstreamHeartbeat = setInterval(heartbeat, UPSTREAM_SIGNAL_ALIVE_MS);
      entry.upstreamHeartbeat.unref?.();
      installExpiry(entry.ice);
    } catch { await this.close(entry); }
  }
  bind(entry: Entry, release: () => void) { if (entry.closed) release(); else entry.release = release; }
  async close(entry: Entry, stop = true) {
    if (entry.closed) return; entry.closed = true;
    this.clearTransportLoss(entry);
    if (entry.upstreamHeartbeat) clearInterval(entry.upstreamHeartbeat);
    entry.upstreamHeartbeat = undefined;
    if (entry.ticket) this.tickets.delete(entry.ticket);
    this.closeFallback(entry);
    entry.attachToken = undefined; entry.ticket = undefined;
    this.entries.delete(entry.viewerSessionId);
    // Clear cached create responses as well: tickets/TURN credentials must not
    // survive a revoked authorization or consumed/terminated reservation.
    for (const [key, value] of this.retries) if (value.principalKey === entry.key) this.retries.delete(key);
    for (const timer of entry.timers) clearTimeout(timer); entry.timers.clear(); entry.release?.();
    entry.socket?.close(1000, "Remote desktop session ended.");
    if (stop) await this.options.request(entry.instanceId, "stop", { requestId: randomBytes(16).toString("hex"), owner: desktopOwner(entry.principal), viewerSessionId: entry.viewerSessionId }).catch(() => undefined);
    entry.closeUpstream?.();
    entry.closeUpstream = undefined;
  }
  async invalidate(test: (principal: DesktopPrincipal, instanceId: string, nodeId: string) => boolean) {
    await Promise.all([...this.entries.values()].filter(entry => test(entry.principal, entry.instanceId, entry.nodeId)).map(entry => this.close(entry)));
  }
  shutdown() { return this.invalidate(() => true); }
}
