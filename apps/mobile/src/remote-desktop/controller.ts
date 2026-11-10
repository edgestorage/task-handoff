import {
  DesktopFallbackFrameAssembler,
  REMOTE_DESKTOP_CHANNEL_VERSION,
  REMOTE_DESKTOP_MAX_MESSAGE_BYTES,
  REMOTE_DESKTOP_SIGNAL_SUBPROTOCOL,
  decodeDesktopFallbackFrame,
} from '@task-handoff/protocol/remote-desktop';
import type {
  DesktopCreated,
  DesktopFallbackSession,
  DesktopIceServer,
  DesktopSessionSnapshot,
} from '@task-handoff/protocol/remote-desktop';
import { RTCPeerConnection } from 'react-native-webrtc';

import {
  closeRemoteDesktopDecoder,
  configureRemoteDesktopDecoder,
  decodeRemoteDesktopFrame,
  resetRemoteDesktopDecoder,
  subscribeRemoteDesktopDecoderErrors,
} from '../../modules/task-handoff-remote-desktop/src';
import { diagnosticLog } from '../observability/diagnostic-logs';
import type { MobileAuthenticatedWebSocket, MobileControlPlaneTransport } from '../control-plane/transport';
import type { createControlPlaneRemoteDesktopApi } from '@task-handoff/control-plane-client';
import {
  REMOTE_DESKTOP_RESOLUTION_PRESETS,
  captureTargetForProtocol,
  type PersistedCaptureTarget,
  type RemoteDesktopFrameRate,
  type RemoteDesktopResolution,
  type RemoteDesktopTransportAvailability,
  type RemoteDesktopTransportKey,
} from './preferences';
import {
  REMOTE_DESKTOP_FALLBACK_RETRY_MS,
  nextRemoteDesktopFallbackDeadline,
  remoteDesktopWebRTCProgress,
} from './fallback-policy';
import {
  emptyRemoteDesktopSnapshot,
  type RemoteDesktopPath,
  type RemoteDesktopSnapshot,
  type RemoteDesktopTransportState,
} from './types';

const FALLBACK_HEAD_START_MS = 1_200;
const CONNECTION_START_TIMEOUT_MS = 20_000;
const NEGOTIATION_TIMEOUT_MS = 15_000;
const ICE_RECOVERY_TIMEOUT_MS = 15_000;
const FALLBACK_PAIR_TIMEOUT_MS = 10_000;
const FALLBACK_UPGRADE_RETRY_MS = 1_000;
const FALLBACK_UPGRADE_TIMEOUT_MS = 10_000;
const STATS_INTERVAL_MS = 2_000;
const INPUT_ALIVE_MS = 500;
const SIGNAL_ALIVE_MS = 2_000;
const MAX_DECODE_BACKLOG = 2;

type RemoteDesktopApi = ReturnType<typeof createControlPlaneRemoteDesktopApi>;
type DataChannel = ReturnType<RTCPeerConnection['createDataChannel']>;
type ChannelName = 'control' | 'input' | 'pointer' | 'clipboard';
type WireChannel = { readonly readyState: number | string; send(data: string): void };

export type RemoteDesktopControllerInput = {
  api: RemoteDesktopApi;
  transport: MobileControlPlaneTransport;
  instanceId: string;
  active?: boolean;
  target: PersistedCaptureTarget;
  resolution: RemoteDesktopResolution;
  frameRate: RemoteDesktopFrameRate;
  transportAvailability: RemoteDesktopTransportAvailability;
};

export class RemoteDesktopController {
  private snapshotValue: RemoteDesktopSnapshot;
  private readonly listeners = new Set<() => void>();
  private session?: DesktopCreated;
  private peer?: RTCPeerConnection;
  private signal?: MobileAuthenticatedWebSocket;
  private channels = new Map<ChannelName, DataChannel>();
  private fallbackMedia?: MobileAuthenticatedWebSocket;
  private fallbackControl?: MobileAuthenticatedWebSocket;
  private fallbackAssembler = new DesktopFallbackFrameAssembler();
  private fallbackSession?: DesktopFallbackSession;
  private fallbackState: 'idle' | 'switching' | 'active' | 'reconnecting' | 'failed' = 'idle';
  private fallbackAttempt = 0;
  private fallbackDeadline = 0;
  private fallbackNeedsKeyframe = true;
  private fallbackFirstFrame = false;
  private fallbackLastKeyframeAt = 0;
  private fallbackCodec = '';
  private fallbackConfigKey = '';
  private fallbackUpgradeStartedAt = 0;
  private epoch = 0;
  private seq = 0;
  private destroyed = false;
  private active = true;
  private starting = false;
  private stopping = false;
  private signalOpen = false;
  private inputEpoch = 0;
  private inputAliveTimer?: ReturnType<typeof setInterval>;
  private signalAliveTimer?: ReturnType<typeof setInterval>;
  private offerInFlight = false;
  private fallbackHeadStartTimer?: ReturnType<typeof setTimeout>;
  private startupTimer?: ReturnType<typeof setTimeout>;
  private negotiationTimer?: ReturnType<typeof setTimeout>;
  private recoveryTimer?: ReturnType<typeof setTimeout>;
  private fallbackPairTimer?: ReturnType<typeof setTimeout>;
  private fallbackRetryTimer?: ReturnType<typeof setTimeout>;
  private fallbackUpgradeTimer?: ReturnType<typeof setTimeout>;
  private statsTimer?: ReturnType<typeof setTimeout>;
  private availabilityTimer?: ReturnType<typeof setTimeout>;
  private decodeQueue = Promise.resolve();
  private decodeBacklog = 0;
  private fallbackDiagnosticFrames = 0;
  private decoderErrorSubscription?: { remove(): void };
  private stopDecoderSubscription?: () => void;

  constructor(private readonly input: RemoteDesktopControllerInput) {
    this.active = input.active !== false;
    this.snapshotValue = {
      ...emptyRemoteDesktopSnapshot,
      paused: !this.active,
      target: input.target,
      resolution: input.resolution,
      frameRate: input.frameRate,
      transportAvailability: { ...input.transportAvailability },
    };
    try {
      this.decoderErrorSubscription = subscribeRemoteDesktopDecoderErrors(() => {
        if (this.destroyed || this.fallbackState === 'idle') return;
        this.fallbackNeedsKeyframe = true;
        void resetRemoteDesktopDecoder().catch(() => undefined);
        this.requestFallbackKeyframe();
      });
    } catch {
      // The optional decoder module reports its own unavailability when a frame arrives.
    }
  }

  getSnapshot = () => this.snapshotValue;

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  async start() {
    if (this.destroyed || this.starting || this.session) return;
    this.starting = true;
    this.stopping = false;
    this.update({ phase: 'connecting', error: undefined });
    this.armStartupTimeout();
    try {
      const created = await this.input.api.createSession(this.input.instanceId, captureTargetForProtocol(this.snapshotValue.target));
      if (this.destroyed || this.stopping) {
        await this.input.api.stop(this.input.instanceId, created.snapshot.viewerSessionId).catch(() => undefined);
        return;
      }
      this.session = created;
      diagnosticLog.info('remote.desktop.session.created', { viewerSessionId: created.snapshot.viewerSessionId, target: this.snapshotValue.target.kind });
      this.applySnapshot(created.snapshot);
      const availability = this.snapshotValue.transportAvailability;
      if (!availability.p2p && !availability.turn && !availability.websocket) {
        await this.fail('REMOTE_DESKTOP_TRANSPORT_DISABLED', 'All remote desktop connection methods are disabled.');
        return;
      }
      // Signaling attaches the component-side viewer session. Both WebRTC and
      // WebSocket fallback operate on that live peer, so they must wait for it.
      this.openSignal(created);
    } catch (cause) {
      await this.failFromCause(cause);
    } finally {
      this.starting = false;
    }
  }

