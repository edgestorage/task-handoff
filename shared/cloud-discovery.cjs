"use strict";

const fs = require("node:fs");
const path = require("node:path");

const CLOUD_DISCOVERY_VERSION = "v1";
const MAX_CLOUD_DISCOVERY_ENDPOINTS = 5;
const DEFAULT_QUERY_TIMEOUT_MS = 1_200;
const DEFAULT_HEALTH_TIMEOUT_MS = 1_200;
const DEFAULT_HEALTH_CHECK_PATH = "/api/v1/auth/providers";
const DEFAULT_CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60_000;
const DEFAULT_COOLDOWN_MS = 60_000;

const TXT_PROVIDERS = Object.freeze([
  Object.freeze({
    name: "alidns",
    url: (record) => `https://dns.alidns.com/resolve?name=${encodeURIComponent(record)}&type=TXT`,
  }),
  Object.freeze({
    name: "cloudflare",
    url: (record) => `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(record)}&type=TXT`,
  }),
]);

class CloudDiscoveryError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "CloudDiscoveryError";
    this.code = code;
  }
}

function decodeDnsTxtValue(value) {
  const input = String(value).trim();
  if (!input.includes('"')) return input;
  const chunks = [];
  const quoted = /"((?:[^"\\]|\\.)*)"/g;
  let match;
  while ((match = quoted.exec(input))) chunks.push(unescapeDnsTxt(match[1]));
  return chunks.length ? chunks.join("") : input.replace(/^"|"$/g, "");
}

function hostMatchesSuffix(hostname, suffix) {
  const normalized = String(suffix).toLowerCase().replace(/^\./, "").replace(/\.$/, "");
  const host = String(hostname).toLowerCase().replace(/\.$/, "");
  return Boolean(normalized) && (host === normalized || host.endsWith(`.${normalized}`));
}

function parseCloudDiscoveryRecord(raw, config) {
  const text = decodeDnsTxtValue(raw).trim();
  const tokens = text.split(/\s+/).filter(Boolean);
  if (tokens.length < 2) throw new CloudDiscoveryError("CLOUD_DISCOVERY_RECORD_EMPTY", "The cloud discovery record is empty.");

  const [version, ...hosts] = tokens;
  if (version !== CLOUD_DISCOVERY_VERSION) {
    throw new CloudDiscoveryError("CLOUD_DISCOVERY_VERSION_UNSUPPORTED", `Unsupported cloud discovery version: ${version}`);
  }
  if (hosts.length > MAX_CLOUD_DISCOVERY_ENDPOINTS) {
    throw new CloudDiscoveryError("CLOUD_DISCOVERY_TOO_MANY_ENDPOINTS", "The cloud discovery record contains too many endpoints.");
  }

  const origins = [...new Set(hosts.map((host) => originForHost(host, config)))];
  if (!origins.length) throw new CloudDiscoveryError("CLOUD_DISCOVERY_RECORD_EMPTY", "The cloud discovery record contains no endpoints.");
  return Object.freeze({ version: CLOUD_DISCOVERY_VERSION, origins: Object.freeze(origins) });
}

async function queryCloudDiscoveryTxt(record, options = {}) {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") throw new Error("Cloud discovery requires a fetch implementation.");
  const failures = [];
  for (const provider of TXT_PROVIDERS) {
    try {
      const response = await fetchWithTimeout(provider.url(record), {
        fetchImpl,
        timeoutMs: options.timeoutMs ?? DEFAULT_QUERY_TIMEOUT_MS,
        init: {
          headers: { accept: "application/dns-json" },
          credentials: "omit",
          redirect: "error",
        },
      });
      if (!response.ok) {
        failures.push(`${provider.name}:http-${response.status}`);
        continue;
      }
      const value = extractTxtAnswer(await response.json());
      if (value) return value;
      failures.push(`${provider.name}:no-txt`);
    } catch (error) {
      failures.push(`${provider.name}:${error?.name ?? "error"}`);
    }
  }
  throw Object.assign(new Error("Cloud discovery TXT lookup failed."), {
    code: "CLOUD_DISCOVERY_LOOKUP_FAILED",
    failures,
  });
}

class CloudEndpointResolver {
  constructor(options) {
    this.config = options.config;
    this.fallbackOrigin = new URL(options.config?.fallbackOrigin ?? options.fallbackOrigin).origin;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    if (typeof this.fetchImpl !== "function") throw new Error("Cloud discovery requires a fetch implementation.");
    this.cachePath = options.cachePath;
    this.now = options.now ?? Date.now;
    this.queryTimeoutMs = options.queryTimeoutMs ?? DEFAULT_QUERY_TIMEOUT_MS;
    this.healthTimeoutMs = options.healthTimeoutMs ?? DEFAULT_HEALTH_TIMEOUT_MS;
    this.healthCheckPath = options.healthCheckPath ?? DEFAULT_HEALTH_CHECK_PATH;
    this.cacheMaxAgeMs = options.cacheMaxAgeMs ?? DEFAULT_CACHE_MAX_AGE_MS;
    this.cooldownMs = options.cooldownMs ?? DEFAULT_COOLDOWN_MS;
    this.candidates = [this.fallbackOrigin];
    this.active = this.fallbackOrigin;
    this.lastGood = undefined;
    this.recordText = undefined;
    this.fetchedAt = 0;
    this.source = "fallback";
    this.initialized = undefined;
    this.refreshing = undefined;
    this.cooldowns = new Map();
  }

