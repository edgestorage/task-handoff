import type { z } from 'zod';
import * as Crypto from 'expo-crypto';
import type { ControlPlanePublicCapabilities } from '@task-handoff/protocol/control-plane-access';
import {
  RelayTtySnapshotEnvelopeSchema,
  RELAY_SESSION_REFRESH_INTERVAL_MS,
  RELAY_SESSION_PROTOCOL_VERSION,
  type OfficialMobileAccountClient as CloudMobileAccountClient,
  type RelayAttachCapability,
  type RelayRoleProof,
  type RelaySelection as CloudRelaySelection,
  type RelaySessionGrant,
} from '@task-handoff/cloud-contracts/mobile';
import type { MobileCloudRelayControlPlaneProfile } from './profile';
import { probeRelayCandidates, RELAY_PROBE_FAST_BUDGET_MS, RELAY_PROBE_FAST_SAMPLES, type RelayProbeTarget } from './relay-prober';
import { selectRelayCandidate, type RelayProbeResult, type RelaySelectionFallback } from './relay-scorer';
import { RelayWinnerCache, type RelayWinnerEntry } from './relay-winner-cache';
import { COMPACT_EVENT_ENVELOPE_VERSION, type AiSessionTransientSubscription } from '@task-handoff/protocol/events';
import { MOBILE_EVENT_KEEPALIVE_INTERVAL_MS, MobileControlPlaneTransportError, mobileEventKeepaliveFrame, normalizeMobileControlPlaneEvent, type MobileAppSessionTtyConnection, type MobileAppSessionTtyHandlers, type MobileControlPlaneEventConnection, type MobileControlPlaneEventHandlers, type MobileControlPlaneTransport } from './transport';
import { createEphemeralRelayProofKey, type RelayProofKeyProvider } from './relay-proof-key';
import type { RelayPendingOperation, RelaySessionStore } from './relay-session-store';

type RelayEnvelope = { type: string; id?: string; status?: number; body?: unknown; event?: any; streamId?: string; data?: unknown; pendingEscape?: unknown; cols?: unknown; rows?: unknown; code?: number | null; signal?: string | null };
export type RelaySessionRenewal = { leaseExpiresAt: string; generation: number; committed: boolean };
export type RelayControlNotice =
  | { type: 'renewed'; sessionId: string; generation: number; committed: boolean; leaseExpiresAt: string }
  | { type: 'peer-detached'; sessionId?: string; retryable?: boolean };
export interface EncryptedRelayChannel {
  readonly leaseExpiresAt?: string;
  readonly generation?: number;
  send(value: RelayEnvelope): void;
  renew?(grant: RelaySessionGrant, proof: RelayRoleProof): Promise<RelaySessionRenewal>;
  subscribe(listener: (value: RelayEnvelope) => void, onClose: (error?: unknown) => void): () => void;
  subscribeControl?(listener: (value: RelayControlNotice) => void): () => void;
  close(code?: number, reason?: string): void;
}
export type RelayChannelFactory = (input: {
  relayUrl: string;
  mode: 'attach' | 'resume';
  grant: RelaySessionGrant;
  proof: RelayRoleProof;
  attach?: RelayAttachCapability;
  targetPublicKeyFingerprint: string;
  epoch: number;
}) => Promise<EncryptedRelayChannel>;

// Grants outlive a single Coordinator request. Renewal happens on the existing
// Relay socket and never replaces the channel, allocation, or frame sequence.
const LEASE_RENEWAL_LEAD_MS = 5_000;
const LEASE_RENEWAL_MINIMUM_MS = 1_000;
const LEASE_RENEWAL_RETRY_MS = 10_000;
const DEFAULT_E2E_REKEY_INTERVAL_MS = 60 * 60_000;
const E2E_REKEY_RETRY_MS = 30_000;
// A bootstrap response contains a fifteen-second selection. A cached confirm is
// useful for much longer because the Coordinator replays a committed result by
// idempotency key even after that selection has expired.
const PENDING_BOOTSTRAP_TTL_MS = 15_000;
const PENDING_CONFIRM_TTL_MS = 5 * 60_000;

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

type ActiveRelaySession = {
  grant: RelaySessionGrant;
  /** Latest generation the Relay acknowledged on the current socket. */
  appliedGeneration: number;
};

type RenewalAttempt = { generation: number; key: string };

export interface RelayTransportOptions {
  /** Injected by tests and by the app so the transport does not reach for platform APIs. */
  winnerCache?: RelayWinnerCache;
  probeRelayCandidates?: typeof probeRelayCandidates;
  allowRelayUrl?: (url: URL) => boolean;
  networkFingerprint?: () => string;
  /** Persistent in production; ephemeral only when a caller supplies no secure store. */
  proofKey?: RelayProofKeyProvider;
  /** Persists the signed grant across app restarts; absent in ephemeral test clients. */
  sessionStore?: RelaySessionStore;
  /** Rotates the E2E socket key without re-running bootstrap or confirm. */
  e2eRekeyIntervalMs?: number;
}

