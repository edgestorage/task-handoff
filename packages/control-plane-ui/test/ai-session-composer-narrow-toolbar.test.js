import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const composer = fs.readFileSync(new URL("../src/components/ai-session/AiSessionComposer.vue", import.meta.url), "utf8");

test("the composer measures its own width for narrow toolbar layouts", () => {
  assert.match(composer, /\.ai-session-composer \{\s*container: ai-session-composer \/ inline-size;/);
});

test("the permission trigger keeps only its icon once the composer is narrow", () => {
  assert.match(
    composer,
    /@container ai-session-composer \(max-width: 420px\) \{[\s\S]*?\.ai-session-composer__permission-trigger \{[^}]*flex: 0 0 auto;[^}]*\}[\s\S]*?\.ai-session-composer__permission-trigger span \{\s*display: none;\s*\}/,
  );
  assert.match(composer, /:aria-label="t\('sessions\.composer\.permissionMode', \{ mode: selectedPermission\.label \}\)"/);
});

test("composer icon buttons keep their round shape when the toolbar is squeezed", () => {
  assert.match(composer, /\.ai-session-composer__tool,\s*\.ai-session-composer__primary \{\s*display: inline-grid;\s*flex: 0 0 auto;/);
});