  async close() {
    if (this.destroyed) return;
    this.destroyed = true;
    await this.stopCurrentSession(true);
    await closeRemoteDesktopDecoder().catch(() => undefined);
    this.stopDecoderSubscription?.();
    this.stopDecoderSubscription = undefined;
    this.decoderErrorSubscription?.remove();
    this.decoderErrorSubscription = undefined;
    this.listeners.clear();
  }

  async disconnect() {
    if (this.destroyed) return;
    await this.stopCurrentSession(true);
    this.update({ phase: 'stopped', error: undefined, paused: false });
  }

  async switchTarget(target: PersistedCaptureTarget) {
    if (this.destroyed || sameTarget(this.snapshotValue.target, target)) return;
    // A new capture target is a new component session. Keeping the old
    // reservation alive leaves the component busy for the replacement.
    await this.stopCurrentSession(true);
    this.update({ target, error: undefined, phase: 'connecting', streamURL: undefined, videoWidth: 0, videoHeight: 0, path: undefined, signalingReady: false });
    if (this.active) await this.start();
  }

  setActive(active: boolean) {
    if (this.destroyed || this.active === active) return;
    this.active = active;
    this.update({ paused: !active, phase: active ? (this.snapshotValue.phase === 'paused' ? 'connected' : this.snapshotValue.phase) : 'paused' });
    this.sendVisibility();
    if (!active) {
      this.clearStartupTimeout();
      this.suspendInput();
      return;
    }
    if (this.snapshotValue.phase === 'connecting' || this.snapshotValue.phase === 'reconnecting') this.armStartupTimeout();
    this.requestKeyframe();
    if (this.snapshotValue.inputRequested) this.resumeWanted();
  }

  setResolution(resolution: RemoteDesktopResolution) {
    if (resolution === this.snapshotValue.resolution) return;
    this.update({ resolution });
    this.applyStreamResolution();
  }

  setFrameRate(frameRate: RemoteDesktopFrameRate) {
    if (frameRate === this.snapshotValue.frameRate) return;
    this.update({ frameRate });
    this.applyStreamResolution();
  }

  setTransportAvailability(availability: RemoteDesktopTransportAvailability) {
    if (sameAvailability(availability, this.snapshotValue.transportAvailability)) return;
    this.update({ transportAvailability: { ...availability } });
    if (!this.session) return;
    if (this.availabilityTimer) clearTimeout(this.availabilityTimer);
    this.availabilityTimer = setTimeout(() => {
      this.availabilityTimer = undefined;
      if (this.destroyed || !this.session || this.stopping) return;
      void this.reconnectForTransportPolicy();
    }, 150);
  }

  requestControl() {
    if (this.destroyed || this.snapshotValue.isController || this.snapshotValue.controlRequestPending) return;
    if (!this.wire('control', 'control.request')) return;
    this.update({ controlRequestPending: true, inputRequested: true });
  }

  enableInput() {
    if (this.destroyed) return;
    this.update({ inputRequested: true });
    if (!this.snapshotValue.isController) {
      this.requestControl();
      return;
    }
    this.resumeWanted();
  }

  disableInput() {
    this.update({ inputRequested: false });
    this.suspendInput();
  }

  requestKeyboard() {
    this.enableInput();
  }

  sendPointer(x: number, y: number) {
    if (!this.inputReady()) return;
    this.wire('pointer', 'pointer', { x: clamp01(x), y: clamp01(y), inputEpoch: this.inputEpoch });
  }

  sendButton(x: number, y: number, button: number, down: boolean) {
    if (!this.inputReady()) return;
    this.wire('input', 'button', { x: clamp01(x), y: clamp01(y), button, down, inputEpoch: this.inputEpoch });
  }

  sendWheel(x: number, y: number, deltaX: number, deltaY: number) {
    if (!this.inputReady()) return;
    this.wire('input', 'wheel', {
      x: clamp01(x),
      y: clamp01(y),
      deltaX: Math.max(-10_000, Math.min(10_000, deltaX)),
      deltaY: Math.max(-10_000, Math.min(10_000, deltaY)),
      inputEpoch: this.inputEpoch,
    });
  }

  sendKey(code: string, down: boolean, modifiers = 0, repeat = false) {
    if (!this.inputReady()) return;
    this.wire('input', 'key', { inputEpoch: this.inputEpoch, code, down, modifiers, repeat });
  }

  sendText(text: string) {
    if (!this.inputReady() || !text) return;
    this.wire('input', 'text.commit', { inputEpoch: this.inputEpoch, text });
  }

  requestKeyframe() {
    if (this.fallbackState === 'active') this.requestFallbackKeyframe();
    else this.wire('control', 'stream.keyframe');
  }

  private openSignal(created: DesktopCreated) {
    const epoch = ++this.epoch;
    const previous = this.signal;
    this.signal = undefined;
    try { previous?.close(); } catch { /* Replaced sockets are best effort. */ }
    try {
      this.signal = this.input.transport.openAuthenticatedWebSocket?.({
        path: created.signalUrl,
        protocols: [REMOTE_DESKTOP_SIGNAL_SUBPROTOCOL],
      }, {
        onOpen: () => {
          if (!this.current(epoch)) return;
          this.signalOpen = true;
          diagnosticLog.info('remote.desktop.signal.open');
          this.startSignalAlive();
          this.sendSignalAlive();
        },
        onMessage: (data) => {
          if (this.current(epoch) && typeof data === 'string') this.handleSignalMessage(data);
        },
        onError: () => {
          if (!this.current(epoch)) return;
          this.signalOpen = false;
          this.stopSignalAlive();
          diagnosticLog.warn('remote.desktop.signal.error', { signalingReady: this.snapshotValue.signalingReady });
          this.considerFallbackAfterSignalFailure('REMOTE_DESKTOP_SIGNAL_SOCKET_ERROR');
        },
        onClose: (event) => {
          if (!this.current(epoch)) return;
          this.signalOpen = false;
          this.stopSignalAlive();
          diagnosticLog.warn('remote.desktop.signal.close', { signalingReady: this.snapshotValue.signalingReady, code: event.code, reason: event.reason });
          this.considerFallbackAfterSignalFailure('REMOTE_DESKTOP_SIGNAL_CLOSED');
        },
      });
      if (!this.signal) throw Object.assign(new Error('Remote desktop signaling is unavailable for this profile.'), { code: 'REMOTE_DESKTOP_TRANSPORT_UNAVAILABLE' });
    } catch (cause) {
      this.signalOpen = false;
      this.considerFallbackAfterSignalFailure(errorCode(cause));
    }
  }

