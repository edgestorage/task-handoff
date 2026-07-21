import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const card = fs.readFileSync(new URL("../src/apps/control-plane/ai-board/AiSessionCard.vue", import.meta.url), "utf8");
const board = fs.readFileSync(new URL("../src/apps/control-plane/ai-board/AiSessionBoardView.vue", import.meta.url), "utf8");
const dock = fs.readFileSync(new URL("../src/apps/control-plane/ai-board/AiSessionFloatingDock.vue", import.meta.url), "utf8");

test("ai session card navigation stops at the first and last messages", () => {
  assert.match(card, /:disabled="promptIndex <= 0"/);
  assert.match(card, /:disabled="promptIndex >= promptCount - 1"/);
  assert.match(board, /index: Math\.min\(Math\.max\(index, 0\), count - 1\)/);
  assert.doesNotMatch(board, /\(index \+ count\) % count/);
});

test("ai session cards do not render lifecycle status text in their headers", () => {
  assert.doesNotMatch(card, /aiSessionStatusLabel\(card\.session\)/);
  assert.doesNotMatch(dock, /aiSessionStatusLabel\(card\.session\)/);
});

test("ai session board cards show workspace context unless paths already group the grid", () => {
  assert.match(card, /v-if="showWorkspace" class="ai-board-workspace"/);
  assert.match(card, /aiSessionBasename\(card\.session\.cwd\)/);
  assert.match(card, /class="ai-board-primary-line"/);
  assert.match(card, /class="ai-board-secondary-line"[\s\S]*aiSessionAppDisplayName[\s\S]*class="ai-board-workspace"[\s\S]*aria-hidden="true">·</);
  assert.match(board, /:show-workspace="true"/);
  assert.match(board, /:show-workspace="gridGroupBy !== 'path'"/);
  assert.match(board, /class="ai-board-grid-group-workspace"/);
  assert.match(dock, /class="ai-board-floating-workspace"/);
  assert.match(dock, /class="ai-board-floating-primary-line"/);
  assert.match(dock, /class="ai-board-floating-secondary-line"[\s\S]*aiSessionAppDisplayName[\s\S]*aria-hidden="true">·<[\s\S]*class="ai-board-floating-workspace"/);
  assert.match(dock, /aiSessionBasename\(card\.session\.cwd\)/);
  assert.match(card, /<TooltipTrigger as-child>\s*<b>/);
  assert.match(card, /<TooltipContent[^>]*>\{\{ card\.session\.cwd \|\| "Unknown path" \}\}<\/TooltipContent>/);
  assert.match(dock, /<TooltipTrigger as-child>\s*<b>/);
  assert.match(dock, /<TooltipContent[^>]*>\{\{ card\.session\.cwd \|\| "Unknown path" \}\}<\/TooltipContent>/);
  assert.match(board, /:global\(\.ai-session-path-tooltip\)\s*\{[^}]*background: var\(--surface-overlay\) !important;[^}]*font-size: 11px;/s);
  assert.match(card, /\.ai-board-workspace b\s*\{[^}]*color: inherit;[^}]*font-weight: inherit;/s);
  assert.match(dock, /\.ai-board-floating-workspace b\s*\{[^}]*color: inherit;[^}]*font-weight: inherit;/s);
});

test("reselecting the selected AI session card restores collapsed details", () => {
  assert.match(board, /function selectCard\(key: string\) \{\s*if \(selectedCardKey\.value === key && detailCollapsed\.value\) \{\s*detailCollapsed\.value = false;\s*\}\s*selectedCardKey\.value = key;\s*\}/);
});

test("ai session board card markdown previews remove paragraph margins", () => {
  assert.match(card, /\.ai-board-question :deep\(p\),\s*\.ai-board-message :deep\(p\)\s*\{\s*margin: 0;/s);
  assert.doesNotMatch(card, /\.ai-board-question\s*\{[^}]*font-weight:\s*800;/s);
});

test("ai session board cards replace the metadata footer with floating navigation", () => {
  assert.doesNotMatch(card, /aiSessionContext/);
  assert.doesNotMatch(card, /ai-board-card-meta/);
  assert.match(card, /grid-template-rows: max-content minmax\(0, 1fr\);/);
  assert.match(card, /\.ai-board-content\s*\{[^}]*padding: 0 14px;/s);
  assert.match(card, /\.ai-board-preview-field-assistant\s*\{[^}]*padding: 10px 14px 0;/s);
  assert.match(card, /\.ai-board-turn-nav\s*\{[^}]*position: absolute;[^}]*right: 10px;[^}]*bottom: 8px;/s);
});

test("waiting approval actions float at the bottom left independently from card tools", () => {
  assert.match(card, /<\/div>\s*<AiSessionToolActivity[\s\S]*?\/>\s*<span v-if="canResolveApproval\(card\.session\)" class="ai-board-approval-actions">\s*<button/s);
  assert.doesNotMatch(card, /<div class="ai-board-card-tools"[^>]*>[\s\S]*?<span v-if="canResolveApproval\(card\.session\)"/);
  assert.match(card, /\.ai-board-approval-actions\s*\{[^}]*position: absolute;[^}]*bottom: 8px;[^}]*left: 14px;/s);
  assert.match(board, /session\.status === "waiting" && session\.phase === "approval"/);
  assert.doesNotMatch(board, /actions\?\.approval/);
});

test("ai session board card previews do not open an expanded overlay", () => {
  assert.doesNotMatch(card, /expandedKind|data-ai-preview-trigger|handlePreviewClick|展开用户消息|展开 AI 进展|cursor: zoom-in/);
});
