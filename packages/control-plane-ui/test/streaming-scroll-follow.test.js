import assert from "node:assert/strict";
import test from "node:test";
import { createStreamingScrollFollow, distanceFromBottom, STREAMING_SCROLL_FOLLOW_THRESHOLD } from "../src/lib/streaming-scroll-follow.ts";
import { FakeAnimationFrameScheduler } from "../../../test/support/streaming-test-tools.mjs";

function viewport(overrides = {}) {
  const target = { clientHeight: 400, scrollHeight: 1000, scrollTop: 600, scrollCalls: [], ...overrides };
  target.scrollTo ??= (options) => {
    target.scrollCalls.push(options);
    target.scrollTop = options.top;
  };
  return target;
}

test("distance from bottom is clamped for rounded browser geometry", () => {
  assert.equal(STREAMING_SCROLL_FOLLOW_THRESHOLD, 48);
  assert.equal(distanceFromBottom(viewport()), 0);
  assert.equal(distanceFromBottom(viewport({ scrollTop: 500 })), 100);
  assert.equal(distanceFromBottom(viewport({ scrollTop: 601 })), 0);
});

test("content and composer growth reconcile to the bottom without starting an animation", () => {
  const frames = new FakeAnimationFrameScheduler();
  const target = viewport();
  const follow = createStreamingScrollFollow(() => target, {
    requestFrame: frames.requestAnimationFrame,
    cancelFrame: frames.cancelAnimationFrame,
  });
  target.scrollHeight = 1200;
  follow.notifyContentResize();
  follow.notifyContentResize();
  assert.equal(frames.pendingFrameCount, 0);
  assert.equal(target.scrollTop, 800);
  assert.deepEqual(target.scrollCalls, []);
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

test("manual scroll intent cancels automatic following during a smooth scroll", () => {
  const frames = new FakeAnimationFrameScheduler();
  const target = viewport();
  const changes = [];
  const follow = createStreamingScrollFollow(() => target, {
    requestFrame: frames.requestAnimationFrame,
    cancelFrame: frames.cancelAnimationFrame,
    onFollowingChange: (value) => changes.push(value),
  });
  target.scrollHeight = 1200;
  follow.notifyContentResize();
  frames.step();
  follow.pauseFollowing();
  target.scrollTop = 500;
  follow.handleScroll();
  assert.equal(follow.isFollowing(), false);
  assert.deepEqual(changes, [false]);
});

test("scroll intent inside the 48px follow zone does not show the return control", () => {
  const frames = new FakeAnimationFrameScheduler();
  const target = viewport({ scrollTop: 580 });
  const changes = [];
  const follow = createStreamingScrollFollow(() => target, {
    requestFrame: frames.requestAnimationFrame,
    cancelFrame: frames.cancelAnimationFrame,
    onFollowingChange: (value) => changes.push(value),
  });
  follow.pauseFollowing();
  assert.equal(follow.isFollowing(), true);
  assert.deepEqual(changes, []);
});

test("long follow jumps within 800px of the bottom before smooth scrolling", () => {
  const frames = new FakeAnimationFrameScheduler();
  const scrollCalls = [];
  const target = viewport({
    clientHeight: 400,
    scrollHeight: 5000,
    scrollTop: 200,
    scrollTo: (options) => scrollCalls.push(options),
  });
  const follow = createStreamingScrollFollow(() => target, {
    requestFrame: frames.requestAnimationFrame,
    cancelFrame: frames.cancelAnimationFrame,
  });
  follow.followLatest();
  frames.step();
  assert.equal(target.scrollTop, 3800);
  assert.deepEqual(scrollCalls, [{ top: 5000, behavior: "smooth" }]);
});

test("content growth retargets an explicit smooth follow without snapping", () => {
  const frames = new FakeAnimationFrameScheduler();
  const target = viewport();
  const follow = createStreamingScrollFollow(() => target, {
    requestFrame: frames.requestAnimationFrame,
    cancelFrame: frames.cancelAnimationFrame,
  });

  follow.followLatest();
  target.scrollHeight = 1200;
  follow.notifyContentResize();

  assert.equal(target.scrollTop, 600);
  assert.equal(frames.pendingFrameCount, 1);
  frames.step();
  assert.deepEqual(target.scrollCalls, [{ top: 1200, behavior: "smooth" }]);
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
  assert.equal(frames.pendingFrameCount, 0);
  assert.equal(target.scrollTop, 700);
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

test("explicit disclosure interaction stops bottom following before layout changes", () => {
  const frames = new FakeAnimationFrameScheduler();
  const target = viewport();
  const changes = [];
  const follow = createStreamingScrollFollow(() => target, {
    requestFrame: frames.requestAnimationFrame,
    cancelFrame: frames.cancelAnimationFrame,
    onFollowingChange: (value) => changes.push(value),
  });

  follow.followLatest();
  assert.equal(frames.pendingFrameCount, 1);
  follow.stopFollowing();
  target.scrollHeight = 1200;
  follow.notifyContentResize();

  assert.equal(frames.pendingFrameCount, 0);
  assert.equal(target.scrollTop, 600);
  assert.equal(follow.isFollowing(), false);
  assert.deepEqual(changes, [false]);
});