export class RelayControlPlaneTransport implements MobileControlPlaneTransport {
  readonly profile: MobileCloudRelayControlPlaneProfile;
  readonly currentCapabilities: ControlPlanePublicCapabilities | undefined = undefined;
  private channel?: Promise<EncryptedRelayChannel>;
  private channelValue?: EncryptedRelayChannel;
  private session?: ActiveRelaySession;
  private leaseTimer?: ReturnType<typeof setTimeout>;
  private rekeyTimer?: ReturnType<typeof setTimeout>;
  private rekeying?: Promise<void>;
  private keepaliveTimer?: ReturnType<typeof setInterval>;
  private renewalAttempt?: RenewalAttempt;
  private unsubscribeControl?: () => void;
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
  private readonly proofKey: RelayProofKeyProvider;
  private readonly sessionStore: RelaySessionStore | undefined;
  private readonly e2eRekeyIntervalMs: number;
  private sessionRestore?: Promise<void>;
  private sessionStoreChain: Promise<void> = Promise.resolve();
  private memoryPending?: RelayPendingOperation;
  private pendingStoreChain: Promise<void> = Promise.resolve();
  constructor(profile: MobileCloudRelayControlPlaneProfile, private readonly account: CloudMobileAccountClient, private readonly openChannel: RelayChannelFactory, options: RelayTransportOptions = {}) {
    this.profile = profile;
    this.winnerCache = options.winnerCache;
    this.probe = options.probeRelayCandidates ?? probeRelayCandidates;
    this.allowRelayUrl = options.allowRelayUrl;
    this.networkFingerprint = options.networkFingerprint ?? (() => DEFAULT_NETWORK_FINGERPRINT);
    this.proofKey = options.proofKey ?? createEphemeralRelayProofKey();
    this.sessionStore = options.sessionStore;
    this.e2eRekeyIntervalMs = Number.isFinite(options.e2eRekeyIntervalMs) ? Math.max(0, options.e2eRekeyIntervalMs!) : DEFAULT_E2E_REKEY_INTERVAL_MS;
  }

