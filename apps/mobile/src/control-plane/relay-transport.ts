import type { z } from 'zod';
import type { ControlPlanePublicCapabilities } from '@task-handoff/protocol/control-plane-access';
import { RelayTtySnapshotEnvelopeSchema, type OfficialMobileAccountClient as CloudMobileAccountClient, type RelaySelection as CloudRelaySelection } from '@task-handoff/cloud-contracts/mobile';
import type { MobileCloudRelayControlPlaneProfile } from './profile';
import { probeRelayCandidates, RELAY_PROBE_FAST_BUDGET_MS, RELAY_PROBE_FAST_SAMPLES, type RelayProbeTarget } from './relay-prober';
import { selectRelayCandidate, type RelayProbeResult, type RelayScoringCandidate, type RelaySelectionFallback } from './relay-scorer';
import { RelayWinnerCache, type RelayWinnerEntry } from './relay-winner-cache';
import { COMPACT_EVENT_ENVELOPE_VERSION, type AiSessionTransientSubscription } from '@task-handoff/protocol/events';
import { MOBILE_EVENT_KEEPALIVE_INTERVAL_MS, MobileControlPlaneTransportError, mobileEventKeepaliveFrame, normalizeMobileControlPlaneEvent, type MobileAppSessionTtyConnection, type MobileAppSessionTtyHandlers, type MobileControlPlaneEventConnection, type MobileControlPlaneEventHandlers, type MobileControlPlaneTransport } from './transport';

type RelayEnvelope = { type: string; id?: string; status?: number; body?: unknown; event?: any; streamId?: string; data?: unknown; pendingEscape?: unknown; cols?: unknown; rows?: unknown; code?: number | null; signal?: string | null };
export interface EncryptedRelayChannel { readonly leaseExpiresAt?: string; send(value: RelayEnvelope): void; close(code?: number, reason?: string): void; subscribe(listener: (value: RelayEnvelope) => void, onClose: (error?: unknown) => void): () => void; }
export type RelayChannelFactory = (input: { relayUrl: string; clientAttach: unknown; ticket: unknown; targetPublicKeyFingerprint: string; epoch: number }) => Promise<EncryptedRelayChannel>;

// Relay channels live only as long as the Coordinator-issued allocation lease,
// so the transport rotates onto a fresh allocation before the current one
// expires instead of waiting for the Relay to close the channel mid-request.
const LEASE_RENEWAL_LEAD_MS = 5_000;
const LEASE_RENEWAL_MINIMUM_MS = 1_000;

// The mobile app renders no instance resource metrics. The Control Plane
// otherwise streams one `instance.metrics.snapshot` per instance on every
// sampler tick, and that stream shares the `instances` topic with real
// directory changes, so it is scoped away explicitly rather than left to the
// legacy default of "everything".
const MOBILE_RESOURCE_METRIC_SCOPE = { metricInstanceIds: [] as string[] };

/**
 * How many Relays one connection attempt evaluates. Three is enough to route
 * around a bad region without making the probe phase a fleet-wide sweep.
 */
const RELAY_CANDIDATE_COUNT = 3;
/** Used when the client cannot tell one network from another (no reachability module on this platform). */
const DEFAULT_NETWORK_FINGERPRINT = 'default';

export interface RelayTransportOptions {
  /** Injected by tests and by the app so the transport does not reach for platform APIs. */
  winnerCache?: RelayWinnerCache;
  probeRelayCandidates?: typeof probeRelayCandidates;
  allowRelayUrl?: (url: URL) => boolean;
  networkFingerprint?: () => string;
}

