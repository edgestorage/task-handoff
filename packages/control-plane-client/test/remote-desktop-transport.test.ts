import assert from "node:assert/strict";
import test from "node:test";

import {
  RemoteDesktopReceiveRateMeter,
  RemoteDesktopRttProbe,
} from "../src/remote-desktop-transport.ts";

test("RTT probe measures a completed control round trip and smooths later samples", () => {
  let now = 1_000;
  const probe = new RemoteDesktopRttProbe(() => now);

  const request = probe.begin();
  assert.equal(request?.sentAt, 1_000);
  now = 1_042;
  assert.equal(probe.complete(request?.requestId ?? ""), 42);
  assert.deepEqual(probe.snapshot(), { status: "active", latencyMs: 42 });

  const next = probe.begin();
  now = 1_102;
  assert.equal(probe.complete(next?.requestId ?? ""), 46);
  assert.deepEqual(probe.snapshot(), { status: "active", latencyMs: 46 });
});

test("RTT probe keeps one request in flight and reports an unsupported peer after two timeouts", () => {
  let now = 0;
  const probe = new RemoteDesktopRttProbe(() => now, 5_000);

  assert.ok(probe.begin());
  assert.equal(probe.begin(), undefined);
  now = 5_001;
  assert.equal(probe.expire(), true);
  assert.deepEqual(probe.snapshot(), { status: "measuring" });

  assert.ok(probe.begin());
  now = 10_002;
  assert.equal(probe.expire(), true);
  assert.deepEqual(probe.snapshot(), { status: "unavailable" });
});

test("RTT probe ignores stale pongs and recovers after a later successful sample", () => {
  let now = 0;
  const probe = new RemoteDesktopRttProbe(() => now, 5_000);

  const first = probe.begin();
  now = 6_000;
  probe.expire();
  assert.equal(probe.complete(first?.requestId ?? ""), undefined);

  const second = probe.begin();
  now = 6_035;
  assert.equal(probe.complete(second?.requestId ?? ""), 35);
  assert.deepEqual(probe.snapshot(), { status: "active", latencyMs: 35 });
});

test("receive rate meter derives Mbps from media bytes in a sliding window", () => {
  let now = 100;
  const meter = new RemoteDesktopReceiveRateMeter(() => now, 2_000);

  assert.deepEqual(meter.sample(), { status: "idle" });
  meter.add(1_000_000);
  assert.deepEqual(meter.sample(), { status: "measuring" });

  now = 1_100;
  assert.deepEqual(meter.sample(), { status: "active", mbps: 8 });

  meter.add(1_000_000);
  now = 3_100;
  assert.deepEqual(meter.sample(), { status: "active", mbps: 4 });
});

test("receive rate meter drops old buckets, reaches zero while idle, and resets", () => {
  let now = 0;
  const meter = new RemoteDesktopReceiveRateMeter(() => now, 2_000);

  meter.add(1_000_000);
  now = 3_000;
  assert.deepEqual(meter.sample(), { status: "active", mbps: 0 });

  meter.add(2_000_000);
  now = 3_500;
  assert.deepEqual(meter.sample(), { status: "active", mbps: 8 });

  meter.reset();
  assert.deepEqual(meter.sample(), { status: "idle" });
});
