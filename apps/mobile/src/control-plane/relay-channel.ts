import '../platform/random-values';
import * as Crypto from 'expo-crypto';
import { deflateSync, inflateSync } from 'fflate';
import { Platform } from 'react-native';
import nacl from 'tweetnacl';
import { isMobileTestMode, isTrustedMobileCloudRelayHost, mobileCloudEnvironment } from '../platform/build-variant';
import {
  decodeRelayFrame,
  encodeRelayFrame,
  packRelayPayload,
  RelaySessionClosedMessageSchema,
  RelaySessionRenewalResultSchema,
  RelaySessionResumeResultSchema,
  unpackRelayPayload,
  type RelayFramePayload,
  type RelayRoleProof,
  type RelaySessionGrant,
} from '@task-handoff/cloud-contracts/mobile';
import { decodeRelayResponseFrame, encodeRelayBodyFrame, isRelayResponseFrame, type RelayBodyFrame } from '@task-handoff/protocol/relay-body';
import type { EncryptedRelayChannel, RelayChannelFactory, RelayControlNotice, RelaySessionRenewal } from './relay-transport';
import { MobileControlPlaneTransportError } from './transport';
import { createNativeRelaySocket, isNativeRelaySocketAvailable } from '../../modules/task-handoff-browser/src';
import { diagnosticErrorDetails, diagnosticLog } from '../observability/diagnostic-logs';

type SocketDefaultEvent = { data?: unknown; code?: number; reason?: string; message?: string };
type SocketListener = (event: SocketDefaultEvent) => void;
type SocketEvent = 'open' | 'message' | 'error' | 'close';
type SocketLike = { readyState: number; bufferedAmount?: number; binaryType?: string; addEventListener(type: SocketEvent, listener: SocketListener): void; removeEventListener?(type: SocketEvent, listener: SocketListener): void; send(data: string | Uint8Array): void; close(code?: number, reason?: string): void };
type SocketFactory = (url: string) => SocketLike | Promise<SocketLike>;
export type MobileRelayChannelTimeouts = {
  socketOpenMs: number;
  attachMs: number;
  handshakeMs: number;
};
type ControlWaiter = {
  predicate(control: RelaySessionRenewal): boolean;
  resolve(value: RelaySessionRenewal): void;
  reject(error: unknown): void;
  timer: ReturnType<typeof setTimeout>;
};

export const MOBILE_RELAY_CHANNEL_TIMEOUTS: Readonly<MobileRelayChannelTimeouts> = Object.freeze({
  socketOpenMs: 10_000,
  attachMs: 8_000,
  handshakeMs: 8_000,
});
const RENEWAL_REPLY_TIMEOUT_MS = 10_000;
// Browsers and URLSession may dispatch `error` immediately before the terminal
// `close`. Waiting briefly lets the close code/reason win instead of replacing
// an actionable Relay rejection with a generic socket failure.
const SOCKET_ERROR_CLOSE_GRACE_MS = 100;

