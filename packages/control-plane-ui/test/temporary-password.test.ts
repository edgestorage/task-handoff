import assert from "node:assert/strict";
import test from "node:test";
import { generateTemporaryPassword } from "../src/apps/control-plane/settings/temporaryPassword.ts";

test("temporary passwords have the requested length and allowed characters", () => {
  for (let index = 0; index < 100; index += 1) {
    const password = generateTemporaryPassword();
    assert.equal(password.length, 20);
    assert.match(password, /^[A-Za-z0-9_-]+$/);
  }
});

test("temporary password length is bounded", () => {
  assert.equal(generateTemporaryPassword(32).length, 32);
  assert.throws(() => generateTemporaryPassword(7), RangeError);
  assert.throws(() => generateTemporaryPassword(257), RangeError);
});
