import assert from "node:assert/strict";
import test from "node:test";
import { createLayoutScrollAnchor, createUserLayoutScrollAnchor } from "../src/lib/layout-scroll-anchor.ts";
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

test("user layout transaction keeps the clicked disclosure at a stable viewport position", () => {
  const frames = new FakeAnimationFrameScheduler();
  const viewport = { scrollTop: 600 };
  let documentTop = 700;
  const activeChanges = [];
  const anchor = { getBoundingClientRect: () => ({ top: documentTop - viewport.scrollTop }) };
  const transaction = createUserLayoutScrollAnchor(() => viewport, {
    requestFrame: frames.requestAnimationFrame,
    cancelFrame: frames.cancelAnimationFrame,
    onActiveChange: (active) => activeChanges.push(active),
  });

  transaction.begin(anchor);
  documentTop += 80;
  frames.step();
  assert.equal(viewport.scrollTop, 680);
  assert.equal(anchor.getBoundingClientRect().top, 100);

  documentTop += 20;
  frames.step();
  assert.equal(viewport.scrollTop, 700);
  assert.equal(anchor.getBoundingClientRect().top, 100);

  frames.step();
  frames.step();
  frames.step();
  assert.equal(transaction.isActive(), false);
  assert.deepEqual(activeChanges, [true, false]);
});
