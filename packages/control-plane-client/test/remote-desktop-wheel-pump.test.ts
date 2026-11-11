import assert from "node:assert/strict";
import test from "node:test";

import { REMOTE_DESKTOP_WHEEL_STEP, RemoteDesktopWheelPump } from "../src/remote-desktop-wheel-pump.ts";

test("wheel pump spreads a burst into one notch per drain", () => {
  const pump = new RemoteDesktopWheelPump();
  pump.add(100, -80);
  assert.deepEqual(pump.take(), { x: REMOTE_DESKTOP_WHEEL_STEP, y: -REMOTE_DESKTOP_WHEEL_STEP });
  assert.deepEqual(pump.take(), { x: REMOTE_DESKTOP_WHEEL_STEP, y: -REMOTE_DESKTOP_WHEEL_STEP });
  assert.deepEqual(pump.take(), { x: 20, y: 0 });
  assert.equal(pump.idle, true);
  assert.equal(pump.take(), undefined);
});

test("wheel pump forwards sub-notch movement instead of discarding it", () => {
  const pump = new RemoteDesktopWheelPump();
  pump.add(12, -7);
  assert.deepEqual(pump.take(), { x: 12, y: -7 });
  assert.equal(pump.idle, true);

  pump.add(28, -33);
  assert.deepEqual(pump.take(), { x: 28, y: -33 });
  assert.equal(pump.idle, true);
});

test("wheel pump drops non-finite values and can be cleared between sessions", () => {
  const pump = new RemoteDesktopWheelPump();
  pump.add(Number.NaN, Number.POSITIVE_INFINITY);
  assert.equal(pump.idle, true);
  pump.add(120, 120);
  pump.clear();
  assert.equal(pump.idle, true);
});