  private handleSignalMessage(text: string) {
    let value: any;
    try { value = JSON.parse(text); } catch { return; }
    const epoch = this.epoch;
    void (async () => {
      try {
        if (value?.type === 'snapshot' && value.snapshot) {
          this.applySnapshot(value.snapshot);
        } else if (value?.type === 'ready') {
          if (!this.current(epoch)) return;
          diagnosticLog.info('remote.desktop.signal.ready');
          this.update({ signalingReady: true });
          this.applyStreamResolution();
          const availability = this.snapshotValue.transportAvailability;
          if (availability.p2p || availability.turn) {
            if (!this.peer) this.setupPeer();
            if (this.peer && !this.peer.localDescription) {
              try {
                await this.startOffer(false);
                this.armFallbackHeadStart();
              } catch (cause) {
                this.handleWebRTCStartFailure(cause);
              }
            } else {
              this.armFallbackHeadStart();
            }
          } else {
            void this.beginFallback('ice-failed', 'REMOTE_DESKTOP_ALL_WEBRTC_TRANSPORTS_DISABLED', false);
          }
        } else if (value?.type === 'answer') {
          if (!this.current(epoch) || !this.peer || typeof value.sdp !== 'string') return;
          try { await this.peer.setRemoteDescription({ type: 'answer', sdp: value.sdp }); }
          catch (cause) { this.handleWebRTCStartFailure(cause); }
        } else if (value?.type === 'candidate' && this.peer && value.candidate) {
          await this.peer.addIceCandidate(value.candidate).catch(() => undefined);
        } else if (value?.type === 'configureIce' && this.peer) {
          this.peer.setConfiguration(this.iceConfiguration(value.iceServers));
        } else if (value?.type === 'iceRenewed' && this.peer) {
          this.peer.setConfiguration(this.iceConfiguration(value.iceServers));
        } else if (value?.type === 'iceConfiguration' && this.peer) {
          this.peer.setConfiguration(this.iceConfiguration(value.iceServers));
          await this.startOffer(true);
        } else if (value?.type === 'error') {
          const code = typeof value.code === 'string' ? value.code : 'REMOTE_DESKTOP_SIGNAL_INVALID';
          if (this.fallbackState !== 'idle' && ['REMOTE_DESKTOP_NEGOTIATION_FAILED', 'REMOTE_DESKTOP_ICE_CONFIG_INVALID', 'REMOTE_DESKTOP_CANDIDATE_INVALID'].includes(code)) return;
          if (!this.snapshotValue.signalingReady) {
            void this.fail(code, 'Remote desktop session initialization failed.');
            return;
          }
          const state = this.peer?.iceConnectionState;
          if (this.fallbackState === 'idle' && state !== 'connected' && state !== 'completed') {
            void this.beginFallback('recovery-timeout', code, false);
          }
        }
      } catch {
        // Malformed signaling is reflected by the next state transition; it must
        // not crash the viewer or hide the fallback path.
      }
    })();
  }

  private setupPeer() {
    if (this.peer || this.destroyed || !this.session) return;
    let peer: RTCPeerConnection;
    try {
      peer = new RTCPeerConnection(this.iceConfiguration(this.session.iceServers));
    } catch (cause) {
      this.considerFallbackAfterSignalFailure(errorCode(cause));
      return;
    }
    this.peer = peer;
    peer.addTransceiver('video', { direction: 'recvonly' });
    for (const [label, id] of [['control', 0], ['input', 1], ['pointer', 2], ['clipboard', 3]] as const) {
      const options = { negotiated: true, id, ordered: label !== 'pointer', ...(label === 'pointer' ? { maxRetransmits: 0 } : {}) };
      const channel = peer.createDataChannel(label, options);
      this.channels.set(label, channel);
      if (label === 'control') {
        channel.onmessage = (event: any) => this.handleControlMessage(event?.data);
        channel.onopen = () => {
          this.sendVisibility();
          this.applyStreamResolution();
          if (this.snapshotValue.inputRequested) this.resumeWanted();
        };
      } else if (label === 'clipboard') {
        channel.onmessage = (event: any) => this.handleControlMessage(event?.data);
      }
    }
    peer.addEventListener('track', (event: any) => {
      if (this.peer !== peer) return;
      const stream = event?.streams?.[0];
      if (!stream) return;
      const url = typeof stream.toURL === 'function' ? stream.toURL() : undefined;
      if (url) this.update({ streamURL: url, path: this.snapshotValue.path || 'p2p' });
      this.applyPath(this.snapshotValue.path);
    });
    peer.addEventListener('icecandidate', (event: any) => {
      if (this.peer !== peer || !this.signalOpen || !event?.candidate) return;
      this.sendSignal({
        type: 'candidate',
        requestId: requestId(),
        candidate: {
          candidate: event.candidate.candidate,
          sdpMid: event.candidate.sdpMid ?? null,
          sdpMLineIndex: event.candidate.sdpMLineIndex ?? null,
        },
      });
    });
    peer.addEventListener('iceconnectionstatechange', () => {
      if (this.peer !== peer) return;
      const state = peer.iceConnectionState;
      if (state === 'connected' || state === 'completed') {
        this.clearWebRTCTimers();
        this.clearStartupTimeout();
        this.update({ phase: this.snapshotValue.paused ? 'paused' : 'connected' });
        this.startStatsWatch(peer);
        if (this.fallbackState === 'active' || this.fallbackState === 'switching') this.requestTransportUpgrade();
      } else if (state === 'failed') {
        void this.beginFallback('ice-failed', 'REMOTE_DESKTOP_ICE_FAILED', false);
      } else if (state === 'disconnected') {
        this.armRecoveryTimer();
      }
    });
    peer.addEventListener('connectionstatechange', () => {
      if (this.peer !== peer) return;
      if (peer.connectionState === 'connected') {
        this.clearWebRTCTimers();
        this.clearStartupTimeout();
        this.update({ phase: this.snapshotValue.paused ? 'paused' : 'connected' });
        this.startStatsWatch(peer);
        if (this.fallbackState === 'active' || this.fallbackState === 'switching') this.requestTransportUpgrade();
      } else if (peer.connectionState === 'failed') {
        void this.beginFallback('ice-failed', 'REMOTE_DESKTOP_ICE_FAILED', false);
      }
    });
  }

  private async startOffer(iceRestart: boolean) {
    const peer = this.peer;
    if (!peer || !this.signalOpen || this.offerInFlight) return;
    this.offerInFlight = true;
    try {
      const offer = await peer.createOffer(iceRestart ? { iceRestart: true } : undefined);
      await peer.setLocalDescription(offer);
      this.sendSignal({ type: 'offer', requestId: requestId(), sdp: offer.sdp });
      if (!iceRestart) this.armNegotiationTimeout();
    } finally {
      this.offerInFlight = false;
    }
  }

  private sendSignal(value: unknown) {
    if (!this.signalOpen || !this.signal) return;
    try { this.signal.send(JSON.stringify(value)); } catch { /* close handler owns fallback */ }
  }

  private iceConfiguration(servers: DesktopIceServer[] | undefined = this.session?.iceServers) {
    const availability = this.snapshotValue.transportAvailability;
    const filtered = (servers ?? []).flatMap((server) => {
      const urls = server.urls.filter((url) => /^turns?:/i.test(url) ? availability.turn : availability.p2p);
      return urls.length ? [{ ...server, urls }] : [];
    });
    return {
      iceServers: filtered,
      iceTransportPolicy: availability.p2p ? 'all' as const : 'relay' as const,
    };
  }

  private async applySnapshot(snapshot: DesktopSessionSnapshot) {
    if (this.destroyed) return;
    if (snapshot.phase === 'stopped' || snapshot.phase === 'failed') {
      await this.fail(snapshot.reason || 'REMOTE_DESKTOP_SESSION_CLOSED', 'The remote desktop session ended.');
      return;
    }
    if (!snapshot.isController) {
      this.releaseInputState();
      this.update({ inputRequested: false, controlRequestPending: false });
    } else if (this.snapshotValue.controlRequestPending) {
      this.update({ controlRequestPending: false });
      if (this.snapshotValue.inputRequested) this.resumeWanted();
    }
    this.update({
      session: snapshot,
      isController: snapshot.isController,
      hasController: snapshot.hasController,
      viewerCount: snapshot.viewerCount,
    });
    if (snapshot.transport === 'webrtc' && this.fallbackState !== 'idle') this.commitTransportUpgrade();
  }