export function createMobileRelayChannelFactory(options: { webSocketFactory?: SocketFactory; allowRelayUrl?: (url: URL) => boolean; timeouts?: Partial<MobileRelayChannelTimeouts> } = {}): RelayChannelFactory {
  const timeouts = {
    socketOpenMs: timeoutOption(options.timeouts?.socketOpenMs, MOBILE_RELAY_CHANNEL_TIMEOUTS.socketOpenMs),
    attachMs: timeoutOption(options.timeouts?.attachMs, MOBILE_RELAY_CHANNEL_TIMEOUTS.attachMs),
    handshakeMs: timeoutOption(options.timeouts?.handshakeMs, MOBILE_RELAY_CHANNEL_TIMEOUTS.handshakeMs),
  };
  return async (input) => {
    const startedAt = Date.now();
    const base = {
      attemptId: input.attemptId,
      epoch: input.epoch,
      mode: input.mode,
      relayId: input.grant.relayId,
      allocationId: input.grant.allocationId,
      generation: input.grant.generation,
    };
    let relayHost: string | undefined;
    let socket: SocketLike | undefined;
    let phase: 'socket' | 'attach' | 'handshake' = 'socket';
    let phaseStartedAt = startedAt;
    try {
      const url = new URL(input.relayUrl);
      relayHost = url.hostname;
      // Test builds may use the plain-HTTP test cloud stack: allow ws:// there just like
      // direct Control Plane enrollment allows http://.
      const insecureAllowed = isMobileTestMode && url.protocol === 'ws:';
      if ((url.protocol !== 'wss:' && !insecureAllowed) || !(options.allowRelayUrl ?? cloudRelayUrl)(url)) {
        diagnosticLog.warn('relay.channel.rejected', { ...base, relayHost, reason: 'untrusted-relay-url' });
        throw relayError('UNTRUSTED_RELAY_URL');
      }
      diagnosticLog.info('relay.socket.connecting', { ...base, relayHost });
      const socketStartedAt = Date.now();
      const createdSocket = (options.webSocketFactory ?? defaultRelaySocketFactory)(url.toString());
      socket = createdSocket instanceof Promise
        ? await withTimeout(createdSocket, timeouts.socketOpenMs, 'RELAY_SOCKET_OPEN_TIMEOUT', closeLateSocket)
        : createdSocket;
      // Frames are binary; attach and the later session-renew acknowledgements
      // are the only text exchanges on this socket.
      socket.binaryType = 'arraybuffer';
      await waitForOpen(socket, remainingTimeout(timeouts.socketOpenMs, socketStartedAt));
      diagnosticLog.info('relay.socket.open', { ...base, relayHost, durationMs: Date.now() - socketStartedAt });
      const attach = input.mode === 'attach'
        ? { type: 'attach', capability: input.attach, grant: input.grant, proof: input.proof }
        : { type: 'session-attach', grant: input.grant, proof: input.proof };
      if (input.mode === 'attach' && !input.attach) throw relayError('RELAY_ATTACH_INVALID');
      const attachStartedAt = Date.now();
      phase = 'attach';
      phaseStartedAt = attachStartedAt;
      socket.send(JSON.stringify(attach));
      diagnosticLog.info('relay.attach.sent', { ...base, relayHost });
      const rawAttached = await nextMessage(socket, (value) => value?.type === 'attached', timeouts.attachMs, 'RELAY_SESSION_ATTACH_TIMEOUT');
      const attached = RelaySessionResumeResultSchema.safeParse(rawAttached);
      if (!attached.success || attached.data.sessionId !== input.grant.sessionId
        || attached.data.allocationId !== input.grant.allocationId
        || attached.data.generation < input.grant.generation) {
        throw relayError('RELAY_SESSION_ATTACH_INVALID');
      }
      diagnosticLog.info('relay.attach.accepted', { ...base, relayHost, durationMs: Date.now() - attachStartedAt, appliedGeneration: attached.data.generation });

      const ticket = input.grant.sessionTranscriptTicket;
      const keyPair = nacl.box.keyPair();
      const hello = {
        ticketId: ticket.transcriptTicketId,
        deviceSessionId: ticket.deviceSessionId,
        clientEphemeralPublicKey: base64Url(keyPair.publicKey),
      };
      let sendSequence = 0;
      const e2eStartedAt = Date.now();
      phase = 'handshake';
      phaseStartedAt = e2eStartedAt;
      socket.send(encodeRelayFrame({ kind: 'handshake', sequence: sendSequence++, payload: new TextEncoder().encode(JSON.stringify(hello)) }));
      const handshakeFrame = await nextFrame(socket, (frame) => frame.kind === 'handshake', timeouts.handshakeMs, 'RELAY_E2E_HANDSHAKE_TIMEOUT');
      const response = JSON.parse(new TextDecoder().decode(handshakeFrame.payload));
      const identityKey = fromBase64Url(response.controlPlanePublicKey);
      const fingerprint = `sha256:${base64Url(new Uint8Array(await Crypto.digest(Crypto.CryptoDigestAlgorithm.SHA256, identityKey)))}`;
      const transcript = await transcriptHash(ticket, hello.clientEphemeralPublicKey, response.serverEphemeralPublicKey);
      if (fingerprint !== input.targetPublicKeyFingerprint || response.transcript !== transcript || !nacl.sign.detached.verify(new TextEncoder().encode(transcript), fromBase64Url(response.signature), identityKey)) throw relayError('RELAY_E2E_IDENTITY_INVALID');
      // The Control Plane derives the session key from the raw X25519 shared secret
      // (packages/cloud-contracts/src/e2e.ts). nacl.box.before would apply the NaCl
      // box HSalsa20 transform on top, so the two sides would never agree.
      const shared = nacl.scalarMult(keyPair.secretKey, fromBase64Url(response.serverEphemeralPublicKey));
      const sessionKey = new Uint8Array(await Crypto.digest(Crypto.CryptoDigestAlgorithm.SHA256, concat(shared, new TextEncoder().encode(transcript), new TextEncoder().encode('task-handoff:control-plane-access:e2e:v1'))));
      diagnosticLog.info('relay.e2e.ready', { ...base, relayHost, durationMs: Date.now() - e2eStartedAt });
      diagnosticLog.info('relay.channel.ready', { ...base, relayHost, durationMs: Date.now() - startedAt, appliedGeneration: attached.data.generation });
      return new WebSocketEncryptedRelayChannel(socket, sessionKey, sendSequence, {
        attemptId: input.attemptId,
        relayId: input.grant.relayId,
        sessionId: input.grant.sessionId,
        allocationId: input.grant.allocationId,
        generation: attached.data.generation,
        leaseExpiresAt: attached.data.leaseExpiresAt,
      });
    } catch (error) {
      // The caller only ever sees the rejection, so a socket left behind by a failed
      // attach/handshake would stay open for the lifetime of the native WebSocket.
      try { socket?.close(4400, 'handshake-failed'); } catch { /* the socket may already be closed */ }
      diagnosticLog.error('relay.channel.failed', {
        ...base,
        relayHost,
        phase,
        phaseDurationMs: Date.now() - phaseStartedAt,
        phaseTimeoutMs: phase === 'socket' ? timeouts.socketOpenMs : phase === 'attach' ? timeouts.attachMs : timeouts.handshakeMs,
        durationMs: Date.now() - startedAt,
        ...diagnosticErrorDetails(error),
      });
      throw error;
    }
  };
}

