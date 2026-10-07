import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");

test("node detail tabs reuse the shared settings directory list pattern", () => {
  const panel = read("src/apps/control-plane/settings/NodeDetailPanel.vue");

  // Section cards own the border and keep the header flush with the card edge.
  assert.match(panel, /\.node-detail-section,\s*\n\.node-remote-panel\s*\{[^}]*overflow:\s*hidden;[^}]*padding:\s*0;/s);

  // Directory header: full-bleed divider, strong 13px title. Text-only headers
  // keep the shared 38px bar; only headers that carry a button or select add
  // 8px vertical padding so the control clears the divider on both sides.
  assert.match(panel, /\.section-head\s*\{[^}]*min-height:\s*38px;[^}]*border-bottom:\s*1px solid var\(--line\);[^}]*padding:\s*0 12px;/s);
  assert.match(panel, /\.section-head\.has-actions\s*\{\s*padding:\s*8px 12px;\s*\}/);
  assert.match(panel, /\.section-head > span\s*\{[^}]*color:\s*var\(--text-strong\);[^}]*font-size:\s*var\(--node-detail-section-title-size\);[^}]*font-weight:\s*500;/s);

  // The taller bar is opt-in per header, not a blanket height on every card.
  assert.equal((panel.match(/class="section-head has-actions"/g) || []).length, 6);
  assert.equal((panel.match(/class="section-head"/g) || []).length, 7);
  for (const headingKey of ["managedUpdates", "updateJobs", "localFolderCount", "dockerImages", "pairedKeys", "activeConnections"]) {
    assert.match(
      panel,
      new RegExp(`class="section-head has-actions">\\s*<span>\\{\\{ t\\("settings\\.nodeDetail\\.${headingKey}"`),
      `expected has-actions on the ${headingKey} header`,
    );
  }

  // Updates renders with the same cards as every other tab instead of a
  // bespoke group rail, and keeps its explanatory copy in a shared note row.
  assert.doesNotMatch(panel, /managed-update-group/);
  assert.match(panel, /\.section-note\s*\{[^}]*padding:\s*9px 12px 10px;/s);

  // Rows: full-bleed separators with 12px horizontal padding and no extra gaps.
  assert.match(panel, /\.node-resource-row\s*\{[^}]*gap:\s*16px;[^}]*padding:\s*10px 12px;/s);
  assert.match(panel, /\.node-resource-row \+ \.node-resource-row\s*\{\s*border-top:\s*1px solid var\(--line\);\s*\}/);
  assert.doesNotMatch(panel, /\n\.node-resource-list\s*\{[^}]*border-top/s);

  // Lists scroll with the single outer ScrollArea instead of nesting their own.
  assert.equal((panel.match(/<ScrollArea/g) || []).length, 1);
  assert.doesNotMatch(panel, /compact-list|settings-scroll-content/);

  // Non-list section content keeps a single padded body wrapper.
  assert.match(panel, /\.node-detail-section-body\s*\{[^}]*display:\s*grid;[^}]*gap:\s*10px;[^}]*padding:\s*12px;/s);
});