  private async beginFallback(reason: 'ice-failed' | 'recovery-timeout', diagnosticCode: string | undefined, proactive: boolean) {
    if (this.destroyed || !this.session || this.fallbackState !== 'idle' || !this.snapshotValue.transportAvailability.websocket) return;
    if (!this.snapshotValue.signalingReady) {
      diagnosticLog.warn('remote.desktop.fallback.not-ready', { reason, diagnosticCode, proactive });
      return;
    }
    this.clearFallbackHeadStart();
    if (!proactive) {
      this.clearNegotiationTimer();
      this.clearRecoveryTimer();
    }
    this.fallbackState = 'switching';
    this.fallbackAttempt += 1;
    this.fallbackDeadline = nextRemoteDesktopFallbackDeadline(Date.now(), this.fallbackDeadline);
    this.updateTransportState('websocket', 'pending');
    this.suspendInput();
    const attempt = this.fallbackAttempt;
    diagnosticLog.info('remote.desktop.fallback.begin', { attempt, reason, diagnosticCode, proactive, deadline: this.fallbackDeadline });
    try {
      const info = await this.input.api.fallback(this.input.instanceId, this.session.snapshot.viewerSessionId, reason, diagnosticCode);
      if (this.destroyed || attempt !== this.fallbackAttempt) return;
      this.fallbackSession = info;
      diagnosticLog.info('remote.desktop.fallback.ticket', { attempt, generation: info.fallbackGeneration });
      this.openFallbackSockets(info, attempt);
    } catch (cause) {
      if (this.destroyed || attempt !== this.fallbackAttempt) return;
      diagnosticLog.warn('remote.desktop.fallback.ticket.failed', { attempt, proactive, code: errorCode(cause), message: errorMessage(cause) });
      if (proactive) {
        if (remoteDesktopWebRTCProgress(Boolean(this.peer), this.peer?.iceConnectionState) === 'connected') {
          this.cancelFallbackAttempt();
        } else if (isRetryableTransportError(cause) && Date.now() < this.fallbackDeadline) {
          this.cancelFallbackAttempt();
        } else {
          this.fallbackState = 'failed';
          this.updateTransportState('websocket', 'failed');
          await this.fail(errorCode(cause), errorMessage(cause));
        }
      } else if (isRetryableTransportError(cause) && Date.now() < this.fallbackDeadline) {
        // The viewer lost its own transport before this request reached the
        // Control Plane. Keep the same reservation and retry inside the common
        // reconnect window instead of turning a temporary offline period into
        // a terminal session failure.
        this.handleFallbackTransportFailure(attempt, 'ticket-request-failed');
      } else {
        this.fallbackState = 'failed';
        this.updateTransportState('websocket', 'failed');
        await this.fail(errorCode(cause), errorMessage(cause));
      }
    }
  }

  private openFallbackSockets(info: DesktopFallbackSession, attempt: number) {
    this.closeFallbackSockets('open-replace');
    this.clearFallbackPairTimer();
    const open = this.input.transport.openAuthenticatedWebSocket?.bind(this.input.transport);
    if (!open) {
      void this.fail('REMOTE_DESKTOP_TRANSPORT_UNAVAILABLE', 'Remote desktop fallback is unavailable for this profile.');
      return;
    }
    try {
      const media = open({ path: info.mediaUrl, protocols: [info.mediaSubprotocol], binaryType: 'arraybuffer' }, {
        onOpen: () => diagnosticLog.info('remote.desktop.fallback.media.open', { attempt }),
        onMessage: (data) => {
          if (attempt !== this.fallbackAttempt || this.fallbackMedia !== media) return;
          if (typeof data === 'string') this.handleFallbackMediaText(data, attempt);
          else this.handleFallbackBinary(data, attempt);
        },
        onError: (cause) => {
          diagnosticLog.warn('remote.desktop.fallback.media.error', { attempt, code: cause.code, message: cause.message });
          this.handleFallbackTransportFailure(attempt, 'media-error');
        },
        onClose: (event) => {
          diagnosticLog.warn('remote.desktop.fallback.media.close', { attempt, code: event.code, reason: event.reason });
          this.handleFallbackTransportFailure(attempt, 'media-close');
        },
      });
      const control = open({ path: info.controlUrl, protocols: [info.controlSubprotocol] }, {
        onOpen: () => diagnosticLog.info('remote.desktop.fallback.control.open', { attempt }),
        onMessage: (data) => {
          if (attempt !== this.fallbackAttempt || this.fallbackControl !== control || typeof data !== 'string') return;
          try { this.handleFallbackControlMessage(JSON.parse(data), attempt); }
          catch { this.handleFallbackTransportFailure(attempt, 'control-message-parse'); }
        },
        onError: (cause) => {
          diagnosticLog.warn('remote.desktop.fallback.control.error', { attempt, code: cause.code, message: cause.message });
          this.handleFallbackTransportFailure(attempt, 'control-error');
        },
        onClose: (event) => {
          diagnosticLog.warn('remote.desktop.fallback.control.close', { attempt, code: event.code, reason: event.reason });
          this.handleFallbackTransportFailure(attempt, 'control-close');
        },
      });
      this.fallbackMedia = media;
      this.fallbackControl = control;
      this.fallbackPairTimer = setTimeout(() => {
        this.fallbackPairTimer = undefined;
        if (attempt === this.fallbackAttempt && this.fallbackState !== 'active') this.handleFallbackTransportFailure(attempt, 'pair-timeout');
      }, FALLBACK_PAIR_TIMEOUT_MS);
    } catch {
      this.handleFallbackTransportFailure(attempt, 'open-threw');
    }
  }

  private handleFallbackMediaText(text: string, attempt: number) {
    let value: any;
    try { value = JSON.parse(text); } catch { this.handleFallbackTransportFailure(attempt, 'media-message-parse'); return; }
    if (value?.type === 'fallback.configure') {
      const payload = value.payload;
      const width = Number(payload?.width);
      const height = Number(payload?.height);
      const fps = Number(payload?.fps);
      const bitrate = Number(payload?.bitrate);
      const codec = typeof payload?.codec === 'string' ? payload.codec : '';
      if (!Number.isInteger(width) || width < 2 || width > 8192
        || !Number.isInteger(height) || height < 2 || height > 8192
        || !Number.isInteger(fps) || fps < 1 || fps > 120
        || !Number.isInteger(bitrate) || bitrate < 1 || bitrate > 8_000_000
        || !/^(avc1|avc3|hvc1|hev1)\./i.test(codec)) {
        this.handleFallbackTransportFailure(attempt, 'media-config-invalid');
        return;
      }
      this.fallbackCodec = codec;
      this.fallbackConfigKey = `${codec}:${width}x${height}:${fps}:${bitrate}`;
      this.fallbackAssembler.reset();
      this.fallbackNeedsKeyframe = true;
      this.fallbackFirstFrame = false;
      void configureRemoteDesktopDecoder({ codec, width, height, fps, bitrate }).catch((cause) => {
          if (errorCode(cause) === 'REMOTE_DESKTOP_DECODER_UNAVAILABLE') {
            void this.fail('REMOTE_DESKTOP_DECODER_UNAVAILABLE', 'The native remote desktop decoder is unavailable.');
            return;
          }
          this.requestFallbackKeyframe();
        });
      return;
    }
    if (value?.type === 'fallback.error') {
      diagnosticLog.warn('remote.desktop.fallback.error', { attempt, code: value.payload?.code });
      this.handleFallbackTransportFailure(attempt, 'media-fallback-error');
    }
  }

