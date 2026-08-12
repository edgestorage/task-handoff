import assert from "node:assert/strict";
import test from "node:test";
import { canPublishTerminalResize } from "../src/apps/control-plane/terminalResizeOwnership.ts";

test("only an active visible focused terminal publishes resize", () => {
  assert.equal(canPublishTerminalResize({ active: true, visible: true, focused: true, applyingRemoteResize: false }), true);
  assert.equal(canPublishTerminalResize({ active: false, visible: true, focused: true, applyingRemoteResize: false }), false);
  assert.equal(canPublishTerminalResize({ active: true, visible: false, focused: true, applyingRemoteResize: false }), false);
  assert.equal(canPublishTerminalResize({ active: true, visible: true, focused: false, applyingRemoteResize: false }), false);
});

test("remote terminal resize cannot be published back", () => {
  assert.equal(canPublishTerminalResize({ active: true, visible: true, focused: true, applyingRemoteResize: true }), false);
});

test("focus transfer leaves exactly one resize publisher across two windows", () => {
  const publish = (focused) => canPublishTerminalResize({ active: true, visible: true, focused, applyingRemoteResize: false });
  assert.deepEqual([publish(true), publish(false)], [true, false]);
  assert.deepEqual([publish(false), publish(true)], [false, true]);
  assert.deepEqual([publish(false), publish(false)], [false, false]);
});

test("a background container resize stays local until its window regains focus", () => {
  const background = { active: true, visible: false, focused: false, applyingRemoteResize: false };
  assert.equal(canPublishTerminalResize(background), false);
  assert.equal(canPublishTerminalResize({ ...background, visible: true, focused: true }), true);
});
