import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const panel = fs.readFileSync(new URL("../src/apps/control-plane/instance-detail/AiSessionPanel.vue", import.meta.url), "utf8");
const styles = fs.readFileSync(new URL("../src/apps/control-plane/instance-detail/AiSessionPanel.css", import.meta.url), "utf8");
const boardCard = fs.readFileSync(new URL("../src/apps/control-plane/ai-board/AiSessionCard.vue", import.meta.url), "utf8");
const sharedActionStyles = fs.readFileSync(new URL("../src/components/ai-session/AiSessionCardAction.css", import.meta.url), "utf8");

test("instance AI session cards match board card status and navigation behavior", () => {
  assert.doesNotMatch(panel, /<small>\{\{ aiSessionStatusLabel\(session\) \}\}<\/small>/);
  assert.match(panel, /:disabled="promptIndexFor\(session\) <= 0"/);
  assert.match(panel, /:disabled="promptIndexFor\(session\) >= promptCount\(session\) - 1"/);
  assert.match(panel, /index: Math\.min\(Math\.max\(index, 0\), count - 1\)/);
  assert.doesNotMatch(panel, /\(index \+ count\) % count/);
});

test("AI session path labels show only the folder and reveal the full path when hovered", () => {
  assert.match(panel, /v-if="!groupSessionsByPath" class="session-ai-card-workspace"/);
  assert.match(panel, /class="session-ai-card-workspace">\s*<span aria-hidden="true">·<\/span>/);
  assert.match(panel, /aiSessionBasename\(session\.cwd\)/);
  assert.match(panel, /<TooltipTrigger as-child>\s*<b>/);
  assert.match(panel, /<TooltipContent[^>]*>\{\{ session\.cwd \|\| "Unknown path" \}\}<\/TooltipContent>/);
  assert.match(panel, /<TooltipTrigger as-child>\s*<span class="session-ai-path-group-title">/);
  assert.match(styles, /\.session-ai-card-workspace b\s*\{[^}]*color: inherit;[^}]*font-weight: inherit;/s);
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

test("bound instance AI sessions expose the same close menu as board cards", () => {
  assert.match(panel, /<DropdownMenu v-if="aiSessionAppTab\(instance, session\)">[\s\S]*?More actions for \$\{session\.agent\}[\s\S]*?Close app session/);
  assert.match(panel, /await stopAppSession\(props\.instance\.id, appSessionId\);/);
  assert.match(panel, /const appSession = aiSessionAppTab\(props\.instance, session\);/);
  assert.match(panel, /stoppingAppSessionId === session\.id \? "Closing app session" : "Close app session"/);
  assert.match(styles, /:global\(\.session-ai-card-menu\)/);
  assert.match(styles, /:global\(\.session-ai-card-menu-item\.danger\)/);
});

test("instance and board cards share one action button style", () => {
  for (const source of [panel, boardCard]) {
    assert.match(source, /trigger-button ai-session-card-action/);
    assert.match(source, /open ai-session-card-action/);
    assert.match(source, /more ai-session-card-action/);
    assert.match(source, /<style scoped src="\.\.\/\.\.\/\.\.\/components\/ai-session\/AiSessionCardAction\.css"><\/style>/);
  }
  assert.match(sharedActionStyles, /border: 1px solid var\(--ai-board-floating-border\)/);
  assert.match(sharedActionStyles, /background: var\(--ai-board-floating-bg\)/);
  assert.match(sharedActionStyles, /border-color: var\(--ai-board-floating-hover-border\)/);
  assert.match(styles, /\.session-ai-trigger-button\[data-bound="true"\] \{\s*border-color: var\(--ai-board-active-border\);\s*color: var\(--ai-board-active-text\);/);
  assert.doesNotMatch(styles, /\.session-ai-open\s*\{/);
});

test("an unselected AI session defaults to the new-session surface", () => {
  assert.match(panel, /const showNewSession = computed\(\(\) => newSessionOpen\.value \|\| !selectedSession\.value\);/);
  assert.match(panel, /<section v-else-if="showNewSession" class="session-ai-detail session-ai-new-detail">/);
  assert.match(panel, /<h1 class="session-ai-new-title">Start with an idea<\/h1>/);
  assert.match(styles, /\.session-ai-new-start\s*\{[^}]*width: min\(760px, 100%\);[^}]*gap: 28px;/s);
  assert.match(styles, /\.session-ai-new-title\s*\{[^}]*text-align: center;/s);
  assert.match(panel, /watch\(\s*\[showNewSession, aiSessionLaunchableApps, newSessionFolders\]/);
  assert.doesNotMatch(panel, /No AI session selected\./);
});
