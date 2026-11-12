import assert from "node:assert/strict";
import test from "node:test";
import { sanitizeSessionRemoteDesktopPreviewPresentation } from "../src/apps/control-plane/instance-detail/sessionRemoteDesktopPreviewPresentation.ts";

test("remote desktop preview presentation defaults to floating and accepts expanded", () => {
  assert.equal(sanitizeSessionRemoteDesktopPreviewPresentation("expanded"), "expanded");
  assert.equal(sanitizeSessionRemoteDesktopPreviewPresentation("floating"), "floating");
  assert.equal(sanitizeSessionRemoteDesktopPreviewPresentation("inline"), "floating");
  assert.equal(sanitizeSessionRemoteDesktopPreviewPresentation(undefined), "floating");
});
