import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const workbenchStyles = fs.readFileSync(new URL("../src/apps/control-plane/ControlPlaneWorkbench.css", import.meta.url), "utf8");
const appStyles = fs.readFileSync(new URL("../src/styles/app.css", import.meta.url), "utf8");
const themeStyles = fs.readFileSync(new URL("../../web-theme/theme.css", import.meta.url), "utf8");
const markdownContent = fs.readFileSync(new URL("../../web-theme/MarkdownContent.vue", import.meta.url), "utf8");

test("control plane strong text defaults to semibold", () => {
  assert.match(appStyles, /strong\s*\{\s*font-weight: 600;\s*\}/);
});

test("control plane light theme uses the default text color for strong text", () => {
  assert.match(appStyles, /:root:not\(\.dark\):not\(\[data-theme="dark"\]\),\s*:root\[data-theme="light"\]\s*\{[^}]*--text: #1c1c1e;[^}]*--text-strong: var\(--text\);/s);
});

test("control plane dark theme uses softer body text with stronger emphasis text", () => {
  assert.match(appStyles, /:root\.dark,\s*:root\[data-theme="dark"\]\s*\{[^}]*--text: #e3e4e8;[^}]*--text-strong: #f3f3f6;/s);
  assert.doesNotMatch(workbenchStyles, /:global\(html\.dark\)/);
});

test("Markdown body text shares the application body text token", () => {
  assert.match(themeStyles, /:root\s*\{[^}]*--markdown-text-color: var\(--text\);[^}]*--markdown-muted-color: var\(--text-muted\);/s);
  assert.match(markdownContent, /color: var\(--markdown-text-color, var\(--text, currentColor\)\)/);
  assert.doesNotMatch(markdownContent, /--markdown-text-color, var\(--text-strong/);
});