export class RelayControlPlaneTransport implements MobileControlPlaneTransport {
  readonly profile: MobileCloudRelayControlPlaneProfile;
  readonly currentCapabilities: ControlPlanePublicCapabilities | undefined = undefined;
  private channel?: Promise<EncryptedRelayChannel>;
  private channelValue?: EncryptedRelayChannel;
  private leaseTimer?: ReturnType<typeof setTimeout>;
  private keepaliveTimer?: ReturnType<typeof setInterval>;
  private epoch = 0;
  private nextId = 0;
  private readonly pending = new Map<string, { resolve(value: unknown): void; reject(error: unknown): void; schema: z.ZodType<any>; abort?: () => void }>();
  private readonly events = new Set<MobileControlPlaneEventHandlers>();
  private readonly tty = new Map<string, MobileAppSessionTtyHandlers>();
  private readonly ttyStreams = new Map<string, { instanceId: string; sessionId: string }>();

  private readonly winnerCache: RelayWinnerCache | undefined;
  private readonly probe: typeof probeRelayCandidates;
  private readonly allowRelayUrl: ((url: URL) => boolean) | undefined;
  private readonly networkFingerprint: () => string;
  constructor(profile: MobileCloudRelayControlPlaneProfile, private readonly account: CloudMobileAccountClient, private readonly openChannel: RelayChannelFactory, options: RelayTransportOptions = {}) {
    this.profile = profile;
    this.winnerCache = options.winnerCache;
    this.probe = options.probeRelayCandidates ?? probeRelayCandidates;
    this.allowRelayUrl = options.allowRelayUrl;
    this.networkFingerprint = options.networkFingerprint ?? (() => DEFAULT_NETWORK_FINGERPRINT);
  }

  async request<T>(path: string, schema: z.ZodType<T>, init: RequestInit = {}, _onUploadProgress?: (progress: number) => void) {
    if (!path.startsWith('/') || path.startsWith('//')) throw transportError('RELAY_ROUTE_INVALID');
    const headers = new Headers(init.headers); if (headers.has('authorization')) throw transportError('RELAY_AUTH_HEADER_FORBIDDEN');
    const channel = await this.ensureChannel(); const id = `request_${++this.nextId}`;
    return new Promise<T>((resolve, reject) => {
      const abort = () => { try { this.sendOrReset(channel, { type: 'cancel', id }); } catch { /* the failed send already reset pending requests */ } this.pending.delete(id); reject(transportError('RELAY_REQUEST_CANCELLED')); };
      if (init.signal?.aborted) return abort();
      init.signal?.addEventListener('abort', abort, { once: true });
      this.pending.set(id, { resolve, reject, schema, abort: () => init.signal?.removeEventListener('abort', abort) });
      try { this.sendOrReset(channel, { type: 'request', id, body: { path, method: init.method ?? 'GET', headers: Object.fromEntries(headers), body: init.body } }); }
      catch (error) { this.pending.delete(id); init.signal?.removeEventListener('abort', abort); reject(error); }
    });
  }

  connectEvents(handlers: MobileControlPlaneEventHandlers): MobileControlPlaneEventConnection {
    let closed = false;
    this.events.add(handlers);
    this.startKeepalive();
    void this.ensureChannel().then((channel) => {
      if (closed) return;
      this.sendEventSubscription(channel);
      handlers.onOpen();
    }).catch(handlers.onError);
    return {
      close: () => {
        if (closed) return;
        closed = true;
        this.events.delete(handlers);
        if (!this.events.size) this.stopKeepalive();
        this.sendEventSubscription();
      },
      updateAiSessionTransient: (subscription) => {
        handlers.aiSessionTransient = subscription;
        this.sendEventSubscription();
      },
    };
  }

  private sendEventSubscription(channel = this.channelValue) {
    if (!channel) return;
    const topics = new Set<string>();
    let wildcard = false;
    for (const subscriber of this.events) {
      if (subscriber.topics === undefined) {
        wildcard = true;
        break;
      }
      for (const topic of subscriber.topics) topics.add(topic);
    }
    const aiSessionTransient = wildcard ? undefined : aggregateTransientDemand(this.events, topics);
    this.sendOrReset(channel, { type: 'event-subscribe', body: { eventEnvelopeVersion: COMPACT_EVENT_ENVELOPE_VERSION, aiSessionHierarchy: { subagents: true }, topics: wildcard ? undefined : [...topics].sort(), ...MOBILE_RESOURCE_METRIC_SCOPE, ...(aiSessionTransient ? { aiSessionTransient } : {}) } });
  }

