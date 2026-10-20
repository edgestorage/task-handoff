import { cloudEnvironmentForServiceOrigin } from "../../../../../shared/cloud-environments.cjs";

export interface RelayLinkMeasurement {
  relayId: string;
  rttMs: number;
  updatedAt: string;
}

/**
 * Link hints are advice, never authority: a coarse cadence and a generous
 * per-sample budget are enough, and a Control Plane that never reports simply
 * leaves every candidate unmeasured on the mobile side.
 */
export const RELAY_LINK_PROBE_INTERVAL_MS = 60_000;
export const RELAY_LINK_PROBE_SAMPLES = 2;
export const RELAY_LINK_PROBE_SAMPLE_TIMEOUT_MS = 2_000;
export const RELAY_LINK_PROBE_MAX_BACKOFF_MS = 15 * 60_000;
const RELAY_LINK_PROBE_MAX_ENTRIES = 64;

interface RelayLinkProbeLoopOptions {
  /** Environment the Control Plane is bound to. */
  serviceOrigin(): string;
  /** Relays are only useful to a bound Control Plane, so an unbound one stays quiet. */
  enabled?(): boolean;
  report?(links: readonly RelayLinkMeasurement[]): Promise<unknown> | unknown;
  fetch?: typeof fetch;
  clock?: () => number;
  intervalMs?: number;
  samples?: number;
  sampleTimeoutMs?: number;
  maxEntries?: number;
}

/** The probe reuses the Relay's unauthenticated, deliberately coarse `/probe` endpoint. */
export function relayProbeUrl(serviceOrigin: string, host: string): URL {
  const environment = cloudEnvironmentForServiceOrigin(serviceOrigin);
  const service = new URL(serviceOrigin);
  // An ad-hoc cloud serves the Relay from its own origin, so that origin's port
  // has to survive; probing the bare hostname would drop it.
  if (host === service.hostname) return new URL("/probe", service);
  return new URL("/probe", `${environment.allowInsecureRelay ? "http:" : "https:"}//${host}`);
}

/**
 * The same probe, derived from a Relay the Control Plane was actually allocated. An
 * environment only declares Relay *suffixes*, and the fleet is reached through hosts
 * under them; the bare suffix does not necessarily resolve. A host the Coordinator
 * just handed out does.
 */
export function relayEndpointProbeUrl(relayUrl: string): URL {
  const url = new URL(relayUrl);
  url.protocol = url.protocol === "wss:" ? "https:" : "http:";
  url.pathname = "/probe";
  url.search = "";
  url.hash = "";
  return url;
}

/**
 * Periodically measures the Control Plane's own RTT to every Relay of its
 * environment and reports the results over the control channel. The cache keeps
 * the last successful measurement per Relay; staleness is judged by the
 * Coordinator and the mobile client, never here, so an entry is only ever
 * replaced by a fresher one.
 */
export class RelayLinkProbeLoop {
  private readonly options: RelayLinkProbeLoopOptions;
  private readonly entries = new Map<string, RelayLinkMeasurement>();
  private readonly fetchImpl: typeof fetch;
  private readonly clock: () => number;
  private readonly intervalMs: number;
  private readonly samples: number;
  private readonly sampleTimeoutMs: number;
  private readonly maxEntries: number;
  private readonly observed = new Map<string, URL>();
  private timer?: ReturnType<typeof setTimeout>;
  private running = false;
  private failures = 0;
  private inFlight?: Promise<RelayLinkMeasurement[]>;

  constructor(options: RelayLinkProbeLoopOptions) {
    this.options = options;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.clock = options.clock ?? (() => Date.now());
    this.intervalMs = options.intervalMs ?? RELAY_LINK_PROBE_INTERVAL_MS;
    this.samples = Math.max(1, options.samples ?? RELAY_LINK_PROBE_SAMPLES);
    this.sampleTimeoutMs = options.sampleTimeoutMs ?? RELAY_LINK_PROBE_SAMPLE_TIMEOUT_MS;
    this.maxEntries = Math.max(1, options.maxEntries ?? RELAY_LINK_PROBE_MAX_ENTRIES);
  }

