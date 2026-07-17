import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const card = fs.readFileSync(new URL("../src/apps/control-plane/ai-board/AiSessionCard.vue", import.meta.url), "utf8");
const board = fs.readFileSync(new URL("../src/apps/control-plane/ai-board/AiSessionBoardView.vue", import.meta.url), "utf8");

test("ai session card navigation stops at the first and last messages", () => {
  assert.match(card, /:disabled="promptIndex <= 0"/);
  assert.match(card, /:disabled="promptIndex >= promptCount - 1"/);
  assert.match(board, /index: Math\.min\(Math\.max\(index, 0\), count - 1\)/);
  assert.doesNotMatch(board, /\(index \+ count\) % count/);
});

test("ai session cards do not render lifecycle status text in their headers", () => {
  assert.doesNotMatch(card, /aiSessionStatusLabel\(card\.session\)/);
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

test("ai session board card previews do not open an expanded overlay", () => {
  assert.doesNotMatch(card, /expandedKind|data-ai-preview-trigger|handlePreviewClick|展开用户消息|展开 AI 进展|cursor: zoom-in/);
});
