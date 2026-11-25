import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import {
  AI_SESSION_COMPOSER_DEFAULT_ROWS,
  AI_SESSION_COMPOSER_MAX_ROWS,
  AI_SESSION_COMPOSER_MIN_ROWS,
  sanitizeAiSessionComposerMinRows,
} from "../src/apps/control-plane/useAiSessionComposerMinRows.ts";

const composer = fs.readFileSync(new URL("../src/components/ai-session/AiSessionComposer.vue", import.meta.url), "utf8");
const panelCss = fs.readFileSync(new URL("../src/apps/control-plane/instance-detail/AiSessionPanel.css", import.meta.url), "utf8");
const floatingDock = fs.readFileSync(new URL("../src/apps/control-plane/ai-board/AiSessionFloatingDock.vue", import.meta.url), "utf8");
const composerMinRows = fs.readFileSync(new URL("../src/apps/control-plane/useAiSessionComposerMinRows.ts", import.meta.url), "utf8");

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

test("the composer textarea starts at one row and defaults to a two-row minimum", () => {
  assert.match(composer, /class="ai-session-composer__input"[\s\S]*?rows="1"/);
  assert.match(composer, /\.ai-session-composer__input \{\s*min-height: calc\(var\(--ai-composer-min-rows, 2\) \* 1\.45em \+ 20px\);/);
  assert.match(panelCss, /\.session-ai-compose :deep\(\.ai-session-composer__input\) \{\s*min-height: calc\(var\(--ai-composer-min-rows, 2\) \* 1\.45em \+ 14px\);/);
  assert.match(floatingDock, /\.ai-board-floating-compose :deep\(\.ai-session-composer__input\) \{\s*min-height: calc\(var\(--ai-composer-min-rows, 2\) \* 1\.45em \+ 14px\);/);
});

test("the composer height handle snaps the persisted minimum to one through four rows", () => {
  assert.equal(AI_SESSION_COMPOSER_MIN_ROWS, 1);
  assert.equal(AI_SESSION_COMPOSER_DEFAULT_ROWS, 2);
  assert.equal(AI_SESSION_COMPOSER_MAX_ROWS, 4);
  assert.equal(sanitizeAiSessionComposerMinRows(-10), 1);
  assert.equal(sanitizeAiSessionComposerMinRows("1.6"), 2);
  assert.equal(sanitizeAiSessionComposerMinRows(4), 4);
  assert.equal(sanitizeAiSessionComposerMinRows(9), 4);
  assert.equal(sanitizeAiSessionComposerMinRows(null), 2);
  assert.equal(sanitizeAiSessionComposerMinRows("invalid"), 2);
  assert.match(composer, /:style="\{ '--ai-composer-min-rows': composerMinRows \}"/);
  assert.match(composer, /class="ai-session-composer__height-handle"[\s\S]*?role="separator"[\s\S]*?:aria-valuemin="AI_SESSION_COMPOSER_MIN_ROWS"[\s\S]*?:aria-valuemax="AI_SESSION_COMPOSER_MAX_ROWS"[\s\S]*?:aria-valuenow="composerMinRows"[\s\S]*?@pointerdown="startComposerHeightResize"[\s\S]*?@keydown="handleComposerHeightKeydown"/);
  assert.match(composer, /setComposerMinRows\(startRows \+ \(startY - moveEvent\.clientY\) \/ lineHeight\)/);
  assert.match(composerMinRows, /task-handoff\.control-plane\.ai-session-composer-min-rows/);
  assert.match(composerMinRows, /localStorage\?\.setItem\(AI_SESSION_COMPOSER_MIN_ROWS_STORAGE_KEY, String\(next\)\)/);
});

test("the height handle stays hidden until hovered and stays on the composer's top edge", () => {
  const handle = composer.indexOf('class="ai-session-composer__height-handle"');
  const hoverZoneStart = composer.indexOf('class="ai-session-composer__height-hover-zone"');
  assert.ok(handle > composer.indexOf("<form ref=\"composerEl\""));
  assert.ok(handle > hoverZoneStart);
  assert.ok(handle < composer.indexOf('class="ai-session-composer__attachments"'));
  assert.doesNotMatch(composer.slice(hoverZoneStart, handle), /@pointerdown/);
  assert.match(composer, /\.ai-session-composer__height-hover-zone \{[\s\S]*?width: min\(320px, 60%\);[\s\S]*?opacity: 0;/);
  assert.match(composer, /\.ai-session-composer__height-handle \{[\s\S]*?width: 40px;[\s\S]*?cursor: ns-resize;/);
  assert.match(composer, /\.ai-session-composer__height-handle::before \{[\s\S]*?top: 3px;[\s\S]*?width: 22px;[\s\S]*?height: 3px;/);
  assert.match(composer, /\.ai-session-composer__height-hover-zone:is\(:hover, :focus-within\),[\s\S]*?\.ai-session-composer__height-hover-zone \{\s*opacity: 1;\s*transition-delay: 50ms;/);
});
