import assert from "node:assert/strict";
import test from "node:test";
import { actionInboxPlacement } from "../src/apps/control-plane/action-inbox/toastPlacement.ts";

const toast = (left, bottom) => ({ left, right: left + 350, top: 68, bottom, height: bottom - 68 });

test("inbox uses visible toast bounds rather than toast count or fixed offsets", () => {
  assert.deepEqual(actionInboxPlacement(1200, 800, []), { top: 76, right: 18, availableHeight: 708 });
  assert.equal(actionInboxPlacement(1200, 800, [toast(830, 145)]).top, 157);
  assert.equal(actionInboxPlacement(1200, 800, [toast(830, 145), toast(830, 215)]).top, 227);
  assert.equal(actionInboxPlacement(1200, 800, [toast(0, 300)]).top, 76);
});

test("a tall toast moves the inbox beside it when vertical room runs out", () => {
  const placement = actionInboxPlacement(1200, 340, [toast(830, 290)]);
  assert.equal(placement.top, 76);
  assert.equal(placement.right, 382);
});

test("long or loading toasts use their rendered bounds and disappearing toasts restore position", () => {
  const loading = toast(830, 250);
  const longMessage = toast(830, 400);
  assert.equal(actionInboxPlacement(1200, 900, [loading, longMessage]).top, 412);
  assert.equal(actionInboxPlacement(1200, 900, [loading]).top, 262);
  assert.equal(actionInboxPlacement(1200, 900, []).top, 76);
  assert.equal(actionInboxPlacement(1200, 300, [longMessage]).right, 382);
});

test("a full-width tall toast cannot push the collapse control off a short viewport", () => {
  const placement = actionInboxPlacement(375, 300, [{ left: 10, right: 365, top: 68, bottom: 400, height: 332 }]);
  assert.equal(placement.top, 160);
  assert.equal(placement.right, 18);
  assert.equal(placement.availableHeight, 124);
});
