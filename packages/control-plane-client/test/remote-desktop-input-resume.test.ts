import assert from "node:assert/strict";
import test from "node:test";

import {
  isRecoverableRemoteDesktopInputResumeError,
  REMOTE_DESKTOP_INPUT_RESUME_ACK_TIMEOUT_MS,
  REMOTE_DESKTOP_INPUT_RESUME_RETRY_BASE_MS,
  REMOTE_DESKTOP_INPUT_RESUME_RETRY_MAX_MS,
  remoteDesktopInputResumeRetryDelayMs,
} from "../src/remote-desktop-input-resume.ts";

test("input resume retries only transient binding races", () => {
  for (const code of [
    "REMOTE_DESKTOP_GEOMETRY_CHANGED",
    "REMOTE_DESKTOP_INVALID_STATE",
    "REMOTE_DESKTOP_STALE_EPOCH",
  ]) {
    assert.equal(isRecoverableRemoteDesktopInputResumeError(code), true);
  }
  assert.equal(isRecoverableRemoteDesktopInputResumeError("REMOTE_DESKTOP_FORBIDDEN"), false);
  assert.equal(isRecoverableRemoteDesktopInputResumeError(undefined), false);
});

test("input resume acknowledgement timeout and retry backoff are bounded", () => {
  assert.equal(REMOTE_DESKTOP_INPUT_RESUME_ACK_TIMEOUT_MS, 2_500);
  assert.equal(REMOTE_DESKTOP_INPUT_RESUME_RETRY_BASE_MS, 250);
  assert.equal(REMOTE_DESKTOP_INPUT_RESUME_RETRY_MAX_MS, 2_000);
  assert.deepEqual([0, 1, 2, 3, 4, 20].map(remoteDesktopInputResumeRetryDelayMs), [250, 500, 1_000, 2_000, 2_000, 2_000]);
});
