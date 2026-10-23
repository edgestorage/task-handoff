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
import { RELAY_BODY_CHUNK_BYTES, RelayBinaryResponseSchema, type RelayBodyFrame } from '@task-handoff/protocol/relay-body';
import { MOBILE_CONTROL_PLANE_CLOSED_MESSAGE, MOBILE_EVENT_KEEPALIVE_INTERVAL_MS, MobileControlPlaneTransportError, mobileEventKeepaliveFrame, normalizeMobileControlPlaneEvent, type MobileAppSessionTtyConnection, type MobileAppSessionTtyHandlers, type MobileControlPlaneEventConnection, type MobileControlPlaneEventHandlers, type MobileControlPlaneTransport } from './transport';
import { createEphemeralRelayProofKey, type RelayProofKeyProvider } from './relay-proof-key';
import type { RelayPendingOperation, RelaySessionStore } from './relay-session-store';
import { diagnosticErrorDetails, diagnosticLog } from '../observability/diagnostic-logs';

type RelayEnvelope = { type: string; id?: string; status?: number; body?: unknown; binaryResponse?: unknown; bodyId?: number; responseId?: number; offset?: number; bytes?: Uint8Array; final?: boolean; event?: any; streamId?: string; data?: unknown; pendingEscape?: unknown; cols?: unknown; rows?: unknown; code?: number | null; signal?: string | null };
export type RelaySessionRenewal = { leaseExpiresAt: string; generation: number; committed: boolean };
export type RelayControlNotice =
  | { type: 'renewed'; sessionId: string; generation: number; committed: boolean; leaseExpiresAt: string }
  | { type: 'peer-detached'; sessionId?: string; retryable?: boolean }
  | { type: 'session-closed'; sessionId: string; code: string; retryable: boolean };
export interface EncryptedRelayChannel {
  readonly leaseExpiresAt?: string;
  readonly generation?: number;
  send(value: RelayEnvelope): void;
  sendBody(frame: RelayBodyFrame): void;
  renew?(grant: RelaySessionGrant, proof: RelayRoleProof): Promise<RelaySessionRenewal>;
  subscribe(listener: (value: RelayEnvelope) => void, onClose: (error?: unknown) => void): () => void;
  subscribeControl?(listener: (value: RelayControlNotice) => void): () => void;
  close(code?: number, reason?: string): void;
}
export type RelayChannelFactory = (input: {
  attemptId?: string;
  relayUrl: string;
  mode: 'attach' | 'resume';
  grant: RelaySessionGrant;
  proof: RelayRoleProof;
  attach?: RelayAttachCapability;
  targetPublicKeyFingerprint: string;
  epoch: number;
  signal?: AbortSignal;
}) => Promise<EncryptedRelayChannel>;

