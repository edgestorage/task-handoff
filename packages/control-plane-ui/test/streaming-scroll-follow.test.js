import assert from "node:assert/strict";
import test from "node:test";
import { createStreamingScrollFollow, distanceFromBottom } from "../src/lib/streaming-scroll-follow.ts";
import { FakeAnimationFrameScheduler } from "../../../test/support/streaming-test-tools.mjs";

function viewport(overrides = {}) {
  return { clientHeight: 400, scrollHeight: 1000, scrollTop: 600, ...overrides };
}

test("distance from bottom is clamped for rounded browser geometry", () => {
  assert.equal(distanceFromBottom(viewport()), 0);
  assert.equal(distanceFromBottom(viewport({ scrollTop: 500 })), 100);
  assert.equal(distanceFromBottom(viewport({ scrollTop: 601 })), 0);
});

test("content and composer growth coalesce to one scroll write per frame", () => {
  const frames = new FakeAnimationFrameScheduler();
  const target = viewport();
  const follow = createStreamingScrollFollow(() => target, {
    requestFrame: frames.requestAnimationFrame,
    cancelFrame: frames.cancelAnimationFrame,
  });
  target.scrollHeight = 1200;
  follow.notifyContentResize();
  follow.notifyContentResize();
  assert.equal(frames.pendingFrameCount, 1);
  assert.equal(target.scrollTop, 600);
  frames.step();
  assert.equal(target.scrollTop, 1200);
});

test("user scrolling above the threshold pauses following until explicitly restored", () => {
  const frames = new FakeAnimationFrameScheduler();
  const target = viewport({ scrollTop: 400 });
  const changes = [];
  const follow = createStreamingScrollFollow(() => target, {
    requestFrame: frames.requestAnimationFrame,
    cancelFrame: frames.cancelAnimationFrame,
    onFollowingChange: (value) => changes.push(value),
  });
  follow.handleScroll();
  target.scrollHeight = 1300;
  follow.notifyContentResize();
  assert.equal(frames.pendingFrameCount, 0);
  assert.deepEqual(changes, [false]);
  follow.followLatest();
  frames.step();
  assert.equal(target.scrollTop, 1300);
  assert.deepEqual(changes, [false, true]);
});

test("remaining within 48px keeps automatic following enabled", () => {
  const frames = new FakeAnimationFrameScheduler();
  const target = viewport({ scrollTop: 560 });
  const follow = createStreamingScrollFollow(() => target, {
    requestFrame: frames.requestAnimationFrame,
    cancelFrame: frames.cancelAnimationFrame,
  });
  follow.handleScroll();
  target.scrollHeight = 1100;
  follow.notifyContentResize();
  frames.step();
  assert.equal(target.scrollTop, 1100);
});

test("dispose cancels a pending follow write", () => {
  const frames = new FakeAnimationFrameScheduler();
  const target = viewport();
  const follow = createStreamingScrollFollow(() => target, {
    requestFrame: frames.requestAnimationFrame,
    cancelFrame: frames.cancelAnimationFrame,
  });
  follow.notifyContentResize();
  follow.dispose();
  assert.equal(frames.pendingFrameCount, 0);
});