  private startKeepalive() {
    if (this.keepaliveTimer) return;
    const timer = setInterval(() => {
      if (!this.events.size || !this.channelValue) return;
      try { this.sendOrReset(this.channelValue, mobileEventKeepaliveFrame()); }
      catch { /* the failed send already reset the transport */ }
    }, MOBILE_EVENT_KEEPALIVE_INTERVAL_MS);
    // A keepalive must never be the reason a process stays alive; React Native
    // returns a numeric handle and simply ignores the call.
    (timer as unknown as { unref?(): void }).unref?.();
    this.keepaliveTimer = timer;
  }

  private stopKeepalive() {
    if (this.keepaliveTimer) clearInterval(this.keepaliveTimer);
    this.keepaliveTimer = undefined;
  }

  connectAppSessionTty(instanceId: string, sessionId: string, handlers: MobileAppSessionTtyHandlers): MobileAppSessionTtyConnection {
    const streamId = `tty_${++this.nextId}`; this.tty.set(streamId, handlers);
    const input = { instanceId, sessionId };
    this.ttyStreams.set(streamId, input);
    void this.ensureChannel().then((channel) => this.sendOrReset(channel, { type: 'tty-open', streamId, body: input })).catch(handlers.onError);
    return { sendInput: (data) => { if (this.channelValue) this.sendOrReset(this.channelValue, { type: 'tty-input', streamId, data }); }, resize: (cols, rows) => { if (this.channelValue) this.sendOrReset(this.channelValue, { type: 'tty-resize', streamId, body: { cols, rows } }); }, close: () => { if (this.channelValue) this.sendOrReset(this.channelValue, { type: 'tty-close', streamId }); this.tty.delete(streamId); this.ttyStreams.delete(streamId); } };
  }

  async revalidate() {
    this.reset(transportError('RELAY_NETWORK_CHANGED', true));
    // Callers use revalidate() to reconnect, not to report that the network changed, so
    // the remembered winner survives it: dropping it here made the fast path unreachable.
    // A device that really moved is caught by the network fingerprint inside the cache,
    // and every genuine failure (confirm error, substitution, refused attach) clears it.
    await this.ensureChannel();
  }

  private ensureChannel() {
    if (this.channel) return this.channel;
    this.channel = this.establishChannel().catch((error) => { this.channel = undefined; throw normalize(error); });
    return this.channel;
  }

  private async establishChannel(allowCachedWinner = true): Promise<EncryptedRelayChannel> {
    try {
      return await this.runSelection(allowCachedWinner);
    } catch (error) {
      // "Reuse the winner until it stops working": a failed attempt is that evidence, so
      // the next connection measures again instead of trusting the cache. This is the only
      // place a reconnect invalidates it, which is what keeps the fast path reachable.
      await this.winnerCache?.clear(this.profile.identity.controlPlaneId);
      throw error;
    }
  }