export function allowCloudRelayUrlForService(url: URL, serviceOrigin: string, allowIsolatedEnvironment = false) {
  if (cloudRelayUrl(url)) return true;
  if (!allowIsolatedEnvironment) return false;
  const service = new URL(serviceOrigin);
  // Registered environments only ever reach the Relay hosts they declare.
  if (service.origin === mobileCloudEnvironment.serviceOrigin) return false;
  return url.hostname === service.hostname;
}

class WebSocketEncryptedRelayChannel implements EncryptedRelayChannel {
  leaseExpiresAt?: string;
  private readonly listeners = new Set<(value: any) => void>();
  private readonly closeListeners = new Set<(error?: unknown) => void>();
  private readonly controlListeners = new Set<(value: RelayControlNotice) => void>();
  private readonly controlWaiters = new Set<ControlWaiter>();
  private sendCounter = 0;
  private receiveCounter = 0;
  private receiveSequence = 1;
  private closedFlag = false;
  private readonly detachSocket: () => void;
  private readonly attemptId?: string;
  private readonly relayId?: string;
  private readonly sessionId: string;
  private readonly allocationId: string;
  readonly generation: number;

  constructor(
    private readonly socket: SocketLike,
    private readonly key: Uint8Array,
    private sendSequence: number,
    identity: { attemptId?: string; relayId?: string; sessionId: string; allocationId: string; generation: number; leaseExpiresAt?: string },
  ) {
    this.attemptId = identity.attemptId;
    this.relayId = identity.relayId;
    this.sessionId = identity.sessionId;
    this.allocationId = identity.allocationId;
    this.generation = identity.generation;
    this.leaseExpiresAt = identity.leaseExpiresAt;
    const onMessage = (event: SocketDefaultEvent) => {
      if (typeof event.data === 'string') this.receiveControl(event.data);
      else this.receive(event.data);
    };
    const onError = (event: SocketDefaultEvent) => this.closed(socketError(event, 'RELAY_SOCKET_ERROR'));
    const onClose = (event: SocketDefaultEvent) => this.closed(closeError(event));
    socket.addEventListener('message', onMessage);
    socket.addEventListener('error', onError);
    socket.addEventListener('close', onClose);
    this.detachSocket = () => {
      socket.removeEventListener?.('message', onMessage);
      socket.removeEventListener?.('error', onError);
      socket.removeEventListener?.('close', onClose);
    };
  }

