import { RELAY_CP_HINT_FRESHNESS_MS } from '@task-handoff/cloud-contracts/mobile';

/** The parts of a Coordinator candidate that influence local scoring. */
export interface RelayScoringCandidate {
  allocationId: string;
  relayId: string;
  relayUrl: string;
  relayRegion: string;
  /** Coordinator ranking input. Lower is better, and it is not comparable across fleets. */
  serverScore: number;
  cpHint?: { relayId: string; rttMs: number; updatedAt: string };
}

export interface RelayProbeResult {
  allocationId: string;
  /** Median of the successful samples; absent when every sample failed. */
  mobileRttMs?: number;
  sampleCount: number;
  failureCount: number;
}

export type RelaySelectionFallback = 'none' | 'server-order' | 'partial-probe' | 'preferred-miss';

/**
 * Weights sum to one, so a missing signal can simply be dropped and the rest
 * re-normalised instead of being silently treated as "best" or "worst".
 */
export const RELAY_SCORING_WEIGHTS = Object.freeze({ mobileRtt: 0.45, controlPlaneRtt: 0.3, serverLoad: 0.15, regionAffinity: 0.1 });

const NEUTRAL = 0.5;

export interface RelaySelection {
  /** Allocation ids, best first. */
  ranked: string[];
  winner: string;
  fallback: RelaySelectionFallback;
  scores: Record<string, number>;
}

/**
 * Picks the Relay to confirm. The client's own measurement dominates, the
 * control plane's cached measurement refines it, and the Coordinator's ranking
 * and region affinity break ties. When nothing could be measured locally the
 * Coordinator's order is used verbatim rather than a guess.
 */
export function selectRelayCandidate(input: {
  candidates: readonly RelayScoringCandidate[];
  probes: readonly RelayProbeResult[];
  /** Candidates as the Coordinator ranked them, used for ties and for the no-probe fallback. */
  serverOrder?: readonly string[];
  now?: number;
  preferredRegion?: string;
  preferredRelayId?: string;
  preferredHonored?: boolean;
}): RelaySelection {
  const candidates = input.candidates;
  if (!candidates.length) throw new Error('A relay selection needs at least one candidate.');
  const serverOrder = (input.serverOrder?.length ? input.serverOrder : candidates.map((candidate) => candidate.allocationId)).filter((allocationId) => candidates.some((candidate) => candidate.allocationId === allocationId));
  const serverRank = new Map(serverOrder.map((allocationId, index) => [allocationId, index]));
  const probes = new Map(input.probes.map((probe) => [probe.allocationId, probe]));
  const now = input.now ?? Date.now();

  const measured = candidates.filter((candidate) => probes.get(candidate.allocationId)?.mobileRttMs !== undefined);
  if (!measured.length) {
    return { ranked: serverOrder, winner: serverOrder[0], fallback: 'server-order', scores: {} };
  }

  const freshHint = (candidate: RelayScoringCandidate) => candidate.cpHint !== undefined && Number.isFinite(Date.parse(candidate.cpHint.updatedAt)) && now - Date.parse(candidate.cpHint.updatedAt) <= RELAY_CP_HINT_FRESHNESS_MS;
  const hasHints = measured.some(freshHint);

  // A partially failing link is not just "a bit slower": fold the failure rate
  // into the measured latency so an unreliable Relay loses to a steady one.
  const effectiveRtt = measured.map((candidate) => {
    const probe = probes.get(candidate.allocationId)!;
    const samples = Math.max(1, probe.sampleCount);
    return probe.mobileRttMs! * (1 + probe.failureCount / samples);
  });
  const mobile = normalize(effectiveRtt);
  const controlPlane = hasHints ? measured.map((candidate) => (freshHint(candidate) ? candidate.cpHint!.rttMs : NEUTRAL)) : undefined;
  const controlPlaneNormalized = controlPlane ? normalizeKeepingNeutral(controlPlane) : undefined;
  const server = normalize(measured.map((candidate) => candidate.serverScore));
  const region = measured.map((candidate) => (input.preferredRegion && candidate.relayRegion !== input.preferredRegion ? 1 : 0));

  const weights = { mobileRtt: RELAY_SCORING_WEIGHTS.mobileRtt, controlPlaneRtt: controlPlaneNormalized ? RELAY_SCORING_WEIGHTS.controlPlaneRtt : 0, serverLoad: RELAY_SCORING_WEIGHTS.serverLoad, regionAffinity: RELAY_SCORING_WEIGHTS.regionAffinity };
  const total = weights.mobileRtt + weights.controlPlaneRtt + weights.serverLoad + weights.regionAffinity;

  const scores: Record<string, number> = {};
  const ordered = measured.map((candidate, index) => {
    const score = (weights.mobileRtt * mobile[index] + weights.controlPlaneRtt * (controlPlaneNormalized?.[index] ?? NEUTRAL) + weights.serverLoad * server[index] + weights.regionAffinity * region[index]) / total;
    scores[candidate.allocationId] = score;
    return { allocationId: candidate.allocationId, score };
  }).sort((left, right) => left.score - right.score || (serverRank.get(left.allocationId)! - serverRank.get(right.allocationId)!));

  // Unmeasured candidates keep their Coordinator order after the measured ones:
  // they are a last resort, never a preference.
  // `scores[allocationId]` can legitimately be 0 for the best candidate, so
  // presence is tested explicitly rather than by truthiness.
  const unmeasured = serverOrder.filter((allocationId) => scores[allocationId] === undefined);
  const ranked = [...ordered.map((entry) => entry.allocationId), ...unmeasured];
  const partial = measured.length < candidates.length;
  const preferredMiss = !partial && input.preferredRelayId !== undefined && input.preferredHonored !== true;
  return { ranked, winner: ranked[0], fallback: partial ? 'partial-probe' : preferredMiss ? 'preferred-miss' : 'none', scores };
}

/** Min-max normalisation; a signal with no spread carries no information, so it stays neutral. */
function normalize(values: readonly number[]): number[] {
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (!Number.isFinite(min) || max - min <= Number.EPSILON) return values.map(() => NEUTRAL);
  return values.map((value) => (value - min) / (max - min));
}

/**
 * Like `normalize`, but the neutral sentinel that marks "no hint" must survive
 * as a middling score. It is normalised against the real measurements only, so
 * an unknown link is neither promoted to best nor demoted to worst.
 */
function normalizeKeepingNeutral(values: readonly number[]): number[] {
  const real = values.filter((value) => value !== NEUTRAL);
  if (!real.length) return values.map(() => NEUTRAL);
  const min = Math.min(...real);
  const max = Math.max(...real);
  if (max - min <= Number.EPSILON) return values.map(() => NEUTRAL);
  return values.map((value) => (value === NEUTRAL ? NEUTRAL : (value - min) / (max - min)));
}