  private async runSelection(allowCachedWinner: boolean): Promise<EncryptedRelayChannel> {
    const ticket = await this.account.issueAccessTicket({ controlPlaneId: this.profile.identity.controlPlaneId, trafficClasses: ['interactive', 'stream'] });
    if (ticket.targetPublicKeyFingerprint !== this.profile.identity.publicKeyFingerprint || ticket.bindingId !== this.profile.access.bindingId || ticket.bindingRevision !== this.profile.access.bindingRevision) throw transportError('RELAY_TARGET_IDENTITY_CHANGED');
    const controlPlaneId = this.profile.identity.controlPlaneId;
    const networkFingerprint = this.networkFingerprint();
    const cached = allowCachedWinner ? await this.winnerCache?.read(controlPlaneId, networkFingerprint) : undefined;
    const selection = await this.account.allocateRelaySelection({
      ticket, trafficClass: 'interactive', preferredRegion: undefined,
      maxCandidates: RELAY_CANDIDATE_COUNT,
      ...(cached ? { preferredRelayId: cached.relayId } : {}),
    });
    const winner = await this.chooseWinner(selection, cached, networkFingerprint);
    let confirmed;
    try {
      confirmed = await this.account.confirmRelaySelection(selection.selectionId, winner.confirmation);
    } catch (error) {
      // The Coordinator could not hold any candidate: a fresh selection is the only
      // recovery, and retrying the same one would replay a spent reservation.
      throw error;
    }
    if (confirmed.substituted || confirmed.relayId !== winner.relayId) {
      // The Coordinator had to book something other than what was asked for, so the
      // cached winner is stale information rather than a fact about this network.
      await this.winnerCache?.clear(controlPlaneId);
    }
    try {
      const channel = await this.openChannel({ relayUrl: confirmed.relayUrl, clientAttach: confirmed.clientAttach, ticket, targetPublicKeyFingerprint: this.profile.identity.publicKeyFingerprint, epoch: ++this.epoch });
      this.installChannel(channel);
      await this.rememberWinner(controlPlaneId, confirmed, winner.measurements, networkFingerprint, cached);
      return channel;
    } catch (error) {
      // A Relay that hands out a good probe but refuses the attach is exactly the
      // case the cache must not learn from; retry once with a full selection.
      if (allowCachedWinner && cached) return this.establishChannel(false);
      throw error;
    }
  }

  /**
   * Probes the candidates and decides which one to confirm. The cached winner
   * only needs a single validating sample; anything else falls back to probing
   * the whole set, and if every sample fails the client defers to the
   * Coordinator's own ranking instead of guessing.
   */
  private async chooseWinner(selection: CloudRelaySelection, cached: RelayWinnerEntry | undefined, networkFingerprint: string) {
    const trust = this.allowRelayUrl;
    const targets: RelayProbeTarget[] = selection.candidates.map((candidate) => ({ allocationId: candidate.allocationId, relayUrl: candidate.relayUrl }));
    const cachedCandidate = cached ? selection.candidates.find((candidate) => candidate.relayId === cached.relayId) : undefined;
    const fastPath = cachedCandidate !== undefined && cached !== undefined && selection.preferredHonored;
    const probeOptions = trust ? { allowRelayUrl: trust } : {};
    let probes = await this.probe(
      fastPath ? targets.filter((target) => target.allocationId === cachedCandidate!.allocationId) : targets,
      fastPath ? { ...probeOptions, samples: RELAY_PROBE_FAST_SAMPLES, budgetMs: RELAY_PROBE_FAST_BUDGET_MS } : probeOptions,
    );
    if (fastPath && !probes.some((probe) => probe.mobileRttMs !== undefined)) {
      // The remembered winner did not answer, so this is a full selection after all.
      probes = await this.probe(targets, probeOptions);
    }
    const scored = selectRelayCandidate({
      candidates: selection.candidates,
      probes,
      serverOrder: selection.candidates.map((candidate) => candidate.allocationId),
      preferredRelayId: cached?.relayId,
      preferredHonored: selection.preferredHonored,
    });
    // A successful fast path deliberately measured one candidate out of several,
    // so the scorer's "some candidates went unmeasured" signal does not apply.
    const fallback: RelaySelectionFallback = fastPath && probes.some((probe) => probe.mobileRttMs !== undefined) ? 'none' : scored.fallback;
    const winnerCandidate = selection.candidates.find((candidate) => candidate.allocationId === scored.winner)!;
    const measurements = probes.filter((probe) => probe.sampleCount > 0).map((probe) => ({
      allocationId: probe.allocationId,
      relayId: selection.candidates.find((candidate) => candidate.allocationId === probe.allocationId)!.relayId,
      ...(probe.mobileRttMs === undefined ? {} : { mobileRttMs: probe.mobileRttMs }),
      sampleCount: probe.sampleCount,
      failureCount: probe.failureCount,
    }));
    return {
      relayId: winnerCandidate.relayId,
      measurements: probes,
      confirmation: {
        winnerAllocationId: scored.winner,
        rankedAllocationIds: scored.ranked,
        // The reason travels with the measurement so a degraded connection is
        // visible in operations instead of looking like a normal selection.
        fallback,
        ...(measurements.length ? { measurements } : {}),
      },
    };
  }

