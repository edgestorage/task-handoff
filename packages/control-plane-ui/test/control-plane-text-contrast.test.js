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

test("control plane dark theme tones down strong text without changing the shared theme", () => {
  assert.match(workbenchStyles, /:global\(html\.dark\),\s*:global\(html\[data-theme="dark"\]\)\s*\{[^}]*--text: hsl\(192 18% 82%\);[^}]*--ai-board-title: var\(--text\);[^}]*--ai-session-title: var\(--text\);[^}]*--text-strong: var\(--text\);/s);
});
