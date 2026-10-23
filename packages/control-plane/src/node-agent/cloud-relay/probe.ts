import {
  NODE_RELAY_PROBE_BUDGET_MS,
  NODE_RELAY_PROBE_SAMPLE_COUNT,
  NODE_RELAY_PROBE_TARGET_LIMIT,
  type NodeRelayProbeMeasurement,
  type NodeRelayProbeTarget,
} from "@task-handoff/cloud-contracts";
import { relayEndpointProbeUrl } from "../../control-plane/cloud-connectivity/relay-link-probe.ts";
import { trustedNodeRelayUrl } from "./trust.ts";

export const NODE_RELAY_PROBE_TOTAL_BUDGET_MS = NODE_RELAY_PROBE_BUDGET_MS;
export const NODE_RELAY_PROBE_SAMPLES = NODE_RELAY_PROBE_SAMPLE_COUNT;

export interface NodeRelayProbeResult {
  measurements: NodeRelayProbeMeasurement[];
  rejectedRelayIds: string[];
  elapsedMs: number;
}

/**
 * Measures at most three allowlisted Relay peers in parallel. Each target gets
 * two sequential samples; the shared deadline also caps a peer that ignores its
 * abort signal. The `/probe` call carries no credentials and never follows a
 * redirect, matching the Control Plane's coarse link measurement.
 */
export async function probeNodeRelayTargets(input: {
  targets: readonly NodeRelayProbeTarget[];
  serviceOrigin: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  budgetMs?: number;
  samples?: number;
}): Promise<NodeRelayProbeResult> {
  const now = input.now ?? Date.now;
  const startedAt = now();
  const budgetMs = Math.max(1, input.budgetMs ?? NODE_RELAY_PROBE_TOTAL_BUDGET_MS);
  const samples = Math.min(NODE_RELAY_PROBE_SAMPLES, Math.max(1, Math.trunc(input.samples ?? NODE_RELAY_PROBE_SAMPLES)));
  const deadline = startedAt + budgetMs;
  const controller = new AbortController();
  const deadlineTimer = setTimeout(() => controller.abort(), budgetMs);
  deadlineTimer.unref?.();

  const rejectedRelayIds: string[] = [];
  const unique = new Map<string, NodeRelayProbeTarget>();
  for (const target of input.targets.slice(0, NODE_RELAY_PROBE_TARGET_LIMIT)) {
    if (!target.relayId || unique.has(target.relayUrl)) continue;
    if (!trustedNodeRelayUrl(target.relayUrl, input.serviceOrigin)) {
      rejectedRelayIds.push(target.relayId);
      continue;
    }
    unique.set(target.relayUrl, target);
  }

  try {
    const measurements = await Promise.all([...unique.values()].map((target) => probeTarget({
      target,
      fetchImpl: input.fetchImpl ?? fetch,
      now,
      deadline,
      budgetMs,
      samples,
      signal: controller.signal,
    })));
    return { measurements, rejectedRelayIds, elapsedMs: Math.max(0, now() - startedAt) };
  } finally {
    clearTimeout(deadlineTimer);
  }
}

async function probeTarget(input: {
  target: NodeRelayProbeTarget;
  fetchImpl: typeof fetch;
  now: () => number;
  deadline: number;
  budgetMs: number;
  samples: number;
  signal: AbortSignal;
}): Promise<NodeRelayProbeMeasurement> {
  const timings: number[] = [];
  let attempts = 0;
  let failures = 0;
  const sampleBudgetMs = Math.max(1, Math.ceil(input.budgetMs / input.samples));
  let probeUrl: URL;
  try {
    probeUrl = relayEndpointProbeUrl(input.target.relayUrl);
  } catch {
    return { relayId: input.target.relayId, sampleCount: 1, failureCount: 1 };
  }

  for (let index = 0; index < input.samples; index += 1) {
    const remaining = input.deadline - input.now();
    if (remaining <= 0 || input.signal.aborted) break;
    attempts += 1;
    const startedAt = input.now();
    const sampleController = new AbortController();
    const abortFromDeadline = () => sampleController.abort();
    input.signal.addEventListener("abort", abortFromDeadline, { once: true });
    const sampleTimer = setTimeout(() => sampleController.abort(), Math.min(sampleBudgetMs, remaining));
    sampleTimer.unref?.();
    try {
      await settleWithAbort((async () => {
        const response = await input.fetchImpl(probeUrl, {
          method: "GET",
          headers: { accept: "application/json" },
          cache: "no-store",
          credentials: "omit",
          redirect: "error",
          signal: sampleController.signal,
        });
        const body = await response.json().catch(() => undefined) as { relayId?: unknown } | undefined;
        if (!response.ok || body?.relayId !== input.target.relayId) throw new Error("probe identity mismatch");
      })(), sampleController.signal);
      timings.push(Math.max(0, input.now() - startedAt));
    } catch {
      failures += 1;
    } finally {
      clearTimeout(sampleTimer);
      input.signal.removeEventListener("abort", abortFromDeadline);
    }
  }

  return {
    relayId: input.target.relayId,
    ...(timings.length ? { rttMs: median(timings), measuredAt: new Date(input.now()).toISOString() } : {}),
    sampleCount: attempts,
    failureCount: failures,
  };
}

function settleWithAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError());
    signal.addEventListener("abort", onAbort, { once: true });
    operation.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

function abortError() {
  return Object.assign(new Error("Relay probe timed out."), { name: "AbortError" });
}

export function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}