  send(value: any) {
    if (this.socket.readyState !== 1) throw relayError('RELAY_CHANNEL_CLOSED', true);
    if ((this.socket.bufferedAmount ?? 0) > 2 * 1024 * 1024) throw relayError('RELAY_BACKPRESSURE_LIMIT', true);
    const plaintext = new TextEncoder().encode(JSON.stringify(value));
    const packed = packRelayPayload(plaintext, (input) => deflateSync(input));
    const sealed = nacl.secretbox(packed.payload, nonce(1, this.sendCounter++), this.key);
    this.socket.send(encodeRelayFrame({ kind: value.type === 'cancel' ? 'cancel' : 'data', sequence: this.sendSequence++, payload: sealed, flags: packed.flags }));
  }

  /**
   * One chunk of a binary request body. Chunks travel as `data` frames with
   * their own header, so the Relay still routes opaque bytes while the body
   * avoids the base64 envelope's ~33% growth and its single-frame size ceiling.
   * Chunks skip deflate: they are usually already-compressed file bytes, and
   * the sender window keeps the socket far below its backpressure limit.
   */
  sendBody(frame: RelayBodyFrame) {
    if (this.socket.readyState !== 1) throw relayError('RELAY_CHANNEL_CLOSED', true);
    if ((this.socket.bufferedAmount ?? 0) > 2 * 1024 * 1024) throw relayError('RELAY_BACKPRESSURE_LIMIT', true);
    const sealed = nacl.secretbox(encodeRelayBodyFrame(frame), nonce(1, this.sendCounter++), this.key);
    this.socket.send(encodeRelayFrame({ kind: 'data', sequence: this.sendSequence++, payload: sealed, flags: 0 }));
  }

  async renew(grant: RelaySessionGrant, proof: RelayRoleProof): Promise<RelaySessionRenewal> {
    if (this.closedFlag || this.socket.readyState !== 1) throw relayError('RELAY_CHANNEL_CLOSED', true);
    if (grant.sessionId !== this.sessionId || grant.allocationId !== this.allocationId) throw relayError('RELAY_SESSION_GRANT_INVALID');
    const renewal = this.waitForControl((value) => value.generation >= grant.generation, RENEWAL_REPLY_TIMEOUT_MS);
    // Text control shares the socket but not the E2E frame sequence. Sending it
    // here deliberately leaves sendSequence/receiveSequence untouched.
    const startedAt = Date.now();
    diagnosticLog.info('relay.renew.sent', this.logDetails({ generation: grant.generation }));
    try {
      this.socket.send(JSON.stringify({ type: 'session-renew', grant, proof }));
      const result = await renewal;
      diagnosticLog.info('relay.renew.acknowledged', this.logDetails({ durationMs: Date.now() - startedAt, generation: grant.generation, committed: result.committed }));
      return result;
    } catch (error) {
      diagnosticLog.warn('relay.renew.failed', this.logDetails({ durationMs: Date.now() - startedAt, generation: grant.generation, ...diagnosticErrorDetails(error) }));
      throw error;
    }
  }