  private handleFallbackBinary(data: ArrayBuffer, attempt: number) {
    let frame;
    try { frame = decodeDesktopFallbackFrame(data); }
    catch (cause) {
      const bytes = new Uint8Array(data);
      diagnosticLog.warn('remote.desktop.fallback.frame.invalid', {
        attempt,
        bytes: bytes.byteLength,
        prefix: Array.from(bytes.subarray(0, 32), (value) => value.toString(16).padStart(2, '0')).join(''),
        message: errorMessage(cause),
      });
      this.handleFallbackTransportFailure(attempt, 'media-frame-decode');
      return;
    }
    const traceFallbackFrame = this.fallbackDiagnosticFrames < 8;
    if (traceFallbackFrame) {
      this.fallbackDiagnosticFrames += 1;
      diagnosticLog.info('remote.desktop.fallback.frame.received', {
        attempt,
        frameId: frame.frameId,
        keyframe: frame.keyframe,
        chunkIndex: frame.chunkIndex,
        chunkCount: frame.chunkCount,
        bytes: data.byteLength,
      });
    }
    let assembled;
    try { assembled = this.fallbackAssembler.push(frame); }
    catch { this.handleFallbackTransportFailure(attempt, 'media-frame-assemble'); return; }
    if (assembled.type !== 'frame') return;
    if (traceFallbackFrame) {
      diagnosticLog.info('remote.desktop.fallback.frame.ready', {
        attempt,
        frameId: assembled.frameId,
        keyframe: assembled.keyframe,
        skippedFrames: assembled.skippedFrames,
        bytes: assembled.payload.byteLength,
        timestampUs: assembled.timestampUs,
      });
    }
    if (assembled.skippedFrames) this.fallbackNeedsKeyframe = true;
    if (!this.fallbackCodec) return;
    if (!assembled.keyframe && (this.fallbackNeedsKeyframe || !this.fallbackFirstFrame)) {
      this.requestFallbackKeyframe();
      return;
    }
    const timestampUs = Number(assembled.timestampUs);
    if (!Number.isFinite(timestampUs)) return;
    if (this.decodeBacklog >= MAX_DECODE_BACKLOG && !assembled.keyframe) {
      this.fallbackNeedsKeyframe = true;
      this.requestFallbackKeyframe();
      return;
    }
    this.decodeBacklog += 1;
    const generation = this.epoch;
    if (traceFallbackFrame) {
      diagnosticLog.info('remote.desktop.fallback.decode.enqueue', {
        attempt,
        frameId: assembled.frameId,
        keyframe: assembled.keyframe,
        generation,
        epoch: this.epoch,
        state: this.fallbackState,
        backlog: this.decodeBacklog,
      });
    }
    this.decodeQueue = this.decodeQueue.then(async () => {
      if (traceFallbackFrame) {
        diagnosticLog.info('remote.desktop.fallback.decode.start', {
          frameId: assembled.frameId,
          keyframe: assembled.keyframe,
          generation,
          epoch: this.epoch,
          state: this.fallbackState,
        });
      }
      if (this.destroyed || generation !== this.epoch || this.fallbackState === 'idle') return;
      await decodeRemoteDesktopFrame(assembled.payload, assembled.keyframe, timestampUs);
      if (assembled.keyframe) this.fallbackNeedsKeyframe = false;
      if (!this.fallbackFirstFrame) {
        this.fallbackFirstFrame = true;
        this.update({ videoWidth: this.fallbackWidth(), videoHeight: this.fallbackHeight(), phase: this.snapshotValue.paused ? 'paused' : 'connected' });
      }
    }).catch((cause) => {
      diagnosticLog.warn('remote.desktop.fallback.decode.failed', {
        frameId: assembled.frameId,
        keyframe: assembled.keyframe,
        message: errorMessage(cause),
      });
      this.fallbackNeedsKeyframe = true;
      void resetRemoteDesktopDecoder().catch(() => undefined);
      this.requestFallbackKeyframe();
    }).finally(() => { this.decodeBacklog = Math.max(0, this.decodeBacklog - 1); });
  }

  private handleFallbackControlMessage(value: any, attempt: number) {
    if (attempt !== this.fallbackAttempt || !this.fallbackSession) return;
    if (value?.type === 'fallback.ready') {
      if (value.payload?.fallbackGeneration && value.payload.fallbackGeneration !== this.fallbackSession.fallbackGeneration) return;
      this.markFallbackReady();
      return;
    }
    if (value?.type === 'transport.upgraded') {
      this.commitTransportUpgrade();
      return;
    }
    if (value?.type === 'fallback.error') {
      diagnosticLog.warn('remote.desktop.fallback.error', { attempt, role: 'control', code: value.payload?.code });
      this.handleFallbackTransportFailure(attempt, 'control-fallback-error');
      return;
    }
    this.handleControlValue(value);
  }

  private markFallbackReady() {
    if (!this.fallbackSession) return;
    this.clearFallbackPairTimer();
    this.clearWebRTCTimers();
    this.clearStartupTimeout();
    this.fallbackDeadline = 0;
    this.fallbackState = 'active';
    diagnosticLog.info('remote.desktop.fallback.ready', { attempt: this.fallbackAttempt });
    this.fallbackNeedsKeyframe = true;
    this.fallbackFirstFrame = false;
    this.update({ phase: this.snapshotValue.paused ? 'paused' : 'connected', path: 'websocket', streamURL: undefined, error: undefined });
    this.updateTransportState('websocket', 'active');
    this.sendVisibility();
    this.applyStreamResolution();
    this.requestFallbackKeyframe();
    if (this.active && this.snapshotValue.inputRequested) this.resumeWanted();
    if (this.peer && (this.peer.connectionState === 'connected' || this.peer.iceConnectionState === 'connected' || this.peer.iceConnectionState === 'completed')) {
      this.requestTransportUpgrade();
    }
  }

  private handleFallbackTransportFailure(attempt: number, trigger: string) {
    if (attempt !== this.fallbackAttempt || this.destroyed || !this.session) return;
    if (this.fallbackState === 'idle' || this.fallbackState === 'failed') return;
    diagnosticLog.warn('remote.desktop.fallback.failure.trigger', { attempt, trigger, state: this.fallbackState });
    this.clearFallbackPairTimer();
    this.closeFallbackSockets('transport-failure');
    void resetRemoteDesktopDecoder().catch(() => undefined);
    this.fallbackFirstFrame = false;
    this.fallbackConfigKey = '';
    this.fallbackCodec = '';
    this.fallbackNeedsKeyframe = true;
    this.suspendInput();
    diagnosticLog.warn('remote.desktop.fallback.transport.failed', {
      attempt,
      state: this.fallbackState,
      iceConnectionState: this.peer?.iceConnectionState,
    });
    const progress = remoteDesktopWebRTCProgress(Boolean(this.peer), this.peer?.iceConnectionState);
    if (progress === 'connected' && (this.fallbackState === 'switching' || this.fallbackState === 'reconnecting')) {
      this.cancelFallbackAttempt();
      if (this.snapshotValue.inputRequested) this.resumeWanted();
      return;
    }
    this.fallbackDeadline = nextRemoteDesktopFallbackDeadline(Date.now(), this.fallbackDeadline);
    if (Date.now() >= this.fallbackDeadline) {
      this.fallbackState = 'failed';
      this.updateTransportState('websocket', 'failed');
      void this.fail('REMOTE_DESKTOP_FALLBACK_FAILED', 'The fallback remote desktop connection could not be restored.');
      return;
    }
    this.fallbackState = 'reconnecting';
    this.updateTransportState('websocket', 'pending');
    this.fallbackAttempt += 1;
    const next = this.fallbackAttempt;
    this.clearFallbackRetry();
    this.fallbackRetryTimer = setTimeout(() => {
      this.fallbackRetryTimer = undefined;
      if (next !== this.fallbackAttempt || this.destroyed) return;
      this.fallbackState = 'idle';
      void this.beginFallback('recovery-timeout', 'REMOTE_DESKTOP_FALLBACK_RECOVERY', progress === 'recoverable');
    }, REMOTE_DESKTOP_FALLBACK_RETRY_MS);
  }

