import assert from "node:assert/strict";
import test from "node:test";

import { remoteDesktopVisibleForPlatform } from "../src/apps/control-plane/remoteDesktopCapability.ts";

test("remote desktop UI is visible on Windows, macOS, Linux and unknown platforms", () => {
  assert.equal(remoteDesktopVisibleForPlatform("win32"), true);
  assert.equal(remoteDesktopVisibleForPlatform("linux"), true);
  assert.equal(remoteDesktopVisibleForPlatform("darwin"), true);
  assert.equal(remoteDesktopVisibleForPlatform("unknown"), true);
  assert.equal(remoteDesktopVisibleForPlatform(undefined), true);
});
