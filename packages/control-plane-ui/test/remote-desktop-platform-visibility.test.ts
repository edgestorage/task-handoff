import assert from "node:assert/strict";
import test from "node:test";

import { remoteDesktopVisibleForPlatform } from "../src/apps/control-plane/remoteDesktopCapability.ts";

test("remote desktop UI is hidden only for Windows", () => {
  assert.equal(remoteDesktopVisibleForPlatform("win32"), false);
  assert.equal(remoteDesktopVisibleForPlatform("linux"), true);
  assert.equal(remoteDesktopVisibleForPlatform("darwin"), true);
  assert.equal(remoteDesktopVisibleForPlatform("unknown"), true);
  assert.equal(remoteDesktopVisibleForPlatform(undefined), true);
});
