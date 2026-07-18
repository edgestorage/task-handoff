import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const board = fs.readFileSync(new URL("../src/apps/control-plane/ai-board/AiSessionBoardView.vue", import.meta.url), "utf8");

test("AI board columns remain status lanes sorted only by user prompt recency", () => {
  assert.match(board, /layoutMode\.value === "grid" && gridSortByStatus\.value/);
  assert.match(board, /for \(const card of layoutVisibleCards\.value\) \{\s*byKey\.get\(cardColumnKey\(card\)\)\?\.cards\.push\(card\);/);
  assert.match(board, /compareAiSessionsByLastUserMessage\(left\.session, right\.session, sortByStatus\)/);
});

test("AI board grid alone exposes status sorting and grouping options", () => {
  assert.match(board, /<DropdownMenu v-if="layoutMode === 'grid'">[\s\S]*?>\s*Sort by status\s*</);
  assert.match(board, /value="none">No grouping</);
  assert.match(board, /value="path">Group by path</);
  assert.match(board, /value="instance">Group by instance</);
  assert.match(board, /value="node">Group by node</);
  assert.match(board, /value="agent">Group by agent</);
  assert.doesNotMatch(board, /type AiBoardGridGroupBy = [^;]*status/);
});

test("AI board grid grouping follows the sorted card order and persists independently", () => {
  assert.match(board, /for \(const card of layoutVisibleCards\.value\) \{[\s\S]*?groups\.set\(key, current\);/);
  assert.match(board, /AI_BOARD_GRID_GROUP_BY_STORAGE_KEY/);
  assert.match(board, /AI_BOARD_GRID_SORT_BY_STATUS_STORAGE_KEY/);
  assert.match(board, /class="ai-board-grid-group-label"/);
  assert.match(board, /grid-column: 1 \/ -1;/);
});

test("AI board node and agent groups use authoritative identifiers", () => {
  assert.match(board, /key: card\.instance\.nodeId \|\| "__unknown_node__"/);
  assert.match(board, /label: card\.instance\.node\?\.name \|\| card\.instance\.nodeId \|\| "Unknown node"/);
  assert.match(board, /key: card\.session\.agent, label: appDisplayName\(card\.session\.agent\)/);
  assert.match(board, /stored === "node" \|\| stored === "agent"/);
});