  private requestTransportUpgrade() {
    if (this.fallbackState === 'idle' || this.fallbackState === 'failed') return;
    if (this.fallbackUpgradeStartedAt === 0) this.fallbackUpgradeStartedAt = Date.now();
    this.sendTransportUpgrade();
  }

  private sendTransportUpgrade() {
    this.clearFallbackUpgrade();
    if (this.destroyed || (this.fallbackState !== 'active' && this.fallbackState !== 'switching')) return;
    this.wire('control', 'transport.upgrade');
    if (Date.now() - this.fallbackUpgradeStartedAt < FALLBACK_UPGRADE_TIMEOUT_MS) {
      this.fallbackUpgradeTimer = setTimeout(() => this.sendTransportUpgrade(), FALLBACK_UPGRADE_RETRY_MS);
    } else {
      this.fallbackUpgradeStartedAt = 0;
    }
  }

  private commitTransportUpgrade() {
    if (this.fallbackState === 'idle') return;
    this.clearFallbackUpgrade();
    this.closeFallbackSockets('transport-upgraded');
    void resetRemoteDesktopDecoder().catch(() => undefined);
    this.fallbackAssembler.reset();
    this.fallbackState = 'idle';
    this.fallbackAttempt += 1;
    this.fallbackDeadline = 0;
    this.fallbackFirstFrame = false;
    this.fallbackCodec = '';
    this.fallbackConfigKey = '';
    this.fallbackNeedsKeyframe = true;
    this.update({ path: this.snapshotValue.path === 'websocket' ? undefined : this.snapshotValue.path, streamURL: this.snapshotValue.streamURL, phase: this.snapshotValue.paused ? 'paused' : 'connected' });
    this.applyPath(this.snapshotValue.path);
    this.sendVisibility();
    this.requestKeyframe();
    if (this.snapshotValue.inputRequested) this.resumeWanted();
  }

  private cancelFallbackAttempt() {
    if (this.fallbackState !== 'switching' && this.fallbackState !== 'reconnecting') return;
    this.clearFallbackHeadStart();
    this.clearFallbackRetry();
    this.clearFallbackPairTimer();
    this.closeFallbackSockets('attempt-cancelled');
    this.fallbackState = 'idle';
    this.fallbackDeadline = 0;
    this.updateTransportState('websocket', 'idle');
  }

  private requestFallbackKeyframe() {
    const media = this.fallbackMedia;
    if (!media || this.fallbackState === 'idle') return;
    const now = Date.now();
    if (now - this.fallbackLastKeyframeAt < 500) return;
    this.fallbackLastKeyframeAt = now;
    try { media.send(JSON.stringify({ type: 'fallback.keyframe-request' })); } catch { /* reconnect owns the failure */ }
  }

  private handleControlMessage(data: unknown) {
    if (typeof data !== 'string') return;
    try { this.handleControlValue(JSON.parse(data)); } catch { /* channel-level malformed messages are ignored */ }
  }

  private handleControlValue(value: any) {
    if (value?.type === 'input.resumed') {
      this.inputEpoch = Number(value.payload?.inputEpoch) || 0;
      this.startInputAlive();
      this.update({ inputEnabled: true, inputPending: false, inputRequested: true });
    } else if (value?.type === 'input.suspended') {
      const payload = value.payload ?? {};
      const sessionRevision = Number.isSafeInteger(payload.sessionRevision) && payload.sessionRevision >= 0
        ? payload.sessionRevision
        : undefined;
      const shouldResume = payload.recoverable === true
        && payload.cause === 'REMOTE_DESKTOP_GEOMETRY_CHANGED'
        && sessionRevision !== undefined
        && this.snapshotValue.inputRequested
        && this.snapshotValue.isController
        && this.active
        && !this.snapshotValue.paused;
      this.releaseInputState();
      if (sessionRevision !== undefined && this.snapshotValue.session) {
        this.update({
          session: {
            ...this.snapshotValue.session,
            sessionRevision: Math.max(this.snapshotValue.session.sessionRevision, sessionRevision),
          },
        });
      }
      if (shouldResume) this.resumeWanted();
    } else if (value?.type === 'control.changed') {
      const isController = value.payload?.isController === true;
      this.update({
        isController,
        controlRequestPending: false,
        hasController: isController ? true : this.snapshotValue.hasController,
        viewerCount: Number.isInteger(value.payload?.viewerCount) ? value.payload.viewerCount : this.snapshotValue.viewerCount,
        ...(value.payload?.controlRevision !== undefined ? { session: this.snapshotValue.session ? { ...this.snapshotValue.session, controlRevision: Number(value.payload.controlRevision) || 0, isController } : undefined } : {}),
      });
      if (!isController) {
        this.releaseInputState();
        this.update({ inputRequested: false });
      } else if (this.snapshotValue.inputRequested) {
        this.resumeWanted();
      }
    } else if (value?.type === 'error') {
      const code = typeof value.payload?.code === 'string' ? value.payload.code : 'REMOTE_DESKTOP_MESSAGE_INVALID';
      if (code === 'REMOTE_DESKTOP_WEBRTC_NOT_READY') return;
      this.releaseInputState();
      this.update({ controlRequestPending: false, error: { code, message: code } });
    }
  }

  private resumeWanted() {
    if (this.destroyed || !this.active || this.snapshotValue.paused || this.snapshotValue.inputEnabled || this.snapshotValue.inputPending) return;
    if (!this.snapshotValue.isController) {
      this.requestControl();
      return;
    }
    const sent = this.wire('control', 'input.resume', { sessionRevision: this.snapshotValue.session?.sessionRevision });
    if (sent) this.update({ inputPending: true });
  }

  private suspendInput() {
    if (this.snapshotValue.inputEnabled) this.wire('control', 'input.suspend');
    this.releaseInputState();
  }

  private releaseInputState() {
    this.stopInputAlive();
    this.inputEpoch = 0;
    this.update({ inputEnabled: false, inputPending: false });
  }

  private startInputAlive() {
    this.stopInputAlive();
    this.inputAliveTimer = setInterval(() => {
      if (!this.active || !this.snapshotValue.inputEnabled) return;
      this.wire('control', 'input.alive', { inputEpoch: this.inputEpoch });
    }, INPUT_ALIVE_MS);
  }

  private stopInputAlive() {
    if (this.inputAliveTimer) clearInterval(this.inputAliveTimer);
    this.inputAliveTimer = undefined;
  }

  private startSignalAlive() {
    this.stopSignalAlive();
    this.signalAliveTimer = setInterval(() => this.sendSignalAlive(), SIGNAL_ALIVE_MS);
  }

  private sendSignalAlive() {
    this.sendSignal({ type: 'signalAlive', requestId: requestId() });
  }

  private stopSignalAlive() {
    if (this.signalAliveTimer) clearInterval(this.signalAliveTimer);
    this.signalAliveTimer = undefined;
  }

