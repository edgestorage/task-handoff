const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { MARKET_CATALOG_PROTOCOL_VERSION } = require("../packages/protocol/src/control-plane.ts");
const { MarketCatalogService } = require("../packages/control-plane/src/control-plane/catalog/market.ts");
const {
  RemoteMarketCatalogProvider,
  defaultMarketRepositoryPrefixes,
  isAllowedMarketRepository,
  loadCachedMarketCatalogSnapshot,
  marketCatalogSignatureUrl,
} = require("../packages/control-plane/src/control-plane/catalog/remote-market.ts");
const { marketCatalogOptionsFromEnv } = require("../packages/control-plane/src/control-plane/http/server.ts");

const digest = (letter) => `sha256:${letter.repeat(64)}`;

function catalogPayload(options = {}) {
  return {
    protocolVersion: MARKET_CATALOG_PROTOCOL_VERSION,
    catalogId: "task_handoff_market",
    revision: options.revision || "rev-1",
    source: "remote",
    generatedAt: "2026-09-30T00:00:00.000Z",
    expiresAt: "2026-10-07T00:00:00.000Z",
    items: [{
      id: "market_taskhandoff_codex",
      publisher: "task-handoff",
      slug: "codex",
      name: "TaskHandoff Codex",
      description: "Minimal Codex runtime with terminal and Codex.",
      cover: { kind: "builtin", key: "default-image-cover" },
      repository: options.repository || "huadream/task-handoff-controlled-codex",
      defaultTag: "latest",
      tags: [{
        name: "latest",
        reference: options.reference || "huadream/task-handoff-controlled-codex:latest",
        manifestDigest: digest("a"),
        platforms: [{ os: "linux", architecture: "amd64", digest: digest("b"), downloadSizeBytes: 100 }],
        status: "active",
      }],
      capabilities: ["terminal", "codex"],
      optionalApps: ["terminal-tty"],
      defaultEnv: {},
      labels: { "task-handoff.image.kind": "controlled-instance", "task-handoff.image.profile": "codex" },
      status: "active",
    }],
  };
}

function jsonResponse(payload, options = {}) {
  const body = Buffer.from(typeof payload === "string" ? payload : JSON.stringify(payload ?? {}));
  return {
    ok: (options.status || 200) < 300,
    status: options.status || 200,
    headers: { get: (name) => (name.toLowerCase() === "etag" ? options.etag || null : null) },
    async arrayBuffer() { return body; },
  };
}

function tempCachePath() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "market-cache-")), "catalog-cache.json");
}

test("remote market catalog caches registry responses and reuses them on 304", async () => {
  const cachePath = tempCachePath();
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), headers: init.headers });
    if (calls.length === 1) return jsonResponse(catalogPayload(), { etag: '"rev-1"' });
    return jsonResponse(undefined, { status: 304 });
  };
  const provider = new RemoteMarketCatalogProvider({ url: "https://images.thandoff.com/market/v1/catalog.json", cachePath, fetchImpl });

  const first = await provider.loadCatalog();
  assert.equal(first.source, "remote");
  assert.equal(first.revision, "rev-1");

  const cached = JSON.parse(fs.readFileSync(cachePath, "utf8"));
  assert.equal(cached.version, 1);
  assert.equal(cached.etag, '"rev-1"');
  assert.equal(cached.catalog.revision, "rev-1");
  assert.equal(loadCachedMarketCatalogSnapshot(cachePath).source, "cache");

  const second = await provider.loadCatalog();
  assert.equal(second.source, "cache");
  assert.equal(second.revision, "rev-1");
  assert.equal(calls[1].headers["if-none-match"], '"rev-1"');
});

test("remote market catalog rejects repositories outside the allowlist", async () => {
  const provider = new RemoteMarketCatalogProvider({
    url: "https://images.thandoff.com/market/v1/catalog.json",
    fetchImpl: async () => jsonResponse(catalogPayload({ repository: "evil.example/backdoor", reference: "evil.example/backdoor:latest" })),
  });
  await assert.rejects(provider.loadCatalog(), /not allowed/);
});

test("remote market catalog requires the remote source and https", async () => {
  const embedded = { ...catalogPayload(), source: "embedded" };
  const provider = new RemoteMarketCatalogProvider({
    url: "https://images.thandoff.com/market/v1/catalog.json",
    fetchImpl: async () => jsonResponse(embedded),
  });
  await assert.rejects(provider.loadCatalog(), /source "remote"/);
  assert.throws(() => new RemoteMarketCatalogProvider({ url: "http://images.thandoff.com/market/v1/catalog.json" }), /https/);
});

test("remote market catalog rejects an empty catalog so a bad publish cannot empty the market", async () => {
  const provider = new RemoteMarketCatalogProvider({
    url: "https://images.thandoff.com/market/v1/catalog.json",
    fetchImpl: async () => jsonResponse({ ...catalogPayload(), items: [] }),
  });
  await assert.rejects(provider.loadCatalog(), /at least one image/);
});

