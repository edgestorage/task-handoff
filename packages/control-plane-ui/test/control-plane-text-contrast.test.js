import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const workbenchStyles = fs.readFileSync(new URL("../src/apps/control-plane/ControlPlaneWorkbench.css", import.meta.url), "utf8");
const appStyles = fs.readFileSync(new URL("../src/styles/app.css", import.meta.url), "utf8");

test("control plane strong text defaults to semibold", () => {
  assert.match(appStyles, /strong\s*\{\s*font-weight: 600;\s*\}/);
});

test("control plane light theme uses the default text color for strong text", () => {
  assert.match(appStyles, /:root:not\(\.dark\):not\(\[data-theme="dark"\]\),\s*:root\[data-theme="light"\]\s*\{[^}]*--text: #1c1c1e;[^}]*--text-strong: var\(--text\);/s);
});

test("control plane dark theme uses the mobile palette for normal and strong text", () => {
  assert.match(appStyles, /:root\.dark,\s*:root\[data-theme="dark"\]\s*\{[^}]*--text: #f2f2f7;[^}]*--text-strong: var\(--text\);/s);
  assert.doesNotMatch(workbenchStyles, /:global\(html\.dark\)/);
});