  private sendVisibility() {
    this.wire('control', 'visibility', { hidden: !this.active });
  }

  private applyStreamResolution() {
    const preset = this.snapshotValue.resolution === 'auto' ? undefined : REMOTE_DESKTOP_RESOLUTION_PRESETS[this.snapshotValue.resolution];
    this.wire('control', 'stream.resolution', {
      maxWidth: preset?.width ?? null,
      maxHeight: preset?.height ?? null,
      maxFrameRate: this.snapshotValue.frameRate === 'auto' ? null : Number(this.snapshotValue.frameRate),
    });
  }

  private outputChannel(name: ChannelName): WireChannel | undefined {
    if (this.fallbackState === 'active') {
      return this.fallbackControl?.readyState === 1 ? this.fallbackControl : undefined;
    }
    const channel = this.channels.get(name);
    return channel?.readyState === 'open' ? channel : undefined;
  }

  private wire(name: ChannelName, type: string, payload: unknown = {}, maxBytes = REMOTE_DESKTOP_MAX_MESSAGE_BYTES) {
    const channel = this.outputChannel(name);
    if (!channel) return false;
    const next = this.seq + 1;
    const encoded = JSON.stringify({ v: REMOTE_DESKTOP_CHANNEL_VERSION, seq: next, type, payload });
    if (utf8Length(encoded) > maxBytes) return false;
    try { channel.send(encoded); this.seq = next; return true; }
    catch { return false; }
  }

  private inputReady() {
    return !this.destroyed && this.active && this.snapshotValue.inputEnabled && this.inputEpoch > 0;
  }

  private armFallbackHeadStart() {
    this.clearFallbackHeadStart();
    if (!this.snapshotValue.transportAvailability.websocket) return;
    this.fallbackHeadStartTimer = setTimeout(() => {
      this.fallbackHeadStartTimer = undefined;
      if (this.destroyed || this.fallbackState !== 'idle' || !this.active) return;
      const state = this.peer?.iceConnectionState;
      if (state === 'connected' || state === 'completed') return;
      void this.beginFallback('recovery-timeout', 'REMOTE_DESKTOP_ICE_HEAD_START', true);
    }, FALLBACK_HEAD_START_MS);
  }

  private armNegotiationTimeout() {
    this.clearNegotiationTimer();
    if (this.fallbackState !== 'idle') return;
    this.negotiationTimer = setTimeout(() => {
      this.negotiationTimer = undefined;
      if (this.destroyed || this.fallbackState !== 'idle' || !this.session) return;
      const state = this.peer?.iceConnectionState;
      if (state === 'connected' || state === 'completed') return;
      if (this.snapshotValue.transportAvailability.websocket) void this.beginFallback('recovery-timeout', 'REMOTE_DESKTOP_ICE_TIMEOUT', false);
      else void this.fail('REMOTE_DESKTOP_ICE_TIMEOUT', 'Remote desktop negotiation timed out.');
    }, NEGOTIATION_TIMEOUT_MS);
  }

  private armStartupTimeout() {
    this.clearStartupTimeout();
    if (this.destroyed || this.snapshotValue.phase === 'error' || this.snapshotValue.phase === 'stopped') return;
    this.startupTimer = setTimeout(() => {
      this.startupTimer = undefined;
      if (this.destroyed || !this.connectionPending()) return;
      void this.fail('REMOTE_DESKTOP_CONNECTION_TIMEOUT', 'Remote desktop connection timed out.');
    }, CONNECTION_START_TIMEOUT_MS);
  }

  private connectionPending() {
    return this.snapshotValue.phase === 'connecting'
      || this.snapshotValue.phase === 'reconnecting'
      || (this.snapshotValue.phase !== 'connected' && this.snapshotValue.phase !== 'paused');
  }

  private armRecoveryTimer() {
    if (this.fallbackState !== 'idle' || this.recoveryTimer) return;
    this.recoveryTimer = setTimeout(() => {
      this.recoveryTimer = undefined;
      if (this.destroyed || this.fallbackState !== 'idle' || !this.peer) return;
      if (this.peer.iceConnectionState === 'disconnected') void this.beginFallback('recovery-timeout', 'REMOTE_DESKTOP_ICE_RECOVERY_TIMEOUT', false);
    }, ICE_RECOVERY_TIMEOUT_MS);
  }

  private considerFallbackAfterSignalFailure(code: string) {
    if (this.destroyed || !this.session || this.fallbackState !== 'idle') return;
    if (!this.snapshotValue.signalingReady) {
      void this.fail(code, 'Remote desktop session initialization failed.');
      return;
    }
    if (this.snapshotValue.transportAvailability.websocket) void this.beginFallback('ice-failed', code, false);
    else void this.fail(code, 'Remote desktop signaling failed.');
  }

  private startStatsWatch(peer: RTCPeerConnection) {
    if (this.peer !== peer) return;
    this.stopStatsWatch();
    const poll = async () => {
      if (this.destroyed || this.peer !== peer) return;
      await this.refreshTransportPath(peer);
      if (this.destroyed || this.peer !== peer) return;
      this.statsTimer = setTimeout(() => void poll(), STATS_INTERVAL_MS);
    };
    void poll();
  }

  private async refreshTransportPath(peer: RTCPeerConnection) {
    try {
      const stats = await peer.getStats();
      let pair: any;
      stats.forEach((report: any) => {
        if (report?.type === 'transport' && report.selectedCandidatePairId) pair ??= stats.get(report.selectedCandidatePairId);
      });
      if (!pair) {
        stats.forEach((report: any) => {
          if (!pair && report?.type === 'candidate-pair' && report.state === 'succeeded' && report.nominated) pair = report;
        });
      }
      if (!pair) return;
      const local = typeof pair.localCandidateId === 'string' ? stats.get(pair.localCandidateId) : undefined;
      const remote = typeof pair.remoteCandidateId === 'string' ? stats.get(pair.remoteCandidateId) : undefined;
      const relay = local?.candidateType === 'relay' || remote?.candidateType === 'relay';
      const path: RemoteDesktopPath = relay ? 'turn' : 'p2p';
      if (path === 'turn' && !this.snapshotValue.transportAvailability.turn) return;
      if (path === 'p2p' && !this.snapshotValue.transportAvailability.p2p) return;
      if (this.snapshotValue.path !== path) this.update({ path });
      this.applyPath(path);
    } catch {
      // Stats are diagnostic; media state changes still drive the session.
    }
  }

  private applyPath(path?: RemoteDesktopPath) {
    const availability = this.snapshotValue.transportAvailability;
    const states: Record<RemoteDesktopTransportKey, RemoteDesktopTransportState> = {
      p2p: availability.p2p ? (path === 'p2p' ? 'active' : 'pending') : 'idle',
      turn: availability.turn ? (path === 'turn' ? 'active' : 'pending') : 'idle',
      websocket: this.fallbackState === 'active' ? 'active' : this.fallbackState === 'switching' || this.fallbackState === 'reconnecting' ? 'pending' : this.fallbackState === 'failed' ? 'failed' : 'idle',
    };
    this.update({ path, transportStates: states });
  }

  private updateTransportState(key: RemoteDesktopTransportKey, state: RemoteDesktopTransportState) {
    this.update({ transportStates: { ...this.snapshotValue.transportStates, [key]: state } });
  }

  private async reconnectForTransportPolicy() {
    // Transport policy creates a fresh viewer session, so the previous
    // reservation must be released first; otherwise the component reports the
    // instance as busy and the new transport never starts.
    await this.stopCurrentSession(true);
    this.update({ phase: 'connecting', error: undefined, streamURL: undefined, path: undefined, signalingReady: false, videoWidth: 0, videoHeight: 0 });
    await this.start();
  }

