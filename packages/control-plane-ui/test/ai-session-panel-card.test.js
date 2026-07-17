import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const panel = fs.readFileSync(new URL("../src/apps/control-plane/instance-detail/AiSessionPanel.vue", import.meta.url), "utf8");
const styles = fs.readFileSync(new URL("../src/apps/control-plane/instance-detail/AiSessionPanel.css", import.meta.url), "utf8");

test("instance AI session cards match board card status and navigation behavior", () => {
  assert.doesNotMatch(panel, /<small>\{\{ aiSessionStatusLabel\(session\) \}\}<\/small>/);
  assert.match(panel, /:disabled="promptIndexFor\(session\) <= 0"/);
  assert.match(panel, /:disabled="promptIndexFor\(session\) >= promptCount\(session\) - 1"/);
  assert.match(panel, /index: Math\.min\(Math\.max\(index, 0\), count - 1\)/);
  assert.doesNotMatch(panel, /\(index \+ count\) % count/);
});

test("instance AI session card user messages use a single unpadded line", () => {
  assert.match(styles, /\.session-ai-preview-field-user\s*\{[^}]*max-height: 18px;[^}]*padding-block: 0;/s);
  assert.match(styles, /\.session-ai-question\s*\{[^}]*-webkit-line-clamp: 1;/s);
  assert.doesNotMatch(styles, /\.session-ai-question\s*\{[^}]*font-weight:\s*800;/s);
  assert.match(styles, /\.session-ai-question :deep\(p\),\s*\.session-ai-message :deep\(p\)\s*\{\s*margin: 0;/s);
});

test("instance AI session cards replace the metadata footer with floating navigation", () => {
  assert.doesNotMatch(panel, /aiSessionContext/);
  assert.doesNotMatch(panel, /session-ai-card-meta/);
  assert.match(styles, /grid-template-rows: auto auto minmax\(0, 1fr\);/);
  assert.match(styles, /\.session-ai-select\s*\{[^}]*padding: 10px 14px 0;/s);
  assert.match(styles, /\.session-ai-preview-field-assistant\s*\{[^}]*padding: 10px 14px 0;/s);
  assert.match(styles, /\.session-ai-turn-nav\s*\{[^}]*position: absolute;[^}]*right: 10px;[^}]*bottom: 8px;/s);
});

test("waiting approval actions float at the bottom left of instance AI session cards", () => {
  assert.match(panel, /<div v-if="canResolveApproval\(session\)" class="session-ai-card-approval-actions">[\s\S]*?resolveApproval\(session, 'allow'\)/);
  assert.match(styles, /\.session-ai-card-approval-actions\s*\{[^}]*position: absolute;[^}]*bottom: 8px;[^}]*left: 14px;/s);
  assert.match(panel, /async function resolveApproval\(session: AiSessionSummary, decision:/);
  assert.match(panel, /session\.status === "waiting" && session\.phase === "approval"/);
  assert.doesNotMatch(panel, /actions\?\.approval/);
});

test("instance AI session card previews do not open an expanded overlay", () => {
  assert.doesNotMatch(panel, /expandedPreview|data-ai-preview-trigger|expandPrompt|expandMessage|展开用户消息|展开 AI 进展/);
  assert.doesNotMatch(styles, /session-ai-expanded|cursor: zoom-in/);
});
