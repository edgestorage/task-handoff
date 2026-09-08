import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const conversation = fs.readFileSync(new URL("../src/components/ai-session/AiSessionConversationContent.vue", import.meta.url), "utf8");
const stickyContext = fs.readFileSync(new URL("../src/components/ai-session/AiSessionStickyContext.vue", import.meta.url), "utf8");
const panel = fs.readFileSync(new URL("../src/apps/control-plane/instance-detail/AiSessionPanel.vue", import.meta.url), "utf8");
const panelCss = fs.readFileSync(new URL("../src/apps/control-plane/instance-detail/AiSessionPanel.css", import.meta.url), "utf8");
const board = fs.readFileSync(new URL("../src/apps/control-plane/ai-board/AiSessionBoardView.vue", import.meta.url), "utf8");
const dock = fs.readFileSync(new URL("../src/apps/control-plane/ai-board/AiSessionFloatingDock.vue", import.meta.url), "utf8");
const projection = fs.readFileSync(new URL("../src/apps/control-plane/useAiSessionConversationProjection.ts", import.meta.url), "utf8");

test("AI Session detail does not render the list summary projection as conversation content", () => {
  assert.match(conversation, /class="ai-session-conversation-stage" :data-state="detailState"/);
  assert.match(conversation, /<Transition[\s\S]*?name="ai-session-message-fade"[\s\S]*?@before-enter="beginConversationTransition"[\s\S]*?@after-enter="finishConversationTransition"/);
  assert.doesNotMatch(conversation, /mode="out-in"/);
  assert.match(conversation, /\.ai-session-message-fade-enter-active,[\s\S]*?\.ai-session-message-fade-leave-active[\s\S]*?transition: opacity 180ms ease/);
  assert.match(conversation, /\.ai-session-message-fade-enter-from,[\s\S]*?\.ai-session-message-fade-leave-to[\s\S]*?opacity: 0/);
  assert.match(conversation, /v-if="mode === 'full'"/);
  assert.match(conversation, /detailState\?: AiSessionDetailState/);
  assert.match(conversation, /:key="`session:\$\{session\.id\}`" class="ai-session-conversation-layer"/);
  assert.doesNotMatch(conversation, /:key="[^\n]*detailState/);
  assert.doesNotMatch(conversation, /:key="[^\n]*(?:detailRevision|turnsRevision)/);
  assert.match(conversation, /class="ai-session-conversation-content-layer"/);
  assert.match(conversation, /:response-content="detailState === 'ready' \? compactResponseContent : ''"/);
  assert.match(conversation, /class="ai-session-conversation-detail-skeleton"/);
  assert.match(conversation, /ai-session-conversation-detail-reveal 120ms ease 250ms forwards/);
  assert.match(conversation, /prefers-reduced-motion: reduce/);
  assert.doesNotMatch(conversation, /translate(?:3d|X|Y)?\(/);
  assert.match(panel, /:detail-state="selectedSessionContentState"/);
  assert.match(panel, /@transitioning-change="setDetailConversationTransitioning"/);
  assert.match(panel, /detailScrollLayoutPending \|\| detailConversationTransitioning\.value/);
  assert.match(panel, /effectiveTimelineViewMode === 'compact' && detailScrolled && !detailConversationTransitioning/);
  const stickyRule = panelCss.match(/\.session-ai-timeline-sticky-prompt \{([^}]*)\}/);
  assert.ok(stickyRule);
  assert.doesNotMatch(stickyRule[1], /opacity:\s*0/);
  assert.match(panel, /<Transition name="session-ai-prompt-fade" appear>/);
  assert.match(panel, /v-if="selectedPromptSnapshot" :key="selectedPromptSnapshot\.sessionId" ref="detailPromptSectionEl"/);
  assert.match(panelCss, /\.session-ai-prompt-fade-enter-active,[\s\S]*?\.session-ai-prompt-fade-leave-active[\s\S]*?transition: opacity 180ms ease/);
  assert.match(board, /:detail-state="selectedCardContentState"/);
  assert.match(projection, /const hadRenderableContent = conversations\.hasRenderableProjection\(instanceId, summary\.id\)/);
  assert.match(projection, /if \(!hadRenderableContent\) state\.value = "loading"/);
  assert.match(projection, /if \(next\[1\] !== previous\[1\]\) void refresh\(\{ detail: true \}\)/);
  assert.match(projection, /if \(next\[2\] !== previous\[2\]\) void refresh\(\{ index: true \}\)/);
  assert.match(dock, /:detail-state="detailState"/);
  assert.match(projection, /summary\?\.detailRevision, summary\?\.turnsRevision, summary\?\.latestTurnRef\?\.id/);
  assert.match(projection, /hasRenderableTurn\(instanceId, summary\.id, turnId\)/);
  assert.match(projection, /streamingMessages\.applyAuthoritativeTurnBody\(instanceId, currentSummary\.id, read\.body\.turn\)/);
  assert.match(panel, /hasRenderableSelectedSessionTurn\(turn\.id\) \? "ready" : "loading"/);
  assert.match(board, /hasRenderableSelectedCardTurn\(turn\.id\) \? "ready" : "loading"/);
  for (const source of [panel, board]) assert.match(source, /useAiSessionConversationProjection/);
});

test("compact session switches start at the top while conversation mode follows the latest content", () => {
  assert.match(panel, /if \(effectiveTimelineViewMode\.value === "full"\) \{\s*scrollFollow\?\.jumpLatest\(\);\s*\} else \{\s*scrollFollow\?\.stopFollowing\(\);\s*viewport\.scrollTop = 0;\s*\}/);
  assert.match(panel, /v-if="detailCanScroll && !isFollowingLatest"/);
  assert.match(panel, /detailCanScroll\.value = Boolean\(viewport && viewport\.scrollHeight > viewport\.clientHeight \+ 1\)/);
});

test("sticky prompt context expands over the user message without changing its layout", () => {
  assert.equal(panel.match(/<AiSessionStickyContext/g)?.length, 2);
  assert.match(stickyContext, /<span class="ai-session-sticky-context-agent">[\s\S]*?<AiAgentIcon[\s\S]*?<span class="ai-session-sticky-context-details">/);
  assert.equal(stickyContext.match(/<TooltipTrigger as-child>/g)?.length, 2);
  assert.match(stickyContext, /<TooltipContent[^>]*>\{\{ folderPath \}\}<\/TooltipContent>/);
  assert.match(stickyContext, /<TooltipContent[^>]*>\{\{ nodeName \}\}<\/TooltipContent>/);
  assert.equal(panel.match(/:folder-path="selectedSessionFolderPath"/g)?.length, 2);
  assert.equal(panel.match(/:node-name="selectedSessionNodeName"/g)?.length, 2);
  assert.match(stickyContext, /\.ai-session-sticky-context \{[\s\S]*?position: absolute;[\s\S]*?width: max-content;/);
  assert.match(stickyContext, /left: var\(--ai-session-sticky-context-left, 0px\);/);
  assert.match(stickyContext, /\.ai-session-sticky-context-surface \{[\s\S]*?width: max-content;[\s\S]*?max-width: 18px;[\s\S]*?overflow: hidden;[\s\S]*?transition: max-width/);
  assert.match(stickyContext, /\.ai-session-sticky-context:hover \.ai-session-sticky-context-surface \{[\s\S]*?max-width: min\(620px,/);
  assert.match(stickyContext, /\.ai-session-sticky-context::after \{[\s\S]*?left: 100%;[\s\S]*?linear-gradient\(90deg, var\(--workspace-bg\) 0%, transparent 100%\)/);
  assert.match(panelCss, /\.session-ai-timeline-sticky-message \{[\s\S]*?margin-left: 24px;/);
  assert.match(panelCss, /@media \(max-width: 920px\) \{[\s\S]*?\.session-ai-timeline-sticky-prompt \{[\s\S]*?--ai-session-sticky-context-left: 24px;/);
  assert.doesNotMatch(stickyContext, /display: none/);
});

test("outgoing session layers do not control incoming conversation layout", () => {
  assert.match(panelCss, /\.session-ai-detail-prompt-stage \{[\s\S]*?position: relative;[\s\S]*?display: grid;/);
  assert.match(panelCss, /\.session-ai-detail-prompt-stage > \.session-ai-detail-block-user \{[\s\S]*?grid-area: 1 \/ 1;[\s\S]*?align-self: start;/);
  assert.match(panelCss, /\.session-ai-prompt-fade-leave-active \{[\s\S]*?position: absolute;[\s\S]*?inset: 0 0 auto;[\s\S]*?pointer-events: none;/);
  assert.match(conversation, /\.ai-session-conversation-stage \{[\s\S]*?position: relative;[\s\S]*?display: grid;/);
  assert.match(conversation, /\.ai-session-conversation-layer \{[\s\S]*?grid-area: 1 \/ 1;[\s\S]*?align-self: start;/);
  assert.match(conversation, /\.ai-session-message-fade-leave-active \{[\s\S]*?position: absolute;[\s\S]*?inset: 0 0 auto;[\s\S]*?pointer-events: none;/);
  assert.match(panel, /if \(!summary \|\| selectedSessionContentState\.value === "loading"\) return undefined;/);
  assert.match(panel, /watch\(selectedPromptCandidate, \(candidate\) => \{\s*if \(candidate\) selectedPromptSnapshot\.value = candidate;/);
  assert.match(panel, /:content="selectedPromptSnapshot\.content"/);
  assert.match(panel, /:user-messages="selectedPromptSnapshot\.userMessages"/);
  assert.doesNotMatch(panel, /:content="selectedSessionContentState === 'ready' \? displayAiSessionTitle/);
});

test("both AI Session detail surfaces expose failed detail recovery", () => {
  assert.match(conversation, /detailState !== 'error'/);
  assert.match(conversation, /sessions\.detail\.loadFailed/);
  assert.match(conversation, /\$emit\('retryDetail'\)/);
  assert.match(panel, /@retry-detail="loadSelectedSessionDetail"/);
  assert.match(board, /@retry-detail="loadSelectedCardSessionDetail"/);
  assert.match(projection, /state\.value = renderable \? "ready" : "error"/);
  assert.match(projection, /scheduleRetry\(\)/);
});