  close(code = 1000, reason = 'normal') {
    diagnosticLog.info('relay.channel.close.requested', this.logDetails({ closeCode: code, reason }));
    try { this.socket.close(code, reason); }
    catch { this.closed(); }
  }

  subscribe(listener: (value: any) => void, onClose: (error?: unknown) => void) {
    this.listeners.add(listener);
    this.closeListeners.add(onClose);
    return () => {
      this.listeners.delete(listener);
      this.closeListeners.delete(onClose);
    };
  }

  subscribeControl(listener: (value: RelayControlNotice) => void) {
    this.controlListeners.add(listener);
    return () => { this.controlListeners.delete(listener); };
  }

  private receiveControl(raw: string) {
    try {
      const value = JSON.parse(raw);
      if (value?.type === 'renewed') {
        const parsed = RelaySessionRenewalResultSchema.safeParse(value);
        if (!parsed.success || parsed.data.sessionId !== this.sessionId) throw relayError('RELAY_PROTOCOL_INVALID');
        const control: RelayControlNotice = {
          type: 'renewed',
          sessionId: parsed.data.sessionId,
          generation: parsed.data.generation,
          committed: parsed.data.committed,
          leaseExpiresAt: parsed.data.leaseExpiresAt,
        };
        if (control.committed) this.leaseExpiresAt = control.leaseExpiresAt;
        this.resolveControl({
          generation: parsed.data.generation,
          committed: parsed.data.committed,
          leaseExpiresAt: parsed.data.leaseExpiresAt,
        });
        for (const listener of this.controlListeners) listener(control);
        return;
      }
      if (value?.type === 'peer-detached') {
        const control: RelayControlNotice = {
          type: 'peer-detached',
          ...(typeof value.sessionId === 'string' ? { sessionId: value.sessionId } : {}),
          ...(value.retryable === true ? { retryable: true } : {}),
        };
        diagnosticLog.warn('relay.peer.detached', this.logDetails({ retryable: control.retryable }));
        for (const listener of this.controlListeners) listener(control);
        return;
      }
      if (value?.type === 'session-closed') {
        const parsed = RelaySessionClosedMessageSchema.safeParse(value);
        if (!parsed.success || parsed.data.sessionId !== this.sessionId) throw relayError('RELAY_PROTOCOL_INVALID');
        const control: RelayControlNotice = {
          type: 'session-closed',
          sessionId: parsed.data.sessionId,
          code: parsed.data.code,
          retryable: parsed.data.retryable,
        };
        diagnosticLog.warn('relay.session.closed', this.logDetails({ code: control.code, retryable: control.retryable }));
        for (const listener of this.controlListeners) listener(control);
        return;
      }
      throw relayError('RELAY_PROTOCOL_INVALID');
    } catch (error) {
      this.closed(error);
      try { this.socket.close(4400, 'protocol-error'); } catch { /* already closed */ }
    }
  }

  private receive(raw: unknown) {
    try {
      const bytes = frameBytes(raw);
      if (!bytes) throw relayError('RELAY_FRAME_INVALID');
      const frame = decodeRelayFrame(bytes);
      if (frame.sequence !== this.receiveSequence++) throw relayError('RELAY_FRAME_SEQUENCE_INVALID');
      const opened = nacl.secretbox.open(frame.payload, nonce(2, this.receiveCounter++), this.key);
      if (!opened) throw relayError('RELAY_E2E_DECRYPT_FAILED');
      const plaintext = unpackRelayPayload(opened, frame.flags ?? 0, (input) => inflateSync(input));
      if (isRelayResponseFrame(plaintext)) {
        const chunk = decodeRelayResponseFrame(plaintext);
        const envelope = { type: 'response-chunk', responseId: chunk.responseId, offset: chunk.offset, bytes: chunk.bytes, final: chunk.final };
        for (const listener of this.listeners) listener(envelope);
        return;
      }
      const envelope = JSON.parse(new TextDecoder().decode(plaintext));
      for (const listener of this.listeners) listener(envelope);
    } catch (error) {
      this.closed(error);
      try { this.socket.close(4400, 'protocol-error'); } catch { /* already closed */ }
    }
  }

