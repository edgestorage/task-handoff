const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  CloudDiscoveryError,
  CloudEndpointResolver,
  parseCloudDiscoveryRecord,
} = require("../shared/cloud-discovery.cjs");

const CONFIG = Object.freeze({
  record: "_cloud.example.test",
  fallbackOrigin: "https://primary.discovery.test",
  allowedHostSuffixes: Object.freeze(["discovery.test"]),
});

function txtResponse(record) {
  return new Response(JSON.stringify({ Answer: [{ type: 16, data: record }] }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

test("cloud discovery records accept HTTPS hosts under the configured suffixes", () => {
  assert.deepEqual(parseCloudDiscoveryRecord("v1 primary.discovery.test backup.discovery.test", CONFIG), {
    version: "v1",
    origins: ["https://primary.discovery.test", "https://backup.discovery.test"],
  });
  assert.throws(() => parseCloudDiscoveryRecord("v1 primary.evil.test", CONFIG), CloudDiscoveryError);
  assert.throws(() => parseCloudDiscoveryRecord("v1 192.0.2.10", { allowedHostSuffixes: ["0.2.10"] }), /IP addresses/);
  assert.throws(() => parseCloudDiscoveryRecord("v2 primary.discovery.test", CONFIG), /Unsupported/);
});

test("cloud discovery selects the first healthy TXT endpoint and keeps the full candidate list", async () => {
  const calls = [];
  const resolver = new CloudEndpointResolver({
    config: CONFIG,
    fallbackOrigin: CONFIG.fallbackOrigin,
    fetchImpl: async (input) => {
      const url = new URL(String(input));
      calls.push(url.href);
      if (url.hostname === "dns.alidns.com") return txtResponse("v1 primary.discovery.test backup.discovery.test");
      if (url.pathname === "/api/v1/auth/providers") return new Response("", { status: url.hostname.startsWith("primary.") ? 503 : 200 });
      return new Response("", { status: 200 });
    },
  });

  await resolver.initialize();
  assert.equal(resolver.activeOrigin, "https://backup.discovery.test");
  assert.deepEqual(resolver.endpoints, ["https://primary.discovery.test", "https://backup.discovery.test"]);
  assert.equal(resolver.currentSource, "txt");
  assert.ok(calls.includes("https://primary.discovery.test/api/v1/auth/providers"));
  assert.ok(calls.includes("https://backup.discovery.test/api/v1/auth/providers"));
});

test("cloud discovery falls back safely and reuses a validated cache", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-cloud-discovery-"));
  const cachePath = path.join(directory, "cloud-discovery.json");
  const now = Date.parse("2026-10-20T00:00:00Z");
  try {
    const initial = new CloudEndpointResolver({
      config: CONFIG,
      fallbackOrigin: CONFIG.fallbackOrigin,
      cachePath,
      now: () => now,
      fetchImpl: async (input) => new URL(String(input)).hostname === "dns.alidns.com"
        ? txtResponse("v1 backup.discovery.test")
        : new Response("", { status: 200 }),
    });
    await initial.initialize();
    assert.equal(initial.activeOrigin, "https://backup.discovery.test");
    assert.equal(fs.statSync(cachePath).mode & 0o777, 0o600);

    const cached = new CloudEndpointResolver({
      config: CONFIG,
      fallbackOrigin: CONFIG.fallbackOrigin,
      cachePath,
      now: () => now + 1_000,
      fetchImpl: async () => { throw new Error("DNS unavailable"); },
    });
    await cached.initialize();
    assert.equal(cached.activeOrigin, "https://backup.discovery.test");
    assert.equal(cached.currentSource, "cache");

    const unavailable = new CloudEndpointResolver({
      config: CONFIG,
      fallbackOrigin: CONFIG.fallbackOrigin,
      now: () => now,
      fetchImpl: async () => { throw new Error("DNS unavailable"); },
    });
    await unavailable.initialize();
    assert.equal(unavailable.activeOrigin, CONFIG.fallbackOrigin);
    assert.equal(unavailable.currentSource, "fallback");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
