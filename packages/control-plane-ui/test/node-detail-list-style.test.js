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

  // Directory header: 38px bar, full-bleed divider, strong 13px title.
  assert.match(panel, /\.section-head\s*\{[^}]*min-height:\s*38px;[^}]*border-bottom:\s*1px solid var\(--line\);[^}]*padding:\s*0 12px;/s);
  assert.match(panel, /\.section-head > span\s*\{[^}]*color:\s*var\(--text-strong\);[^}]*font-size:\s*var\(--node-detail-section-title-size\);[^}]*font-weight:\s*500;/s);

  // Rows: full-bleed separators with 12px horizontal padding and no extra gaps.
  assert.match(panel, /\.node-resource-row\s*\{[^}]*gap:\s*16px;[^}]*padding:\s*10px 12px;/s);
  assert.match(panel, /\.node-resource-row \+ \.node-resource-row\s*\{\s*border-top:\s*1px solid var\(--line\);\s*\}/);
  assert.match(panel, /\.settings-scroll-content\s*\{[^}]*gap:\s*0;/s);
  assert.doesNotMatch(panel, /\n\.node-resource-list\s*\{[^}]*border-top/s);

  // Non-list section content keeps a single padded body wrapper.
  assert.match(panel, /\.node-detail-section-body\s*\{[^}]*display:\s*grid;[^}]*gap:\s*10px;[^}]*padding:\s*12px;/s);
});
