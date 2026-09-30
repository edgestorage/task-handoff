import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import writeFileAtomic from "write-file-atomic";
import {
  MarketCatalogSnapshotSchema,
  sanitizeStoredMarketCatalogSnapshot,
  type MarketCatalogSnapshot,
} from "@task-handoff/protocol/control-plane";
import { embeddedMarketCatalogSnapshot, type MarketCatalogProvider } from "./market.ts";

export const DEFAULT_MARKET_CATALOG_URL = "https://images.thandoff.com/market/v1/catalog.json";
export const DEFAULT_MARKET_CATALOG_REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000;

const CACHE_VERSION = 1;
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_BYTES = 4 * 1024 * 1024;
const SIGNATURE_MAX_BYTES = 64 * 1024;

export type MarketCatalogCache = {
  version: 1;
  etag?: string;
  fetchedAt: string;
  catalog: MarketCatalogSnapshot;
};

export type RemoteMarketCatalogOptions = {
  url: string;
  publicKey?: string;
  keyId?: string;
  allowedRepositoryPrefixes?: string[];
  cachePath?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxBytes?: number;
  now?: () => Date;
  log?: (message: string, details?: Record<string, unknown>) => void;
};

function stripDefaultRegistry(repository: string) {
  return repository.startsWith("docker.io/") ? repository.slice("docker.io/".length) : repository;
}

export function normalizeMarketRepository(reference: string) {
  const value = String(reference ?? "").trim();
  if (!value || value.includes("://") || /\s/.test(value)) return undefined;
  const withoutDigest = value.split("@")[0];
  const lastSlash = withoutDigest.lastIndexOf("/");
  const lastColon = withoutDigest.lastIndexOf(":");
  const name = lastColon > lastSlash ? withoutDigest.slice(0, lastColon) : withoutDigest;
  return name ? stripDefaultRegistry(name) : undefined;
}

export function defaultMarketRepositoryPrefixes() {
  const prefixes = new Set<string>();
  for (const item of embeddedMarketCatalogSnapshot().items) {
    const repository = normalizeMarketRepository(item.repository);
    if (!repository) continue;
    const slash = repository.lastIndexOf("/");
    if (slash === -1) continue;
    prefixes.add(`${repository.slice(0, slash + 1)}`);
  }
  return [...prefixes].sort();
}

export function isAllowedMarketRepository(reference: string, prefixes: string[]) {
  const repository = normalizeMarketRepository(reference);
  if (!repository) return false;
  return prefixes.some((prefix) => repository.startsWith(prefix));
}

export function marketCatalogSignatureUrl(url: string) {
  return url.endsWith("/catalog.json") ? `${url.slice(0, -"catalog.json".length)}catalog.sig` : `${url}.sig`;
}

function describeErrorEntry(entry: unknown): string {
  if (entry instanceof AggregateError) {
    const messages = [...new Set(entry.errors.map((value) => describeErrorEntry(value)).filter(Boolean))];
    return messages.length ? messages.join("; ") : entry.message;
  }
  if (entry instanceof Error) {
    const code = (entry as NodeJS.ErrnoException).code;
    const own = [code, entry.message].filter((value): value is string => Boolean(value)).join(" ");
    const nested = describeErrorCause(entry);
    return nested ? `${own}: ${nested}` : own;
  }
  return String(entry);
}

function describeErrorCause(error: unknown): string | undefined {
  const cause = error instanceof Error ? (error as { cause?: unknown }).cause : undefined;
  if (cause instanceof AggregateError) {
    const messages = [...new Set(cause.errors.map((entry) => describeErrorEntry(entry)).filter(Boolean))];
    return messages.length ? messages.join("; ") : undefined;
  }
  if (cause instanceof Error) return describeErrorEntry(cause);
  if (typeof cause === "string" && cause.trim()) return cause;
  return undefined;
}

export function augmentMarketCatalogError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  const cause = describeErrorCause(error);
  if (!cause || message.includes(cause)) return error instanceof Error ? error : new Error(message);
  return new Error(`${message}: ${cause}`, { cause: error });
}

export function loadMarketCatalogPublicKey(value: string | undefined) {
  if (!value || !value.trim()) return undefined;
  const raw = value.trim();
  if (raw.includes("-----BEGIN")) return crypto.createPublicKey({ key: raw.replaceAll("\\n", "\n"), format: "pem" });
  return crypto.createPublicKey({ key: Buffer.from(raw, "base64"), format: "der", type: "spki" });
}

export function loadMarketCatalogCache(cachePath: string | undefined): MarketCatalogCache | undefined {
  if (!cachePath) return undefined;
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(cachePath, "utf8"));
  } catch {
    return undefined;
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const record = raw as Record<string, unknown>;
  if (record.version !== CACHE_VERSION) return undefined;
  const parsed = MarketCatalogSnapshotSchema.safeParse(sanitizeStoredMarketCatalogSnapshot(record.catalog));
  if (!parsed.success) return undefined;
  return {
    version: CACHE_VERSION,
    ...(typeof record.etag === "string" && record.etag ? { etag: record.etag } : {}),
    fetchedAt: typeof record.fetchedAt === "string" ? record.fetchedAt : new Date(0).toISOString(),
    catalog: parsed.data,
  };
}

