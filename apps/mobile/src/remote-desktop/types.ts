import type { DesktopSessionSnapshot } from '@task-handoff/protocol/remote-desktop';
import type { RemoteDesktopWebRTCStats } from '@task-handoff/control-plane-client';

import type {
  PersistedCaptureTarget,
  RemoteDesktopCapturePrecision,
  RemoteDesktopFrameRate,
  RemoteDesktopResolution,
  RemoteDesktopTransportAvailability,
  RemoteDesktopTransportKey,
} from './preferences';

export type RemoteDesktopPhase = 'idle' | 'connecting' | 'connected' | 'paused' | 'reconnecting' | 'stopped' | 'error';
export type RemoteDesktopPath = 'p2p' | 'turn' | 'websocket';
export type RemoteDesktopTransportState = 'idle' | 'pending' | 'active' | 'failed';

export type RemoteDesktopError = { code: string; message: string };

export type RemoteDesktopSnapshot = {
  phase: RemoteDesktopPhase;
  error?: RemoteDesktopError;
  session?: DesktopSessionSnapshot;
  streamURL?: string;
  videoWidth: number;
  videoHeight: number;
  videoCodec?: string;
  videoFrameRate?: number;
  path?: RemoteDesktopPath;
  transportDiagnostics?: RemoteDesktopWebRTCStats;
  signalingReady: boolean;
  paused: boolean;
  inputEnabled: boolean;
  inputRequested: boolean;
  inputPending: boolean;
  controlRequestPending: boolean;
  isController: boolean;
  hasController: boolean;
  viewerCount: number;
  target: PersistedCaptureTarget;
  resolution: RemoteDesktopResolution;
  frameRate: RemoteDesktopFrameRate;
  capturePrecision: RemoteDesktopCapturePrecision;
  transportAvailability: RemoteDesktopTransportAvailability;
  transportStates: Record<RemoteDesktopTransportKey, RemoteDesktopTransportState>;
};

export const emptyRemoteDesktopSnapshot: RemoteDesktopSnapshot = {
  phase: 'idle',
  videoWidth: 0,
  videoHeight: 0,
  signalingReady: false,
  paused: false,
  inputEnabled: false,
  inputRequested: true,
  inputPending: false,
  controlRequestPending: false,
  isController: true,
  hasController: true,
  viewerCount: 1,
  target: { kind: 'display' },
  resolution: 'auto',
  frameRate: 'auto',
  capturePrecision: 'auto',
  transportAvailability: { p2p: true, turn: true, websocket: true },
  transportStates: { p2p: 'idle', turn: 'idle', websocket: 'idle' },
};
