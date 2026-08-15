import assert from "node:assert/strict";
import test from "node:test";
import { createLatestTurnHeightBuffer } from "../src/lib/latest-turn-height.ts";

test("latest turn height retains shrinkage up to 100px", () => {
  const buffer = createLatestTurnHeightBuffer(100);
  assert.equal(buffer.update(230), 230);
  assert.equal(buffer.update(200), 230);
  assert.equal(buffer.update(130), 230);
});

test("latest turn height reclaims retained space after it exceeds 100px", () => {
  const buffer = createLatestTurnHeightBuffer(100);
  assert.equal(buffer.update(230), 230);
  assert.equal(buffer.update(129), 129);
  assert.equal(buffer.update(150), 150);
});

test("historical turns do not retain height", () => {
  const buffer = createLatestTurnHeightBuffer(100);
  assert.equal(buffer.update(230), 230);
  assert.equal(buffer.update(200, false), 0);
  assert.equal(buffer.update(20), 20);
});