test("remote market catalog reports the underlying network cause instead of a bare fetch failure", async () => {
  const cause = Object.assign(new Error("getaddrinfo ENOTFOUND images.thandoff.com"), { code: "ENOTFOUND" });
  const fetchFailure = new TypeError("fetch failed", { cause });
  const provider = new RemoteMarketCatalogProvider({
    url: "https://images.thandoff.com/market/v1/catalog.json",
    fetchImpl: async () => { throw fetchFailure; },
  });
  await assert.rejects(provider.loadCatalog(), (error) => {
    assert.equal(error.message, "fetch failed: ENOTFOUND getaddrinfo ENOTFOUND images.thandoff.com");
    assert.equal(error.cause, fetchFailure);
    return true;
  });

  const aggregateCause = new AggregateError([
    Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:443"), { code: "ECONNREFUSED" }),
    Object.assign(new Error("connect ECONNREFUSED ::1:443"), { code: "ECONNREFUSED" }),
  ], "all addresses failed");
  const aggregateProvider = new RemoteMarketCatalogProvider({
    url: "https://images.thandoff.com/market/v1/catalog.json",
    fetchImpl: async () => { throw new TypeError("fetch failed", { cause: aggregateCause }); },
  });
  await assert.rejects(aggregateProvider.loadCatalog(), /fetch failed: ECONNREFUSED connect ECONNREFUSED 127\.0\.0\.1:443/);
});

test("remote market catalog verifies ed25519 signatures before accepting a catalog", async () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
  const body = JSON.stringify(catalogPayload({ revision: "rev-signed" }));
  const envelope = {
    alg: "ed25519",
    keyId: "test-key",
    catalogSha256: crypto.createHash("sha256").update(body).digest("hex"),
    signature: crypto.sign(null, Buffer.from(body), privateKey).toString("base64"),
  };
  const publicKeyValue = publicKey.export({ format: "der", type: "spki" }).toString("base64");
  assert.equal(marketCatalogSignatureUrl("https://images.thandoff.com/market/v1/catalog.json"), "https://images.thandoff.com/market/v1/catalog.sig");

  const provider = new RemoteMarketCatalogProvider({
    url: "https://images.thandoff.com/market/v1/catalog.json",
    publicKey: publicKeyValue,
    keyId: "test-key",
    fetchImpl: async (url) => (String(url).endsWith("catalog.sig") ? jsonResponse(envelope) : jsonResponse(body, { status: 200 })),
  });
  const snapshot = await provider.loadCatalog();
  assert.equal(snapshot.revision, "rev-signed");

  const tampered = new RemoteMarketCatalogProvider({
    url: "https://images.thandoff.com/market/v1/catalog.json",
    publicKey: publicKeyValue,
    fetchImpl: async (url) => (String(url).endsWith("catalog.sig")
      ? jsonResponse({ ...envelope, signature: crypto.sign(null, Buffer.from(`${body} `), privateKey).toString("base64") })
      : jsonResponse(body)),
  });
  await assert.rejects(tampered.loadCatalog(), /verification failed/);
});

test("default market allowlist follows the embedded publisher namespace", () => {
  const prefixes = defaultMarketRepositoryPrefixes();
  assert.ok(prefixes.includes("huadream/"));
  assert.equal(isAllowedMarketRepository("docker.io/huadream/task-handoff-controlled-codex:latest", prefixes), true);
  assert.equal(isAllowedMarketRepository("huadream/task-handoff-controlled-obscura:latest", prefixes), true);
  assert.equal(isAllowedMarketRepository("docker.io/other/task-handoff-controlled-codex:latest", prefixes), false);
  assert.equal(isAllowedMarketRepository("not a reference", prefixes), false);
});

test("market catalog keeps the previous snapshot when a remote refresh fails", async () => {
  const service = new MarketCatalogService();
  const before = service.getCatalog();
  const failure = await service.refresh({ async loadCatalog() { throw new Error("offline"); } });
  assert.equal(failure.accepted, false);
  assert.equal(service.getStatus().state, "stale");
  assert.equal(service.getStatus().error, "offline");
  assert.equal(service.getCatalog().revision, before.revision);

  const success = await service.refresh({ async loadCatalog() { return catalogPayload({ revision: "rev-next" }); } });
  assert.equal(success.accepted, true);
  assert.equal(service.getCatalog().revision, "rev-next");
  assert.equal(service.getStatus().state, "ready");
});

test("market catalog environment configuration defaults, disables, and overrides", () => {
  const names = [
    "TASK_HANDOFF_MARKET_CATALOG_URL",
    "TASK_HANDOFF_MARKET_REFRESH_INTERVAL",
    "TASK_HANDOFF_MARKET_ALLOWED_REPOSITORIES",
    "TASK_HANDOFF_MARKET_CATALOG_KEY_ID",
  ];
  const before = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  try {
    for (const name of names) delete process.env[name];
    const defaults = marketCatalogOptionsFromEnv();
    assert.equal(defaults.url, "https://images.thandoff.com/market/v1/catalog.json");
    assert.equal(defaults.refreshIntervalMs, 6 * 60 * 60 * 1000);

    process.env.TASK_HANDOFF_MARKET_CATALOG_URL = "off";
    assert.equal(marketCatalogOptionsFromEnv(), undefined);

    process.env.TASK_HANDOFF_MARKET_CATALOG_URL = "https://mirror.example.com/catalog.json";
    process.env.TASK_HANDOFF_MARKET_REFRESH_INTERVAL = "0";
    process.env.TASK_HANDOFF_MARKET_ALLOWED_REPOSITORIES = "mirror.example.com/team/, huadream/";
    process.env.TASK_HANDOFF_MARKET_CATALOG_KEY_ID = "mirror-key";
    const overridden = marketCatalogOptionsFromEnv();
    assert.equal(overridden.url, "https://mirror.example.com/catalog.json");
    assert.equal(overridden.refreshIntervalMs, 0);
    assert.deepEqual(overridden.allowedRepositoryPrefixes, ["mirror.example.com/team/", "huadream/"]);
    assert.equal(overridden.keyId, "mirror-key");
  } finally {
    for (const name of names) {
      if (before[name] === undefined) delete process.env[name];
      else process.env[name] = before[name];
    }
  }
});
