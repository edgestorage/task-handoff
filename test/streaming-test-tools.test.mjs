import assert from "node:assert/strict";
import test from "node:test";

import {
  FakeAnimationFrameScheduler,
  FakeClock,
  FakePageVisibility,
  FakeReducedMotion,
  createStreamingTestEnvironment,
} from "./support/streaming-test-tools.mjs";

test("fake clock runs timers deterministically and preserves insertion order", () => {
  const clock = new FakeClock(100);
  const calls = [];
  const cancelled = clock.setTimeout(() => calls.push("cancelled"), 5);
  clock.setTimeout(() => {
    calls.push(`first:${clock.now()}`);
    clock.setTimeout(() => calls.push(`nested:${clock.now()}`), 0);
  }, 10);
  clock.setTimeout(() => calls.push(`second:${clock.now()}`), 10);
  clock.clearTimeout(cancelled);

  clock.advanceBy(9);
  assert.deepEqual(calls, []);
  clock.advanceBy(1);

  assert.deepEqual(calls, ["first:110", "second:110", "nested:110"]);
  assert.equal(clock.pendingTimerCount, 0);
  assert.equal(clock.now(), 110);
});

test("fake clock guards against invalid time and runaway timer loops", () => {
  const clock = new FakeClock();
  const reschedule = () => clock.setTimeout(reschedule, 0);
  reschedule();

  assert.throws(() => clock.advanceBy(-1), /non-negative/);
  assert.throws(() => clock.runAll({ maxTimers: 3 }), /safety limit/);
});

test("animation frame scheduler batches current callbacks and defers nested frames", () => {
  const clock = new FakeClock(20);
  const frames = new FakeAnimationFrameScheduler({ clock, frameDuration: 16 });
  const calls = [];
  const cancelled = frames.requestAnimationFrame(() => calls.push("cancelled"));
  frames.cancelAnimationFrame(cancelled);
  frames.requestAnimationFrame((timestamp) => {
    calls.push(`first:${timestamp}`);
    frames.requestAnimationFrame((nextTimestamp) => calls.push(`nested:${nextTimestamp}`));
  });

  frames.step();
  assert.deepEqual(calls, ["first:36"]);
  assert.equal(frames.pendingFrameCount, 1);

  frames.step(4);
  assert.deepEqual(calls, ["first:36", "nested:40"]);
  assert.equal(frames.pendingFrameCount, 0);
});

test("page visibility exposes document and injectable subscription shapes", () => {
  const visibility = new FakePageVisibility();
  const browserEvents = [];
  const injectedStates = [];
  visibility.addEventListener("visibilitychange", (event) => browserEvents.push(event.target.visibilityState));
  const unsubscribe = visibility.subscribe((visible) => injectedStates.push(visible));

  visibility.setVisibility("hidden");
  visibility.setVisibility("hidden");
  unsubscribe();
  visibility.setVisibility("visible");

  assert.equal(visibility.hidden, false);
  assert.equal(visibility.isVisible(), true);
  assert.deepEqual(browserEvents, ["hidden", "visible"]);
  assert.deepEqual(injectedStates, [false]);
  assert.throws(() => visibility.setVisibility("prerender"), /visible.*hidden/);
});

test("reduced motion provides stable matchMedia lists and change events", () => {
  const preference = new FakeReducedMotion();
  const reduced = preference.matchMedia("(prefers-reduced-motion: reduce)");
  const noPreference = preference.matchMedia("(prefers-reduced-motion: no-preference)");
  const browserEvents = [];
  const injectedStates = [];
  reduced.addEventListener("change", (event) => browserEvents.push(event.matches));
  const unsubscribe = preference.subscribe((matches) => injectedStates.push(matches));

  assert.equal(preference.matchMedia("(prefers-reduced-motion: reduce)"), reduced);
  assert.equal(reduced.matches, false);
  assert.equal(noPreference.matches, true);

  preference.setReducedMotion(true);
  preference.setReducedMotion(true);
  unsubscribe();
  preference.setReducedMotion(false);

  assert.deepEqual(browserEvents, [true, false]);
  assert.deepEqual(injectedStates, [true]);
  assert.equal(noPreference.matches, true);
});

test("streaming environment shares one clock across browser-shaped adapters", () => {
  const environment = createStreamingTestEnvironment({
    startTime: 1_000,
    frameDuration: 8,
    visibilityState: "hidden",
    reducedMotion: true,
  });
  let timestamp;
  environment.window.requestAnimationFrame((value) => {
    timestamp = value;
  });

  environment.animationFrames.step();

  assert.equal(timestamp, 1_008);
  assert.equal(environment.clock.now(), 1_008);
  assert.equal(environment.document.hidden, true);
  assert.equal(environment.window.matchMedia("(prefers-reduced-motion: reduce)").matches, true);
});