  async request<T>(path: string, schema: z.ZodType<T>, init: RequestInit = {}, _onUploadProgress?: (progress: number) => void) {
    if (!path.startsWith('/') || path.startsWith('//')) throw transportError('RELAY_ROUTE_INVALID');
    const headers = new Headers(init.headers);
    if (headers.has('authorization')) throw transportError('RELAY_AUTH_HEADER_FORBIDDEN');
    const channel = await this.ensureChannel();
    const id = `request_${++this.nextId}`;
    return new Promise<T>((resolve, reject) => {
      const abort = () => {
        try { this.sendOrReset(channel, { type: 'cancel', id }); } catch { /* the failed send already reset pending requests */ }
        this.pending.delete(id);
        reject(transportError('RELAY_REQUEST_CANCELLED'));
      };
      if (init.signal?.aborted) return abort();
      init.signal?.addEventListener('abort', abort, { once: true });
      this.pending.set(id, { resolve, reject, schema, abort: () => init.signal?.removeEventListener('abort', abort) });
      try {
        this.sendOrReset(channel, { type: 'request', id, body: { path, method: init.method ?? 'GET', headers: Object.fromEntries(headers), body: init.body } });
      } catch (error) {
        this.pending.delete(id);
        init.signal?.removeEventListener('abort', abort);
        reject(error);
      }
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
      updateTopics: (topics) => {
        handlers.topics = topics;
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
    this.sendOrReset(channel, {
      type: 'event-subscribe',
      body: {
        eventEnvelopeVersion: COMPACT_EVENT_ENVELOPE_VERSION,
        aiSessionHierarchy: { subagents: true },
        topics: wildcard ? undefined : [...topics].sort(),
        ...MOBILE_RESOURCE_METRIC_SCOPE,
        ...(aiSessionTransient ? { aiSessionTransient } : {}),
      },
    });
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
    const streamId = `tty_${++this.nextId}`;
    this.tty.set(streamId, handlers);
    const input = { instanceId, sessionId };
    this.ttyStreams.set(streamId, input);
    void this.ensureChannel().then((channel) => this.sendOrReset(channel, { type: 'tty-open', streamId, body: input })).catch(handlers.onError);
    return {
      sendInput: (data) => { if (this.channelValue) this.sendOrReset(this.channelValue, { type: 'tty-input', streamId, data }); },
      resize: (cols, rows) => { if (this.channelValue) this.sendOrReset(this.channelValue, { type: 'tty-resize', streamId, body: { cols, rows } }); },
      close: () => {
        if (this.channelValue) this.sendOrReset(this.channelValue, { type: 'tty-close', streamId });
        this.tty.delete(streamId);
        this.ttyStreams.delete(streamId);
      },
    };
  }

  async revalidate() {
    this.reset(transportError('RELAY_NETWORK_CHANGED', true));
    // Callers use revalidate() to reconnect, not to report that the network changed, so
    // the remembered winner survives it. A device that really moved is caught by the
    // network fingerprint inside the cache, and every genuine failure clears it.
    await this.ensureChannel();
  }

  private ensureChannel() {
    if (this.channel) return this.channel;
    this.channel = this.establishChannel().catch((error) => {
      this.channel = undefined;
      throw normalize(error);
    });
    return this.channel;
  }

  private async establishChannel(allowCachedWinner = true): Promise<EncryptedRelayChannel> {
    await this.restorePersistedSession();
    if (this.session) {
      try {
        return await this.resumeSession(this.session);
      } catch (error) {
        // A transient network failure is not a reason to burn two Coordinator
        // requests and an allocation. Only an authoritative resume rejection
        // falls back to a fresh bootstrap + confirm.
        if (!terminalResumeFailure(error)) throw error;
        this.clearSession();
      }
    }
    try {
      return await this.runSelection(allowCachedWinner);
    } catch (error) {
      // "Reuse the winner until it stops working": a failed attempt is that evidence, so
      // the next connection measures again instead of trusting the cache.
      await this.winnerCache?.clear(this.profile.identity.controlPlaneId);
      throw error;
    }
  }

  private async resumeSession(session: ActiveRelaySession) {
    if (Date.parse(session.grant.expiresAt) <= Date.now()) {
      this.clearSession();
      throw transportError('RELAY_SESSION_EXPIRED', false);
    }
    const proof = await this.proofKey.proof(session.grant);
    const channel = await this.openChannel({
      relayUrl: session.grant.relayUrl,
      mode: 'resume',
      grant: session.grant,
      proof,
      targetPublicKeyFingerprint: this.profile.identity.publicKeyFingerprint,
      epoch: ++this.epoch,
    });
    if (this.session !== session) {
      channel.close(1000, 'session-replaced');
      throw transportError('RELAY_SESSION_REPLACED', true);
    }
    this.installChannel(channel, { grant: session.grant, appliedGeneration: channel.generation ?? session.appliedGeneration });
    return channel;
  }

  private async runSelection(allowCachedWinner: boolean, freshRetry = false): Promise<EncryptedRelayChannel> {
    const controlPlaneId = this.profile.identity.controlPlaneId;
    const networkFingerprint = this.networkFingerprint();
    const cached = allowCachedWinner ? await this.winnerCache?.read(controlPlaneId, networkFingerprint) : undefined;
    const pending = await this.loadPendingOperation();
    if (pending?.type === 'confirm') {
      let confirmed;
      try {
        confirmed = await this.account.confirmRelaySession(pending.selectionId, pending.body, pending.key);
      } catch (error) {
        if (!pendingOperationRetryable(error)) await this.clearPendingOperation();
        throw error;
      }
      await this.clearPendingOperation();
      return this.completeConfirmedSelection(controlPlaneId, confirmed, cached, undefined, undefined, allowCachedWinner);
    }

    const clientProofPublicKey = await this.proofKey.publicKey();
    let bootstrapOperation = pending?.type === 'bootstrap' ? pending : undefined;
    if (bootstrapOperation && bootstrapOperation.body.clientProofPublicKey !== clientProofPublicKey) {
      await this.clearPendingOperation();
      bootstrapOperation = undefined;
    }
    if (!bootstrapOperation) {
      bootstrapOperation = {
        type: 'bootstrap',
        key: idempotencyKey('bootstrap'),
        body: {
          controlPlaneId,
          trafficClasses: ['interactive', 'stream'],
          trafficClass: 'interactive',
          maxCandidates: RELAY_CANDIDATE_COUNT,
          clientProofPublicKey,
          ...(cached ? { preferredRelayId: cached.relayId } : {}),
        },
        createdAt: Date.now(),
      };
      await this.savePendingOperation(bootstrapOperation);
    }

    let bootstrap;
    try {
      bootstrap = await this.account.bootstrapRelaySession(bootstrapOperation.body, bootstrapOperation.key);
    } catch (error) {
      if (!pendingOperationRetryable(error)) await this.clearPendingOperation();
      throw error;
    }
    const ticket = bootstrap.relayTicket;
    if (bootstrap.clientProofPublicKey !== clientProofPublicKey || ticket.clientProofPublicKey !== clientProofPublicKey
      || ticket.targetPublicKeyFingerprint !== this.profile.identity.publicKeyFingerprint
      || ticket.bindingId !== this.profile.access.bindingId
      || ticket.bindingRevision !== this.profile.access.bindingRevision
      || ticket.controlPlaneId !== controlPlaneId) {
      throw transportError('RELAY_TARGET_IDENTITY_CHANGED');
    }

    const selection = bootstrap.selection;
    if (Date.parse(selection.expiresAt) <= Date.now()) {
      await this.clearPendingOperation();
      if (!freshRetry) return this.runSelection(false, true);
      throw transportError('RELAY_SELECTION_EXPIRED', true);
    }
    const winner = await this.chooseWinner(selection, cached, networkFingerprint);
    const confirmOperation: RelayPendingOperation = {
      type: 'confirm',
      selectionId: selection.selectionId,
      key: idempotencyKey('confirm'),
      body: winner.confirmation,
      createdAt: Date.now(),
    };
    await this.savePendingOperation(confirmOperation);
    let confirmed;
    try {
      confirmed = await this.account.confirmRelaySession(confirmOperation.selectionId, confirmOperation.body, confirmOperation.key);
    } catch (error) {
      if (!pendingOperationRetryable(error)) await this.clearPendingOperation();
      if (pendingOperationSelectionExpired(error) && !freshRetry) {
        await this.clearPendingOperation();
        return this.runSelection(false, true);
      }
      throw error;
    }
    await this.clearPendingOperation();
    return this.completeConfirmedSelection(controlPlaneId, confirmed, cached, winner.relayId, winner.measurements, allowCachedWinner);
  }

  private async completeConfirmedSelection(
    controlPlaneId: string,
    confirmed: Awaited<ReturnType<CloudMobileAccountClient['confirmRelaySession']>>,
    cached: RelayWinnerEntry | undefined,
    winnerRelayId: string | undefined,
    measurements: RelayProbeResult[] | undefined,
    allowCachedWinner: boolean,
  ): Promise<EncryptedRelayChannel> {
    const expectedRelayId = winnerRelayId ?? cached?.relayId;
    if (confirmed.substituted || (expectedRelayId && confirmed.relayId !== expectedRelayId)) {
      // The Coordinator had to book something other than what was asked for, so the
      // cached winner is stale information rather than a fact about this network.
      await this.winnerCache?.clear(controlPlaneId);
    }
    this.verifyConfirmedGrant(confirmed, await this.proofKey.publicKey());
    const session: ActiveRelaySession = { grant: confirmed.grant, appliedGeneration: 0 };
    // Publish the confirmed session before the first socket attempt so a lost
    // attach reply can be retried with `session-attach` instead of allocating a
    // second Relay session. The Control Plane half is already attached by now.
    this.session = session;
    await this.persistSession(confirmed.grant);
    try {
      const proof = await this.proofKey.proof(confirmed.grant);
      const channel = await this.openChannel({
        relayUrl: confirmed.relayUrl,
        mode: 'attach',
        grant: confirmed.grant,
        proof,
        attach: confirmed.clientAttach,
        targetPublicKeyFingerprint: this.profile.identity.publicKeyFingerprint,
        epoch: ++this.epoch,
      });
      session.appliedGeneration = channel.generation ?? confirmed.grant.generation;
      this.installChannel(channel, session);
      if (measurements) await this.rememberWinner(controlPlaneId, confirmed, measurements, this.networkFingerprint(), cached);
      return channel;
    } catch (error) {
      // A cached winner that just failed should be remeasured, but an ordinary
      // first-attach failure keeps the grant for the next in-place resume.
      if (allowCachedWinner && cached) {
        this.clearSession();
        return this.establishChannel(false);
      }
      throw error;
    }
  }

  private verifyConfirmedGrant(confirmed: { allocationId: string; relayId: string; relayUrl: string; grant: RelaySessionGrant }, clientProofPublicKey: string) {
    const grant = confirmed.grant;
    const ticket = grant.sessionTranscriptTicket;
    const relayUrl = new URL(grant.relayUrl).href;
    if (grant.protocolVersion !== RELAY_SESSION_PROTOCOL_VERSION || ticket.protocolVersion !== RELAY_SESSION_PROTOCOL_VERSION
      || grant.allocationId !== confirmed.allocationId || grant.relayId !== confirmed.relayId || relayUrl !== new URL(confirmed.relayUrl).href
      || grant.controlPlaneId !== this.profile.identity.controlPlaneId
      || grant.bindingId !== this.profile.access.bindingId
      || grant.bindingRevision !== this.profile.access.bindingRevision
      || grant.targetPublicKeyFingerprint !== this.profile.identity.publicKeyFingerprint
      || grant.clientProofPublicKey !== clientProofPublicKey
      || ticket.controlPlaneId !== grant.controlPlaneId
      || ticket.bindingId !== grant.bindingId
      || ticket.bindingRevision !== grant.bindingRevision
      || ticket.targetPublicKeyFingerprint !== grant.targetPublicKeyFingerprint
      || Date.parse(grant.expiresAt) <= Date.now()) {
      throw transportError('RELAY_GRANT_AUTHORITY_INVALID');
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

  private installChannel(channel: EncryptedRelayChannel, session: ActiveRelaySession) {
    const previous = this.channelValue;
    this.unsubscribeControl?.();
    this.channelValue = channel;
    this.channel = Promise.resolve(channel);
    this.session = session;
    channel.subscribe((value) => this.receive(value), (error) => this.channelClosed(channel, error));
    this.unsubscribeControl = channel.subscribeControl?.((notice) => this.receiveControl(channel, notice));
    // A rotated or resumed channel starts empty: replay the demand the previous
    // transport carried without re-running the domain bootstrap.
    if (previous || this.events.size) {
      if (this.events.size) this.sendEventSubscription(channel);
      for (const [streamId, input] of this.ttyStreams) this.sendOrReset(channel, { type: 'tty-open', streamId, body: input });
    }
    this.scheduleLeaseRenewal(channel);
    this.scheduleE2eRekey(channel);
  }

  private scheduleE2eRekey(channel: EncryptedRelayChannel) {
    this.cancelE2eRekey();
    if (!(this.e2eRekeyIntervalMs > 0) || this.channelValue !== channel || !this.session) return;
    const timer = setTimeout(() => { this.rekeyTimer = undefined; void this.rekeyChannel(channel); }, this.e2eRekeyIntervalMs);
    (timer as unknown as { unref?(): void }).unref?.();
    this.rekeyTimer = timer;
  }

  private cancelE2eRekey() {
    if (this.rekeyTimer) clearTimeout(this.rekeyTimer);
    this.rekeyTimer = undefined;
  }

  /**
   * A controlled rekey is a fast resume, not a reauthorization. The old channel
   * remains active until the replacement has attached, so a transient failure
   * never creates a user-visible gap.
   */
  private async rekeyChannel(current: EncryptedRelayChannel) {
    if (this.rekeying || this.channelValue !== current || !this.session) return;
    const session = this.session;
    this.rekeying = (async () => {
      try {
        const channel = await this.openChannel({
          relayUrl: session.grant.relayUrl,
          mode: 'resume',
          grant: session.grant,
          proof: await this.proofKey.proof(session.grant),
          targetPublicKeyFingerprint: this.profile.identity.publicKeyFingerprint,
          epoch: ++this.epoch,
        });
        if (this.channelValue !== current || this.session !== session) {
          channel.close(1000, 'session-replaced');
          return;
        }
        this.installChannel(channel, session);
        current.close(1000, 'e2e-rekey');
      } catch {
        if (this.channelValue === current) this.scheduleE2eRekeyRetry(current);
      }
    })().finally(() => { this.rekeying = undefined; });
    return this.rekeying;
  }

  private scheduleE2eRekeyRetry(channel: EncryptedRelayChannel) {
    this.cancelE2eRekey();
    if (!(this.e2eRekeyIntervalMs > 0) || this.channelValue !== channel) return;
    const delay = Math.min(E2E_REKEY_RETRY_MS, this.e2eRekeyIntervalMs);
    const timer = setTimeout(() => { this.rekeyTimer = undefined; void this.rekeyChannel(channel); }, delay);
    (timer as unknown as { unref?(): void }).unref?.();
    this.rekeyTimer = timer;
  }

  private receiveControl(channel: EncryptedRelayChannel, notice: RelayControlNotice) {
    if (this.channelValue !== channel) return;
    if (notice.type === 'peer-detached') {
      this.channelClosed(channel, transportError('RELAY_PEER_DETACHED', true));
      return;
    }
    const session = this.session;
    if (!session || notice.sessionId !== session.grant.sessionId || notice.generation < session.grant.generation) return;
    if (notice.committed) {
      session.appliedGeneration = Math.max(session.appliedGeneration, notice.generation);
      this.scheduleLeaseRenewal(channel);
    }
  }

  private sendOrReset(channel: EncryptedRelayChannel, value: RelayEnvelope) {
    try { channel.send(value); }
    catch (error) { this.channelClosed(channel, error); throw error; }
  }

  private channelClosed(channel: EncryptedRelayChannel, error?: unknown) {
    // A rotated channel closes on its own schedule; only the active one resets the transport.
    if (this.channelValue !== channel) return;
    // The grant survives a socket close; the next request resumes it in place.
    this.reset(error ?? transportError('RELAY_CHANNEL_CLOSED', true));
  }

  private scheduleLeaseRenewal(channel: EncryptedRelayChannel) {
    this.cancelLeaseRenewal();
    const issuedAt = this.session ? Date.parse(this.session.grant.issuedAt) : Number.NaN;
    const expiresAt = channel.leaseExpiresAt ? Date.parse(channel.leaseExpiresAt) : Number.NaN;
    const refreshAt = Number.isFinite(issuedAt) ? issuedAt + RELAY_SESSION_REFRESH_INTERVAL_MS : Number.POSITIVE_INFINITY;
    const expiryGuardAt = Number.isFinite(expiresAt) ? expiresAt - LEASE_RENEWAL_LEAD_MS : Number.POSITIVE_INFINITY;
    const renewAt = Math.min(refreshAt, expiryGuardAt);
    if (!Number.isFinite(renewAt)) return;
    const delay = Math.max(LEASE_RENEWAL_MINIMUM_MS, renewAt - Date.now());
    const timer = setTimeout(() => { this.leaseTimer = undefined; void this.renewLease(channel); }, delay);
    (timer as unknown as { unref?(): void }).unref?.();
    this.leaseTimer = timer;
  }

  private scheduleRenewalRetry(channel: EncryptedRelayChannel) {
    this.cancelLeaseRenewal();
    if (this.channelValue !== channel) return;
    const timer = setTimeout(() => { this.leaseTimer = undefined; void this.renewLease(channel); }, LEASE_RENEWAL_RETRY_MS);
    (timer as unknown as { unref?(): void }).unref?.();
    this.leaseTimer = timer;
  }

  private cancelLeaseRenewal() {
    if (this.leaseTimer) clearTimeout(this.leaseTimer);
    this.leaseTimer = undefined;
  }

  private async renewLease(current: EncryptedRelayChannel) {
    if (this.channelValue !== current || !this.session) return;
    if (Date.parse(this.session.grant.expiresAt) <= Date.now()) {
      this.clearSession();
      return;
    }

    // The Coordinator may have issued the next generation while the socket was
    // briefly unable to carry the control reply. Push that same grant before
    // asking for yet another generation.
    if (this.session.appliedGeneration < this.session.grant.generation) {
      if (await this.pushGrant(current, this.session.grant)) this.scheduleLeaseRenewal(current);
      else this.scheduleRenewalRetry(current);
      return;
    }

    let next: RelaySessionGrant;
    try {
      next = await this.renewCoordinatorGrant(this.session.grant);
    } catch {
      // A failed renewal deliberately leaves the current channel intact. It can
      // keep carrying requests until the Relay closes it at grant expiry.
      this.scheduleRenewalRetry(current);
      return;
    }
    if (this.channelValue !== current || !this.session) return;
    this.session.grant = next;
    await this.persistSession(next);
    if (await this.pushGrant(current, next)) this.scheduleLeaseRenewal(current);
    else this.scheduleRenewalRetry(current);
  }

  private async renewCoordinatorGrant(current: RelaySessionGrant) {
    if (!this.renewalAttempt || this.renewalAttempt.generation !== current.generation) {
      this.renewalAttempt = { generation: current.generation, key: idempotencyKey('renew') };
    }
    const attempt = this.renewalAttempt;
    const response = await this.account.renewRelaySession(current.sessionId, { expectedGeneration: current.generation }, attempt.key);
    const grant = response.grant;
    const ticket = grant.sessionTranscriptTicket;
    if (grant.protocolVersion !== RELAY_SESSION_PROTOCOL_VERSION || ticket.protocolVersion !== RELAY_SESSION_PROTOCOL_VERSION
      || grant.sessionId !== current.sessionId || grant.generation <= current.generation
      || grant.allocationId !== current.allocationId || grant.relayId !== current.relayId || grant.relayUrl !== current.relayUrl
      || grant.controlPlaneId !== current.controlPlaneId || grant.bindingId !== current.bindingId
      || grant.bindingRevision !== current.bindingRevision || grant.targetPublicKeyFingerprint !== current.targetPublicKeyFingerprint
      || grant.clientProofPublicKey !== current.clientProofPublicKey
      || ticket.controlPlaneId !== grant.controlPlaneId || ticket.bindingId !== grant.bindingId
      || ticket.bindingRevision !== grant.bindingRevision || Date.parse(grant.expiresAt) <= Date.now()) {
      throw transportError('RELAY_GRANT_AUTHORITY_INVALID');
    }
    if (this.renewalAttempt === attempt) this.renewalAttempt = undefined;
    return grant;
  }

  private async pushGrant(channel: EncryptedRelayChannel, grant: RelaySessionGrant) {
    if (!channel.renew || this.channelValue !== channel || !this.session) return false;
    try {
      const result = await channel.renew(grant, await this.proofKey.proof(grant));
      if (this.channelValue !== channel || !this.session) return false;
      if (result.generation !== grant.generation) throw transportError('RELAY_SESSION_GENERATION_CONFLICT');
      if (result.committed) this.session.appliedGeneration = Math.max(this.session.appliedGeneration, result.generation);
      return result.committed;
    } catch {
      return false;
    }
  }

  private receive(value: RelayEnvelope) {
    if (value.type === 'response' && value.id) {
      const pending = this.pending.get(value.id);
      if (!pending) return;
      this.pending.delete(value.id);
      pending.abort?.();
      if ((value.status ?? 500) >= 400) pending.reject(new MobileControlPlaneTransportError('RELAY_CONTROL_PLANE_RESPONSE_FAILED', 'Control Plane request failed.', false, value.status));
      else {
        const parsed = pending.schema.safeParse(value.body);
        if (parsed.success) pending.resolve(parsed.data);
        else pending.reject(transportError('RELAY_RESPONSE_SCHEMA_INVALID'));
      }
      return;
    }
    if (value.type === 'event' && value.event) {
      const event = normalizeMobileControlPlaneEvent(value.event);
      if (!event) return this.reset(transportError('RELAY_EVENT_INVALID'));
      for (const handlers of this.events) handlers.onEvent(event);
      return;
    }
    if (value.streamId && this.tty.has(value.streamId)) {
      const handlers = this.tty.get(value.streamId)!;
      if (value.type === 'tty-opened') handlers.onOpen();
      else if (value.type === 'tty-snapshot') {
        const snapshot = RelayTtySnapshotEnvelopeSchema.safeParse(value);
        if (!snapshot.success) handlers.onError(transportError('RELAY_TTY_SNAPSHOT_INVALID'));
        else handlers.onSnapshot(snapshot.data.data, snapshot.data.pendingEscape, snapshot.data.cols, snapshot.data.rows);
      } else if (value.type === 'tty-output') handlers.onOutput(String(value.data ?? ''));
      else if (value.type === 'tty-resize') {
        const body = value.body as any;
        handlers.onResize(body.cols, body.rows);
      } else if (value.type === 'tty-exit') handlers.onExit(value.code, value.signal);
      else if (value.type === 'tty-error') handlers.onError(transportError('RELAY_TTY_FAILED'));
      else if (value.type === 'tty-closed') {
        handlers.onClose();
        this.tty.delete(value.streamId);
      }
    }
  }

  private reset(error: unknown) {
    this.cancelLeaseRenewal();
    this.cancelE2eRekey();
    this.unsubscribeControl?.();
    this.unsubscribeControl = undefined;
    this.channelValue?.close(4000, 'reset');
    this.channelValue = undefined;
    this.channel = undefined;
    for (const pending of this.pending.values()) pending.reject(normalize(error));
    this.pending.clear();
    for (const handler of this.events) handler.onError(normalize(error));
    for (const handler of this.tty.values()) handler.onError(normalize(error));
  }

  private clearSession() {
    this.session = undefined;
    this.renewalAttempt = undefined;
    void this.persistSession(undefined);
  }

  private async restorePersistedSession() {
    if (this.session || !this.sessionStore) return;
    this.sessionRestore ??= (async () => {
      const grant = await this.sessionStore!.load().catch(() => undefined);
      if (!grant || !(await this.usablePersistedGrant(grant))) {
        if (grant) await this.persistSession(undefined);
        return;
      }
      this.session = { grant, appliedGeneration: grant.generation };
    })();
    await this.sessionRestore;
  }

  private async usablePersistedGrant(grant: RelaySessionGrant) {
    const ticket = grant.sessionTranscriptTicket;
    return grant.protocolVersion === RELAY_SESSION_PROTOCOL_VERSION
      && ticket.protocolVersion === RELAY_SESSION_PROTOCOL_VERSION
      && Date.parse(grant.expiresAt) > Date.now()
      && grant.controlPlaneId === this.profile.identity.controlPlaneId
      && grant.bindingId === this.profile.access.bindingId
      && grant.bindingRevision === this.profile.access.bindingRevision
      && grant.targetPublicKeyFingerprint === this.profile.identity.publicKeyFingerprint
      && ticket.controlPlaneId === grant.controlPlaneId
      && ticket.bindingId === grant.bindingId
      && ticket.bindingRevision === grant.bindingRevision
      && ticket.targetPublicKeyFingerprint === grant.targetPublicKeyFingerprint
      && grant.clientProofPublicKey === await this.proofKey.publicKey();
  }

  private async loadPendingOperation(): Promise<RelayPendingOperation | undefined> {
    const stored = await this.sessionStore?.loadPending?.().catch(() => undefined);
    if (stored) {
      if (pendingOperationExpired(stored)) {
        await this.clearPendingOperation();
        return undefined;
      }
      this.memoryPending = stored;
      return stored;
    }
    if (!this.memoryPending) return undefined;
    if (pendingOperationExpired(this.memoryPending)) {
      await this.clearPendingOperation();
      return undefined;
    }
    return this.memoryPending;
  }

  private savePendingOperation(operation: RelayPendingOperation) {
    this.memoryPending = operation;
    if (!this.sessionStore?.savePending) return Promise.resolve();
    this.pendingStoreChain = this.pendingStoreChain.catch(() => undefined)
      .then(() => this.sessionStore!.savePending!(operation))
      .catch(() => undefined);
    return this.pendingStoreChain;
  }

  private clearPendingOperation() {
    this.memoryPending = undefined;
    if (!this.sessionStore?.clearPending) return Promise.resolve();
    this.pendingStoreChain = this.pendingStoreChain.catch(() => undefined)
      .then(() => this.sessionStore!.clearPending!())
      .catch(() => undefined);
    return this.pendingStoreChain;
  }

  private persistSession(grant: RelaySessionGrant | undefined) {
    if (!this.sessionStore) return Promise.resolve();
    const operation = grant ? () => this.sessionStore!.save(grant) : () => this.sessionStore!.clear();
    this.sessionStoreChain = this.sessionStoreChain.catch(() => undefined).then(operation).catch(() => undefined);
    return this.sessionStoreChain;
  }
}

function aggregateTransientDemand(events: Iterable<MobileControlPlaneEventHandlers>, topics: Set<string>): AiSessionTransientSubscription | undefined {
  if (![...topics].some((topic) => topic === 'ai.sessions' || topic === '*')) return undefined;
  const selected = [...events].filter((entry) => entry.topics?.some((topic) => topic === 'ai.sessions' || topic === '*'));
  if (selected.some((entry) => !entry.aiSessionTransient)) return undefined;
  const instances = new Set<string>();
  const sessions = new Map<string, { instanceId: string; sessionId: string }>();
  let allInstances = false;
  let timelineAllSessions = false;
  let replaySince: string | undefined;
  for (const entry of selected) {
    const demand = entry.aiSessionTransient!;
    allInstances ||= demand.messageDeltas.allInstances;
    timelineAllSessions ||= demand.timelineAllSessions;
    for (const id of demand.messageDeltas.instanceIds) instances.add(id);
    for (const session of demand.timelineSessions) sessions.set(`${session.instanceId}\0${session.sessionId}`, session);
    if (demand.replaySince && (!replaySince || demand.replaySince < replaySince)) replaySince = demand.replaySince;
  }
  return { ...(replaySince ? { replaySince } : {}), messageDeltas: { allInstances, instanceIds: [...instances] }, timelineAllSessions, timelineSessions: [...sessions.values()] };
}

function idempotencyKey(operation: 'bootstrap' | 'confirm' | 'renew') {
  const random = new Uint8Array(24);
  Crypto.getRandomValues(random);
  let binary = '';
  for (const byte of random) binary += String.fromCharCode(byte);
  return `relay_${operation}_${btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')}`;
}

function pendingOperationExpired(operation: RelayPendingOperation) {
  const ttl = operation.type === 'bootstrap' ? PENDING_BOOTSTRAP_TTL_MS : PENDING_CONFIRM_TTL_MS;
  return operation.createdAt + ttl <= Date.now();
}

function pendingOperationRetryable(error: unknown) {
  if (error instanceof MobileControlPlaneTransportError) return error.retryable;
  const code = String((error as { code?: unknown } | null)?.code ?? '');
  if ([
    'IDEMPOTENCY_KEY_REUSED',
    'IDEMPOTENCY_KEY_REQUIRED',
    'IDEMPOTENCY_KEY_INVALID',
    'RELAY_SESSION_RESUME_NOT_READY',
    'RELAY_SELECTION_EXPIRED',
    'RELAY_SELECTION_NOT_FOUND',
    'RELAY_SELECTION_MISMATCH',
    'RELAY_ALLOCATION_AUTHORITY_INVALID',
    'RELAY_SESSION_GRANT_INVALID',
  ].includes(code)) return false;
  const status = Number((error as { status?: unknown } | null)?.status);
  if (Number.isFinite(status)) return status >= 500 || [408, 409, 425, 429].includes(status);
  // A reset, timeout, or a response lost after the server committed is
  // ambiguous, so the pending operation must remain replayable.
  return true;
}

function pendingOperationSelectionExpired(error: unknown) {
  const code = String((error as { code?: unknown } | null)?.code ?? '');
  return code === 'RELAY_SELECTION_EXPIRED' || code === 'RELAY_SELECTION_NOT_FOUND';
}

function terminalResumeFailure(error: unknown) {
  const code = String((error as { code?: unknown } | null)?.code ?? '');
  return [
    'RELAY_SESSION_NOT_FOUND',
    'RELAY_SESSION_REVOKED',
    'RELAY_SESSION_EXPIRED',
    'RELAY_SESSION_GRANT_INVALID',
    'RELAY_SESSION_ROLE_MISMATCH',
    'RELAY_SESSION_PROOF_INVALID',
    'RELAY_SESSION_REPLAYED',
    'RELAY_SESSION_GENERATION_STALE',
    'RELAY_SESSION_GENERATION_CONFLICT',
    'RELAY_ALLOCATION_MISMATCH',
  ].includes(code);
}

function normalize(error: unknown) {
  if (error instanceof MobileControlPlaneTransportError) return error;
  const code = typeof (error as { code?: unknown } | null)?.code === 'string' ? String((error as { code: string }).code) : undefined;
  const status = Number((error as { status?: unknown } | null)?.status);
  const message = error instanceof Error ? error.message : 'Cloud Relay connection is unavailable.';
  if (code) return new MobileControlPlaneTransportError(code, message, !Number.isFinite(status) || status >= 500 || status === 409, Number.isFinite(status) ? status : undefined);
  return new MobileControlPlaneTransportError('RELAY_CONNECTION_FAILED', 'Cloud Relay connection is unavailable.', true);
}

function transportError(code: string, retryable = false) {
  return new MobileControlPlaneTransportError(code, 'Cloud Relay connection is unavailable.', retryable);
}