  private async rememberWinner(controlPlaneId: string, confirmed: { relayId: string; relayUrl: string }, measurements: readonly RelayProbeResult[], networkFingerprint: string, cached?: RelayWinnerEntry) {
    if (!this.winnerCache) return;
    const measured = measurements.find((probe) => probe.mobileRttMs !== undefined);
    // The winner still answers, but far slower than the measurement the cache was
    // built from: this network (or that Relay) changed underneath us, so forget the
    // hint and let the next connection run a full selection.
    if (cached && measured?.mobileRttMs !== undefined && cached.rttMs > 0 && measured.mobileRttMs > cached.rttMs * 2) {
      await this.winnerCache.clear(controlPlaneId);
      return;
    }
    await this.winnerCache.write(controlPlaneId, { relayId: confirmed.relayId, relayUrl: confirmed.relayUrl, rttMs: measured?.mobileRttMs ?? cached?.rttMs ?? 0, networkFingerprint });
  }

  private installChannel(channel: EncryptedRelayChannel) {
    const previous = this.channelValue;
    this.channelValue = channel;
    this.channel = Promise.resolve(channel);
    channel.subscribe((value) => this.receive(value), (error) => this.channelClosed(channel, error));
    // A rotated channel starts empty: replay the demand the previous one carried.
    if (previous) {
      if (this.events.size) this.sendEventSubscription(channel);
      for (const [streamId, input] of this.ttyStreams) this.sendOrReset(channel, { type: 'tty-open', streamId, body: input });
    }
    this.scheduleLeaseRenewal(channel);
  }

  // A channel that rejects a frame is dead for our purposes: closed sockets fail within
  // the channel while a stalled one fails the backpressure guard. Treat either as the
  // channel closing so the active channel resets and the retry allocates a fresh one
  // instead of failing on the same dead channel forever.
  private sendOrReset(channel: EncryptedRelayChannel, value: RelayEnvelope) {
    try { channel.send(value); }
    catch (error) { this.channelClosed(channel, error); throw error; }
  }

  private channelClosed(channel: EncryptedRelayChannel, error?: unknown) {
    // A rotated channel closes on its own schedule; only the active one resets the transport.
    if (this.channelValue !== channel) return;
    this.reset(error ?? transportError('RELAY_CHANNEL_CLOSED', true));
  }

  private scheduleLeaseRenewal(channel: EncryptedRelayChannel) {
    this.cancelLeaseRenewal();
    const expiresAt = channel.leaseExpiresAt ? Date.parse(channel.leaseExpiresAt) : Number.NaN;
    if (!Number.isFinite(expiresAt)) return;
    const delay = Math.max(LEASE_RENEWAL_MINIMUM_MS, expiresAt - Date.now() - LEASE_RENEWAL_LEAD_MS);
    this.leaseTimer = setTimeout(() => { this.leaseTimer = undefined; void this.renewLease(channel); }, delay);
  }

  private cancelLeaseRenewal() { if (this.leaseTimer) clearTimeout(this.leaseTimer); this.leaseTimer = undefined; }

  private async renewLease(current: EncryptedRelayChannel) {
    if (this.channelValue !== current) return;
    // Requests keep flowing on `current` until the replacement is ready, and the
    // previous channel stays open for in-flight responses until its lease ends. A
    // failed renewal changes nothing here: the current lease still runs out and
    // `channelClosed` resets the transport then.
    await this.establishChannel().catch(() => undefined);
  }

