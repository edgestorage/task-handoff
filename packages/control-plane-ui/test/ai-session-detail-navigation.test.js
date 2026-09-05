import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const navigator = fs.readFileSync(new URL("../src/components/ai-session/AiSessionTurnNavigator.vue", import.meta.url), "utf8");
const panel = fs.readFileSync(new URL("../src/apps/control-plane/instance-detail/AiSessionPanel.vue", import.meta.url), "utf8");
const panelCss = fs.readFileSync(new URL("../src/apps/control-plane/instance-detail/AiSessionPanel.css", import.meta.url), "utf8");
const floatingDock = fs.readFileSync(new URL("../src/apps/control-plane/ai-board/AiSessionFloatingDock.vue", import.meta.url), "utf8");
const compactPrompt = fs.readFileSync(new URL("../src/components/ai-session/AiSessionCompactPrompt.vue", import.meta.url), "utf8");
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

test("turn navigation belongs to the detail bottom overlay instead of the composer or header", () => {
  const detailActions = panel.indexOf('ref="detailActionsEl"');
  const panelNavigator = panel.indexOf('class="session-ai-detail-turn-navigator"');
  assert.ok(detailActions >= 0);
  assert.ok(panelNavigator > detailActions);
  assert.match(panelCss, /\.session-ai-detail-turn-navigator \{[\s\S]*?position: absolute;[\s\S]*?bottom: calc\([\s\S]*?var\(--session-ai-compose-offset, 84px\)[\s\S]*?var\(--session-ai-compose-bottom\)[\s\S]*?\+ 16px/);
  assert.match(floatingDock, /class="ai-board-floating-detail"[\s\S]*?has-turn-navigator[\s\S]*?class="ai-board-floating-turn-navigator"/);
  assert.match(floatingDock, /\.ai-board-floating-turn-navigator \{[\s\S]*?position: absolute;[\s\S]*?bottom: 10px;/);
  assert.match(floatingDock, /\.ai-board-floating-detail\.has-turn-navigator \.ai-board-floating-content \{[\s\S]*?padding-bottom: 56px;/);
  assert.equal((floatingDock.match(/<AiSessionTurnNavigator/g) || []).length, 1);
});

test("non-latest turn navigation exposes a combined latest-turn action", () => {
  assert.match(navigator, /v-if="latestVisible"[\s\S]*class="ai-session-turn-navigator__latest"/);
  assert.match(navigator, /const latestText = computed\(\(\) => props\.latestLabel \|\| t\("sessions\.panel\.backLatestTurn"\)\)/);
  assert.match(navigator, /<SkipForward :size="13" \/>/);
  assert.match(navigator, /@click="\$emit\('latest'\)"/);
  assert.match(navigator, /\.ai-session-turn-navigator \{[\s\S]*?overflow: hidden;[\s\S]*?transform: translateX\(calc\(-50% \+ var\(--ai-session-turn-latest-offset, 0px\)\)\);/);
  assert.match(navigator, /\.ai-session-turn-navigator__controls \{[\s\S]*?display: inline-flex;/);
  assert.match(navigator, /button\.ai-session-turn-navigator__latest \{[\s\S]*?display: inline-flex;[\s\S]*?border-left: 1px solid var\(--line-subtle\);[\s\S]*?border-radius: 0;/);
  assert.match(navigator, /button\.ai-session-turn-navigator__latest \{[\s\S]*?background: var\(--brand-accent-soft\);[\s\S]*?color: var\(--brand-accent\);/);
  assert.match(navigator, /data-tone="board"\] button\.ai-session-turn-navigator__latest \{[\s\S]*?background: var\(--ai-board-turn-hover-bg\);[\s\S]*?color: var\(--ai-board-active-text, var\(--brand-accent\)\);/);
  assert.match(navigator, /latestWidth\.value \/ 2/);
  assert.match(navigator, /new ResizeObserver\(\(\) => \{\s*latestWidth\.value = latestEl\.value\?\.getBoundingClientRect\(\)\.width/);
  assert.doesNotMatch(navigator, /latestWidth\.value = entry\?\.contentRect\.width/);
  assert.match(panel, /:latest-label="t\('sessions\.panel\.backLatestTurn'\)"[\s\S]*?@latest="backToLatestPrompt\(selectedSession\)"/);
  assert.match(panel, /function backToLatestPrompt\(session: AiSessionSummary\) \{\s*void setPromptIndex\(session, latestPromptIndex\(session\)\);/);
  assert.match(floatingDock, /:latest-label="t\('sessions\.panel\.backLatestTurn'\)"[\s\S]*?@latest="\$emit\('latestPrompt'\)"/);
  assert.match(board, /@latest-prompt="backToLatestPrompt\(selectedCard\)"/);
  assert.match(board, /function backToLatestPrompt\(card: AiBoardCard\) \{\s*void setPromptIndex\(card, promptCount\(card\.session\) - 1\);/);
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
  assert.match(panel, /<AiSessionCompactPrompt[\s\S]*?:content="selectedSessionContentState === 'ready' \? displayAiSessionTitle/);
  assert.match(panel, /<AiSessionConversationContent/);
  assert.match(floatingDock, /<AiSessionCompactPrompt[\s\S]*?:content="detailState === 'ready' \? displayAiSessionTitle/);
  assert.match(floatingDock, /<AiSessionConversationContent/);
  assert.match(compactPrompt, /<MarkdownContent v-if="content" :content="content"/);
  assert.match(conversation, /<AiSessionResult[\s\S]*?:response-content="detailState === 'ready' \? compactResponseContent : ''"/);
  assert.match(conversation, /compactResponseContent = computed\(\(\) => displayAiSessionResponse/);
  for (const detail of [panel, floatingDock]) assert.doesNotMatch(detail, /message-section-title|response-section-title/);
});

test("AI session errors render as a semantic block outside assistant responses", () => {
  assert.match(conversation, /v-if="showSessionError" class="ai-session-conversation-error" role="alert"/);
  assert.match(conversation, /session\.error \|\| t\("sessions\.detail\.noErrorDetail"\)/);
  assert.match(conversation, /props\.session\.status === "failed"[\s\S]*?props\.mode === "full"[\s\S]*?props\.promptIndex >= props\.promptCount - 1/);
  assert.match(conversation, /\.ai-session-conversation-error \{[\s\S]*?background: var\(--status-danger-bg\);[\s\S]*?border: 1px solid var\(--status-danger-border\);/);
  assert.match(displayHelpers, /if \(session\.error\) \{\s*return includeProgress \? session\.error : "";/);
});

test("details count retained turns while cards consume bounded summary counts", () => {
  assert.match(panel, /const conversation = selectedConversationSession\.value\?\.id === session\.id[\s\S]*?conversation\.turns \? aiSessionTurns\(conversation\)\.length : conversation\.turnCount \?\? 0;/);
  assert.match(board, /return session\.turnCount \?\? aiSessionTurns\(session\)\.length;/);
  assert.match(displayHelpers, /const turns = aiSessionDisplayTurns\(session\);[\s\S]*?const turn = turns\[index\];[\s\S]*?const turnPrompt = turn\?\.userPrompt\?\.trim\(\);[\s\S]*?if \(turn\?\.contextCompactions\?\.length\) return "\/compact";[\s\S]*?return session\.userPrompt\?\.trim\(\) \|\| "";/);
});

test("compact Turn navigation loads the target body before committing selection", () => {
  assert.match(panel, /async function setPromptIndex[\s\S]*?await loadSelectedSessionTurn\(targetTurn\.id\)[\s\S]*?promptIndexes\.value =/);
  assert.match(board, /async function setPromptIndex[\s\S]*?await loadSelectedCardTurn\(targetTurn\.id\)[\s\S]*?promptIndexes\.value =/);
  assert.match(panel, /:content="selectedSessionContentState === 'ready' \? displayAiSessionTitle/);
  assert.match(floatingDock, /:content="detailState === 'ready' \? displayAiSessionTitle\(conversationSession, promptIndex, t\) : ''"/);
});

test("AI session prompt state exists before the timeline's immediate watcher", () => {
  const promptState = panel.indexOf("const promptIndexes = ref");
  const timelinePresentation = panel.indexOf("useAiSessionTimelinePresentation({");
  assert.ok(promptState >= 0);
  assert.ok(timelinePresentation >= 0);
  assert.ok(promptState < timelinePresentation);
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
