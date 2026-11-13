import type { RemoteDesktopTransportDiagnostics } from './remote-desktop-transport.ts';

export type RemoteDesktopWebRTCStats = Omit<RemoteDesktopTransportDiagnostics, 'path'> & {
  path?: 'p2p' | 'turn';
};

export type RemoteDesktopWebRTCReceiveSample = {
  bytes: number;
  timestampMs: number;
};

type StatsReport = {
  forEach(callback: (report: unknown) => void): void;
  get(id: string): unknown;
};

type CandidatePairReport = {
  type?: unknown;
  selectedCandidatePairId?: unknown;
  localCandidateId?: unknown;
  remoteCandidateId?: unknown;
  state?: unknown;
  nominated?: unknown;
  protocol?: unknown;
  currentRoundTripTime?: unknown;
  totalRoundTripTime?: unknown;
  responsesReceived?: unknown;
};

type CandidateReport = {
  candidateType?: unknown;
  protocol?: unknown;
};

type InboundRtpReport = {
  type?: unknown;
  kind?: unknown;
  mediaType?: unknown;
  bytesReceived?: unknown;
  timestamp?: unknown;
  codecId?: unknown;
  codec?: unknown;
  framesPerSecond?: unknown;
};

type CodecReport = {
  mimeType?: unknown;
  codec?: unknown;
};

/** Projects the selected ICE candidate pair into UI diagnostics. RTT values are
 * client-owned runtime data and must never be added to the public protocol. */
export function parseRemoteDesktopWebRTCStats(
  stats: StatsReport,
  previousReceive?: RemoteDesktopWebRTCReceiveSample,
): RemoteDesktopWebRTCStats | undefined {
  const selected = selectedCandidatePair(stats);
  if (!selected) return undefined;
  const local = candidate(stats, selected.localCandidateId);
  const remote = candidate(stats, selected.remoteCandidateId);
  const localType = candidateType(local?.candidateType);
  const remoteType = candidateType(remote?.candidateType);
  const protocol = firstString(selected.protocol, local?.protocol, remote?.protocol);
  const latencyMs = roundTripTimeMs(selected);
  const bandwidthMbps = receiveBandwidthMbps(parseRemoteDesktopWebRTCReceiveSample(stats), previousReceive);
  const encoding = videoEncoding(stats);
  return {
    ...(localType || remoteType
      ? { path: localType === 'relay' || remoteType === 'relay' ? 'turn' as const : 'p2p' as const }
      : {}),
    ...(protocol ? { protocol } : {}),
    ...(localType ? { localCandidateType: localType } : {}),
    ...(remoteType ? { remoteCandidateType: remoteType } : {}),
    ...(latencyMs !== undefined ? { latencyMs } : {}),
    ...(bandwidthMbps !== undefined ? { bandwidthMbps } : {}),
    ...encoding,
  };
}

/** Returns the monotonic receive counter used to derive transport throughput
 * between two stats polls. The value stays client-side and never enters the
 * public remote desktop protocol. */
export function parseRemoteDesktopWebRTCReceiveSample(stats: StatsReport): RemoteDesktopWebRTCReceiveSample | undefined {
  let bytes = 0;
  let timestampMs = 0;
  let found = false;
  stats.forEach((value) => {
    const report = value as InboundRtpReport;
    if (report?.type !== 'inbound-rtp') return;
    const kind = firstString(report.kind, report.mediaType);
    if (kind && kind !== 'video') return;
    const received = finiteNonNegative(report.bytesReceived);
    const timestamp = finiteNonNegative(report.timestamp);
    if (received === undefined || timestamp === undefined) return;
    bytes += received;
    timestampMs = Math.max(timestampMs, timestamp);
    found = true;
  });
  return found ? { bytes, timestampMs } : undefined;
}

function selectedCandidatePair(stats: StatsReport): CandidatePairReport | undefined {
  let selected: CandidatePairReport | undefined;
  stats.forEach((value) => {
    if (selected) return;
    const report = value as CandidatePairReport;
    if (report?.type !== 'transport' || typeof report.selectedCandidatePairId !== 'string') return;
    const pair = stats.get(report.selectedCandidatePairId) as CandidatePairReport | undefined;
    if (pair?.type === 'candidate-pair') selected = pair;
  });
  if (selected) return selected;
  stats.forEach((value) => {
    if (selected) return;
    const pair = value as CandidatePairReport;
    if (pair?.type === 'candidate-pair' && pair.state === 'succeeded' && pair.nominated === true) selected = pair;
  });
  return selected;
}

function candidate(stats: StatsReport, id: unknown): CandidateReport | undefined {
  if (typeof id !== 'string') return undefined;
  return stats.get(id) as CandidateReport | undefined;
}

function roundTripTimeMs(pair: CandidatePairReport) {
  const current = finiteNonNegative(pair.currentRoundTripTime);
  if (current !== undefined) return Math.round(current * 1_000);
  const total = finiteNonNegative(pair.totalRoundTripTime);
  const responses = finiteNonNegative(pair.responsesReceived);
  if (total === undefined || !responses) return undefined;
  return Math.round((total / responses) * 1_000);
}

function receiveBandwidthMbps(
  current: RemoteDesktopWebRTCReceiveSample | undefined,
  previous: RemoteDesktopWebRTCReceiveSample | undefined,
) {
  if (!current || !previous) return undefined;
  const elapsedMs = current.timestampMs - previous.timestampMs;
  const receivedBytes = current.bytes - previous.bytes;
  if (!(elapsedMs > 0) || receivedBytes < 0) return undefined;
  return Math.round((receivedBytes * 8) / elapsedMs / 1_000 * 10) / 10;
}

function videoEncoding(stats: StatsReport) {
  let selected: InboundRtpReport | undefined;
  let selectedBytes = -1;
  stats.forEach((value) => {
    const report = value as InboundRtpReport;
    if (report?.type !== 'inbound-rtp') return;
    const kind = firstString(report.kind, report.mediaType);
    if (kind && kind !== 'video') return;
    const bytes = finiteNonNegative(report.bytesReceived) ?? 0;
    if (bytes < selectedBytes) return;
    selected = report;
    selectedBytes = bytes;
  });
  if (!selected) return {};
  const codecReport = typeof selected.codecId === 'string'
    ? stats.get(selected.codecId) as CodecReport | undefined
    : undefined;
  const codec = firstString(codecReport?.mimeType, codecReport?.codec, selected.codec);
  const frameRate = finiteNonNegative(selected.framesPerSecond);
  return {
    ...(codec ? { codec } : {}),
    ...(frameRate ? { frameRate: Math.round(frameRate) } : {}),
  };
}

function finiteNonNegative(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function candidateType(value: unknown) {
  return typeof value === 'string' && value ? value : undefined;
}

function firstString(...values: unknown[]) {
  return values.find((value): value is string => typeof value === 'string' && value.length > 0);
}