  get enabled() {
    return Boolean(this.config);
  }

  get activeOrigin() {
    return this.active;
  }

  get endpoints() {
    return [...this.candidates];
  }

  get currentSource() {
    return this.source;
  }

  initialize() {
    this.initialized ??= this.initializeInternal();
    return this.initialized;
  }

  async refresh() {
    if (!this.config) return;
    if (!this.initialized) return this.initialize();
    await this.refreshAndSelect();
  }

  isTrustedOrigin(origin) {
    if (typeof origin !== "string" || !origin) return false;
    let parsed;
    try {
      parsed = new URL(origin);
    } catch {
      return false;
    }
    if (parsed.origin === this.fallbackOrigin || this.candidates.includes(parsed.origin)) return true;
    if (parsed.protocol !== "https:") return false;
    return Boolean(this.config?.allowedHostSuffixes.some((suffix) => hostMatchesSuffix(parsed.hostname, suffix)));
  }

  markSuccess(origin) {
    let normalized;
    try {
      normalized = new URL(origin).origin;
    } catch {
      return;
    }
    this.cooldowns.delete(normalized);
    const changed = this.active !== normalized || this.lastGood !== normalized;
    this.active = normalized;
    this.lastGood = normalized;
    if (changed) this.persistCache();
  }

  markFailure(origin) {
    let normalized;
    try {
      normalized = new URL(origin).origin;
    } catch {
      return;
    }
    this.cooldowns.set(normalized, this.now() + this.cooldownMs);
    if (this.active !== normalized) return;
    const next = this.candidates.find((candidate) => candidate !== normalized && (this.cooldowns.get(candidate) ?? 0) <= this.now());
    if (next) this.active = next;
  }

  async request(input, init) {
    await this.initialize();
    const target = new URL(String(input), this.active);
    const requestPath = `${target.pathname}${target.search}`;
    const method = String(init?.method ?? "GET").toUpperCase();
    const retryable = method === "GET" || method === "HEAD";
    const candidates = this.orderedCandidates();
    let lastResponse;
    let lastError;
    for (let index = 0; index < candidates.length; index += 1) {
      const origin = candidates[index];
      try {
        const response = await this.fetchImpl(`${origin}${requestPath}`, init);
        if (response.status >= 500) {
          this.markFailure(origin);
          lastResponse = response;
          if (retryable && index < candidates.length - 1) continue;
          return response;
        }
        this.markSuccess(origin);
        return response;
      } catch (error) {
        this.markFailure(origin);
        lastError = error;
        if (retryable && index < candidates.length - 1) continue;
        throw error;
      }
    }
    if (lastResponse) return lastResponse;
    throw lastError ?? Object.assign(new Error("No cloud endpoint is available."), { code: "CLOUD_DISCOVERY_UNAVAILABLE" });
  }

  async initializeInternal() {
    this.loadCache();
    if (!this.config) return;
    await this.refreshAndSelect();
  }

  async refreshAndSelect() {
    if (this.refreshing) return this.refreshing;
    this.refreshing = (async () => {
      await this.refreshRecord();
      await this.selectHealthy();
    })().finally(() => { this.refreshing = undefined; });
    return this.refreshing;
  }

  async refreshRecord() {
    if (!this.config) return;
    try {
      const recordText = await queryCloudDiscoveryTxt(this.config.record, {
        fetchImpl: this.fetchImpl,
        timeoutMs: this.queryTimeoutMs,
      });
      const parsed = parseCloudDiscoveryRecord(recordText, this.config);
      this.recordText = recordText;
      this.fetchedAt = this.now();
      this.candidates = [...parsed.origins];
      this.lastGood = this.lastGood && this.candidates.includes(this.lastGood) ? this.lastGood : undefined;
      this.active = this.candidates.includes(this.active) ? this.active : this.lastGood ?? this.candidates[0] ?? this.fallbackOrigin;
      this.source = "txt";
      this.persistCache();
    } catch {
      // A failed lookup keeps the cached or fallback endpoint.
    }
  }

  async selectHealthy() {
    if (this.candidates.length < 2) {
      this.active = this.candidates[0] ?? this.fallbackOrigin;
      return;
    }
    const results = await Promise.all(this.candidates.map(async (origin) => ({ origin, healthy: await this.healthCheck(origin) })));
    const healthy = results.find((result) => result.healthy);
    this.active = healthy?.origin
      ?? (this.lastGood && this.candidates.includes(this.lastGood) ? this.lastGood : this.candidates[0] ?? this.fallbackOrigin);
  }