  start() { this.running = true; this.schedule(0); }
  stop() { this.running = false; if (this.timer) { clearTimeout(this.timer); this.timer = undefined; } }

  /** Last successful measurement per Relay, freshest first. */
  links(): RelayLinkMeasurement[] {
    return [...this.entries.values()].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  /** One probe cycle; concurrent callers share the same cycle instead of doubling the load. */
  probeOnce(): Promise<RelayLinkMeasurement[]> {
    if (!this.inFlight) this.inFlight = this.runCycle().finally(() => { this.inFlight = undefined; });
    return this.inFlight;
  }

  /** Runs a probe and reports whatever was measured; exposed so the runtime can force a refresh. */
  async refresh(): Promise<RelayLinkMeasurement[]> {
    const links = await this.probeOnce();
    await this.report(links);
    return links;
  }

  /**
   * Remembers a Relay the Coordinator allocated to this Control Plane. The fleet is
   * reached through hosts under configured suffixes, so a real endpoint is the only
   * reliable probe target.
   */
  observe(relayUrl: unknown) {
    if (typeof relayUrl !== "string" || !relayUrl) return;
    let url: URL;
    try { url = relayEndpointProbeUrl(relayUrl); } catch { return; }
    if (!["http:", "https:"].includes(url.protocol)) return;
    this.observed.delete(url.host);
    this.observed.set(url.host, url);
    while (this.observed.size > this.maxEntries) {
      const oldest = this.observed.keys().next().value;
      if (oldest === undefined) break;
      this.observed.delete(oldest);
    }
  }

  private targets(): URL[] {
    const targets = new Map<string, URL>();
    for (const url of this.observed.values()) targets.set(url.host, url);
    return [...targets.values()];
  }

  private async runCycle(): Promise<RelayLinkMeasurement[]> {
    const measured = await Promise.all(this.targets().map((url) => this.probe(url)));
    for (const entry of measured) {
      if (!entry) continue;
      // Re-insert so the Map preserves freshness order for eviction.
      this.entries.delete(entry.relayId);
      this.entries.set(entry.relayId, entry);
    }
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
    return measured.filter((entry): entry is RelayLinkMeasurement => Boolean(entry));
  }

  private async probe(url: URL): Promise<RelayLinkMeasurement | undefined> {
    const timings: number[] = [];
    let relayId: string | undefined;
    for (let index = 0; index < this.samples; index += 1) {
      const startedAt = this.clock();
      try {
        const response = await this.fetchImpl(url, { method: "GET", cache: "no-store", credentials: "omit", redirect: "error", signal: AbortSignal.timeout(this.sampleTimeoutMs) });
        const body = await response.json().catch(() => undefined) as { relayId?: unknown } | undefined;
        // Only a Relay that answers with its identity counts; anything else is unreachable advice.
        if (response.ok && typeof body?.relayId === "string" && body.relayId) { relayId = body.relayId; timings.push(this.clock() - startedAt); }
      } catch { /* unreachable or slow; the Relay simply keeps its previous measurement */ }
    }
    if (!relayId || !timings.length) return undefined;
    return { relayId, rttMs: median(timings), updatedAt: new Date(this.clock()).toISOString() };
  }

  private async report(links: readonly RelayLinkMeasurement[]) {
    if (!links.length || !this.options.report) return;
    try { await this.options.report(links); } catch { /* reporting is best-effort; the channel may be down */ }
  }

  private schedule(delay: number) {
    if (!this.running || this.timer) return;
    this.timer = setTimeout(() => { this.timer = undefined; void this.tick(); }, delay);
    this.timer.unref();
  }

  private async tick() {
    const enabled = this.options.enabled ? this.options.enabled() : true;
    let ok = false;
    if (enabled) {
      try { ok = (await this.refresh()).length > 0; } catch { ok = false; }
    } else {
      ok = true;
    }
    if (!this.running) return;
    this.failures = ok ? 0 : Math.min(this.failures + 1, 8);
    const delay = ok ? this.intervalMs : Math.min(this.intervalMs * 2 ** this.failures, RELAY_LINK_PROBE_MAX_BACKOFF_MS);
    this.schedule(delay);
  }
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}
