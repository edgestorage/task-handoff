import assert from "node:assert/strict";
import test from "node:test";

import { isRemoteDesktopSourceEndedError } from "../src/remote-desktop-source-state.ts";

test("terminal source failures are distinguished from transient capture races", () => {
  assert.equal(isRemoteDesktopSourceEndedError("REMOTE_DESKTOP_WINDOW_UNAVAILABLE"), true);
  assert.equal(isRemoteDesktopSourceEndedError("REMOTE_DESKTOP_GEOMETRY_CHANGED"), false);
  assert.equal(isRemoteDesktopSourceEndedError("REMOTE_DESKTOP_CAPTURE_UNAVAILABLE"), false);
  assert.equal(isRemoteDesktopSourceEndedError(undefined), false);
});