  async healthCheck(origin) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.healthTimeoutMs);
    timeout.unref?.();
    try {
      const response = await this.fetchImpl(`${origin}${this.healthCheckPath}`, {
        method: "GET",
        headers: { accept: "application/json" },
        credentials: "omit",
        redirect: "error",
        signal: controller.signal,
      });
      return response.status < 500;
    } catch {
      return false;
    } finally {
      clearTimeout(timeout);
    }
  }

  orderedCandidates() {
    const now = this.now();
    const available = this.candidates.filter((origin) => (this.cooldowns.get(origin) ?? 0) <= now);
    const pool = available.length ? available : this.candidates;
    const first = pool.includes(this.active) ? this.active : pool[0];
    return first ? [first, ...pool.filter((origin) => origin !== first)] : [this.fallbackOrigin];
  }

  loadCache() {
    if (!this.config || !this.cachePath) return;
    try {
      const cache = JSON.parse(fs.readFileSync(this.cachePath, "utf8"));
      if (cache.record !== this.config.record) return;
      if (typeof cache.recordText !== "string" || !cache.recordText) return;
      if (typeof cache.fetchedAt !== "number" || !Number.isFinite(cache.fetchedAt)) return;
      if (this.now() - cache.fetchedAt > this.cacheMaxAgeMs) return;
      const parsed = parseCloudDiscoveryRecord(cache.recordText, this.config);
      this.candidates = [...parsed.origins];
      this.recordText = cache.recordText;
      this.fetchedAt = cache.fetchedAt;
      this.source = "cache";
      this.lastGood = typeof cache.lastGoodOrigin === "string" && this.candidates.includes(cache.lastGoodOrigin)
        ? cache.lastGoodOrigin
        : undefined;
      this.active = this.lastGood ?? this.candidates[0] ?? this.fallbackOrigin;
    } catch {
      // Invalid or stale cache never replaces the configured fallback.
    }
  }

  persistCache() {
    if (!this.config || !this.cachePath || !this.recordText || !this.fetchedAt) return;
    try {
      fs.mkdirSync(path.dirname(this.cachePath), { recursive: true, mode: 0o700 });
      fs.writeFileSync(this.cachePath, `${JSON.stringify({
        record: this.config.record,
        recordText: this.recordText,
        origins: [...this.candidates],
        fetchedAt: this.fetchedAt,
        ...(this.lastGood ? { lastGoodOrigin: this.lastGood } : {}),
      }, null, 2)}\n`, { mode: 0o600 });
    } catch {
      // Discovery still works in memory when cache storage is unavailable.
    }
  }
}

function originForHost(host, config) {
  if (!/^[a-z0-9.-]+$/i.test(host) || !host.includes(".")) {
    throw new CloudDiscoveryError("CLOUD_DISCOVERY_HOST_INVALID", `Invalid cloud discovery host: ${host}`);
  }
  let url;
  try {
    url = new URL(`https://${host}`);
  } catch {
    throw new CloudDiscoveryError("CLOUD_DISCOVERY_HOST_INVALID", `Invalid cloud discovery host: ${host}`);
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port || url.pathname !== "/" || url.search || url.hash) {
    throw new CloudDiscoveryError("CLOUD_DISCOVERY_HOST_INVALID", `Invalid cloud discovery host: ${host}`);
  }
  const hostname = url.hostname.replace(/\.$/, "");
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname)) {
    throw new CloudDiscoveryError("CLOUD_DISCOVERY_HOST_INVALID", `IP addresses are not allowed in cloud discovery: ${host}`);
  }
  if (!config.allowedHostSuffixes.some((suffix) => hostMatchesSuffix(hostname, suffix))) {
    throw new CloudDiscoveryError("CLOUD_DISCOVERY_HOST_UNTRUSTED", `Untrusted cloud discovery host: ${host}`);
  }
  return `https://${hostname}`;
}

function extractTxtAnswer(body) {
  if (!body || typeof body !== "object") return undefined;
  const answer = body.Answer;
  if (!Array.isArray(answer)) return undefined;
  for (const entry of answer) {
    if (!entry || typeof entry !== "object") continue;
    if (Number(entry.type) !== 16 || typeof entry.data !== "string") continue;
    const value = decodeDnsTxtValue(entry.data).trim();
    if (value.startsWith(`${CLOUD_DISCOVERY_VERSION} `)) return value;
  }
  return undefined;
}

async function fetchWithTimeout(input, options) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs);
  timeout.unref?.();
  try {
    return await options.fetchImpl(input, { ...options.init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

function unescapeDnsTxt(value) {
  return value
    .replace(/\\(\d{3})/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/\\(.)/g, "$1");
}

module.exports = {
  CLOUD_DISCOVERY_VERSION,
  MAX_CLOUD_DISCOVERY_ENDPOINTS,
  CloudDiscoveryError,
  CloudEndpointResolver,
  decodeDnsTxtValue,
  hostMatchesSuffix,
  parseCloudDiscoveryRecord,
  queryCloudDiscoveryTxt,
};
