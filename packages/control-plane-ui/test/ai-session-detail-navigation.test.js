import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const navigator = fs.readFileSync(new URL("../src/components/ai-session/AiSessionTurnNavigator.vue", import.meta.url), "utf8");
const panel = fs.readFileSync(new URL("../src/apps/control-plane/instance-detail/AiSessionPanel.vue", import.meta.url), "utf8");
const floatingDock = fs.readFileSync(new URL("../src/apps/control-plane/ai-board/AiSessionFloatingDock.vue", import.meta.url), "utf8");
const board = fs.readFileSync(new URL("../src/apps/control-plane/ai-board/AiSessionBoardView.vue", import.meta.url), "utf8");
const conversation = fs.readFileSync(new URL("../src/components/ai-session/AiSessionConversationContent.vue", import.meta.url), "utf8");
const displayHelpers = fs.readFileSync(new URL("../src/apps/control-plane/useInstanceSessions.ts", import.meta.url), "utf8");
const repositoryEnvironment = fs.readFileSync(new URL("../src/apps/control-plane/instance-detail/RepositoryEnvironment.vue", import.meta.url), "utf8");

test("AI session details expose compact message navigation without a visible label", () => {
  assert.match(navigator, /<small>\{\{ index \+ 1 \}\} \/ \{\{ count \}\}<\/small>/);
  assert.doesNotMatch(navigator, />\s*Turn\b/i);
  assert.match(panel, /<AiSessionTurnNavigator[\s\S]*?:count="promptCount\(selectedSession\)"[\s\S]*?@previous="previousPrompt\(selectedSession\)"[\s\S]*?@next="nextPrompt\(selectedSession\)"/);
  assert.match(floatingDock, /<AiSessionTurnNavigator[\s\S]*?:count="promptCount"[\s\S]*?@previous="\$emit\('previousPrompt'\)"[\s\S]*?@next="\$emit\('nextPrompt'\)"/);
});

test("AI session turn navigation keeps accessible labels without redundant tooltips", () => {
  assert.match(navigator, /<button type="button" :aria-label="previousLabel \|\| t\('sessions\.actions\.previousMessage'/);
  assert.match(navigator, /<button type="button" :aria-label="nextLabel \|\| t\('sessions\.actions\.nextMessage'/);
  assert.doesNotMatch(navigator, /Tooltip/);
  assert.match(repositoryEnvironment, /<TooltipContent side="bottom"[^>]*>\{\{ t\("repository\.environment\.title"\) \}\}/);
});

test("all viewport sizes share one compact detail actions menu", () => {
  assert.doesNotMatch(panel, /compactDetailActions/);
  assert.match(panel, /compactAiSessionLayout = useMediaQuery\("\(max-width: 920px\)"\)/);
  assert.match(panel, /v-if="!compactAiSessionLayout"[\s\S]*?trigger-appearance="detail"[\s\S]*?sessions\.detail\.sessionDetails/);
  assert.match(panel, /<DropdownMenu :modal="false">[\s\S]*?<MoreHorizontal[\s\S]*?trigger-appearance="menu"/);
  assert.match(panel, /v-if="supportsAiSessionTimeline"[\s\S]*?<ToggleGroup[\s\S]*?class="session-ai-detail-actions-view-mode"[\s\S]*?:model-value="effectiveTimelineViewMode"[\s\S]*?value="compact"[\s\S]*?value="full"/);
  assert.match(panel, /<RepositoryEnvironment[\s\S]*?v-if="compactAiSessionLayout"[\s\S]*?trigger-appearance="menu"/);
  assert.match(panel, /@interact-outside="keepCompactActionsMenuOpenForRepository"/);
  assert.match(panel, /target\.closest\("\.repository-environment-popover"\)[\s\S]*?event\.preventDefault\(\)/);
  for (const action of ["openApp", "continueFromTurn", "closeSession"]) {
    assert.match(panel, new RegExp(`session-ai-detail-actions-menu-item[\\s\\S]*?sessions\\.actions\\.${action}`));
  }
});

test("AI session details render messages without redundant section titles", () => {
  assert.match(panel, /class="session-ai-detail-prompt-content"[\s\S]*?<MarkdownContent :content="displayAiSessionTitle/);
  assert.match(panel, /<AiSessionConversationContent/);
  assert.match(floatingDock, /class="ai-board-floating-prompt-content"[\s\S]*?<MarkdownContent :content="displayAiSessionTitle/);
  assert.match(floatingDock, /<AiSessionConversationContent/);
  assert.match(conversation, /<AiSessionResult[\s\S]*?:response-content="compactResponseContent"/);
  assert.match(conversation, /compactResponseContent = computed\(\(\) => displayAiSessionResponse/);
  for (const detail of [panel, floatingDock]) assert.doesNotMatch(detail, /message-section-title|response-section-title/);
});

test("cards and details count the same display turns", () => {
  assert.match(panel, /return aiSessionTurns\(session\)\.length;/);
  assert.match(board, /return aiSessionTurns\(session\)\.length;/);
  assert.match(displayHelpers, /const turns = aiSessionDisplayTurns\(session\);[\s\S]*?const turn = turns\[index\];[\s\S]*?const turnPrompt = turn\?\.userPrompt\?\.trim\(\);[\s\S]*?if \(turn\?\.contextCompactions\?\.length\) return "\/compact";[\s\S]*?return session\.userPrompt\?\.trim\(\) \|\| "-";/);
});

test("current approval summary remains visible while navigating messages", () => {
  const explicitSelection = displayHelpers.indexOf("if (turns.length && promptIndex !== undefined)");
  const currentApproval = displayHelpers.indexOf('if (session.status === "waiting" && session.phase === "approval"');
  assert.ok(currentApproval >= 0);
  assert.ok(explicitSelection > currentApproval);
});

test("waiting approval state is the only source for approval actions", () => {
  for (const detail of [panel, floatingDock]) {
    assert.doesNotMatch(detail, /actions\?\.approval/);
  }
});
