import type { RelayProbeResult } from './relay-scorer';

/** Two samples per candidate in the normal path: enough to see past one jittery RTT. */
export const RELAY_PROBE_SAMPLES = 2;
export const RELAY_PROBE_SAMPLE_TIMEOUT_MS = 700;
/** The whole probe phase is bounded, so a silent Relay cannot stall the connection. */
export const RELAY_PROBE_BUDGET_MS = 1_200;
/** The cached-winner fast path only has to prove the known good Relay still answers. */
export const RELAY_PROBE_FAST_SAMPLES = 1;
export const RELAY_PROBE_FAST_BUDGET_MS = 400;

export interface RelayProbeTarget {
  allocationId: string;
  relayUrl: string;
}

export interface RelayProbeOptions {
  fetchImpl?: typeof fetch;
  now?: () => number;
  samples?: number;
  budgetMs?: number;
  sampleTimeoutMs?: number;
  /** Mirrors the channel factory's trust check; an untrusted URL is never probed. */
  allowRelayUrl?: (url: URL) => boolean;
}

/**
 * `/connect` is the only path a client ever attaches to, so the probe rewrites it
 * to the Relay's unauthenticated `/probe` endpoint on the same origin.
 */
export function relayProbeUrl(relayUrl: string): URL {
  const url = new URL(relayUrl);
  url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:';
  url.pathname = '/probe';
  url.search = '';
  url.hash = '';
  return url;
}

/**
 * Measures every candidate in parallel. A candidate that fails, times out or is
 * untrusted comes back with a failure count and no `mobileRttMs`, which is how
 * the scorer learns to exclude it without a separate error channel.
 */
export async function probeRelayCandidates(targets: readonly RelayProbeTarget[], options: RelayProbeOptions = {}): Promise<RelayProbeResult[]> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? (() => Date.now());
  const samples = Math.max(1, options.samples ?? RELAY_PROBE_SAMPLES);
  const sampleTimeoutMs = options.sampleTimeoutMs ?? RELAY_PROBE_SAMPLE_TIMEOUT_MS;
  const deadline = now() + (options.budgetMs ?? RELAY_PROBE_BUDGET_MS);
  const allow = options.allowRelayUrl;
  return Promise.all(targets.map((target) => probeCandidate(target, { fetchImpl, now, samples, sampleTimeoutMs, deadline, allow })));
}

async function probeCandidate(target: RelayProbeTarget, context: { fetchImpl: typeof fetch; now: () => number; samples: number; sampleTimeoutMs: number; deadline: number; allow?: (url: URL) => boolean }): Promise<RelayProbeResult> {
  const base = { allocationId: target.allocationId, sampleCount: 0, failureCount: 0 };
  let url: URL;
  try {
    url = relayProbeUrl(target.relayUrl);
    // An untrusted candidate can never be attached to, so it must not be contacted either.
    if (context.allow && !context.allow(url)) return { ...base, failureCount: 1 };
  } catch {
    return { ...base, failureCount: 1 };
  }
  const timings: number[] = [];
  let failures = 0;
  for (let index = 0; index < context.samples; index += 1) {
    const remaining = context.deadline - context.now();
    if (remaining <= 0) break;
    const startedAt = context.now();
    try {
      const response = await withTimeout(context.fetchImpl(url, { method: 'GET', cache: 'no-store', credentials: 'omit', redirect: 'error' }), Math.min(context.sampleTimeoutMs, remaining));
      await response.arrayBuffer().catch(() => undefined);
      if (response.ok) timings.push(context.now() - startedAt);
      else failures += 1;
    } catch {
      failures += 1;
    }
  }
  const sampleCount = timings.length + failures;
  if (!timings.length) return { ...base, sampleCount, failureCount: failures };
  return { allocationId: target.allocationId, sampleCount, failureCount: failures, mobileRttMs: median(timings) };
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/**
 * Races the request against a timer. React Native's fetch does not reliably
 * honour `AbortSignal.timeout`, so the timer is what actually bounds a probe; an
 * abandoned request costs one socket, never the connection attempt.
 */
function withTimeout(promise: Promise<Response>, timeoutMs: number): Promise<Response> {
  return new Promise<Response>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('RELAY_PROBE_TIMEOUT')), Math.max(1, timeoutMs));
    promise.then((value) => { clearTimeout(timer); resolve(value); }, (error) => { clearTimeout(timer); reject(error); });
  });
}