type RelayAttempt = {
  controller: AbortController;
  detachSignal?: () => void;
};

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
// Binary uploads keep four 256 KiB chunks in flight: 1 MiB of unacknowledged
// bytes stays well under the 2 MiB socket backpressure limit while still
// hiding one round trip behind the next chunk on mobile networks.
const RELAY_UPLOAD_WINDOW_CHUNKS = 4;
// The window is shared by every concurrent upload on the channel. Without the
// shared cap, selecting several attachments at once could put 4 MiB or more in
// flight and trip the socket backpressure guard, resetting every request.
const RELAY_UPLOAD_GLOBAL_WINDOW_BYTES = RELAY_UPLOAD_WINDOW_CHUNKS * RELAY_BODY_CHUNK_BYTES;
const RELAY_UPLOAD_STALL_TIMEOUT_MS = 15_000;
const RELAY_DOWNLOAD_IDLE_TIMEOUT_MS = 60_000;
// The client has already reattached successfully when this fires; the missing
// half is the Control Plane's E2E handshake on a stale allocation. Retrying the
// same Relay forever cannot repair that pair, so a fresh selection is required.
const DEFAULT_MAX_E2E_HANDSHAKE_TIMEOUTS = 2;
// A stale in-memory grant can fail before the Relay has a session to reject.
// After this many consecutive transport failures, stop spending attempts on it
// and let selection obtain a fresh allocation.
const DEFAULT_MAX_RESUME_FAILURES = 3;

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
type PendingRelayUpload = {
  requestId: string;
  channel: EncryptedRelayChannel;
  bodyId: number;
  data: Uint8Array;
  size: number;
  /** Cumulative bytes the Control Plane acknowledged; this is the flow-control cursor. */
  acked: number;
  nextOffset: number;
  final: boolean;
  finished: boolean;
  timer?: ReturnType<typeof setTimeout>;
  onProgress?: (progress: number) => void;
};
type PendingRelayDownload = {
  requestId: string;
  responseId: number;
  size: number;
  received: number;
  data: Uint8Array;
  contentType?: string;
  filename?: string;
  timer?: ReturnType<typeof setTimeout>;
};
type PendingRelayRequest = {
  requestId: string;
  resolve(value: unknown): void;
  reject(error: unknown): void;
  schema?: z.ZodType<any>;
  abort?: () => void;
  upload?: PendingRelayUpload;
  download?: PendingRelayDownload;
  method: string;
  path: string;
  bodyBytes: number;
  bodyEncoding: 'none' | 'utf8' | 'binary';
  binary: boolean;
  responseBinary: boolean;
  startedAt: number;
};
type EncodedRelayRequestBody = { value: unknown; data?: Uint8Array; bytes: number; encoding: PendingRelayRequest['bodyEncoding']; binary: boolean };

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
  /** Consecutive E2E handshake timeouts before abandoning the allocation and reselecting. */
  maxE2eHandshakeTimeouts?: number;
  /** Consecutive resume transport failures before abandoning a stale grant. */
  maxResumeFailures?: number;
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
  private rekeyAbort?: AbortController;
  private keepaliveTimer?: ReturnType<typeof setInterval>;
  private renewalAttempt?: RenewalAttempt;
  private unsubscribeControl?: () => void;
  private attempt?: RelayAttempt;
  private epoch = 0;
  private nextId = 0;
  private nextBodyId = 0;
  private nextAttemptId = 0;
  private readonly pending = new Map<string, PendingRelayRequest>();
  private readonly uploadByBodyId = new Map<number, string>();
  private readonly downloadByResponseId = new Map<number, string>();
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
  private readonly maxE2eHandshakeTimeouts: number;
  private readonly maxResumeFailures: number;
  private e2eHandshakeTimeouts = 0;
  private resumeFailures = 0;
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
    this.maxE2eHandshakeTimeouts = Number.isFinite(options.maxE2eHandshakeTimeouts)
      ? Math.max(1, Math.floor(options.maxE2eHandshakeTimeouts!))
      : DEFAULT_MAX_E2E_HANDSHAKE_TIMEOUTS;
    this.maxResumeFailures = Number.isFinite(options.maxResumeFailures)
      ? Math.max(1, Math.floor(options.maxResumeFailures!))
      : DEFAULT_MAX_RESUME_FAILURES;
  }

  async request<T>(path: string, schema: z.ZodType<T>, init: RequestInit = {}, onUploadProgress?: (progress: number) => void) {
    return await this.performRequest(path, init, { schema, onUploadProgress, responseBinary: false }) as T;
  }

  async requestBinary(path: string, init: RequestInit = {}): Promise<{ body: Uint8Array; filename?: string; contentType?: string }> {
    return await this.performRequest(path, init, { responseBinary: true }) as { body: Uint8Array; filename?: string; contentType?: string };
  }

  private async performRequest(
    path: string,
    init: RequestInit,
    options: { schema?: z.ZodType<any>; onUploadProgress?: (progress: number) => void; responseBinary: boolean },
  ): Promise<unknown> {
    if (!path.startsWith('/') || path.startsWith('//')) throw transportError('RELAY_ROUTE_INVALID');
    const body = encodeRelayRequestBody(init.body);
    const headers = new Headers(init.headers);
    if (headers.has('authorization')) throw transportError('RELAY_AUTH_HEADER_FORBIDDEN');
    if (options.responseBinary) {
      headers.set('accept', 'application/octet-stream, */*');
      headers.set('accept-encoding', 'identity');
    }
    const channel = await this.ensureChannel();
    const id = `request_${++this.nextId}`;
    const details = { method: init.method ?? 'GET', path: relayRequestPath(path), bodyBytes: body.bytes, bodyEncoding: body.encoding, binary: body.binary, responseBinary: options.responseBinary, startedAt: Date.now() };
    return new Promise((resolve, reject) => {
      const abort = () => {
        const pending = this.pending.get(id);
        if (pending) {
          this.stopUpload(pending);
          this.stopDownload(pending);
        }
        try { this.sendOrReset(channel, { type: 'cancel', id }); } catch { /* the failed send already reset pending requests */ }
        this.pending.delete(id);
        diagnosticLog.warn('relay.request.cancelled', requestLogDetails(details, 'cancelled'));
        reject(transportError('RELAY_REQUEST_CANCELLED'));
      };
      if (init.signal?.aborted) return abort();
      init.signal?.addEventListener('abort', abort, { once: true });
      const pending: PendingRelayRequest = { requestId: id, resolve, reject, schema: options.schema, abort: () => init.signal?.removeEventListener('abort', abort), ...details };
      this.pending.set(id, pending);
      try {
        if (body.binary) {
          // Binary bodies travel as chunk frames; the request envelope carries
          // only the metadata plus the body id the frames refer to.
          this.startBinaryUpload(channel, id, pending, path, Object.fromEntries(headers), body.data ?? new Uint8Array(0), options.onUploadProgress);
        } else {
          this.sendOrReset(channel, {
            type: 'request',
            id,
            body: {
              path,
              method: details.method,
              headers: Object.fromEntries(headers),
              body: body.value,
              ...(options.responseBinary ? { responseBinary: true } : {}),
            },
          });
        }
      } catch (error) {
        const stillPending = this.pending.delete(id);
        init.signal?.removeEventListener('abort', abort);
        if (stillPending) {
          this.stopUpload(pending);
          this.stopDownload(pending);
        }
        if (stillPending) diagnosticLog.warn('relay.request.failed', { ...requestLogDetails(details, 'send'), ...diagnosticErrorDetails(error) });
        reject(error);
      }
    });
  }

  private startBinaryUpload(channel: EncryptedRelayChannel, id: string, pending: PendingRelayRequest, path: string, headers: Record<string, string>, data: Uint8Array, onProgress?: (progress: number) => void) {
    const upload: PendingRelayUpload = { requestId: id, channel, bodyId: ++this.nextBodyId, data, size: data.byteLength, acked: 0, nextOffset: 0, final: false, finished: false, onProgress };
    pending.upload = upload;
    this.uploadByBodyId.set(upload.bodyId, id);
    diagnosticLog.info('relay.request.start', { ...requestLogDetails(pending), bodyId: upload.bodyId, size: upload.size, chunks: Math.max(1, Math.ceil(upload.size / RELAY_BODY_CHUNK_BYTES)) });
    this.sendOrReset(channel, {
      type: 'request',
      id,
      body: {
        path,
        method: pending.method,
        headers,
        binaryBody: { bodyId: upload.bodyId, size: upload.size },
        ...(pending.responseBinary ? { responseBinary: true } : {}),
      },
    });
    this.pumpPendingUploads(channel);
  }

  /** Sends at most one chunk so concurrent uploads share the channel fairly. */
  private pumpUploadStep(upload: PendingRelayUpload) {
    if (upload.finished || upload.final) return false;
    if (upload.size === 0) {
      this.sendBodyOrReset(upload.channel, { bodyId: upload.bodyId, offset: 0, bytes: new Uint8Array(0), final: true });
      upload.final = true;
      return true;
    }
    const perUploadBytes = RELAY_UPLOAD_WINDOW_CHUNKS * RELAY_BODY_CHUNK_BYTES;
    if (upload.nextOffset - upload.acked >= perUploadBytes || upload.nextOffset >= upload.size) return false;
    const inFlight = this.uploadInFlightBytes(upload.channel);
    const available = RELAY_UPLOAD_GLOBAL_WINDOW_BYTES - inFlight;
    if (available <= 0) return false;
    const end = Math.min(upload.nextOffset + RELAY_BODY_CHUNK_BYTES, upload.size, upload.nextOffset + available);
    const final = end >= upload.size;
    this.sendBodyOrReset(upload.channel, { bodyId: upload.bodyId, offset: upload.nextOffset, bytes: upload.data.subarray(upload.nextOffset, end), final });
    upload.nextOffset = end;
    upload.final = final;
    return true;
  }

  private uploadInFlightBytes(channel: EncryptedRelayChannel) {
    let bytes = 0;
    for (const pending of this.pending.values()) {
      const upload = pending.upload;
      if (upload && !upload.finished && upload.channel === channel) bytes += upload.nextOffset - upload.acked;
    }
    return bytes;
  }

  private pumpPendingUploads(channel: EncryptedRelayChannel) {
    if (this.channelValue !== channel) return;
    const progressedUploads = new Set<PendingRelayUpload>();
    let progressed = true;
    try {
      while (progressed) {
        progressed = false;
        const uploads = [...this.pending.values()]
          .map((pending) => pending.upload)
          .filter((upload): upload is PendingRelayUpload => Boolean(upload && !upload.finished && upload.channel === channel))
          .sort((left, right) => (left.nextOffset - left.acked) - (right.nextOffset - right.acked));
        for (const upload of uploads) {
          if (this.pumpUploadStep(upload)) {
            progressed = true;
            progressedUploads.add(upload);
          }
        }
      }
    } catch {
      return;
    }
    for (const pending of this.pending.values()) {
      if (pending.upload?.channel === channel) this.armUploadStallTimer(pending.upload, progressedUploads.has(pending.upload));
    }
  }

  private armUploadStallTimer(upload: PendingRelayUpload, refresh = false) {
    if (upload.finished || upload.acked >= upload.size || upload.nextOffset <= upload.acked) {
      if (upload.timer) { clearTimeout(upload.timer); upload.timer = undefined; }
      return;
    }
    // Another upload's acknowledgement must not extend this upload's idle
    // deadline. Only a frame that actually made progress resets its timer.
    if (upload.timer && !refresh) return;
    if (upload.timer) clearTimeout(upload.timer);
    upload.timer = setTimeout(() => this.failStalledUpload(upload), RELAY_UPLOAD_STALL_TIMEOUT_MS);
  }

  private failStalledUpload(upload: PendingRelayUpload) {
    if (upload.finished || upload.acked >= upload.size) return;
    const pending = this.pending.get(upload.requestId);
    if (!pending) return;
    const error = transportError('RELAY_UPLOAD_STALLED', true);
    diagnosticLog.warn('relay.request.failed', { ...requestLogDetails(pending, 'response'), ...diagnosticErrorDetails(error) });
    this.failPending(pending, error);
  }

  private handleBodyAck(value: { bodyId: number; offset: number }) {
    const requestId = this.uploadByBodyId.get(value.bodyId);
    if (!requestId) return;
    const pending = this.pending.get(requestId);
    const upload = pending?.upload;
    if (!pending || !upload || upload.finished) return;
    // A cumulative ACK cannot cover bytes that have not even been sent yet;
    // accepting one would make the in-flight calculation negative and reopen
    // the flow-control window to a full extra round.
    if (value.offset <= upload.acked || value.offset > upload.size || value.offset > upload.nextOffset) {
      const error = transportError('RELAY_UPLOAD_ACK_INVALID');
      diagnosticLog.warn('relay.request.failed', { ...requestLogDetails(pending, 'response'), ...diagnosticErrorDetails(error) });
      this.failPending(pending, error);
      return;
    }
    upload.acked = value.offset;
    upload.onProgress?.(upload.size === 0 ? 1 : upload.acked / upload.size);
    if (upload.acked >= upload.size) {
      if (upload.timer) { clearTimeout(upload.timer); upload.timer = undefined; }
      // The completed upload no longer occupies the shared window. Pump the
      // remaining uploads immediately instead of waiting for another ACK.
      this.pumpPendingUploads(upload.channel);
      return;
    }
    if (upload.timer) { clearTimeout(upload.timer); upload.timer = undefined; }
    this.pumpPendingUploads(upload.channel);
  }

  private stopUpload(pending: PendingRelayRequest) {
    const upload = pending.upload;
    if (!upload || upload.finished) return;
    upload.finished = true;
    if (upload.timer) { clearTimeout(upload.timer); upload.timer = undefined; }
    this.uploadByBodyId.delete(upload.bodyId);
    if (this.channelValue === upload.channel) this.pumpPendingUploads(upload.channel);
  }

  private stopDownload(pending: PendingRelayRequest) {
    const download = pending.download;
    if (!download) return;
    if (download.timer) clearTimeout(download.timer);
    download.timer = undefined;
    this.downloadByResponseId.delete(download.responseId);
    pending.download = undefined;
  }

  private handleBinaryResponse(pending: PendingRelayRequest, value: RelayEnvelope) {
    if (!pending.responseBinary) return this.failPending(pending, transportError('RELAY_RESPONSE_PROTOCOL_INVALID'));
    if (pending.download) return this.failDownload(pending, transportError('RELAY_RESPONSE_PROTOCOL_INVALID'));
    if ((value.status ?? 500) >= 400) return this.failPending(pending, relayResponseError(value.status ?? 500, value.body));
    // Once a response envelope exists, the upload side (if any) has completed.
    this.stopUpload(pending);
    const parsed = RelayBinaryResponseSchema.safeParse(value.binaryResponse);
    if (!parsed.success) return this.failPending(pending, transportError('RELAY_RESPONSE_PROTOCOL_INVALID'));
    const metadata = parsed.data;
    const download: PendingRelayDownload = {
      requestId: pending.requestId,
      responseId: metadata.responseId,
      size: metadata.size,
      received: 0,
      data: new Uint8Array(metadata.size),
      ...(metadata.contentType ? { contentType: metadata.contentType } : {}),
      ...(metadata.filename ? { filename: metadata.filename } : {}),
    };
    pending.download = download;
    this.downloadByResponseId.set(download.responseId, download.requestId);
    if (download.size === 0) return this.completeDownload(pending, download);
    this.armDownloadTimer(pending, download);
  }

  private receiveBinaryChunk(value: RelayEnvelope) {
    if (typeof value.responseId !== 'number' || typeof value.offset !== 'number' || !(value.bytes instanceof Uint8Array)) {
      return this.reset(transportError('RELAY_RESPONSE_PROTOCOL_INVALID'));
    }
    const requestId = this.downloadByResponseId.get(value.responseId);
    const pending = requestId ? this.pending.get(requestId) : undefined;
    const download = pending?.download;
    if (!pending || !download) return;
    if (value.offset !== download.received || value.offset + value.bytes.byteLength > download.size) {
      return this.failDownload(pending, transportError('RELAY_RESPONSE_PROTOCOL_INVALID'));
    }
    download.data.set(value.bytes, value.offset);
    download.received += value.bytes.byteLength;
    this.armDownloadTimer(pending, download);
    if (!this.sendResponseAck(download)) return;
    if (value.final === true) {
      if (download.received !== download.size) return this.failDownload(pending, transportError('RELAY_RESPONSE_PROTOCOL_INVALID'));
      this.completeDownload(pending, download);
    } else if (download.received >= download.size) {
      this.failDownload(pending, transportError('RELAY_RESPONSE_PROTOCOL_INVALID'));
    }
  }

  private sendResponseAck(download: PendingRelayDownload) {
    if (!this.channelValue) return false;
    try {
      this.sendOrReset(this.channelValue, { type: 'response-ack', responseId: download.responseId, offset: download.received });
      return true;
    } catch {
      return false;
    }
  }

  private armDownloadTimer(pending: PendingRelayRequest, download: PendingRelayDownload) {
    if (download.timer) clearTimeout(download.timer);
    download.timer = setTimeout(() => {
      this.failDownload(pending, transportError('RELAY_DOWNLOAD_STALLED', true));
    }, RELAY_DOWNLOAD_IDLE_TIMEOUT_MS);
    (download.timer as unknown as { unref?(): void }).unref?.();
  }

  private completeDownload(pending: PendingRelayRequest, download: PendingRelayDownload) {
    const result = {
      body: download.data,
      ...(download.filename ? { filename: download.filename } : {}),
      ...(download.contentType ? { contentType: download.contentType } : {}),
    };
    this.stopDownload(pending);
    this.pending.delete(pending.requestId);
    pending.abort?.();
    pending.resolve(result);
  }

  private failDownload(pending: PendingRelayRequest, error: unknown) {
    this.stopDownload(pending);
    this.pending.delete(pending.requestId);
    this.cancelRelayRequest(pending.requestId);
    pending.abort?.();
    pending.reject(error);
  }

  private failPending(pending: PendingRelayRequest, error: unknown) {
    const requestId = pending.requestId;
    this.stopUpload(pending);
    this.stopDownload(pending);
    this.pending.delete(requestId);
    this.cancelRelayRequest(requestId);
    pending.abort?.();
    pending.reject(error);
  }

  private cancelRelayRequest(requestId: string) {
    try { this.channelValue?.send({ type: 'cancel', id: requestId }); }
    catch { /* the channel is already gone; the request is locally rejected */ }
  }

  private sendBodyOrReset(channel: EncryptedRelayChannel, frame: RelayBodyFrame) {
    try { channel.sendBody(frame); }
    catch (error) { this.channelClosed(channel, error); throw error; }
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

  async revalidate(signal?: AbortSignal) {
    this.reset(transportError('RELAY_NETWORK_CHANGED', true));
    // Callers use revalidate() to reconnect, not to report that the network changed, so
    // the remembered winner survives it. A device that really moved is caught by the
    // network fingerprint inside the cache, and every genuine failure clears it.
    const attempt = this.beginAttempt(signal);
    try {
      await this.ensureChannel(attempt);
    } finally {
      this.finishAttempt(attempt);
    }
  }

  suspend() {
    diagnosticLog.info('relay.transport.suspend', { hadChannel: Boolean(this.channelValue), hadAttempt: Boolean(this.attempt) });
    this.reset(transportError('RELAY_TRANSPORT_SUSPENDED', true, 'Cloud Relay connection was suspended.'));
  }

  private ensureChannel(attempt = this.attempt && this.isAttemptCurrent(this.attempt) ? this.attempt : this.beginAttempt()) {
    if (this.channel) return this.channel;
    if (!this.isAttemptCurrent(attempt)) return Promise.reject(attemptCancelled());
    let pending!: Promise<EncryptedRelayChannel>;
    pending = this.establishChannel(true, attempt).catch((error) => {
      if (this.channel === pending) this.channel = undefined;
      throw normalize(error);
    });
    this.channel = pending;
    void pending.then(
      () => this.finishAttempt(attempt),
      () => this.finishAttempt(attempt),
    );
    return pending;
  }

  private nextRelayAttemptId() {
    return `relay_${Date.now().toString(36)}_${++this.nextAttemptId}`;
  }

  private async establishChannel(allowCachedWinner = true, attempt = this.attempt ?? this.beginAttempt()): Promise<EncryptedRelayChannel> {
    const attemptId = this.nextRelayAttemptId();
    const startedAt = Date.now();
    let route: 'resume' | 'selection' = 'selection';
    diagnosticLog.info('relay.connect.start', { attemptId, allowCachedWinner, hasSession: Boolean(this.session) });
    await this.restorePersistedSession();
    this.assertAttemptCurrent(attempt);
    if (this.session) {
      route = 'resume';
      diagnosticLog.info('relay.connect.route', { attemptId, route });
      try {
        const channel = await this.resumeSession(this.session, attemptId, attempt);
        diagnosticLog.info('relay.connect.complete', { attemptId, route, durationMs: Date.now() - startedAt });
        return channel;
      } catch (error) {
        if (!this.isAttemptCurrent(attempt)) throw attemptCancelled();
        // A transient network failure is not a reason to burn two Coordinator
        // requests and an allocation. Repeated E2E timeouts mean this allocation
        // no longer has a reachable Control Plane peer, while an authoritative
        // rejection means the grant itself is dead; both need a fresh selection.
        if (this.shouldAbandonE2eSession(error, 'resume')) {
          const abandoned = { generation: this.session?.grant.generation, relayId: this.session?.grant.relayId, allocationId: this.session?.grant.allocationId };
          this.clearSession();
          await this.winnerCache?.clear(this.profile.identity.controlPlaneId);
          allowCachedWinner = false;
          diagnosticLog.warn('relay.resume.abandoned', { attemptId, reason: 'repeated-e2e-handshake-timeout', ...abandoned, ...diagnosticErrorDetails(error) });
        } else if (this.isE2eHandshakeTimeout(error)) {
          throw error;
        } else if (this.discardTerminalSession(error, 'resume')) {
          diagnosticLog.warn('relay.resume.fallback', { attemptId, reason: 'terminal-resume-failure', ...diagnosticErrorDetails(error) });
        } else if (this.shouldAbandonResumeSession(error)) {
          const abandoned = { generation: this.session?.grant.generation, relayId: this.session?.grant.relayId, allocationId: this.session?.grant.allocationId };
          this.clearSession();
          await this.winnerCache?.clear(this.profile.identity.controlPlaneId);
          allowCachedWinner = false;
          diagnosticLog.warn('relay.resume.abandoned', { attemptId, reason: 'repeated-transport-failure', ...abandoned, ...diagnosticErrorDetails(error) });
        } else {
          throw error;
        }
      }
    }
    route = 'selection';
    diagnosticLog.info('relay.connect.route', { attemptId, route, hasCachedWinner: allowCachedWinner });
    try {
      const channel = await this.runSelection(allowCachedWinner, false, attemptId, attempt);
      diagnosticLog.info('relay.connect.complete', { attemptId, route, durationMs: Date.now() - startedAt });
      return channel;
    } catch (error) {
      if (!this.isAttemptCurrent(attempt)) throw attemptCancelled();
      // "Reuse the winner until it stops working": a failed attempt is that evidence, so
      // the next connection measures again instead of trusting the cache.
      await this.winnerCache?.clear(this.profile.identity.controlPlaneId);
      diagnosticLog.error('relay.connect.failed', { attemptId, route, durationMs: Date.now() - startedAt, ...diagnosticErrorDetails(error) });
      throw error;
    }
  }

  private async resumeSession(session: ActiveRelaySession, attemptId: string, attempt: RelayAttempt) {
    this.assertAttemptCurrent(attempt);
    if (Date.parse(session.grant.expiresAt) <= Date.now()) {
      diagnosticLog.warn('relay.resume.expired', { attemptId, generation: session.grant.generation, relayId: session.grant.relayId });
      this.clearSession();
      throw transportError('RELAY_SESSION_EXPIRED', false);
    }
    const startedAt = Date.now();
    diagnosticLog.info('relay.resume.start', { attemptId, generation: session.grant.generation, relayId: session.grant.relayId, allocationId: session.grant.allocationId });
    const proof = await this.proofKey.proof(session.grant);
    this.assertAttemptCurrent(attempt);
    let channel: EncryptedRelayChannel;
    try {
      channel = await this.openChannelForAttempt({
        attemptId,
        relayUrl: session.grant.relayUrl,
        mode: 'resume',
        grant: session.grant,
        proof,
        targetPublicKeyFingerprint: this.profile.identity.publicKeyFingerprint,
        epoch: ++this.epoch,
      }, attempt);
    } catch (error) {
      diagnosticLog.warn('relay.resume.failed', { attemptId, durationMs: Date.now() - startedAt, generation: session.grant.generation, relayId: session.grant.relayId, ...diagnosticErrorDetails(error) });
      throw error;
    }
    if (!this.isAttemptCurrent(attempt)) {
      channel.close(1000, 'attempt-cancelled');
      throw attemptCancelled();
    }
    if (this.session !== session) {
      channel.close(1000, 'session-replaced');
      throw transportError('RELAY_SESSION_REPLACED', true);
    }
    this.installChannel(channel, { grant: session.grant, appliedGeneration: channel.generation ?? session.appliedGeneration });
    diagnosticLog.info('relay.resume.complete', { attemptId, durationMs: Date.now() - startedAt, generation: channel.generation ?? session.appliedGeneration, relayId: session.grant.relayId });
    return channel;
  }

  private async runSelection(allowCachedWinner: boolean, freshRetry = false, attemptId = this.nextRelayAttemptId(), attempt = this.attempt ?? this.beginAttempt()): Promise<EncryptedRelayChannel> {
    const startedAt = Date.now();
    const controlPlaneId = this.profile.identity.controlPlaneId;
    const networkFingerprint = this.networkFingerprint();
    const cached = allowCachedWinner ? await this.winnerCache?.read(controlPlaneId, networkFingerprint) : undefined;
    const pending = await this.loadPendingOperation();
    this.assertAttemptCurrent(attempt);
    diagnosticLog.info('relay.selection.start', { attemptId, freshRetry, cacheHit: Boolean(cached), cachedRelayId: cached?.relayId, pendingOperation: pending?.type ?? 'none' });
    if (pending?.type === 'confirm') {
      const replayStartedAt = Date.now();
      diagnosticLog.info('relay.confirm.replay.start', { attemptId, cacheHit: Boolean(cached) });
      let confirmed;
      try {
        confirmed = await this.account.confirmRelaySession(pending.selectionId, pending.body, pending.key);
      } catch (error) {
        if (!this.isAttemptCurrent(attempt)) throw attemptCancelled();
        if (!pendingOperationRetryable(error)) await this.clearPendingOperation();
        diagnosticLog.warn('relay.confirm.replay.failed', { attemptId, durationMs: Date.now() - replayStartedAt, ...diagnosticErrorDetails(error) });
        throw error;
      }
      this.assertAttemptCurrent(attempt);
      await this.clearPendingOperation();
      diagnosticLog.info('relay.confirm.replay.complete', { attemptId, durationMs: Date.now() - replayStartedAt, relayId: confirmed.relayId, substituted: confirmed.substituted });
      const channel = await this.completeConfirmedSelection(controlPlaneId, confirmed, cached, undefined, undefined, allowCachedWinner, attemptId, attempt);
      diagnosticLog.info('relay.selection.complete', { attemptId, durationMs: Date.now() - startedAt, route: 'confirm-replay', relayId: confirmed.relayId });
      return channel;
    }

    const clientProofPublicKey = await this.proofKey.publicKey();
    this.assertAttemptCurrent(attempt);
    let bootstrapOperation = pending?.type === 'bootstrap' ? pending : undefined;
    if (bootstrapOperation && bootstrapOperation.body.clientProofPublicKey !== clientProofPublicKey) {
      await this.clearPendingOperation();
      bootstrapOperation = undefined;
    }
    const bootstrapReplay = Boolean(bootstrapOperation);
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

    const bootstrapStartedAt = Date.now();
    diagnosticLog.info('relay.bootstrap.start', { attemptId, replay: bootstrapReplay, candidateLimit: RELAY_CANDIDATE_COUNT });
    let bootstrap;
    try {
      bootstrap = await this.account.bootstrapRelaySession(bootstrapOperation.body, bootstrapOperation.key);
    } catch (error) {
      if (!this.isAttemptCurrent(attempt)) throw attemptCancelled();
      if (!pendingOperationRetryable(error)) await this.clearPendingOperation();
      diagnosticLog.warn('relay.bootstrap.failed', { attemptId, replay: bootstrapReplay, durationMs: Date.now() - bootstrapStartedAt, ...diagnosticErrorDetails(error) });
      throw error;
    }
    this.assertAttemptCurrent(attempt);
    const ticket = bootstrap.relayTicket;
    if (bootstrap.clientProofPublicKey !== clientProofPublicKey || ticket.clientProofPublicKey !== clientProofPublicKey
      || ticket.targetPublicKeyFingerprint !== this.profile.identity.publicKeyFingerprint
      || ticket.bindingId !== this.profile.access.bindingId
      || ticket.bindingRevision !== this.profile.access.bindingRevision
      || ticket.controlPlaneId !== controlPlaneId) {
      throw transportError('RELAY_TARGET_IDENTITY_CHANGED');
    }

    const selection = bootstrap.selection;
    diagnosticLog.info('relay.bootstrap.complete', {
      attemptId,
      replay: bootstrapReplay,
      durationMs: Date.now() - bootstrapStartedAt,
      candidates: selection.candidates.length,
      preferredHonored: selection.preferredHonored,
      expiresInMs: Date.parse(selection.expiresAt) - Date.now(),
    });
    if (Date.parse(selection.expiresAt) <= Date.now()) {
      await this.clearPendingOperation();
      diagnosticLog.warn('relay.selection.expired', { attemptId, freshRetry });
      if (!freshRetry) return this.runSelection(false, true, attemptId, attempt);
      throw transportError('RELAY_SELECTION_EXPIRED', true);
    }
    const winner = await this.chooseWinner(selection, cached, networkFingerprint, attemptId);
    this.assertAttemptCurrent(attempt);
    const confirmOperation: RelayPendingOperation = {
      type: 'confirm',
      selectionId: selection.selectionId,
      key: idempotencyKey('confirm'),
      body: winner.confirmation,
      createdAt: Date.now(),
    };
    await this.savePendingOperation(confirmOperation);
    const confirmStartedAt = Date.now();
    diagnosticLog.info('relay.confirm.start', { attemptId, winnerRelayId: winner.relayId, fallback: winner.confirmation.fallback, cacheHit: Boolean(cached) });
    let confirmed;
    try {
      confirmed = await this.account.confirmRelaySession(confirmOperation.selectionId, confirmOperation.body, confirmOperation.key);
    } catch (error) {
      if (!this.isAttemptCurrent(attempt)) throw attemptCancelled();
      if (!pendingOperationRetryable(error)) await this.clearPendingOperation();
      diagnosticLog.warn('relay.confirm.failed', { attemptId, durationMs: Date.now() - confirmStartedAt, winnerRelayId: winner.relayId, ...diagnosticErrorDetails(error) });
      if (pendingOperationSelectionExpired(error) && !freshRetry) {
        await this.clearPendingOperation();
        return this.runSelection(false, true, attemptId, attempt);
      }
      throw error;
    }
    this.assertAttemptCurrent(attempt);
    await this.clearPendingOperation();
    diagnosticLog.info('relay.confirm.complete', { attemptId, durationMs: Date.now() - confirmStartedAt, winnerRelayId: winner.relayId, relayId: confirmed.relayId, substituted: confirmed.substituted, fallback: winner.confirmation.fallback });
    const channel = await this.completeConfirmedSelection(controlPlaneId, confirmed, cached, winner.relayId, winner.measurements, allowCachedWinner, attemptId, attempt);
    diagnosticLog.info('relay.selection.complete', { attemptId, durationMs: Date.now() - startedAt, route: 'selection', relayId: confirmed.relayId, fallback: winner.confirmation.fallback });
    return channel;
  }

  private async completeConfirmedSelection(
    controlPlaneId: string,
    confirmed: Awaited<ReturnType<CloudMobileAccountClient['confirmRelaySession']>>,
    cached: RelayWinnerEntry | undefined,
    winnerRelayId: string | undefined,
    measurements: RelayProbeResult[] | undefined,
    allowCachedWinner: boolean,
    attemptId: string,
    attempt: RelayAttempt,
  ): Promise<EncryptedRelayChannel> {
    this.assertAttemptCurrent(attempt);
    const expectedRelayId = winnerRelayId ?? cached?.relayId;
    if (confirmed.substituted || (expectedRelayId && confirmed.relayId !== expectedRelayId)) {
      // The Coordinator had to book something other than what was asked for, so the
      // cached winner is stale information rather than a fact about this network.
      await this.winnerCache?.clear(controlPlaneId);
      diagnosticLog.warn('relay.cache.invalidated', { attemptId, reason: confirmed.substituted ? 'substituted' : 'winner-changed', expectedRelayId, relayId: confirmed.relayId });
    }
    try {
      this.verifyConfirmedGrant(confirmed, await this.proofKey.publicKey());
    } catch (error) {
      diagnosticLog.error('relay.grant.rejected', { attemptId, relayId: confirmed.relayId, allocationId: confirmed.allocationId, ...diagnosticErrorDetails(error) });
      throw error;
    }
    this.assertAttemptCurrent(attempt);
    diagnosticLog.info('relay.grant.verified', { attemptId, relayId: confirmed.relayId, allocationId: confirmed.allocationId, generation: confirmed.grant.generation, expiresInMs: Date.parse(confirmed.grant.expiresAt) - Date.now() });
    const session: ActiveRelaySession = { grant: confirmed.grant, appliedGeneration: 0 };
    // Publish the confirmed session before the first socket attempt so a lost
    // attach reply can be retried with `session-attach` instead of allocating a
    // second Relay session. The Control Plane half is already attached by now.
    this.session = session;
    await this.persistSession(confirmed.grant);
    this.assertAttemptCurrent(attempt);
    const attachStartedAt = Date.now();
    diagnosticLog.info('relay.attach.start', { attemptId, relayId: confirmed.relayId, allocationId: confirmed.allocationId, generation: confirmed.grant.generation });
    try {
      const proof = await this.proofKey.proof(confirmed.grant);
      this.assertAttemptCurrent(attempt);
      const channel = await this.openChannelForAttempt({
        attemptId,
        relayUrl: confirmed.relayUrl,
        mode: 'attach',
        grant: confirmed.grant,
        proof,
        attach: confirmed.clientAttach,
        targetPublicKeyFingerprint: this.profile.identity.publicKeyFingerprint,
        epoch: ++this.epoch,
      }, attempt);
      this.assertAttemptCurrent(attempt);
      session.appliedGeneration = channel.generation ?? confirmed.grant.generation;
      this.installChannel(channel, session);
      diagnosticLog.info('relay.attach.complete', { attemptId, durationMs: Date.now() - attachStartedAt, relayId: confirmed.relayId, allocationId: confirmed.allocationId, appliedGeneration: session.appliedGeneration });
      if (measurements) await this.rememberWinner(controlPlaneId, confirmed, measurements, this.networkFingerprint(), cached, attemptId);
      return channel;
    } catch (error) {
      if (!this.isAttemptCurrent(attempt)) throw attemptCancelled();
      // A cached winner that just failed should be remeasured. Transient attach
      // failures keep the grant for an in-place resume; authoritative session
      // failures discard it and reselect instead of retrying a dead grant.
      const terminalSessionFailure = this.discardTerminalSession(error, 'attach');
      const abandonedE2eSession = this.shouldAbandonE2eSession(error, 'attach');
      if (abandonedE2eSession) {
        diagnosticLog.warn('relay.attach.abandoned', { attemptId, reason: 'repeated-e2e-handshake-timeout', relayId: confirmed.relayId, allocationId: confirmed.allocationId, ...diagnosticErrorDetails(error) });
        this.clearSession();
        await this.winnerCache?.clear(controlPlaneId);
      }
      diagnosticLog.warn('relay.attach.failed', { attemptId, durationMs: Date.now() - attachStartedAt, relayId: confirmed.relayId, allocationId: confirmed.allocationId, cachedWinnerFallback: allowCachedWinner && Boolean(cached), terminalSessionFailure, ...diagnosticErrorDetails(error) });
      if (allowCachedWinner && (cached || terminalSessionFailure || abandonedE2eSession)) {
        if (!terminalSessionFailure && !abandonedE2eSession) this.clearSession();
        return this.establishChannel(false, attempt);
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
  private async chooseWinner(selection: CloudRelaySelection, cached: RelayWinnerEntry | undefined, networkFingerprint: string, attemptId: string) {
    const startedAt = Date.now();
    const trust = this.allowRelayUrl;
    const targets: RelayProbeTarget[] = selection.candidates.map((candidate) => ({ allocationId: candidate.allocationId, relayUrl: candidate.relayUrl }));
    const cachedCandidate = cached ? selection.candidates.find((candidate) => candidate.relayId === cached.relayId) : undefined;
    const fastPath = cachedCandidate !== undefined && cached !== undefined && selection.preferredHonored;
    const probeOptions = { attemptId, ...(trust ? { allowRelayUrl: trust } : {}) };
    diagnosticLog.info('relay.probe.start', { attemptId, fastPath, candidateCount: targets.length, measuredCandidateCount: fastPath ? 1 : targets.length });
    let probes = await this.probe(
      fastPath ? targets.filter((target) => target.allocationId === cachedCandidate!.allocationId) : targets,
      fastPath ? { ...probeOptions, samples: RELAY_PROBE_FAST_SAMPLES, budgetMs: RELAY_PROBE_FAST_BUDGET_MS } : probeOptions,
    );
    const fastPathSucceeded = fastPath && probes.some((probe) => probe.mobileRttMs !== undefined);
    if (fastPath && !probes.some((probe) => probe.mobileRttMs !== undefined)) {
      // The remembered winner did not answer, so this is a full selection after all.
      diagnosticLog.warn('relay.probe.fast-path-missed', { attemptId, cachedRelayId: cached?.relayId, fallbackCandidateCount: targets.length });
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
    diagnosticLog.info('relay.probe.complete', {
      attemptId,
      durationMs: Date.now() - startedAt,
      mode: fastPath ? (fastPathSucceeded ? 'cached-fast-path' : 'cached-fallback') : 'full',
      fastPath,
      fastPathSucceeded,
      fullFallback: fastPath && !fastPathSucceeded,
      winnerRelayId: winnerCandidate.relayId,
      fallback,
      measurements,
    });
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

  private async rememberWinner(controlPlaneId: string, confirmed: { relayId: string; relayUrl: string }, measurements: readonly RelayProbeResult[], networkFingerprint: string, cached: RelayWinnerEntry | undefined, attemptId: string) {
    if (!this.winnerCache) return;
    const measured = measurements.find((probe) => probe.mobileRttMs !== undefined);
    // The winner still answers, but far slower than the measurement the cache was
    // built from: this network (or that Relay) changed underneath us, so forget the
    // hint and let the next connection run a full selection.
    if (cached && measured?.mobileRttMs !== undefined && cached.rttMs > 0 && measured.mobileRttMs > cached.rttMs * 2) {
      await this.winnerCache.clear(controlPlaneId);
      diagnosticLog.warn('relay.winner-cache.invalidated', { attemptId, relayId: confirmed.relayId, cachedRttMs: cached.rttMs, measuredRttMs: measured.mobileRttMs, reason: 'latency-degraded' });
      return;
    }
    await this.winnerCache.write(controlPlaneId, { relayId: confirmed.relayId, relayUrl: confirmed.relayUrl, rttMs: measured?.mobileRttMs ?? cached?.rttMs ?? 0, networkFingerprint });
    diagnosticLog.info('relay.winner-cache.saved', { attemptId, relayId: confirmed.relayId, rttMs: measured?.mobileRttMs ?? cached?.rttMs ?? 0 });
  }

  private installChannel(channel: EncryptedRelayChannel, session: ActiveRelaySession) {
    const previous = this.channelValue;
    this.unsubscribeControl?.();
    this.channelValue = channel;
    this.channel = Promise.resolve(channel);
    this.session = session;
    this.e2eHandshakeTimeouts = 0;
    this.resumeFailures = 0;
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
    const attemptId = this.nextRelayAttemptId();
    const startedAt = Date.now();
    const controller = new AbortController();
    this.rekeyAbort = controller;
    diagnosticLog.info('relay.rekey.start', { attemptId, generation: session.grant.generation, relayId: session.grant.relayId });
    this.rekeying = (async () => {
      try {
        const channel = await this.openChannel({
          attemptId,
          relayUrl: session.grant.relayUrl,
          mode: 'resume',
          grant: session.grant,
          proof: await this.proofKey.proof(session.grant),
          targetPublicKeyFingerprint: this.profile.identity.publicKeyFingerprint,
          epoch: ++this.epoch,
          signal: controller.signal,
        });
        if (this.channelValue !== current || this.session !== session) {
          channel.close(1000, 'session-replaced');
          return;
        }
        this.installChannel(channel, session);
        current.close(1000, 'e2e-rekey');
        diagnosticLog.info('relay.rekey.complete', { attemptId, durationMs: Date.now() - startedAt, generation: channel.generation ?? session.grant.generation, relayId: session.grant.relayId });
      } catch (error) {
        diagnosticLog.warn('relay.rekey.failed', { attemptId, durationMs: Date.now() - startedAt, generation: session.grant.generation, relayId: session.grant.relayId, retryScheduled: this.channelValue === current, ...diagnosticErrorDetails(error) });
        if (this.channelValue === current) this.scheduleE2eRekeyRetry(current);
      }
    })().finally(() => {
      if (this.rekeyAbort === controller) this.rekeyAbort = undefined;
      this.rekeying = undefined;
    });
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
    if (notice.type === 'session-closed') {
      diagnosticLog.warn('relay.session.closed', { sessionId: notice.sessionId, code: notice.code, retryable: notice.retryable });
      if (!notice.retryable) this.clearSession();
      this.channelClosed(channel, transportError('RELAY_SESSION_CLOSED', notice.retryable, notice.retryable ? MOBILE_CONTROL_PLANE_CLOSED_MESSAGE : 'Cloud Relay session ended.'));
      return;
    }
    if (notice.type === 'peer-detached') {
      this.channelClosed(channel, transportError('RELAY_PEER_DETACHED', true, MOBILE_CONTROL_PLANE_CLOSED_MESSAGE));
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
    const session = this.session;
    this.discardTerminalSession(error, 'channel-close');
    // A transient socket close keeps the grant for an in-place resume; a terminal
    // Relay reason has already discarded it above.
    diagnosticLog.warn('relay.channel.reset', { generation: session?.grant.generation, relayId: session?.grant.relayId, ...diagnosticErrorDetails(error) });
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
    const startedAt = Date.now();
    if (Date.parse(this.session.grant.expiresAt) <= Date.now()) {
      diagnosticLog.warn('relay.renew.expired', { generation: this.session.grant.generation, relayId: this.session.grant.relayId });
      this.clearSession();
      return;
    }
    diagnosticLog.info('relay.renew.start', { generation: this.session.grant.generation, appliedGeneration: this.session.appliedGeneration, relayId: this.session.grant.relayId });

    // The Coordinator may have issued the next generation while the socket was
    // briefly unable to carry the control reply. Push that same grant before
    // asking for yet another generation.
    if (this.session.appliedGeneration < this.session.grant.generation) {
      const committed = await this.pushGrant(current, this.session.grant);
      if (committed) this.scheduleLeaseRenewal(current);
      else this.scheduleRenewalRetry(current);
      diagnosticLog[committed ? 'info' : 'warn']('relay.renew.repush', { durationMs: Date.now() - startedAt, generation: this.session.grant.generation, committed });
      return;
    }

    let next: RelaySessionGrant;
    try {
      next = await this.renewCoordinatorGrant(this.session.grant);
    } catch (error) {
      // A failed renewal deliberately leaves the current channel intact. It can
      // keep carrying requests until the Relay closes it at grant expiry.
      diagnosticLog.warn('relay.renew.coordinator-failed', { durationMs: Date.now() - startedAt, generation: this.session.grant.generation, relayId: this.session.grant.relayId, retryScheduled: true, ...diagnosticErrorDetails(error) });
      this.scheduleRenewalRetry(current);
      return;
    }
    if (this.channelValue !== current || !this.session) return;
    const previousGeneration = this.session.grant.generation;
    this.session.grant = next;
    await this.persistSession(next);
    const committed = await this.pushGrant(current, next);
    if (committed) this.scheduleLeaseRenewal(current);
    else this.scheduleRenewalRetry(current);
    diagnosticLog[committed ? 'info' : 'warn']('relay.renew.complete', { durationMs: Date.now() - startedAt, previousGeneration, generation: next.generation, relayId: next.relayId, committed });
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
    } catch (error) {
      diagnosticLog.warn('relay.grant.push.failed', { generation: grant.generation, relayId: grant.relayId, ...diagnosticErrorDetails(error) });
      return false;
    }
  }

  private receive(value: RelayEnvelope) {
    if (value.type === 'response-chunk') {
      this.receiveBinaryChunk(value);
      return;
    }
    if (value.type === 'body-ack' && typeof value.bodyId === 'number' && typeof value.offset === 'number') {
      this.handleBodyAck({ bodyId: value.bodyId, offset: value.offset });
      return;
    }
    if (value.type === 'response' && value.id) {
      const pending = this.pending.get(value.id);
      if (!pending) return;
      if ((value.status ?? 500) >= 400) {
        this.pending.delete(value.id);
        this.stopUpload(pending);
        this.stopDownload(pending);
        pending.abort?.();
        const error = relayResponseError(value.status ?? 500, value.body);
        diagnosticLog.warn('relay.request.failed', { ...requestLogDetails(pending, 'response', value.status), ...diagnosticErrorDetails(error) });
        pending.reject(error);
        return;
      }
      if (value.binaryResponse !== undefined) {
        this.handleBinaryResponse(pending, value);
        return;
      }
      if (pending.responseBinary) {
        const error = transportError('RELAY_RESPONSE_PROTOCOL_INVALID');
        diagnosticLog.warn('relay.request.failed', { ...requestLogDetails(pending, 'response-schema'), ...diagnosticErrorDetails(error) });
        this.failPending(pending, error);
        return;
      }
      this.pending.delete(value.id);
      this.stopUpload(pending);
      pending.abort?.();
      const parsed = pending.schema?.safeParse(value.body);
      if (parsed?.success) {
        if (pending.binary) diagnosticLog.info('relay.request.complete', requestLogDetails(pending, 'complete', value.status));
        pending.resolve(parsed.data);
      } else {
        const error = transportError('RELAY_RESPONSE_SCHEMA_INVALID');
        diagnosticLog.warn('relay.request.failed', { ...requestLogDetails(pending, 'response-schema'), ...diagnosticErrorDetails(error) });
        pending.reject(error);
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

  private beginAttempt(signal?: AbortSignal) {
    this.cancelAttempt('superseded');
    const attempt: RelayAttempt = { controller: new AbortController() };
    this.attempt = attempt;
    if (signal) {
      const abort = () => attempt.controller.abort();
      if (signal.aborted) abort();
      else {
        signal.addEventListener('abort', abort, { once: true });
        attempt.detachSignal = () => signal.removeEventListener('abort', abort);
      }
    }
    return attempt;
  }

  private finishAttempt(attempt: RelayAttempt) {
    if (this.attempt !== attempt) return;
    this.attempt = undefined;
    attempt.detachSignal?.();
  }

  private cancelAttempt(reason: 'superseded' | 'reset' | 'rekey') {
    const attempt = this.attempt;
    if (!attempt) return;
    this.attempt = undefined;
    attempt.detachSignal?.();
    if (!attempt.controller.signal.aborted) attempt.controller.abort();
    diagnosticLog.info('relay.attempt.cancelled', { reason });
  }

  private isAttemptCurrent(attempt: RelayAttempt) {
    return this.attempt === attempt && !attempt.controller.signal.aborted;
  }

  private assertAttemptCurrent(attempt: RelayAttempt) {
    if (!this.isAttemptCurrent(attempt)) throw attemptCancelled();
  }

  /** Stops the transport from installing a channel even if a platform socket resolves late. */
  private openChannelForAttempt(input: Parameters<RelayChannelFactory>[0], attempt: RelayAttempt): Promise<EncryptedRelayChannel> {
    this.assertAttemptCurrent(attempt);
    return new Promise<EncryptedRelayChannel>((resolve, reject) => {
      let settled = false;
      const cleanup = () => attempt.controller.signal.removeEventListener('abort', aborted);
      const finish = (value: EncryptedRelayChannel) => {
        if (settled) {
          try { value.close(1000, 'attempt-cancelled'); } catch { /* already closed */ }
          return;
        }
        settled = true;
        cleanup();
        resolve(value);
      };
      const fail = (error: unknown) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      };
      const aborted = () => fail(attemptCancelled());
      attempt.controller.signal.addEventListener('abort', aborted, { once: true });
      let opening: Promise<EncryptedRelayChannel>;
      try {
        opening = Promise.resolve(this.openChannel({ ...input, signal: attempt.controller.signal }));
      } catch (error) {
        fail(error);
        return;
      }
      void opening.then(finish, fail);
    });
  }

  private reset(error: unknown) {
    this.cancelAttempt('reset');
    this.rekeyAbort?.abort();
    this.rekeyAbort = undefined;
    diagnosticLog.warn('relay.transport.reset', { hadChannel: Boolean(this.channelValue), generation: this.session?.grant.generation, relayId: this.session?.grant.relayId, ...diagnosticErrorDetails(error) });
    this.cancelLeaseRenewal();
    this.cancelE2eRekey();
    this.unsubscribeControl?.();
    this.unsubscribeControl = undefined;
    this.channelValue?.close(4000, 'reset');
    this.channelValue = undefined;
    this.channel = undefined;
    for (const pending of this.pending.values()) {
      const normalized = normalize(error);
      this.stopUpload(pending);
      this.stopDownload(pending);
      pending.abort?.();
      diagnosticLog.warn('relay.request.failed', { ...requestLogDetails(pending, 'connection-reset'), ...diagnosticErrorDetails(normalized) });
      pending.reject(normalized);
    }
    this.pending.clear();
    for (const handler of this.events) handler.onError(normalize(error));
    for (const handler of this.tty.values()) handler.onError(normalize(error));
  }

  private clearSession() {
    this.session = undefined;
    this.renewalAttempt = undefined;
    this.e2eHandshakeTimeouts = 0;
    this.resumeFailures = 0;
    void this.persistSession(undefined);
  }

  private isE2eHandshakeTimeout(error: unknown) {
    return isE2eHandshakeTimeout(error);
  }

  /** Returns true once consecutive timeouts justify replacing the allocation. */
  private shouldAbandonE2eSession(error: unknown, source: 'resume' | 'attach') {
    if (!this.isE2eHandshakeTimeout(error)) return false;
    this.e2eHandshakeTimeouts += 1;
    const exhausted = this.e2eHandshakeTimeouts >= this.maxE2eHandshakeTimeouts;
    diagnosticLog.warn('relay.e2e.timeout', {
      source,
      consecutive: this.e2eHandshakeTimeouts,
      threshold: this.maxE2eHandshakeTimeouts,
      exhausted,
      generation: this.session?.grant.generation,
      relayId: this.session?.grant.relayId,
      allocationId: this.session?.grant.allocationId,
      ...diagnosticErrorDetails(error),
    });
    return exhausted;
  }

  /** Returns true once repeated transport failures justify replacing a stale grant. */
  private shouldAbandonResumeSession(error: unknown) {
    if (!retryableRelayResumeFailure(error)) return false;
    this.resumeFailures += 1;
    const exhausted = this.resumeFailures >= this.maxResumeFailures;
    diagnosticLog.warn('relay.resume.retry', {
      consecutive: this.resumeFailures,
      threshold: this.maxResumeFailures,
      exhausted,
      generation: this.session?.grant.generation,
      relayId: this.session?.grant.relayId,
      allocationId: this.session?.grant.allocationId,
      ...diagnosticErrorDetails(error),
    });
    return exhausted;
  }

  private discardTerminalSession(error: unknown, source: 'resume' | 'attach' | 'channel-close') {
    if (!terminalRelaySessionFailure(error)) return false;
    diagnosticLog.warn('relay.session.discarded', {
      source,
      generation: this.session?.grant.generation,
      relayId: this.session?.grant.relayId,
      sessionId: this.session?.grant.sessionId,
      allocationId: this.session?.grant.allocationId,
      ...diagnosticErrorDetails(error),
    });
    this.clearSession();
    return true;
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

function encodeRelayRequestBody(body: BodyInit | null | undefined): EncodedRelayRequestBody {
  if (body === undefined || body === null) return { value: undefined, bytes: 0, encoding: 'none', binary: false };
  if (typeof body === 'string') return { value: body, bytes: new TextEncoder().encode(body).byteLength, encoding: 'utf8', binary: false };
  if (typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams) {
    return encodeRelayRequestBody(body.toString());
  }
  if (body instanceof ArrayBuffer) {
    const data = new Uint8Array(body);
    return { value: undefined, data, bytes: data.byteLength, encoding: 'binary', binary: true };
  }
  if (ArrayBuffer.isView(body)) {
    const data = new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
    return { value: undefined, data, bytes: data.byteLength, encoding: 'binary', binary: true };
  }
  throw transportError('RELAY_REQUEST_BODY_UNSUPPORTED', false, 'Cloud Relay request body type is unsupported.');
}

function relayRequestPath(path: string) {
  return (path.split(/[?#]/, 1)[0] || '/').slice(0, 512);
}

function requestLogDetails(
  request: Pick<PendingRelayRequest, 'method' | 'path' | 'bodyBytes' | 'bodyEncoding' | 'binary' | 'responseBinary' | 'startedAt'>,
  phase?: 'cancelled' | 'send' | 'response' | 'response-schema' | 'connection-reset' | 'complete',
  status?: number,
) {
  return {
    method: request.method,
    path: request.path,
    bodyBytes: request.bodyBytes,
    bodyEncoding: request.bodyEncoding,
    binary: request.binary,
    responseBinary: request.responseBinary,
    durationMs: Math.max(0, Date.now() - request.startedAt),
    ...(phase ? { phase } : {}),
    ...(status === undefined ? {} : { status }),
  };
}

function relayResponseError(status: number, body: unknown) {
  const envelope = body && typeof body === 'object' ? body as { error?: unknown } : undefined;
  const record = envelope?.error && typeof envelope.error === 'object'
    ? envelope.error as { code?: unknown; message?: unknown; retryable?: unknown }
    : undefined;
  const retryable = typeof record?.retryable === 'boolean'
    ? record.retryable
    : status >= 500 || [408, 409, 425, 429].includes(status);
  return new MobileControlPlaneTransportError(
    typeof record?.code === 'string' && record.code ? record.code : 'RELAY_CONTROL_PLANE_RESPONSE_FAILED',
    typeof record?.message === 'string' && record.message ? record.message : `Control Plane request failed with HTTP ${status}.`,
    retryable,
    status,
  );
}

function terminalRelaySessionFailure(error: unknown) {
  const { code, relayCloseReason } = (error ?? {}) as { code?: unknown; relayCloseReason?: unknown };
  return [code, relayCloseReason].some((value) => value !== undefined && [
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
  ].includes(String(value)));
}

function isE2eHandshakeTimeout(error: unknown) {
  const { code, relayCloseReason } = (error ?? {}) as { code?: unknown; relayCloseReason?: unknown };
  return code === 'RELAY_E2E_HANDSHAKE_TIMEOUT' || relayCloseReason === 'handshake-timeout';
}

function retryableRelayResumeFailure(error: unknown) {
  const code = String((error as { code?: unknown } | null)?.code ?? '');
  return [
    'RELAY_SOCKET_CLOSED',
    'RELAY_SOCKET_ERROR',
    'RELAY_SOCKET_FAILED',
    'RELAY_SOCKET_OPEN_TIMEOUT',
    'RELAY_SESSION_ATTACH_TIMEOUT',
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

function transportError(code: string, retryable = false, message = 'Cloud Relay connection is unavailable.') {
  return new MobileControlPlaneTransportError(code, message, retryable);
}

function attemptCancelled() {
  return transportError('RELAY_ATTEMPT_CANCELLED', true, 'Cloud Relay connection attempt was superseded.');
}