  private async stopCurrentSession(stopRemote: boolean) {
    this.stopping = true;
    this.epoch += 1;
    this.clearAllTimers();
    this.stopInputAlive();
    this.stopSignalAlive();
    this.signalOpen = false;
    const signal = this.signal;
    this.signal = undefined;
    try { signal?.close(); } catch { /* best effort */ }
    this.closeFallbackSockets('session-stop');
    this.closePeer();
    const session = this.session;
    this.session = undefined;
    this.fallbackSession = undefined;
    this.fallbackState = 'idle';
    this.fallbackAssembler.reset();
    this.fallbackAttempt += 1;
    this.fallbackDeadline = 0;
    this.fallbackFirstFrame = false;
    this.fallbackCodec = '';
    this.fallbackConfigKey = '';
    this.fallbackUpgradeStartedAt = 0;
    this.channels.clear();
    this.seq = 0;
    this.inputEpoch = 0;
    this.update({
      streamURL: undefined,
      videoWidth: 0,
      videoHeight: 0,
      path: undefined,
      signalingReady: false,
      inputEnabled: false,
      inputPending: false,
      controlRequestPending: false,
      transportStates: { p2p: 'idle', turn: 'idle', websocket: 'idle' },
    });
    await resetRemoteDesktopDecoder().catch(() => undefined);
    if (stopRemote && session) await this.input.api.stop(this.input.instanceId, session.snapshot.viewerSessionId).catch(() => undefined);
    this.stopping = false;
  }

  private closePeer() {
    const peer = this.peer;
    this.peer = undefined;
    this.stopStatsWatch();
    try { peer?.close(); } catch { /* native close is best effort */ }
    this.channels.clear();
  }

  private closeFallbackSockets(reason: string) {
    const media = this.fallbackMedia;
    const control = this.fallbackControl;
    this.fallbackMedia = undefined;
    this.fallbackControl = undefined;
    if (media || control) diagnosticLog.info('remote.desktop.fallback.sockets.close', { reason, hasMedia: Boolean(media), hasControl: Boolean(control), state: this.fallbackState, attempt: this.fallbackAttempt });
    try { media?.close(); } catch { /* best effort */ }
    try { control?.close(); } catch { /* best effort */ }
  }

  private clearWebRTCTimers() {
    this.clearFallbackHeadStart();
    this.clearNegotiationTimer();
    this.clearRecoveryTimer();
  }

  private clearStartupTimeout() { if (this.startupTimer) clearTimeout(this.startupTimer); this.startupTimer = undefined; }
  private clearFallbackHeadStart() { if (this.fallbackHeadStartTimer) clearTimeout(this.fallbackHeadStartTimer); this.fallbackHeadStartTimer = undefined; }
  private clearNegotiationTimer() { if (this.negotiationTimer) clearTimeout(this.negotiationTimer); this.negotiationTimer = undefined; }
  private clearRecoveryTimer() { if (this.recoveryTimer) clearTimeout(this.recoveryTimer); this.recoveryTimer = undefined; }
  private clearFallbackPairTimer() { if (this.fallbackPairTimer) clearTimeout(this.fallbackPairTimer); this.fallbackPairTimer = undefined; }
  private clearFallbackRetry() { if (this.fallbackRetryTimer) clearTimeout(this.fallbackRetryTimer); this.fallbackRetryTimer = undefined; }
  private clearFallbackUpgrade() { if (this.fallbackUpgradeTimer) clearTimeout(this.fallbackUpgradeTimer); this.fallbackUpgradeTimer = undefined; }
  private stopStatsWatch() { if (this.statsTimer) clearTimeout(this.statsTimer); this.statsTimer = undefined; }

  private clearAllTimers() {
    this.clearWebRTCTimers();
    this.clearStartupTimeout();
    this.clearFallbackPairTimer();
    this.clearFallbackRetry();
    this.clearFallbackUpgrade();
    this.stopStatsWatch();
    if (this.availabilityTimer) clearTimeout(this.availabilityTimer);
    this.availabilityTimer = undefined;
  }

  private fallbackWidth() {
    const match = /^[^:]+:(\d+)x(\d+):/.exec(this.fallbackConfigKey);
    return match ? Number(match[1]) : 0;
  }

  private fallbackHeight() {
    const match = /^[^:]+:(\d+)x(\d+):/.exec(this.fallbackConfigKey);
    return match ? Number(match[2]) : 0;
  }

  private current(epoch: number) { return !this.destroyed && this.epoch === epoch; }

  private async failFromCause(cause: unknown) {
    await this.fail(errorCode(cause), errorMessage(cause));
  }

  private handleWebRTCStartFailure(cause: unknown) {
    if (this.destroyed || this.fallbackState !== 'idle') return;
    const code = errorCode(cause);
    diagnosticLog.warn('remote.desktop.webrtc.start-failed', { code, message: errorMessage(cause) });
    this.clearNegotiationTimer();
    if (this.snapshotValue.signalingReady && this.snapshotValue.transportAvailability.websocket) {
      void this.beginFallback('ice-failed', code, false);
    } else {
      void this.fail(code, errorMessage(cause));
    }
  }

  private async fail(code: string, message: string) {
    if (this.destroyed) return;
    diagnosticLog.warn('remote.desktop.fail', { code, message });
    const session = this.session;
    this.epoch += 1;
    this.clearAllTimers();
    this.stopInputAlive();
    this.stopSignalAlive();
    this.signalOpen = false;
    const signal = this.signal;
    this.signal = undefined;
    try { signal?.close(); } catch { /* best effort */ }
    this.closeFallbackSockets('session-failed');
    this.closePeer();
    await resetRemoteDesktopDecoder().catch(() => undefined);
    this.session = undefined;
    this.fallbackState = 'failed';
    this.update({ phase: 'error', error: { code, message }, inputEnabled: false, inputRequested: false, inputPending: false, signalingReady: false, streamURL: undefined });
    if (session) await this.input.api.stop(this.input.instanceId, session.snapshot.viewerSessionId).catch(() => undefined);
  }

  private update(patch: Partial<RemoteDesktopSnapshot>) {
    this.snapshotValue = { ...this.snapshotValue, ...patch };
    for (const listener of this.listeners) listener();
  }
}

function sameTarget(left: PersistedCaptureTarget, right: PersistedCaptureTarget) {
  if (left.kind !== right.kind) return false;
  return left.kind === 'display' || (right.kind === 'window' && left.windowRef === right.windowRef);
}

function sameAvailability(left: RemoteDesktopTransportAvailability, right: RemoteDesktopTransportAvailability) {
  return left.p2p === right.p2p && left.turn === right.turn && left.websocket === right.websocket;
}

function clamp01(value: number) { return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0)); }
function utf8Length(value: string) { return new TextEncoder().encode(value).byteLength; }
function requestId() {
  return globalThis.crypto?.randomUUID?.() ?? `rd-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}
function errorCode(cause: unknown) {
  return cause && typeof cause === 'object' && 'code' in cause && typeof (cause as { code?: unknown }).code === 'string'
    ? String((cause as { code: string }).code)
    : 'REMOTE_DESKTOP_CONNECTION_FAILED';
}
function errorMessage(cause: unknown) {
  return cause instanceof Error && cause.message ? cause.message : 'Remote desktop connection failed.';
}
function isRetryableTransportError(cause: unknown) {
  return Boolean(cause && typeof cause === 'object' && 'retryable' in cause && (cause as { retryable?: unknown }).retryable === true);
}