  private receive(value: RelayEnvelope) {
    if (value.type === 'response' && value.id) { const pending = this.pending.get(value.id); if (!pending) return; this.pending.delete(value.id); pending.abort?.(); if ((value.status ?? 500) >= 400) pending.reject(new MobileControlPlaneTransportError('RELAY_CONTROL_PLANE_RESPONSE_FAILED', 'Control Plane request failed.', false, value.status)); else { const parsed = pending.schema.safeParse(value.body); if (parsed.success) pending.resolve(parsed.data); else pending.reject(transportError('RELAY_RESPONSE_SCHEMA_INVALID')); } return; }
    if (value.type === 'event' && value.event) {
      const event = normalizeMobileControlPlaneEvent(value.event);
      if (!event) return this.reset(transportError('RELAY_EVENT_INVALID'));
      for (const handlers of this.events) handlers.onEvent(event);
      return;
    }
    if (value.streamId && this.tty.has(value.streamId)) { const handlers = this.tty.get(value.streamId)!; if (value.type === 'tty-opened') handlers.onOpen(); else if (value.type === 'tty-snapshot') { const snapshot = RelayTtySnapshotEnvelopeSchema.safeParse(value); if (!snapshot.success) handlers.onError(transportError('RELAY_TTY_SNAPSHOT_INVALID')); else handlers.onSnapshot(snapshot.data.data, snapshot.data.pendingEscape, snapshot.data.cols, snapshot.data.rows); } else if (value.type === 'tty-output') handlers.onOutput(String(value.data ?? '')); else if (value.type === 'tty-resize') { const body = value.body as any; handlers.onResize(body.cols, body.rows); } else if (value.type === 'tty-exit') handlers.onExit(value.code, value.signal); else if (value.type === 'tty-error') handlers.onError(transportError('RELAY_TTY_FAILED')); else if (value.type === 'tty-closed') { handlers.onClose(); this.tty.delete(value.streamId); } }
  }

  private reset(error: unknown) { this.cancelLeaseRenewal(); this.channelValue?.close(4000, 'reset'); this.channelValue = undefined; this.channel = undefined; for (const pending of this.pending.values()) pending.reject(normalize(error)); this.pending.clear(); for (const handler of this.events) handler.onError(normalize(error)); for (const handler of this.tty.values()) handler.onError(normalize(error)); }
}

function aggregateTransientDemand(events: Iterable<MobileControlPlaneEventHandlers>, topics: Set<string>): AiSessionTransientSubscription | undefined {
  if (![...topics].some((topic) => topic === 'ai.sessions' || topic === '*')) return undefined;
  const selected = [...events].filter((entry) => entry.topics?.some((topic) => topic === 'ai.sessions' || topic === '*'));
  if (selected.some((entry) => !entry.aiSessionTransient)) return undefined;
  const instances = new Set<string>(); const sessions = new Map<string, { instanceId: string; sessionId: string }>();
  let allInstances = false; let timelineAllSessions = false; let replaySince: string | undefined;
  for (const entry of selected) {
    const demand = entry.aiSessionTransient!; allInstances ||= demand.messageDeltas.allInstances; timelineAllSessions ||= demand.timelineAllSessions;
    for (const id of demand.messageDeltas.instanceIds) instances.add(id);
    for (const session of demand.timelineSessions) sessions.set(`${session.instanceId}\0${session.sessionId}`, session);
    if (demand.replaySince && (!replaySince || demand.replaySince < replaySince)) replaySince = demand.replaySince;
  }
  return { ...(replaySince ? { replaySince } : {}), messageDeltas: { allInstances, instanceIds: [...instances] }, timelineAllSessions, timelineSessions: [...sessions.values()] };
}

function normalize(error: unknown) { return error instanceof MobileControlPlaneTransportError ? error : transportError('RELAY_CONNECTION_FAILED', true); }
function transportError(code: string, retryable = false) { return new MobileControlPlaneTransportError(code, 'Cloud Relay connection is unavailable.', retryable); }
