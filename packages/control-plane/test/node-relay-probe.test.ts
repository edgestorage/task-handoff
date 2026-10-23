import assert from "node:assert/strict";
import test from "node:test";
import { probeNodeRelayTargets } from "../src/node-agent/cloud-relay/probe.ts";

const SERVICE_ORIGIN = "https://cloud.example.com";

function relayTarget(relayId: string, host = `${relayId}.cloud.example.com`) {
  return { relayId, relayUrl: `wss://${host}/connect` };
}

function probeResponse(relayId: string) {
  return new Response(JSON.stringify({ relayId, region: null, now: new Date().toISOString(), draining: false, loadBucket: "low" }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

test("probe requests are bounded, trusted, credential-free and identity checked", async () => {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const result = await probeNodeRelayTargets({
    serviceOrigin: SERVICE_ORIGIN,
    targets: [
      relayTarget("relay_untrusted", "relay.example.net"),
      relayTarget("relay_a"),
      relayTarget("relay_b"),
    ],
    samples: 8,
    fetchImpl: (async (input, init) => {
      calls.push({ url: String(input), init });
      return probeResponse(/relay_([a-d])/.exec(String(input))?.[1] ? `relay_${/relay_([a-d])/.exec(String(input))![1]}` : "relay_a");
    }) as typeof fetch,
  });

  assert.deepEqual(result.rejectedRelayIds, ["relay_untrusted"]);
  assert.equal(calls.length, 4, "only trusted targets are measured, two samples each");
  assert.deepEqual(calls.map((call) => call.url).sort(), [
    "https://relay_a.cloud.example.com/probe",
    "https://relay_a.cloud.example.com/probe",
    "https://relay_b.cloud.example.com/probe",
    "https://relay_b.cloud.example.com/probe",
  ]);
  for (const call of calls) {
    assert.equal(call.init?.credentials, "omit");
    assert.equal(call.init?.redirect, "error");
    assert.equal((call.init?.headers as Record<string, string>).authorization, undefined);
  }
  assert.deepEqual(result.measurements.map((measurement) => measurement.relayId), ["relay_a", "relay_b"]);
});

test("probe target and sample counts are capped, and duplicate URLs are measured once", async () => {
  const urls: string[] = [];
  await probeNodeRelayTargets({
    serviceOrigin: SERVICE_ORIGIN,
    targets: [
      relayTarget("relay_a"),
      relayTarget("relay_a_duplicate"),
      relayTarget("relay_b"),
      relayTarget("relay_c"),
      relayTarget("relay_d"),
    ],
    samples: 2,
    fetchImpl: (async (input) => {
      urls.push(String(input));
      const relayId = /https:\/\/(relay_[a-z]+)\./.exec(String(input))![1];
      return probeResponse(relayId);
    }) as typeof fetch,
  });
  assert.equal(urls.length, 6);
  assert.deepEqual([...new Set(urls)].sort(), [
    "https://relay_a.cloud.example.com/probe",
    "https://relay_a_duplicate.cloud.example.com/probe",
    "https://relay_b.cloud.example.com/probe",
  ]);
});

test("an identical Relay URL is never re-probed inside one reconnect attempt", async () => {
  const urls: string[] = [];
  await probeNodeRelayTargets({
    serviceOrigin: SERVICE_ORIGIN,
    targets: [
      relayTarget("relay_a"),
      { relayId: "relay_a_alias", relayUrl: "wss://relay_a.cloud.example.com/connect" },
      relayTarget("relay_b"),
    ],
    fetchImpl: (async (input) => {
      const url = String(input);
      urls.push(url);
      const relayId = /https:\/\/(relay_[a-z]+)\./.exec(url)![1];
      return probeResponse(relayId);
    }) as typeof fetch,
  });
  assert.equal(urls.length, 4);
  assert.deepEqual([...new Set(urls)].sort(), [
    "https://relay_a.cloud.example.com/probe",
    "https://relay_b.cloud.example.com/probe",
  ]);
});

test("successful samples use their median while partial failures stay explicit", async () => {
  let clock = 0;
  let call = 0;
  const partial = await probeNodeRelayTargets({
    serviceOrigin: SERVICE_ORIGIN,
    targets: [relayTarget("relay_a")],
    now: () => clock,
    fetchImpl: (async () => {
      call += 1;
      if (call === 1) {
        clock += 50;
        throw new Error("ECONNRESET");
      }
      clock += 30;
      return probeResponse("relay_a");
    }) as typeof fetch,
  });
  assert.deepEqual(partial.measurements, [{
    relayId: "relay_a",
    rttMs: 30,
    measuredAt: new Date(80).toISOString(),
    sampleCount: 2,
    failureCount: 1,
  }]);

  clock = 0;
  call = 0;
  const median = await probeNodeRelayTargets({
    serviceOrigin: SERVICE_ORIGIN,
    targets: [relayTarget("relay_a")],
    now: () => clock,
    fetchImpl: (async () => {
      call += 1;
      clock += call === 1 ? 10 : 30;
      return probeResponse("relay_a");
    }) as typeof fetch,
  });
  assert.equal(median.measurements[0].rttMs, 20);
  assert.equal(median.measurements[0].failureCount, 0);
});

test("all failures remain available as failure evidence and an ignored abort cannot exceed the budget", async () => {
  const startedAt = Date.now();
  let calls = 0;
  const result = await probeNodeRelayTargets({
    serviceOrigin: SERVICE_ORIGIN,
    targets: [relayTarget("relay_a"), relayTarget("relay_b"), relayTarget("relay_c")],
    budgetMs: 40,
    fetchImpl: (async () => {
      calls += 1;
      return new Promise<Response>(() => {});
    }) as typeof fetch,
  });
  const elapsedMs = Date.now() - startedAt;
  assert.ok(elapsedMs < 500, `probe returned in ${elapsedMs}ms instead of honoring its budget`);
  assert.ok(calls <= 6, `probe attempted ${calls} requests`);
  assert.equal(result.measurements.length, 3);
  for (const measurement of result.measurements) {
    assert.equal(measurement.rttMs, undefined);
    assert.equal(measurement.measuredAt, undefined);
    assert.ok(measurement.failureCount >= 1);
  }
});

test("all-failure samples preserve the two-sample contract without invented RTT", async () => {
  const result = await probeNodeRelayTargets({
    serviceOrigin: SERVICE_ORIGIN,
    targets: [relayTarget("relay_a")],
    fetchImpl: (async () => { throw new Error("ECONNREFUSED"); }) as typeof fetch,
  });
  assert.deepEqual(result.measurements, [{ relayId: "relay_a", sampleCount: 2, failureCount: 2 }]);
});