  private waitForControl(predicate: (control: RelaySessionRenewal) => boolean, timeoutMs: number) {
    return new Promise<RelaySessionRenewal>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.controlWaiters.delete(waiter);
        reject(relayError('RELAY_SESSION_RENEW_TIMEOUT', true));
      }, timeoutMs);
      const waiter: ControlWaiter = { predicate, resolve, reject, timer };
      this.controlWaiters.add(waiter);
    });
  }

  private resolveControl(control: RelaySessionRenewal) {
    for (const waiter of [...this.controlWaiters]) {
      if (!waiter.predicate(control)) continue;
      clearTimeout(waiter.timer);
      this.controlWaiters.delete(waiter);
      waiter.resolve(control);
    }
  }

  private closed(error?: unknown) {
    if (this.closedFlag) return;
    this.closedFlag = true;
    const details = this.logDetails({ ...diagnosticErrorDetails(error), ...(error ? { reason: 'socket-error' } : { reason: 'normal-close' }) });
    if (error) diagnosticLog.warn('relay.channel.closed', details);
    else diagnosticLog.info('relay.channel.closed', details);
    this.detachSocket();
    for (const waiter of this.controlWaiters) {
      clearTimeout(waiter.timer);
      waiter.reject(error ?? relayError('RELAY_CHANNEL_CLOSED', true));
    }
    this.controlWaiters.clear();
    for (const listener of this.closeListeners) listener(error);
    this.listeners.clear();
    this.closeListeners.clear();
    this.controlListeners.clear();
  }

  private logDetails(data: Record<string, unknown> = {}) {
    return {
      ...(this.attemptId ? { attemptId: this.attemptId } : {}),
      ...(this.relayId ? { relayId: this.relayId } : {}),
      allocationId: this.allocationId,
      channelGeneration: this.generation,
      ...data,
    };
  }
}

function cloudRelayUrl(url: URL) { return isTrustedMobileCloudRelayHost(url); }

function defaultRelaySocketFactory(url: string): SocketLike | Promise<SocketLike> {
  if (Platform.OS === 'ios' && isNativeRelaySocketAvailable()) return createNativeRelaySocket(url);
  return new WebSocket(url) as unknown as SocketLike;
}