export function loadCachedMarketCatalogSnapshot(cachePath: string | undefined) {
  const cache = loadMarketCatalogCache(cachePath);
  return cache ? { ...cache.catalog, source: "cache" as const } : undefined;
}

export function writeMarketCatalogCache(cachePath: string, cache: MarketCatalogCache) {
  fs.mkdirSync(path.dirname(cachePath), { recursive: true });
  writeFileAtomic.sync(cachePath, `${JSON.stringify(cache, null, 2)}\n`, { encoding: "utf8" });
}

async function readLimited(response: Response, maxBytes: number) {
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.byteLength > maxBytes) throw new Error(`market catalog response exceeds ${maxBytes} bytes`);
  return buffer.toString("utf8");
}

export class RemoteMarketCatalogProvider implements MarketCatalogProvider {
  private readonly options: RemoteMarketCatalogOptions;

  constructor(options: RemoteMarketCatalogOptions) {
    if (!options.url || !options.url.startsWith("https://")) throw new Error("market catalog URL must use https");
    this.options = options;
  }

  private log(message: string, details?: Record<string, unknown>) {
    this.options.log?.(message, details);
  }

  private parseSnapshot(body: string) {
    let payload: unknown;
    try {
      payload = JSON.parse(body);
    } catch (error) {
      throw new Error(`market catalog response is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
    const parsed = MarketCatalogSnapshotSchema.safeParse(payload);
    if (!parsed.success) throw new Error(`market catalog response is invalid: ${parsed.error.message}`);
    if (parsed.data.source !== "remote") throw new Error(`market catalog response must declare source "remote"`);
    if (!parsed.data.items.length) throw new Error("market catalog response must contain at least one image");

    const prefixes = this.options.allowedRepositoryPrefixes ?? defaultMarketRepositoryPrefixes();
    for (const item of parsed.data.items) {
      if (!isAllowedMarketRepository(item.repository, prefixes)) {
        throw new Error(`market catalog repository is not allowed: ${item.repository}`);
      }
      for (const tag of item.tags) {
        if (!isAllowedMarketRepository(tag.reference, prefixes)) {
          throw new Error(`market catalog tag reference is not allowed: ${tag.reference}`);
        }
      }
    }
    return { ...parsed.data, source: "remote" as const };
  }

  private async verifySignature(body: string, fetchImpl: typeof fetch) {
    const publicKey = loadMarketCatalogPublicKey(this.options.publicKey);
    if (!publicKey) return;
    const url = marketCatalogSignatureUrl(this.options.url);
    const response = await fetchImpl(url, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`market catalog signature request failed: HTTP ${response.status}`);
    const payload = JSON.parse(await readLimited(response, SIGNATURE_MAX_BYTES)) as Record<string, unknown>;
    if (payload.alg !== "ed25519") throw new Error("market catalog signature must use ed25519");
    if (this.options.keyId && payload.keyId !== this.options.keyId) {
      throw new Error(`market catalog signature key mismatch: ${String(payload.keyId)}`);
    }
    if (typeof payload.signature !== "string") throw new Error("market catalog signature payload is invalid");
    const digest = crypto.createHash("sha256").update(body).digest("hex");
    if (typeof payload.catalogSha256 === "string" && payload.catalogSha256 !== digest) {
      throw new Error("market catalog signature digest does not match the catalog");
    }
    const verified = crypto.verify(null, Buffer.from(body), publicKey, Buffer.from(payload.signature, "base64"));
    if (!verified) throw new Error("market catalog signature verification failed");
  }

  async loadCatalog(): Promise<MarketCatalogSnapshot> {
    try {
      return await this.loadRemoteCatalog();
    } catch (error) {
      throw augmentMarketCatalogError(error);
    }
  }

  private async loadRemoteCatalog(): Promise<MarketCatalogSnapshot> {
    const fetchImpl = this.options.fetchImpl ?? fetch;
    const cache = loadMarketCatalogCache(this.options.cachePath);
    const headers: Record<string, string> = { accept: "application/json" };
    if (cache?.etag) headers["if-none-match"] = cache.etag;

    const response = await fetchImpl(this.options.url, {
      headers,
      signal: AbortSignal.timeout(this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
    if (response.status === 304) {
      if (!cache) throw new Error("market catalog returned 304 without a local cache");
      this.log("market catalog is unchanged", { revision: cache.catalog.revision });
      return { ...cache.catalog, source: "cache" };
    }
    if (!response.ok) throw new Error(`market catalog request failed: HTTP ${response.status}`);

    const body = await readLimited(response, this.options.maxBytes ?? DEFAULT_MAX_BYTES);
    const snapshot = this.parseSnapshot(body);
    await this.verifySignature(body, fetchImpl);
    if (this.options.cachePath) {
      writeMarketCatalogCache(this.options.cachePath, {
        version: CACHE_VERSION,
        ...(response.headers.get("etag") ? { etag: response.headers.get("etag")! } : {}),
        fetchedAt: (this.options.now?.() ?? new Date()).toISOString(),
        catalog: snapshot,
      });
    }
    this.log("market catalog refreshed", { revision: snapshot.revision, images: snapshot.items.length });
    return snapshot;
  }
}
