import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const workbenchStyles = fs.readFileSync(new URL("../src/apps/control-plane/ControlPlaneWorkbench.css", import.meta.url), "utf8");

test("control plane dark theme tones down strong text without changing the shared theme", () => {
  assert.match(workbenchStyles, /:global\(html\.dark\),\s*:global\(html\[data-theme="dark"\]\)\s*\{[^}]*--text: hsl\(192 18% 82%\);[^}]*--ai-board-title: var\(--text\);[^}]*--ai-session-title: var\(--text\);[^}]*--text-strong: var\(--text\);/s);
});
