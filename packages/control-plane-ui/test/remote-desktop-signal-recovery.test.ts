import assert from "node:assert/strict";
import test from "node:test";
import {
  isLostRemoteDesktopSessionError,
  isRetryableRemoteDesktopSignalResumeError,
  REMOTE_DESKTOP_SIGNAL_RESUME_RETRY_MAX_MS,
  remoteDesktopSignalResumeRetryDelayMs,
} from "../src/apps/control-plane/instance-detail/remoteDesktopSignalRecovery.ts";

test("signal resume retries back off and stay bounded", () => {
  assert.equal(remoteDesktopSignalResumeRetryDelayMs(0), 300);
  assert.equal(remoteDesktopSignalResumeRetryDelayMs(1), 600);
  assert.equal(remoteDesktopSignalResumeRetryDelayMs(4), 4_000);
  assert.equal(remoteDesktopSignalResumeRetryDelayMs(20), REMOTE_DESKTOP_SIGNAL_RESUME_RETRY_MAX_MS);
});

test("only transient signal resume failures retry", () => {
  assert.equal(isRetryableRemoteDesktopSignalResumeError(Object.assign(new Error("offline"), { name: "FetchError" })), true);
  assert.equal(isRetryableRemoteDesktopSignalResumeError({ status: 503 }), true);
  assert.equal(isRetryableRemoteDesktopSignalResumeError({ status: 429 }), true);
  assert.equal(isRetryableRemoteDesktopSignalResumeError({ status: 401 }), false);
  assert.equal(isRetryableRemoteDesktopSignalResumeError({ status: 422 }), false);
});

test("lost sessions remain distinguishable from transient transport errors", () => {
  assert.equal(isLostRemoteDesktopSessionError({ status: 404 }), true);
  assert.equal(isLostRemoteDesktopSessionError({ code: "REMOTE_DESKTOP_SESSION_CLOSED" }), true);
  assert.equal(isLostRemoteDesktopSessionError({ status: 503 }), false);
});
