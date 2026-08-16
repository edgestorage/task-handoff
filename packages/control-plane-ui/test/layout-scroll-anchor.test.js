import assert from "node:assert/strict";
import test from "node:test";
import { createLayoutScrollAnchor, createUserLayoutChangeGuard } from "../src/lib/layout-scroll-anchor.ts";
import { FakeAnimationFrameScheduler } from "../../../test/support/streaming-test-tools.mjs";

test("layout transaction keeps the bottom anchor at the same viewport position", () => {
  const viewport = { scrollTop: 600 };
  let anchorTop = 380;
  const anchor = { getBoundingClientRect: () => ({ top: anchorTop }) };
  const transaction = createLayoutScrollAnchor(() => viewport, () => anchor, () => true);

  transaction.begin();
  anchorTop += 22;
  transaction.commit();

  assert.equal(viewport.scrollTop, 622);
});

test("native anchoring and paused following do not cause duplicate adjustments", () => {
  const viewport = { scrollTop: 600 };
  let anchorTop = 380;
  let following = true;
  const anchor = { getBoundingClientRect: () => ({ top: anchorTop }) };
  const transaction = createLayoutScrollAnchor(() => viewport, () => anchor, () => following);

  transaction.begin();
  transaction.commit();
  assert.equal(viewport.scrollTop, 600);

  transaction.begin();
  anchorTop += 22;
  following = false;
  transaction.commit();
  assert.equal(viewport.scrollTop, 600);
});

test("user layout guard suppresses competing anchors without writing scroll position", () => {
  const frames = new FakeAnimationFrameScheduler();
  const viewport = { scrollTop: 600 };
  const activeChanges = [];
  const guard = createUserLayoutChangeGuard({
    requestFrame: frames.requestAnimationFrame,
    cancelFrame: frames.cancelAnimationFrame,
    onActiveChange: (active) => activeChanges.push(active),
  });

  guard.begin();
  viewport.scrollTop = 620;
  frames.step();
  frames.step();
  frames.step();
  assert.equal(viewport.scrollTop, 620);
  assert.equal(guard.isActive(), false);
  assert.deepEqual(activeChanges, [true, false]);
});