function waitForOpen(socket: SocketLike, timeoutMs: number) {
  return new Promise<void>((resolve, reject) => {
    let errorTimer: ReturnType<typeof setTimeout> | undefined;
    const timer = setTimeout(() => {
      cleanup();
      reject(relayError('RELAY_SOCKET_OPEN_TIMEOUT', true));
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      if (errorTimer) clearTimeout(errorTimer);
      socket.removeEventListener?.('open', opened);
      socket.removeEventListener?.('error', failed);
      socket.removeEventListener?.('close', closed);
    };
    const opened = () => { cleanup(); resolve(); };
    const failed = (event: SocketDefaultEvent) => {
      if (errorTimer) return;
      errorTimer = setTimeout(() => { cleanup(); reject(socketError(event)); }, SOCKET_ERROR_CLOSE_GRACE_MS);
    };
    const closed = (event: SocketDefaultEvent) => { cleanup(); reject(closeError(event)); };
    socket.addEventListener('open', opened);
    socket.addEventListener('error', failed);
    socket.addEventListener('close', closed);
  });
}

// A one-shot wait must stop listening the moment it settles: a long-lived channel would
// otherwise keep parsing every incoming frame once per completed wait.
function nextMessage(socket: SocketLike, predicate: (value: any) => boolean, timeoutMs: number, timeoutCode: string) {
  return new Promise<any>((resolve, reject) => {
    let errorTimer: ReturnType<typeof setTimeout> | undefined;
    const timer = setTimeout(() => {
      cleanup();
      reject(relayError(timeoutCode, true));
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      if (errorTimer) clearTimeout(errorTimer);
      socket.removeEventListener?.('message', message);
      socket.removeEventListener?.('error', failed);
      socket.removeEventListener?.('close', closed);
    };
    const message = (event: SocketDefaultEvent) => {
      try {
        const value = JSON.parse(String(event.data));
        if (!predicate(value)) return;
        cleanup();
        resolve(value);
      } catch {
        cleanup();
        reject(relayError('RELAY_PROTOCOL_INVALID'));
      }
    };
    const failed = (event: SocketDefaultEvent) => {
      if (errorTimer) return;
      errorTimer = setTimeout(() => { cleanup(); reject(socketError(event)); }, SOCKET_ERROR_CLOSE_GRACE_MS);
    };
    const closed = (event: SocketDefaultEvent) => { cleanup(); reject(closeError(event)); };
    socket.addEventListener('message', message);
    socket.addEventListener('error', failed);
    socket.addEventListener('close', closed);
  });
}

// Binary frames travel as ArrayBuffer once `binaryType` is set; the React Native
// WebSocket normalizes to ArrayBuffer the same way the browser does.
// Everything after attach is binary; a text message here is a protocol violation.
function nextFrame(socket: SocketLike, predicate: (frame: RelayFramePayload) => boolean, timeoutMs: number, timeoutCode: string) {
  return new Promise<RelayFramePayload>((resolve, reject) => {
    let errorTimer: ReturnType<typeof setTimeout> | undefined;
    const timer = setTimeout(() => {
      cleanup();
      reject(relayError(timeoutCode, true));
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      if (errorTimer) clearTimeout(errorTimer);
      socket.removeEventListener?.('message', message);
      socket.removeEventListener?.('error', failed);
      socket.removeEventListener?.('close', closed);
    };
    const message = (event: SocketDefaultEvent) => {
      try {
        const bytes = frameBytes(event.data);
        if (!bytes) throw relayError('RELAY_PROTOCOL_INVALID');
        const frame = decodeRelayFrame(bytes);
        if (!predicate(frame)) return;
        cleanup();
        resolve(frame);
      } catch (error) {
        cleanup();
        reject(error);
      }
    };
    const failed = (event: SocketDefaultEvent) => {
      if (errorTimer) return;
      errorTimer = setTimeout(() => { cleanup(); reject(socketError(event)); }, SOCKET_ERROR_CLOSE_GRACE_MS);
    };
    const closed = (event: SocketDefaultEvent) => { cleanup(); reject(closeError(event)); };
    socket.addEventListener('message', message);
    socket.addEventListener('error', failed);
    socket.addEventListener('close', closed);
  });
}

function frameBytes(raw: unknown) {
  if (raw instanceof Uint8Array) return raw;
  if (raw instanceof ArrayBuffer) return new Uint8Array(raw);
  return undefined;
}

function remainingTimeout(timeoutMs: number, startedAt: number) {
  return Math.max(1, timeoutMs - (Date.now() - startedAt));
}

function timeoutOption(value: number | undefined, fallback: number) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, timeoutCode: string, onLateValue?: (value: T) => void) {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      reject(relayError(timeoutCode, true));
    }, timeoutMs);
    promise.then(
      (value) => {
        if (settled) {
          try { onLateValue?.(value); } catch { /* late-resource cleanup is best effort */ }
          return;
        }
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function closeLateSocket(socket: SocketLike) {
  try { socket.close(4400, 'handshake-timeout'); } catch { /* the socket may already be closed */ }
}

async function transcriptHash(ticket: { audience: string; transcriptTicketId?: string; ticketId?: string; accountId: string; deviceSessionId: string; controlPlaneId: string; bindingId: string; bindingRevision: number; nonce: string; accessMode?: string; ownerAccountId?: string; shareGrantId?: string; shareRevision?: number; shareRole?: string }, clientKey: string, serverKey: string) {
  const canonical = canonicalJson({
    audience: ticket.audience,
    ticketId: ticket.transcriptTicketId ?? ticket.ticketId,
    accountId: ticket.accountId,
    deviceSessionId: ticket.deviceSessionId,
    controlPlaneId: ticket.controlPlaneId,
    bindingId: ticket.bindingId,
    bindingRevision: ticket.bindingRevision,
    nonce: ticket.nonce,
    clientEphemeralPublicKey: clientKey,
    serverEphemeralPublicKey: serverKey,
    ...(ticket.accessMode === undefined ? {} : {
      ownerAccountId: ticket.ownerAccountId,
      accessMode: ticket.accessMode,
      ...(ticket.shareGrantId === undefined ? {} : { shareGrantId: ticket.shareGrantId, shareRevision: ticket.shareRevision, shareRole: ticket.shareRole }),
    }),
  });
  return base64Url(new Uint8Array(await Crypto.digest(Crypto.CryptoDigestAlgorithm.SHA256, new TextEncoder().encode(canonical))));
}

function canonicalJson(value: any): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
  return JSON.stringify(value);
}

function nonce(direction: number, counter: number) {
  const value = new Uint8Array(24);
  value[0] = direction;
  for (let index = 0; index < 6; index += 1) value[23 - index] = (counter / (2 ** (8 * index))) & 255;
  return value;
}

function concat(...values: Uint8Array[]) {
  const length = values.reduce((sum, value) => sum + value.length, 0);
  const result = new Uint8Array(length);
  let offset = 0;
  for (const value of values) { result.set(value, offset); offset += value.length; }
  return result;
}

function base64Url(value: Uint8Array) {
  let binary = '';
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function fromBase64Url(value: string) {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(normalized + '='.repeat((4 - normalized.length % 4) % 4));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function closeError(event: SocketDefaultEvent) {
  const close = socketCloseDetails(event);
  const reason = close.relayCloseReason ?? '';
  const message = socketCloseMessage(event);
  if (/^RELAY_[A-Z0-9_]+$/.test(reason)) return relayError(reason, retryableRelayClose(reason), message, close);
  return relayError('RELAY_SOCKET_CLOSED', true, message, close);
}

function socketError(event: SocketDefaultEvent, code = 'RELAY_SOCKET_FAILED') {
  const detail = closeDetailText(event);
  const message = typeof event.message === 'string' && event.message
    ? event.message
    : detail ? `Cloud Relay socket failed (${detail}).` : 'Cloud Relay channel failed.';
  return relayError(code, true, message, socketCloseDetails(event));
}

function socketCloseDetails(event: SocketDefaultEvent) {
  return {
    ...(typeof event.code === 'number' && Number.isFinite(event.code) ? { relayCloseCode: event.code } : {}),
    ...(typeof event.reason === 'string' && event.reason ? { relayCloseReason: event.reason.slice(0, 240) } : {}),
  };
}

function socketCloseMessage(event: SocketDefaultEvent) {
  const detail = closeDetailText(event);
  return detail ? `Cloud Relay closed the socket (${detail}).` : 'Cloud Relay channel closed.';
}

function closeDetailText(event: SocketDefaultEvent) {
  const code = typeof event.code === 'number' && Number.isFinite(event.code) ? String(event.code) : '';
  const reason = typeof event.reason === 'string' ? event.reason.slice(0, 240) : '';
  return code && reason ? `${code}: ${reason}` : code || reason;
}

function retryableRelayClose(reason: string) {
  return ['RELAY_SESSION_REVOCATION_SYNC_PENDING', 'RELAY_DRAINING', 'RELAY_PROTOCOL_ERROR'].includes(reason);
}

function relayError(code: string, retryable = false, message = 'Cloud Relay channel failed.', close?: { relayCloseCode?: number; relayCloseReason?: string }) {
  return new MobileControlPlaneTransportError(code, message, retryable, undefined, close?.relayCloseCode, close?.relayCloseReason);
}
