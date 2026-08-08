import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const workbenchStyles = fs.readFileSync(new URL("../src/apps/control-plane/ControlPlaneWorkbench.css", import.meta.url), "utf8");
const sessionStyles = fs.readFileSync(new URL("../src/apps/control-plane/instance-detail/AiSessionPanel.css", import.meta.url), "utf8");

test("control plane follows the visible viewport when mobile browser chrome changes", () => {
  assert.match(
    workbenchStyles,
    /\.control-plane-shell\s*\{[^}]*--control-plane-viewport-height: 100vh;[^}]*height: var\(--control-plane-viewport-height\);/s,
  );
  assert.match(
    workbenchStyles,
    /@supports \(height: 100dvh\)\s*\{\s*\.control-plane-shell\s*\{\s*--control-plane-viewport-height: 100dvh;/s,
  );
  assert.match(
    workbenchStyles,
    /\.control-plane-workbench\s*\{[^}]*height: calc\(var\(--control-plane-viewport-height\) - 56px\);/s,
  );
  assert.doesNotMatch(workbenchStyles, /height: calc\(100vh - 56px\);/);
});

test("AI session composers use the same authoritative viewport height", () => {
  assert.match(
    sessionStyles,
    /max-height: min\(320px, calc\(var\(--control-plane-viewport-height, 100vh\) - 180px\)\);/,
  );
  assert.match(
    sessionStyles,
    /max-height: min\(320px, calc\(var\(--control-plane-viewport-height, 100vh\) - 220px\)\);/,
  );
});
