import type { DesktopConnectionOptions } from '@task-handoff/protocol/control-plane-desktop';
import { RemoteDesktopDecodeQueue } from './decode-queue';
import {
  DesktopFallbackFrameAssembler,
  DesktopViewerSourcesSchema,
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
import {
  isRecoverableRemoteDesktopInputResumeError,
  parseRemoteDesktopWebRTCReceiveSample,
  parseRemoteDesktopWebRTCStats,
  preferredRemoteDesktopVideoCodecs,
  REMOTE_DESKTOP_DIAGNOSTICS_INTERVAL_MS,
  remoteDesktopInputResumeRetryDelayMs,
  REMOTE_DESKTOP_INPUT_RESUME_ACK_TIMEOUT_MS,
  REMOTE_DESKTOP_RTT_INTERVAL_MS,
  RemoteDesktopReceiveRateMeter,
  RemoteDesktopRttProbe,
  type createControlPlaneRemoteDesktopApi,
  type RemoteDesktopFallbackDiagnostics,
  type RemoteDesktopTransportDiagnostics,
  type RemoteDesktopWebRTCReceiveSample,
} from '@task-handoff/control-plane-client';
import { RTCPeerConnection, RTCRtpReceiver } from 'react-native-webrtc';

import {
  closeRemoteDesktopDecoder,
  configureRemoteDesktopDecoder,
  decodeRemoteDesktopFrame,
  resetRemoteDesktopDecoder,
  subscribeRemoteDesktopDecoderErrors,
  subscribeRemoteDesktopVideoDimensions,
} from '../../modules/task-handoff-remote-desktop/src';
import { diagnosticLog } from '../observability/diagnostic-logs';
import type { MobileAuthenticatedWebSocket, MobileControlPlaneTransport } from '../control-plane/transport';
import {
  captureSelectionForProtocol,
  remoteDesktopStreamResolution,
  resolvePersistedCaptureTarget,
  type PersistedCaptureTarget,
  type RemoteDesktopCapturePrecision,
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
const SIGNAL_RESUME_WINDOW_MS = 30_000;
const SIGNAL_RESUME_RETRY_BASE_MS = 300;
const SIGNAL_RESUME_RETRY_MAX_MS = 4_000;

type RemoteDesktopApi = ReturnType<typeof createControlPlaneRemoteDesktopApi>;
type DataChannel = ReturnType<RTCPeerConnection['createDataChannel']>;
type ChannelName = 'control' | 'input' | 'pointer' | 'clipboard';
type WireChannel = { readonly readyState: number | string; send(data: string): void };

export type RemoteDesktopControllerInput = {
  api: RemoteDesktopApi;
  transport: MobileControlPlaneTransport;
  instanceId: string;
  active?: boolean;
  interactive?: boolean;
  target: PersistedCaptureTarget;
  resolution: RemoteDesktopResolution;
  frameRate: RemoteDesktopFrameRate;
  capturePrecision: RemoteDesktopCapturePrecision;
  transportAvailability: RemoteDesktopTransportAvailability;
  videoCodecs?: readonly string[];
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
  private fallbackFrameRate = 0;
  private fallbackConfiguredWidth = 0;
  private fallbackConfiguredHeight = 0;
  private fallbackDecodedDimensions?: { width: number; height: number };
  private fallbackUpgradeStartedAt = 0;
  private readonly fallbackRttProbe = new RemoteDesktopRttProbe();
  private readonly fallbackReceiveRate = new RemoteDesktopReceiveRateMeter();
  private fallbackDiagnosticsTimer?: ReturnType<typeof setInterval>;
  private fallbackNextPingAt = 0;
  private fallbackLastMetricsLogAt = 0;
  private fallbackFramesReceived = 0;
  private fallbackFramesDecoded = 0;
  private fallbackDroppedFrames = 0;
  private fallbackKeyframeRequests = 0;
  private epoch = 0;
  private seq = 0;
  private destroyed = false;
  private active = true;
  private interactive = true;
  private startingTask?: Promise<void>;
  private stopping = false;
  private targetTransition?: Promise<void>;
  private pendingTarget?: PersistedCaptureTarget;
  private sessionRecovery?: Promise<void>;
  private signalOpen = false;
  private inputEpoch = 0;
  private inputAliveTimer?: ReturnType<typeof setInterval>;
  private inputResumeAckTimer?: ReturnType<typeof setTimeout>;
  private inputResumeRetryTimer?: ReturnType<typeof setTimeout>;
  private inputResumeRetryCount = 0;
  private inputResumeRefresh?: Promise<void>;
  private signalAliveTimer?: ReturnType<typeof setInterval>;
  private signalResumeTimer?: ReturnType<typeof setTimeout>;
  private signalResumeAttempt = 0;
  private signalResumeDeadline = 0;
  private signalResumeInFlight = false;
  private offerInFlight = false;
  private fallbackHeadStartTimer?: ReturnType<typeof setTimeout>;
  private startupTimer?: ReturnType<typeof setTimeout>;
  private negotiationTimer?: ReturnType<typeof setTimeout>;
  private recoveryTimer?: ReturnType<typeof setTimeout>;
  private fallbackPairTimer?: ReturnType<typeof setTimeout>;
  private fallbackRetryTimer?: ReturnType<typeof setTimeout>;
  private fallbackUpgradeTimer?: ReturnType<typeof setTimeout>;
  private fallbackPointerTimer?: ReturnType<typeof setTimeout>;
  private fallbackPointer?: { x: number; y: number; inputEpoch: number };
  private pointerTraceCount = 0;
  private pointerTraceSkipped = 0;
  private pointerTraceLastAt = 0;
  private statsTimer?: ReturnType<typeof setTimeout>;
  private statsPeer?: RTCPeerConnection;
  private webRTCReceiveSample?: RemoteDesktopWebRTCReceiveSample;
  private availabilityTimer?: ReturnType<typeof setTimeout>;
  private readonly decodeQueue = new RemoteDesktopDecodeQueue();
  private fallbackDiagnosticFrames = 0;
  private decoderErrorSubscription?: { remove(): void };
  private videoDimensionsSubscription?: { remove(): void };
  private stopDecoderSubscription?: () => void;
  private videoCodecs: readonly string[];

  constructor(private readonly input: RemoteDesktopControllerInput) {
    this.active = input.active !== false;
    this.interactive = input.interactive !== false;
    this.videoCodecs = input.videoCodecs ?? [];
    this.snapshotValue = {
      ...emptyRemoteDesktopSnapshot,
      paused: !this.active,
      inputRequested: this.interactive,
      target: input.target,
      resolution: input.resolution,
      frameRate: input.frameRate,
      capturePrecision: input.capturePrecision,
      transportAvailability: { ...input.transportAvailability },
    };
    try {
      this.decoderErrorSubscription = subscribeRemoteDesktopDecoderErrors((event) => {
        if (this.destroyed || this.fallbackState === 'idle') return;
        this.decodeQueue.clear();
        this.fallbackNeedsKeyframe = true;
        this.fallbackDroppedFrames += 1;
        if (event.code !== 'REMOTE_DESKTOP_DECODER_BACKPRESSURE') void resetRemoteDesktopDecoder().catch(() => undefined);
        this.requestFallbackKeyframe();
      });
    } catch {
      // The optional decoder module reports its own unavailability when a frame arrives.
    }
    try {
      this.videoDimensionsSubscription = subscribeRemoteDesktopVideoDimensions((event) => {
        if (this.destroyed || this.fallbackState === 'idle') return;
        this.fallbackDecodedDimensions = { width: event.width, height: event.height };
        diagnosticLog.info('remote.desktop.fallback.decoded-dimensions', {
          width: event.width,
          height: event.height,
          state: this.fallbackState,
        });
        if (this.fallbackState === 'active') this.setVideoDimensions(event.width, event.height);
      });
    } catch {
      // Decoder geometry is optional; configure dimensions remain the fallback.
    }
  }

  getSnapshot = () => this.snapshotValue;

  /** The native RTC view reports the decoded frame size. Keep it in the same
   * snapshot as fallback decoding so connection diagnostics and coordinate
   * mapping always consume one authoritative video geometry. */
  setVideoDimensions(width: number, height: number) {
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return;
    const nextWidth = Math.round(width);
    const nextHeight = Math.round(height);
    if (nextWidth === this.snapshotValue.videoWidth && nextHeight === this.snapshotValue.videoHeight) return;
    this.update({ videoWidth: nextWidth, videoHeight: nextHeight });
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  start(): Promise<void> {
    if (this.destroyed || this.session) return Promise.resolve();
    if (this.targetTransition) return this.targetTransition.then(() => this.start());
    if (this.stopping) return Promise.resolve();
    return this.beginStart();
  }

  private beginStart(): Promise<void> {
    if (this.destroyed || this.session) return Promise.resolve();
    if (this.startingTask) return this.startingTask;
    const task = this.startSession();
    this.startingTask = task;
    void task.then(
      () => { if (this.startingTask === task) this.startingTask = undefined; },
      () => { if (this.startingTask === task) this.startingTask = undefined; },
    );
    return task;
  }

  private async startSession() {
    if (this.destroyed || this.session) return;
    const epoch = this.epoch;
    this.update({ phase: 'connecting', error: undefined, inputRequested: this.interactive, transportDiagnostics: undefined, videoCodec: undefined, videoFrameRate: undefined });
    this.armStartupTimeout();
    try {
      const selection = await this.resolveCaptureSelection();
      if (this.destroyed || this.stopping || !this.current(epoch)) return;
      if (!selection) {
        this.clearStartupTimeout();
        this.update({
          phase: 'error',
          error: { code: 'REMOTE_DESKTOP_SOURCE_SELECTION_REQUIRED', message: 'Select a view before connecting.' },
          paused: false,
        });
        return;
      }
      const created = await this.input.api.createSession(this.input.instanceId, selection, undefined, this.snapshotValue.connectionOptions ? (this.snapshotValue.transportAvailability.turn ? 'custom' : 'none') : undefined);
      if (this.destroyed || this.stopping || !this.current(epoch)) {
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
      if (!this.current(epoch)) return;
      await this.failFromCause(cause);
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
    this.videoDimensionsSubscription?.remove();
    this.videoDimensionsSubscription = undefined;
    this.listeners.clear();
  }

  async disconnect() {
    if (this.destroyed) return;
    await this.stopCurrentSession(true);
    this.update({ phase: 'stopped', error: undefined, paused: false, inputRequested: false });
  }

  switchTarget(target: PersistedCaptureTarget) {
    if (this.destroyed) return Promise.resolve();
    // The session link and target effect can request the same transition in the
    // same React commit. Coalesce them before touching the component session.
    if (!this.targetTransition && sameTarget(this.snapshotValue.target, target)) return Promise.resolve();
    if (this.targetTransition
      && !sameTarget(this.pendingTarget ?? this.snapshotValue.target, target)) {
      // Invalidate an in-flight createSession immediately. The transition loop
      // will release that stale reservation before starting the latest target.
      this.epoch += 1;
    }
    this.pendingTarget = target;
    this.targetTransition ??= this.drainTargetTransitions();
    return this.targetTransition;
  }

  private async drainTargetTransitions() {
    try {
      while (this.pendingTarget && !this.destroyed) {
        const target = this.pendingTarget;
        this.pendingTarget = undefined;
        if (sameTarget(this.snapshotValue.target, target) && this.session) continue;
        // A new capture target is a new component session. Keeping the old
        // reservation alive leaves the component busy for the replacement.
        await this.stopCurrentSession(true);
        if (this.destroyed) return;
        const starting = this.startingTask;
        if (starting) await starting.catch(() => undefined);
        if (this.destroyed) return;
        const newer = this.pendingTarget;
        if (newer && !sameTarget(newer, target)) continue;
        if (newer) this.pendingTarget = undefined;
        this.update({ target, error: undefined, phase: 'connecting', streamURL: undefined, videoWidth: 0, videoHeight: 0, videoCodec: undefined, videoFrameRate: undefined, path: undefined, transportDiagnostics: undefined, signalingReady: false, inputRequested: this.interactive });
        if (this.active) await this.beginStart();
      }
    } finally {
      this.targetTransition = undefined;
      if (this.pendingTarget && !this.destroyed) void this.switchTarget(this.pendingTarget);
    }
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

  setInteractive(interactive: boolean) {
    if (this.destroyed || this.interactive === interactive) return;
    this.interactive = interactive;
    if (!interactive) {
      this.disableInput();
      return;
    }
    this.update({ inputRequested: true });
    if (this.active) this.enableInput();
  }

  private async resolveCaptureSelection() {
    const current = this.snapshotValue.target;
    const { sources } = await this.input.api.sources(this.input.instanceId);
    const resolved = resolvePersistedCaptureTarget(sources, current);
    if (!resolved) {
      diagnosticLog.warn('remote.desktop.target.unresolved', {
        capturableKindCount: sources.filter((source) => source.capturable && source.kind === current.kind).length,
        hasSourceRef: Boolean(current.sourceRef),
        kind: current.kind,
        sourceCount: sources.length,
      });
      return undefined;
    }
    if (!sameTarget(current, resolved)) this.update({ target: resolved });
    return captureSelectionForProtocol(resolved);
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

  setCapturePrecision(capturePrecision: RemoteDesktopCapturePrecision) {
    if (capturePrecision === this.snapshotValue.capturePrecision) return;
    this.update({ capturePrecision });
    this.applyStreamResolution();
  }

  setVideoCodecs(codecs: readonly string[]) {
    this.videoCodecs = codecs;
  }

  setConnectionOptions(options: DesktopConnectionOptions | null) {
    this.update({ connectionOptions: options ?? undefined });
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
    const point = { x: clamp01(x), y: clamp01(y) };
    const blockedReason = this.inputBlockedReason();
    if (blockedReason) {
      if (this.shouldTracePointer()) {
        diagnosticLog.info('remote.desktop.pointer.drop', {
          reason: blockedReason,
          ...point,
          ...this.inputTraceState(),
          skipped: this.pointerTraceSkipped,
        });
        this.pointerTraceSkipped = 0;
      }
      return;
    }
    const pointer = { ...point, inputEpoch: this.inputEpoch };
    if (this.fallbackState === 'active') {
      this.fallbackPointer = pointer;
      if (this.fallbackPointerTimer) return;
      // Pointer motion is latest-value-wins. One 60 Hz flush keeps it behind
      // keyboard/clipboard only for a frame without flooding the control WS.
      this.fallbackPointerTimer = setTimeout(() => {
        this.fallbackPointerTimer = undefined;
        const latest = this.fallbackPointer;
        this.fallbackPointer = undefined;
        if (!latest) return;
        const blocked = this.inputBlockedReason();
        if (blocked) {
          diagnosticLog.info('remote.desktop.pointer.drop', {
            reason: blocked,
            channel: 'fallback',
            x: latest.x,
            y: latest.y,
            inputEpoch: latest.inputEpoch,
            ...this.inputTraceState(),
          });
          return;
        }
        const sequence = this.transmit('pointer', 'pointer', latest);
        diagnosticLog.info('remote.desktop.pointer.sent', {
          channel: 'fallback',
          sequence,
          x: latest.x,
          y: latest.y,
          inputEpoch: latest.inputEpoch,
          ...this.inputTraceState(),
        });
      }, 16);
      return;
    }
    const sequence = this.transmit('pointer', 'pointer', pointer);
    if (this.shouldTracePointer()) {
      diagnosticLog.info('remote.desktop.pointer.sent', {
        channel: 'webrtc',
        sequence,
        ...pointer,
        ...this.inputTraceState(),
        skipped: this.pointerTraceSkipped,
      });
      this.pointerTraceSkipped = 0;
    }
  }

  sendButton(x: number, y: number, button: number, down: boolean) {
    const point = { x: clamp01(x), y: clamp01(y) };
    const blockedReason = this.inputBlockedReason();
    if (blockedReason) {
      diagnosticLog.info('remote.desktop.button.drop', {
        reason: blockedReason,
        ...point,
        button,
        down,
        ...this.inputTraceState(),
      });
      return;
    }
    const payload = { ...point, button, down, inputEpoch: this.inputEpoch };
    const sequence = this.transmit('input', 'button', payload);
    diagnosticLog.info('remote.desktop.button.sent', {
      channel: this.fallbackState === 'active' ? 'fallback' : 'webrtc',
      sequence,
      ...payload,
      ...this.inputTraceState(),
    });
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
          this.signalResumeAttempt = 0;
          this.signalResumeDeadline = 0;
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
          this.invalidateInputForSignalRecovery();
          diagnosticLog.warn('remote.desktop.signal.error', { signalingReady: this.snapshotValue.signalingReady });
          this.considerFallbackAfterSignalFailure('REMOTE_DESKTOP_SIGNAL_SOCKET_ERROR');
        },
        onClose: (event) => {
          if (!this.current(epoch)) return;
          this.signalOpen = false;
          this.stopSignalAlive();
          this.invalidateInputForSignalRecovery();
          diagnosticLog.warn('remote.desktop.signal.close', { signalingReady: this.snapshotValue.signalingReady, code: event.code, reason: event.reason });
          if (!this.snapshotValue.signalingReady) {
            const code = remoteDesktopCodeFromText(event.reason);
            if (code) { void this.fail(code, event.reason || 'Remote desktop session initialization failed.'); return; }
          }
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
          this.sendVisibility();
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
          if (this.active && this.snapshotValue.inputRequested && !this.snapshotValue.inputEnabled) this.resumeWanted();
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
    const transceiver = peer.addTransceiver('video', { direction: 'recvonly' });
    try {
      const codecs = RTCRtpReceiver.getCapabilities('video')?.codecs;
      if (codecs?.length && typeof transceiver.setCodecPreferences === 'function') {
        transceiver.setCodecPreferences(preferredRemoteDesktopVideoCodecs(codecs, this.videoCodecs));
      }
    } catch (cause) {
      diagnosticLog.warn('remote.desktop.video.codec.preferences', { error: errorCode(cause) });
    }
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
      this.update({ controlRequestPending: false });
    } else if (this.snapshotValue.controlRequestPending) {
      this.update({ controlRequestPending: false });
      if (this.snapshotValue.inputRequested) this.resumeWanted();
    }
    this.update({
      session: snapshot,
      isController: snapshot.isController,
      hasController: snapshot.hasController,
      viewerCount: snapshot.viewerCount,
      viewerSources: Array.isArray(snapshot.viewerSources) ? snapshot.viewerSources : [],
    });
    if (this.active && this.snapshotValue.inputRequested) this.resumeWanted();
    if (snapshot.transport === 'webrtc' && this.fallbackState !== 'idle') this.commitTransportUpgrade();
  }

  private async beginFallback(reason: 'ice-failed' | 'recovery-timeout', diagnosticCode: string | undefined, proactive: boolean) {
    if (this.destroyed || !this.session || this.fallbackState !== 'idle' || !this.snapshotValue.transportAvailability.websocket) return;
    if (!this.snapshotValue.signalingReady) {
      diagnosticLog.warn('remote.desktop.fallback.not-ready', { reason, diagnosticCode, proactive });
      return;
    }
    this.clearFallbackHeadStart();
    this.clearFallbackVideoMetadata();
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
      if (isLostSessionError(cause)) {
        await this.recoverLostSession(errorCode(cause), errorMessage(cause));
        return;
      }
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
    this.fallbackReceiveRate.add(utf8Length(text));
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
        || !Number.isSafeInteger(bitrate) || bitrate < 1
        || !/^(avc1|avc3|hvc1|hev1)\./i.test(codec)) {
        this.handleFallbackTransportFailure(attempt, 'media-config-invalid');
        return;
      }
      this.fallbackCodec = codec;
      this.fallbackFrameRate = fps;
      this.fallbackConfiguredWidth = width;
      this.fallbackConfiguredHeight = height;
      diagnosticLog.info('remote.desktop.fallback.configure', { attempt, codec, width, height, fps, bitrate });
      if (this.snapshotValue.path === 'websocket') this.applyFallbackVideoMetadata();
      this.decodeQueue.clear();
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
    this.fallbackReceiveRate.add(data.byteLength);
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
    this.fallbackFramesReceived += 1;
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
    if (assembled.skippedFrames) {
      this.decodeQueue.clear();
      this.fallbackDroppedFrames += 1;
      this.fallbackNeedsKeyframe = true;
    }
    if (!this.fallbackCodec) return;
    if (!assembled.keyframe && (this.fallbackNeedsKeyframe || !this.fallbackFirstFrame)) {
      this.requestFallbackKeyframe();
      return;
    }
    const timestampUs = Number(assembled.timestampUs);
    if (!Number.isFinite(timestampUs)) return;
    const generation = this.epoch;
    if (traceFallbackFrame) {
      diagnosticLog.info('remote.desktop.fallback.decode.enqueue', {
        attempt,
        frameId: assembled.frameId,
        keyframe: assembled.keyframe,
        generation,
        epoch: this.epoch,
        state: this.fallbackState,
        backlog: this.decodeQueue.size,
      });
    }
    const accepted = this.decodeQueue.enqueue({
      bytes: assembled.payload.byteLength,
      run: async (isCurrent) => {
        try {
          if (traceFallbackFrame) {
            diagnosticLog.info('remote.desktop.fallback.decode.start', {
              frameId: assembled.frameId, keyframe: assembled.keyframe,
              generation, epoch: this.epoch, state: this.fallbackState,
            });
          }
          if (!isCurrent() || this.destroyed || generation !== this.epoch
            || attempt !== this.fallbackAttempt || this.fallbackState === 'idle') return;
          if (!this.active) {
            this.fallbackNeedsKeyframe = true;
            return;
          }
          await decodeRemoteDesktopFrame(assembled.payload, assembled.keyframe, timestampUs);
          if (!isCurrent() || this.destroyed || generation !== this.epoch || attempt !== this.fallbackAttempt) return;
          this.fallbackFramesDecoded += 1;
          if (assembled.keyframe) this.fallbackNeedsKeyframe = false;
          if (!this.fallbackFirstFrame) {
            this.fallbackFirstFrame = true;
            this.update({
              videoCodec: this.fallbackCodec, videoFrameRate: this.fallbackFrameRate || undefined,
              phase: this.snapshotValue.paused ? 'paused' : 'connected',
            });
          }
        } catch (cause) {
          if (!isCurrent() || generation !== this.epoch || attempt !== this.fallbackAttempt) return;
          this.decodeQueue.clear();
          diagnosticLog.warn('remote.desktop.fallback.decode.failed', {
            frameId: assembled.frameId, keyframe: assembled.keyframe, message: errorMessage(cause),
          });
          this.fallbackNeedsKeyframe = true;
          void resetRemoteDesktopDecoder().catch(() => undefined);
          this.requestFallbackKeyframe();
        }
      },
    });
    if (!accepted) {
      this.fallbackDroppedFrames += 1;
      this.fallbackNeedsKeyframe = true;
      this.requestFallbackKeyframe();
    }
  }

  private handleFallbackControlMessage(value: any, attempt: number) {
    if (attempt !== this.fallbackAttempt || !this.fallbackSession) return;
    if (value?.type === 'fallback.rtt.pong') {
      const requestId = value.payload?.requestId;
      if (typeof requestId === 'string') {
        this.fallbackRttProbe.complete(requestId);
        this.publishFallbackDiagnostics();
      }
      return;
    }
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
    this.update({ phase: this.snapshotValue.paused ? 'paused' : 'connected', streamURL: undefined, error: undefined });
    this.applyPath('websocket');
    this.applyFallbackVideoMetadata();
    if (this.fallbackDecodedDimensions) this.setVideoDimensions(this.fallbackDecodedDimensions.width, this.fallbackDecodedDimensions.height);
    this.startFallbackDiagnostics();
    this.sendVisibility();
    this.applyStreamResolution();
    this.requestFallbackKeyframe();
    if (this.active && this.snapshotValue.inputRequested) this.resumeWanted();
    if (this.peer && (this.peer.connectionState === 'connected' || this.peer.iceConnectionState === 'connected' || this.peer.iceConnectionState === 'completed')) {
      this.requestTransportUpgrade();
    }
  }

  private startFallbackDiagnostics() {
    this.stopFallbackDiagnostics();
    this.probeFallbackRtt();
    this.fallbackNextPingAt = Date.now() + REMOTE_DESKTOP_RTT_INTERVAL_MS;
    this.publishFallbackDiagnostics();
    this.fallbackDiagnosticsTimer = setInterval(() => {
      if (this.destroyed || this.fallbackState !== 'active') return;
      const now = Date.now();
      if (now >= this.fallbackNextPingAt) {
        this.fallbackNextPingAt = now + REMOTE_DESKTOP_RTT_INTERVAL_MS;
        this.probeFallbackRtt();
      }
      this.publishFallbackDiagnostics();
    }, REMOTE_DESKTOP_DIAGNOSTICS_INTERVAL_MS);
  }

  private probeFallbackRtt() {
    const request = this.fallbackRttProbe.begin();
    if (request && !this.wire('control', 'fallback.rtt.ping', { requestId: request.requestId })) {
      this.fallbackRttProbe.cancel(request.requestId);
    }
  }

  private stopFallbackDiagnostics() {
    if (this.fallbackDiagnosticsTimer) clearInterval(this.fallbackDiagnosticsTimer);
    this.fallbackDiagnosticsTimer = undefined;
    this.fallbackNextPingAt = 0;
    this.fallbackLastMetricsLogAt = 0;
    this.fallbackFramesReceived = 0;
    this.fallbackFramesDecoded = 0;
    this.fallbackDroppedFrames = 0;
    this.fallbackKeyframeRequests = 0;
    this.fallbackRttProbe.reset();
    this.fallbackReceiveRate.reset();
    if (this.snapshotValue.transportDiagnostics?.path === 'websocket') {
      this.update({ transportDiagnostics: undefined });
    }
  }

  private publishFallbackDiagnostics() {
    if (this.fallbackState !== 'active') return;
    const latency = this.fallbackRttProbe.snapshot();
    const bandwidth = this.fallbackReceiveRate.sample();
    const diagnostics: RemoteDesktopFallbackDiagnostics = {
      path: 'websocket',
      latencyStatus: latency.status,
      bandwidthStatus: bandwidth.status,
      ...(latency.latencyMs === undefined ? {} : { latencyMs: latency.latencyMs }),
      ...(bandwidth.mbps === undefined ? {} : { bandwidthMbps: bandwidth.mbps }),
    };
    this.applyPath('websocket', diagnostics);
    const now = Date.now();
    if (now - this.fallbackLastMetricsLogAt >= 900) {
      const metrics = {
        receiveMbps: bandwidth.mbps,
        decodeQueueSize: this.decodeQueue.size,
        rttMs: latency.latencyMs,
        droppedFrames: this.fallbackDroppedFrames,
        receivedFrames: this.fallbackFramesReceived,
        decodedFrames: this.fallbackFramesDecoded,
        keyframeRequests: this.fallbackKeyframeRequests,
      };
      diagnosticLog.info('remote.desktop.fallback.metrics', { attempt: this.fallbackAttempt, ...metrics });
      this.fallbackLastMetricsLogAt = now;
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
    this.clearFallbackVideoMetadata();
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
    this.clearFallbackVideoMetadata();
    this.fallbackNeedsKeyframe = true;
    this.update({ path: this.snapshotValue.path === 'websocket' ? undefined : this.snapshotValue.path, transportDiagnostics: undefined, streamURL: this.snapshotValue.streamURL, phase: this.snapshotValue.paused ? 'paused' : 'connected' });
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
    this.clearFallbackVideoMetadata();
    this.updateTransportState('websocket', 'idle');
  }

  private requestFallbackKeyframe() {
    const media = this.fallbackMedia;
    if (!media || this.fallbackState === 'idle') return;
    const now = Date.now();
    if (now - this.fallbackLastKeyframeAt < 500) return;
    this.fallbackLastKeyframeAt = now;
    this.fallbackKeyframeRequests += 1;
    try { media.send(JSON.stringify({ type: 'fallback.keyframe-request' })); } catch { /* reconnect owns the failure */ }
  }

  private handleControlMessage(data: unknown) {
    if (typeof data !== 'string') return;
    try { this.handleControlValue(JSON.parse(data)); } catch { /* channel-level malformed messages are ignored */ }
  }

  private handleControlValue(value: any) {
    if (value?.type === 'input.resumed') {
      this.inputEpoch = Number(value.payload?.inputEpoch) || 0;
      this.clearInputResumeTimers();
      this.inputResumeRetryCount = 0;
      this.startInputAlive();
      const wantsInput = this.snapshotValue.inputRequested;
      this.update({ inputEnabled: true, inputPending: false, inputRequested: wantsInput });
      if (!wantsInput) this.suspendInput();
      diagnosticLog.info('remote.desktop.input.resumed', { inputEpoch: this.inputEpoch });
    } else if (value?.type === 'input.suspended') {
      const payload = value.payload ?? {};
      const sessionRevision = Number.isSafeInteger(payload.sessionRevision) && payload.sessionRevision >= 0
        ? payload.sessionRevision
        : undefined;
      const shouldResume = payload.recoverable === true
        && sessionRevision !== undefined
        && this.snapshotValue.inputRequested
        && this.snapshotValue.isController
        && this.active
        && !this.snapshotValue.paused;
      this.releaseInputState();
      diagnosticLog.info('remote.desktop.input.suspended', {
        cause: typeof payload.cause === 'string' ? payload.cause : undefined,
        recoverable: payload.recoverable === true,
        sessionRevision,
      });
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
      const viewerSources = DesktopViewerSourcesSchema.safeParse(value.payload?.viewerSources).data;
      this.update({
        isController,
        controlRequestPending: false,
        hasController: true,
        viewerCount: Number.isInteger(value.payload?.viewerCount) ? value.payload.viewerCount : this.snapshotValue.viewerCount,
        viewerSources: viewerSources ?? this.snapshotValue.viewerSources,
        ...(value.payload?.controlRevision !== undefined ? { session: this.snapshotValue.session ? { ...this.snapshotValue.session, controlRevision: Number(value.payload.controlRevision) || 0, isController } : undefined } : {}),
      });
      if (!isController) {
        this.releaseInputState();
      } else if (this.snapshotValue.inputRequested) {
        this.resumeWanted();
      }
    } else if (value?.type === 'error') {
      const code = typeof value.payload?.code === 'string' ? value.payload.code : 'REMOTE_DESKTOP_MESSAGE_INVALID';
      if (code === 'REMOTE_DESKTOP_WEBRTC_NOT_READY') return;
      if (code === 'REMOTE_DESKTOP_INVALID_STATE' && this.snapshotValue.inputEnabled) {
        diagnosticLog.info('remote.desktop.input.late-error.ignored', { code });
        return;
      }
      const retryingInput = isRecoverableRemoteDesktopInputResumeError(code)
        && this.snapshotValue.inputRequested
        && this.snapshotValue.isController
        && this.active
        && !this.snapshotValue.paused;
      this.releaseInputState(!retryingInput);
      if (retryingInput) {
        diagnosticLog.warn('remote.desktop.input.resume.error', {
          code,
          sessionRevision: this.snapshotValue.session?.sessionRevision,
        });
        if (code === 'REMOTE_DESKTOP_STALE_EPOCH') void this.refreshInputResumeSnapshot(code);
        else this.scheduleInputResumeRetry(code);
        return;
      }
      this.update({ controlRequestPending: false, error: { code, message: code } });
    }
  }

  private resumeWanted() {
    if (this.destroyed || !this.active || this.snapshotValue.paused || this.snapshotValue.inputEnabled || this.snapshotValue.inputPending || this.inputResumeRetryTimer !== undefined) return;
    // mediaPaused is a snapshot projection and can be stale across fallback
    // reconnects. Visibility and input resume share one ordered control
    // channel, so the server clears mediaPaused before accepting the resume.
    if (this.snapshotValue.session?.phase !== 'active' && this.snapshotValue.phase !== 'connected') {
      this.deferInputResume('session-not-ready');
      return;
    }
    if (!this.snapshotValue.isController) {
      if (!this.snapshotValue.hasController) this.requestControl();
      return;
    }
    const sessionRevision = this.snapshotValue.session?.sessionRevision;
    const sent = this.wire('control', 'input.resume', { sessionRevision });
    if (sent) {
      diagnosticLog.info('remote.desktop.input.resume.sent', {
        attempt: this.inputResumeRetryCount + 1,
        sessionRevision,
      });
      this.update({ inputPending: true });
      this.armInputResumeAckTimeout();
      return;
    }
    const channel = this.fallbackState === 'active' ? this.fallbackControl : this.channels.get('control');
    this.deferInputResume(channel ? 'control-send-failed' : 'control-channel-unavailable');
  }

  private deferInputResume(reason: string) {
    const channel = this.fallbackState === 'active' ? this.fallbackControl : this.channels.get('control');
    diagnosticLog.info('remote.desktop.input.resume.deferred', {
      reason,
      controlReadyState: channel?.readyState,
      fallbackState: this.fallbackState,
      sessionPhase: this.snapshotValue.session?.phase,
      mediaPaused: this.snapshotValue.session?.mediaPaused,
      ...this.inputTraceState(),
    });
    this.scheduleInputResumeRetry(reason);
  }

  private armInputResumeAckTimeout() {
    this.clearInputResumeAckTimer();
    this.inputResumeAckTimer = setTimeout(() => {
      this.inputResumeAckTimer = undefined;
      if (this.destroyed || !this.active || this.snapshotValue.paused || !this.snapshotValue.inputRequested || !this.snapshotValue.isController || this.snapshotValue.inputEnabled) return;
      diagnosticLog.warn('remote.desktop.input.resume.timeout', {
        attempt: this.inputResumeRetryCount + 1,
        sessionRevision: this.snapshotValue.session?.sessionRevision,
      });
      this.update({ inputPending: false });
      this.scheduleInputResumeRetry('ack-timeout');
    }, REMOTE_DESKTOP_INPUT_RESUME_ACK_TIMEOUT_MS);
  }

  private scheduleInputResumeRetry(reason: string) {
    if (this.inputResumeRetryTimer || this.destroyed || !this.active || this.snapshotValue.paused || !this.snapshotValue.inputRequested || !this.snapshotValue.isController || this.snapshotValue.inputEnabled) return;
    const attempt = this.inputResumeRetryCount;
    this.inputResumeRetryCount += 1;
    const delayMs = remoteDesktopInputResumeRetryDelayMs(attempt);
    diagnosticLog.info('remote.desktop.input.resume.retry', {
      attempt: attempt + 1,
      delayMs,
      reason,
      sessionRevision: this.snapshotValue.session?.sessionRevision,
    });
    this.inputResumeRetryTimer = setTimeout(() => {
      this.inputResumeRetryTimer = undefined;
      this.resumeWanted();
    }, delayMs);
  }

  private refreshInputResumeSnapshot(reason: string) {
    if (this.inputResumeRefresh) return this.inputResumeRefresh;
    const session = this.session;
    if (!session || this.destroyed) return Promise.resolve();
    diagnosticLog.info('remote.desktop.input.resume.refresh', {
      sessionRevision: session.snapshot.sessionRevision,
    });
    const refresh = Promise.resolve()
      .then(() => this.input.api.snapshot(this.input.instanceId, session.snapshot.viewerSessionId))
      .then(async (snapshot) => {
        if (this.destroyed || this.session?.snapshot.viewerSessionId !== session.snapshot.viewerSessionId) return;
        await this.applySnapshot(snapshot);
      })
      .catch((cause) => {
        if (this.destroyed || this.session?.snapshot.viewerSessionId !== session.snapshot.viewerSessionId) return;
        diagnosticLog.warn('remote.desktop.input.resume.refresh.failed', {
          code: errorCode(cause),
          message: errorMessage(cause),
        });
        this.scheduleInputResumeRetry(reason);
      })
      .finally(() => {
        if (this.inputResumeRefresh === refresh) this.inputResumeRefresh = undefined;
      });
    this.inputResumeRefresh = refresh;
    return refresh;
  }

  private invalidateInputForSignalRecovery() {
    if (!this.snapshotValue.inputEnabled && !this.snapshotValue.inputPending) return;
    diagnosticLog.info('remote.desktop.input.rearm.pending', {
      inputEpoch: this.inputEpoch,
      inputPending: this.snapshotValue.inputPending,
    });
    this.releaseInputState();
  }

  private suspendInput() {
    if (this.snapshotValue.inputEnabled) this.wire('control', 'input.suspend');
    this.releaseInputState();
  }

  private releaseInputState(resetRetry = true) {
    this.stopInputAlive();
    this.clearInputResumeTimers();
    if (resetRetry) this.inputResumeRetryCount = 0;
    this.inputEpoch = 0;
    this.update({ inputEnabled: false, inputPending: false });
  }

  private startInputAlive() {
    this.stopInputAlive();
    this.inputAliveTimer = setInterval(() => {
      if (!this.active || !this.snapshotValue.inputEnabled) return;
      const rawChannel = this.fallbackState === 'active' ? this.fallbackControl : this.channels.get('control');
      const sequence = this.transmit('control', 'input.alive', { inputEpoch: this.inputEpoch });
      diagnosticLog.info('remote.desktop.input.alive', {
        sent: sequence !== undefined,
        sequence,
        inputEpoch: this.inputEpoch,
        channel: this.fallbackState === 'active' ? 'websocket' : 'webrtc',
        channelReadyState: rawChannel?.readyState,
        active: this.active,
        inputEnabled: this.snapshotValue.inputEnabled,
        inputRequested: this.snapshotValue.inputRequested,
        inputPending: this.snapshotValue.inputPending,
        isController: this.snapshotValue.isController,
        paused: this.snapshotValue.paused,
        path: this.snapshotValue.path,
      });
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
    this.wire('control', 'stream.resolution', remoteDesktopStreamResolution(
      this.snapshotValue.resolution,
      this.snapshotValue.frameRate,
      this.snapshotValue.capturePrecision,
    ));
  }

  private outputChannel(name: ChannelName): WireChannel | undefined {
    if (this.fallbackState === 'active') {
      return this.fallbackControl?.readyState === 1 ? this.fallbackControl : undefined;
    }
    const channel = this.channels.get(name);
    return channel?.readyState === 'open' ? channel : undefined;
  }

  private wire(name: ChannelName, type: string, payload: unknown = {}, maxBytes = REMOTE_DESKTOP_MAX_MESSAGE_BYTES) {
    return this.transmit(name, type, payload, maxBytes) !== undefined;
  }

  private transmit(name: ChannelName, type: string, payload: unknown = {}, maxBytes = REMOTE_DESKTOP_MAX_MESSAGE_BYTES) {
    const channel = this.outputChannel(name);
    if (!channel) return undefined;
    const next = this.seq + 1;
    const encoded = JSON.stringify({ v: REMOTE_DESKTOP_CHANNEL_VERSION, seq: next, type, payload });
    if (utf8Length(encoded) > maxBytes) return undefined;
    try { channel.send(encoded); this.seq = next; return next; }
    catch { return undefined; }
  }

  private inputReady() {
    return this.inputBlockedReason() === undefined;
  }

  private inputBlockedReason() {
    if (this.destroyed) return 'destroyed';
    if (!this.active) return 'inactive';
    if (!this.snapshotValue.inputEnabled) return 'input-disabled';
    if (this.inputEpoch <= 0) return 'epoch-unavailable';
    return undefined;
  }

  private inputTraceState() {
    return {
      active: this.active,
      inputEnabled: this.snapshotValue.inputEnabled,
      inputRequested: this.snapshotValue.inputRequested,
      inputPending: this.snapshotValue.inputPending,
      isController: this.snapshotValue.isController,
      paused: this.snapshotValue.paused,
      path: this.snapshotValue.path,
    };
  }

  private shouldTracePointer() {
    const now = Date.now();
    this.pointerTraceCount += 1;
    if (this.pointerTraceCount <= 10 || now - this.pointerTraceLastAt >= 500) {
      this.pointerTraceLastAt = now;
      return true;
    }
    this.pointerTraceSkipped += 1;
    return false;
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
    const progress = remoteDesktopWebRTCProgress(Boolean(this.peer), this.peer?.iceConnectionState);
    // A Relay outage tears down the signaling tunnel, not the WebRTC media
    // path. Keep a connected peer alive and replace only the signaling tunnel;
    // switching a live P2P stream to the fallback transport here would turn a
    // control-plane reconnect into an unnecessary media downgrade.
    if (progress === 'connected' || !this.snapshotValue.signalingReady) {
      diagnosticLog.warn('remote.desktop.signal.recover', { code, progress, signalingReady: this.snapshotValue.signalingReady });
      this.scheduleSignalResume(code, true);
      return;
    }
    if (this.snapshotValue.transportAvailability.websocket) void this.beginFallback('ice-failed', code, false);
    else this.scheduleSignalResume(code, true);
  }

  private scheduleSignalResume(code: string, immediate = false) {
    if (this.destroyed || !this.session || this.fallbackState !== 'idle' || this.signalResumeTimer || this.signalResumeInFlight) return;
    if (!this.signalResumeDeadline) this.signalResumeDeadline = Date.now() + SIGNAL_RESUME_WINDOW_MS;
    if (Date.now() >= this.signalResumeDeadline) {
      this.finishSignalResumeFailure(code);
      return;
    }
    const delay = immediate
      ? 0
      : Math.min(SIGNAL_RESUME_RETRY_MAX_MS, SIGNAL_RESUME_RETRY_BASE_MS * 2 ** Math.max(0, this.signalResumeAttempt - 1));
    this.signalResumeTimer = setTimeout(() => {
      this.signalResumeTimer = undefined;
      void this.resumeSignal(code);
    }, delay);
  }

  private async resumeSignal(code: string) {
    const session = this.session;
    if (this.destroyed || !session || this.fallbackState !== 'idle' || this.signalResumeInFlight) return;
    if (Date.now() >= this.signalResumeDeadline) {
      this.finishSignalResumeFailure(code);
      return;
    }
    const epoch = this.epoch;
    this.signalResumeInFlight = true;
    this.signalResumeAttempt += 1;
    let retry = false;
    diagnosticLog.info('remote.desktop.signal.resume.begin', { attempt: this.signalResumeAttempt, code });
    try {
      const ticket = await this.input.api.resumeSignal(this.input.instanceId, session.snapshot.viewerSessionId);
      if (!this.current(epoch) || this.session !== session || this.stopping) return;
      this.session = { ...session, signalUrl: ticket.signalUrl, ticketExpiresAt: ticket.ticketExpiresAt };
      this.openSignal(this.session);
      diagnosticLog.info('remote.desktop.signal.resume.ticket', { attempt: this.signalResumeAttempt });
    } catch (cause) {
      if (!this.current(epoch) || this.session !== session) return;
      diagnosticLog.warn('remote.desktop.signal.resume.failed', {
        attempt: this.signalResumeAttempt,
        code: errorCode(cause),
        retryable: isRetryableTransportError(cause),
      });
      if (isLostSessionError(cause)) {
        await this.recoverLostSession(errorCode(cause), errorMessage(cause));
      } else if (isRetryableTransportError(cause) && Date.now() < this.signalResumeDeadline) {
        retry = true;
      } else {
        this.finishSignalResumeFailure(errorCode(cause));
      }
    } finally {
      this.signalResumeInFlight = false;
      if (retry) this.scheduleSignalResume(code);
    }
  }

  private finishSignalResumeFailure(code: string) {
    this.stopSignalResume();
    if (this.snapshotValue.signalingReady && this.snapshotValue.transportAvailability.websocket) {
      void this.beginFallback('ice-failed', code || 'REMOTE_DESKTOP_SIGNAL_RECOVERY_FAILED', false);
      return;
    }
    void this.fail(code || 'REMOTE_DESKTOP_SIGNAL_RECOVERY_FAILED', 'Remote desktop signaling could not be restored.');
  }

  private recoverLostSession(code: string, message: string) {
    if (this.destroyed) return Promise.resolve();
    if (this.stopping || this.targetTransition) return Promise.resolve();
    if (!this.active) return this.fail(code, message);
    if (this.sessionRecovery) return this.sessionRecovery;
    diagnosticLog.info('remote.desktop.session.recreate', {
      code,
      target: this.snapshotValue.target.kind,
      targetRef: this.snapshotValue.target.sourceRef,
    });
    const recovery = this.recoverLostSessionNow();
    this.sessionRecovery = recovery;
    void recovery.then(
      () => { if (this.sessionRecovery === recovery) this.sessionRecovery = undefined; },
      () => { if (this.sessionRecovery === recovery) this.sessionRecovery = undefined; },
    );
    return recovery;
  }

  private async recoverLostSessionNow() {
    // A Relay reconnect can outlive the viewer reservation. In that case the
    // old signaling and fallback endpoints return 404 forever, so resuming it
    // cannot recover; release the dead reservation and create a fresh session
    // for the same capture target.
    await this.stopCurrentSession(true);
    if (this.destroyed) return;
    const starting = this.startingTask;
    if (starting) await starting.catch(() => undefined);
    if (this.destroyed) return;
    this.update({
      phase: 'connecting',
      error: undefined,
      streamURL: undefined,
      path: undefined,
      signalingReady: false,
      inputRequested: this.interactive,
      transportDiagnostics: undefined,
      videoWidth: 0,
      videoHeight: 0,
      videoCodec: undefined,
      videoFrameRate: undefined,
    });
    await this.beginStart();
  }

  private stopSignalResume() {
    if (this.signalResumeTimer) clearTimeout(this.signalResumeTimer);
    this.signalResumeTimer = undefined;
    this.signalResumeDeadline = 0;
    this.signalResumeAttempt = 0;
  }

  private startStatsWatch(peer: RTCPeerConnection) {
    // Both ICE and connection state transitions report success. Starting the
    // watcher twice creates overlapping getStats samples, which makes the
    // receive counter advance without a measurable time delta and intermittently
    // clears the derived traffic value.
    if (this.peer !== peer || this.statsPeer === peer) return;
    this.stopStatsWatch();
    this.statsPeer = peer;
    const poll = async () => {
      if (this.destroyed || this.peer !== peer || this.statsPeer !== peer) return;
      await this.refreshTransportPath(peer);
      if (this.destroyed || this.peer !== peer || this.statsPeer !== peer) return;
      this.statsTimer = setTimeout(() => void poll(), STATS_INTERVAL_MS);
    };
    void poll();
  }

  private async refreshTransportPath(peer: RTCPeerConnection) {
    try {
      const stats = await peer.getStats();
      const receiveSample = parseRemoteDesktopWebRTCReceiveSample(stats as Parameters<typeof parseRemoteDesktopWebRTCReceiveSample>[0]);
      const diagnostics = parseRemoteDesktopWebRTCStats(stats as Parameters<typeof parseRemoteDesktopWebRTCStats>[0], this.webRTCReceiveSample);
      this.webRTCReceiveSample = receiveSample;
      const path = diagnostics?.path;
      if (!path) return;
      if (path === 'turn' && !this.snapshotValue.transportAvailability.turn) return;
      if (path === 'p2p' && !this.snapshotValue.transportAvailability.p2p) return;
      this.applyPath(path, diagnostics);
    } catch {
      // Stats are diagnostic; media state changes still drive the session.
    }
  }

  private applyPath(path?: RemoteDesktopPath, diagnostics?: RemoteDesktopTransportDiagnostics) {
    const availability = this.snapshotValue.transportAvailability;
    const states: Record<RemoteDesktopTransportKey, RemoteDesktopTransportState> = {
      p2p: availability.p2p ? (path === 'p2p' ? 'active' : 'pending') : 'idle',
      turn: availability.turn ? (path === 'turn' ? 'active' : 'pending') : 'idle',
      websocket: this.fallbackState === 'active' ? 'active' : this.fallbackState === 'switching' || this.fallbackState === 'reconnecting' ? 'pending' : this.fallbackState === 'failed' ? 'failed' : 'idle',
    };
    const webRTCDiagnostics = path === 'p2p' || path === 'turn' ? diagnostics : undefined;
    const nextDiagnostics = path === 'websocket' || path === 'p2p' || path === 'turn' ? diagnostics : undefined;
    const nextCodec = path === 'websocket' ? this.fallbackCodec || undefined : webRTCDiagnostics?.codec;
    const nextFrameRate = path === 'websocket' ? this.fallbackFrameRate || undefined : webRTCDiagnostics?.frameRate;
    if (this.snapshotValue.path === path
      && sameTransportStates(this.snapshotValue.transportStates, states)
      && sameTransportDiagnostics(this.snapshotValue.transportDiagnostics, nextDiagnostics)
      && this.snapshotValue.videoCodec === nextCodec
      && this.snapshotValue.videoFrameRate === nextFrameRate) return;
    this.update({ path, transportStates: states, transportDiagnostics: nextDiagnostics, videoCodec: nextCodec, videoFrameRate: nextFrameRate });
  }

  private updateTransportState(key: RemoteDesktopTransportKey, state: RemoteDesktopTransportState) {
    this.update({ transportStates: { ...this.snapshotValue.transportStates, [key]: state } });
  }

  private async reconnectForTransportPolicy() {
    // Transport policy creates a fresh viewer session, so the previous
    // reservation must be released first; otherwise the component reports the
    // instance as busy and the new transport never starts.
    await this.stopCurrentSession(true);
    this.update({ phase: 'connecting', error: undefined, streamURL: undefined, path: undefined, transportDiagnostics: undefined, signalingReady: false, videoWidth: 0, videoHeight: 0, videoCodec: undefined, videoFrameRate: undefined, inputRequested: true });
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
    this.clearFallbackVideoMetadata();
    this.fallbackUpgradeStartedAt = 0;
    this.channels.clear();
    this.seq = 0;
    this.inputEpoch = 0;
    this.update({
      streamURL: undefined,
      videoWidth: 0,
      videoHeight: 0,
      videoCodec: undefined,
      videoFrameRate: undefined,
      path: undefined,
      transportDiagnostics: undefined,
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
    this.webRTCReceiveSample = undefined;
    this.stopStatsWatch();
    try { peer?.close(); } catch { /* native close is best effort */ }
    this.channels.clear();
  }

  private closeFallbackSockets(reason: string) {
    this.decodeQueue.clear();
    const media = this.fallbackMedia;
    const control = this.fallbackControl;
    this.fallbackMedia = undefined;
    this.fallbackControl = undefined;
    this.stopFallbackDiagnostics();
    this.clearFallbackPointer();
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
  private clearFallbackPointer() {
    if (this.fallbackPointerTimer) clearTimeout(this.fallbackPointerTimer);
    this.fallbackPointerTimer = undefined;
    this.fallbackPointer = undefined;
  }
  private stopStatsWatch() {
    if (this.statsTimer) clearTimeout(this.statsTimer);
    this.statsTimer = undefined;
    this.statsPeer = undefined;
  }

  private clearAllTimers() {
    this.clearWebRTCTimers();
    this.clearStartupTimeout();
    this.clearFallbackPairTimer();
    this.clearFallbackRetry();
    this.clearFallbackUpgrade();
    this.clearFallbackPointer();
    this.stopSignalResume();
    this.stopStatsWatch();
    this.clearInputResumeTimers();
    if (this.availabilityTimer) clearTimeout(this.availabilityTimer);
    this.availabilityTimer = undefined;
  }

  private clearInputResumeTimers() {
    this.clearInputResumeAckTimer();
    if (this.inputResumeRetryTimer) clearTimeout(this.inputResumeRetryTimer);
    this.inputResumeRetryTimer = undefined;
  }

  private clearInputResumeAckTimer() {
    if (this.inputResumeAckTimer) clearTimeout(this.inputResumeAckTimer);
    this.inputResumeAckTimer = undefined;
  }

  private applyFallbackVideoMetadata() {
    if (!this.fallbackCodec) return;
    this.update({
      videoWidth: this.fallbackConfiguredWidth,
      videoHeight: this.fallbackConfiguredHeight,
      videoCodec: this.fallbackCodec,
      videoFrameRate: this.fallbackFrameRate || undefined,
    });
  }

  private clearFallbackVideoMetadata() {
    this.fallbackCodec = '';
    this.fallbackFrameRate = 0;
    this.fallbackConfiguredWidth = 0;
    this.fallbackConfiguredHeight = 0;
    this.fallbackDecodedDimensions = undefined;
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
    this.update({ phase: 'error', error: { code, message }, inputEnabled: false, inputRequested: false, inputPending: false, signalingReady: false, streamURL: undefined, transportDiagnostics: undefined, videoCodec: undefined, videoFrameRate: undefined });
    if (session) await this.input.api.stop(this.input.instanceId, session.snapshot.viewerSessionId).catch(() => undefined);
  }

  private update(patch: Partial<RemoteDesktopSnapshot>) {
    this.snapshotValue = { ...this.snapshotValue, ...patch };
    for (const listener of this.listeners) listener();
  }
}

function sameTarget(left: PersistedCaptureTarget, right: PersistedCaptureTarget) {
  if (left.kind !== right.kind) return false;
  if (left.sourceRef || right.sourceRef) return left.sourceRef === right.sourceRef;
  return left.title === right.title
    && left.subtitle === right.subtitle
    && left.width === right.width
    && left.height === right.height;
}

function sameAvailability(left: RemoteDesktopTransportAvailability, right: RemoteDesktopTransportAvailability) {
  return left.p2p === right.p2p && left.turn === right.turn && left.websocket === right.websocket;
}

function sameTransportStates(
  left: RemoteDesktopSnapshot['transportStates'],
  right: RemoteDesktopSnapshot['transportStates'],
) {
  return left.p2p === right.p2p && left.turn === right.turn && left.websocket === right.websocket;
}

function sameTransportDiagnostics(left?: RemoteDesktopTransportDiagnostics, right?: RemoteDesktopTransportDiagnostics) {
  if (!left || !right) return left === right;
  return left.path === right.path
    && left.protocol === right.protocol
    && left.localCandidateType === right.localCandidateType
    && left.remoteCandidateType === right.remoteCandidateType
    && left.latencyMs === right.latencyMs
    && left.latencyStatus === right.latencyStatus
    && left.bandwidthMbps === right.bandwidthMbps
    && left.bandwidthStatus === right.bandwidthStatus
    && left.codec === right.codec
    && left.frameRate === right.frameRate;
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
function remoteDesktopCodeFromText(value: unknown) {
  const match = typeof value === 'string' ? /(REMOTE_DESKTOP_[A-Z0-9_]+)/.exec(value) : null;
  return match?.[1];
}
function isRetryableTransportError(cause: unknown) {
  return Boolean(cause && typeof cause === 'object' && 'retryable' in cause && (cause as { retryable?: unknown }).retryable === true);
}

const LOST_SESSION_ERROR_CODES = new Set([
  'REMOTE_DESKTOP_NOT_FOUND',
  'REMOTE_DESKTOP_STALE_BOOT',
  'REMOTE_DESKTOP_DEADLINE_EXCEEDED',
  'REMOTE_DESKTOP_SESSION_CLOSED',
]);

function isLostSessionError(cause: unknown) {
  const status = cause && typeof cause === 'object' && 'status' in cause
    ? Number((cause as { status?: unknown }).status)
    : undefined;
  return status === 404 || LOST_SESSION_ERROR_CODES.has(errorCode(cause));
}
