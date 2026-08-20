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
  assert.match(board, /<DropdownMenu v-if="layoutMode === 'grid'">[\s\S]*?t\("sessions\.board\.sortByStatus"\)/);
  assert.match(board, /value="none">\{\{ t\("sessions\.board\.noGrouping"\) \}\}/);
  assert.match(board, /value="path">\{\{ t\("sessions\.board\.groupPath"\) \}\}/);
  assert.match(board, /value="instance">\{\{ t\("sessions\.board\.groupInstance"\) \}\}/);
  assert.match(board, /value="node">\{\{ t\("sessions\.board\.groupNode"\) \}\}/);
  assert.match(board, /value="agent">\{\{ t\("sessions\.board\.groupAgent"\) \}\}/);
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
  assert.match(board, /label: card\.instance\.node\?\.name \|\| card\.instance\.nodeId \|\| t\("sessions\.board\.unknownNode"\)/);
  assert.match(board, /key: card\.session\.agent, label: appDisplayName\(card\.session\.agent, t\)/);
  assert.match(board, /stored === "node" \|\| stored === "agent"/);
});

test("AI board path groups resolve the authoritative local-folder display name", () => {
  assert.match(board, /props\.nodeLocalFoldersByNodeId\[card\.instance\.nodeId\]/);
  assert.match(board, /candidate\.id === card\.session\.cwdFolderId/);
  assert.match(board, /folder \? nodeLocalFolderDisplayName\(folder\) : path/);
});

test("sticky AI board column headers own one continuous rounded border", () => {
  assert.doesNotMatch(board, /\.ai-board-column \{[^}]*border: 1px/);
  assert.doesNotMatch(board, /clip-path: inset\(0 round 8px\);/);
  assert.doesNotMatch(board, /columnsHeadersStuck|data-headers-stuck|updateColumnsHeaderStuck/);
  assert.match(board, /class="ai-board-column-head-mask">\s*<header class="ai-board-column-head">/);
  assert.match(board, /\.ai-board-column-head-mask \{[\s\S]*?position: sticky;[\s\S]*?background: var\(--workspace-bg\);/);
  assert.match(board, /\.ai-board-column-head \{[\s\S]*?border: 1px solid var\(--ai-board-column-border\);[\s\S]*?border-radius: 8px 8px 0 0;/);
  assert.match(board, /\.ai-board-column\[data-tone="waiting"\] \.ai-board-column-head \{[\s\S]*?border-top-color: var\(--ai-board-column-waiting-border\);[\s\S]*?border-right-color: var\(--ai-board-column-waiting-border\);[\s\S]*?border-left-color: var\(--ai-board-column-waiting-border\);/);
  assert.match(board, /background: linear-gradient\(var\(--ai-board-waiting-head-bg\), var\(--ai-board-waiting-head-bg\)\), var\(--ai-board-column-head-bg\);/);
  assert.match(board, /\.ai-board-column \{[\s\S]*?display: flex;[\s\S]*?flex-direction: column;/);
  assert.match(board, /\.ai-board-column-body-content \{[\s\S]*?position: relative;[\s\S]*?z-index: 1;[\s\S]*?flex: 1 0 auto;[\s\S]*?min-height: 0;[\s\S]*?border: solid var\(--ai-board-column-border\);[\s\S]*?border-width: 0 1px 1px;/);
});
