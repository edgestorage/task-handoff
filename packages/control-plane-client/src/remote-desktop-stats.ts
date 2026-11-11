export type RemoteDesktopWebRTCStats = {
  path?: 'p2p' | 'turn';
  protocol?: string;
  localCandidateType?: string;
  remoteCandidateType?: string;
  latencyMs?: number;
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

/** Projects the selected ICE candidate pair into UI diagnostics. RTT values are
 * client-owned runtime data and must never be added to the public protocol. */
export function parseRemoteDesktopWebRTCStats(stats: StatsReport): RemoteDesktopWebRTCStats | undefined {
  const selected = selectedCandidatePair(stats);
  if (!selected) return undefined;
  const local = candidate(stats, selected.localCandidateId);
  const remote = candidate(stats, selected.remoteCandidateId);
  const localType = candidateType(local?.candidateType);
  const remoteType = candidateType(remote?.candidateType);
  const protocol = firstString(selected.protocol, local?.protocol, remote?.protocol);
  const latencyMs = roundTripTimeMs(selected);
  return {
    ...(localType || remoteType
      ? { path: localType === 'relay' || remoteType === 'relay' ? 'turn' as const : 'p2p' as const }
      : {}),
    ...(protocol ? { protocol } : {}),
    ...(localType ? { localCandidateType: localType } : {}),
    ...(remoteType ? { remoteCandidateType: remoteType } : {}),
    ...(latencyMs !== undefined ? { latencyMs } : {}),
  };
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

function finiteNonNegative(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function candidateType(value: unknown) {
  return typeof value === 'string' && value ? value : undefined;
}

function firstString(...values: unknown[]) {
  return values.find((value): value is string => typeof value === 'string' && value.length > 0);
}
