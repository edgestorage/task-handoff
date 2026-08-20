import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const activity = fs.readFileSync(new URL("../src/components/ai-session/AiSessionToolActivity.vue", import.meta.url), "utf8");
const result = fs.readFileSync(new URL("../src/components/ai-session/AiSessionResult.vue", import.meta.url), "utf8");
const panel = fs.readFileSync(new URL("../src/apps/control-plane/instance-detail/AiSessionPanel.vue", import.meta.url), "utf8");
const panelCss = fs.readFileSync(new URL("../src/apps/control-plane/instance-detail/AiSessionPanel.css", import.meta.url), "utf8");
const card = fs.readFileSync(new URL("../src/apps/control-plane/ai-board/AiSessionCard.vue", import.meta.url), "utf8");
const floatingDock = fs.readFileSync(new URL("../src/apps/control-plane/ai-board/AiSessionFloatingDock.vue", import.meta.url), "utf8");
const conversation = fs.readFileSync(new URL("../src/components/ai-session/AiSessionConversationContent.vue", import.meta.url), "utf8");
const sessions = fs.readFileSync(new URL("../src/apps/control-plane/useInstanceSessions.ts", import.meta.url), "utf8");
const types = fs.readFileSync(new URL("../src/api/types.ts", import.meta.url), "utf8");

test("tool activity uses the authoritative API projection", () => {
  assert.match(types, /AiSessionTool as ProtocolAiSessionTool/);
  assert.match(types, /export type AiSessionTool = ProtocolAiSessionTool/);
  assert.match(types, /export type AiSessionSummary = SharedControlPlaneAiSessionSummary/);
  assert.match(activity, /props\.toolCallsSinceLastMessage/);
  assert.match(activity, /props\.currentTool\?\.name/);
  assert.match(activity, /props\.summary/);
  assert.doesNotMatch(activity, /watch\(\(\) => props/);
});

test("expanded tool activity consumes live items without triggering timeline reloads", () => {
  const activity = fs.readFileSync(new URL("../src/components/ai-session/AiSessionToolActivity.vue", import.meta.url), "utf8");
  assert.doesNotMatch(activity, /requestExpand|activityRevision|defineEmits/);
  assert.match(activity, /function toggleExpanded\(\) \{[\s\S]*expanded\.value = !expanded\.value;/);
});

test("background Timeline loading affects history without hiding authoritative live activity", () => {
  assert.match(conversation, /:activity-history-status="selectedTurnState\.status"/);
  assert.match(conversation, /:activity-history-error="selectedTurnState\.error"/);
  assert.doesNotMatch(conversation, /:activity-loading="selectedTurnState/);
});

test("tool activity projects the current execution into one line", () => {
  assert.match(activity, /`\$\{props\.currentTool\.name\} · \$\{props\.currentTool\.inputPreview\}`/);
  assert.match(activity, /t\("sessions\.activity\.thinking"\)/);
  assert.match(activity, /t\("sessions\.activity\.thinkingTools", \{ count: count\.value \}\)/);
  assert.match(activity, /t\("sessions\.activity\.waitingApproval"\)/);
  assert.match(activity, /`\$\{t\("sessions\.status\.waitingApproval"\)\} · \$\{props\.summary\}`/);
  assert.match(activity, /t\("sessions\.activity\.responding"\)/);
  assert.match(activity, /props\.phase === "responding"[\s\S]*?count\.value > 0[\s\S]*?t\("sessions\.activity\.respondingTools", \{ count: count\.value \}\)/);
  assert.match(activity, /\.ai-session-tool-activity-trigger \{[\s\S]*?font-weight: 400;[\s\S]*?line-height: 1\.45;/);
  assert.match(activity, /\.ai-session-tool-activity-trigger > span \{ font-weight: 400; \}/);
  assert.match(activity, /text-overflow: ellipsis/);
  assert.match(activity, /white-space: nowrap/);
  assert.match(activity, /ai-session-tool-activity-detail \{[\s\S]*?font-size: 14px/);
  assert.match(activity, /ai-session-tool-activity-board \{[\s\S]*?font-size: 14px/);
  assert.match(card, /ai-board-question \{[\s\S]*?font-size: 14px/);
  assert.match(card, /ai-board-message \{[\s\S]*?font-size: 14px/);
  assert.match(floatingDock, /ai-board-floating-block > div \{[\s\S]*?font-size: 14px/);
  assert.match(panelCss, /session-ai-question \{[\s\S]*?font-size: 14px/);
  assert.match(panelCss, /session-ai-message \{[\s\S]*?font-size: 14px/);
});

test("tool activity follows the authoritative active lifecycle", () => {
  assert.match(activity, /const visible = computed\(\(\) => props\.status === "running" \|\| props\.status === "waiting"\)/);
  assert.match(activity, /<section[\s\S]*?v-if="visible"/);
});

test("turn-aware surfaces only attach current activity to the latest turn", () => {
  assert.match(result, /<AiSessionToolActivity\s+v-if="isLatest && active"/);
  assert.match(panel, /displayAiSessionMessage\(session, latestPromptIndex\(session\), t\)[\s\S]*<AiSessionToolActivity\s+v-if="!canResolveApproval\(session\)"/);
  assert.match(card, /<AiSessionToolActivity\s+v-if="promptIndex >= promptCount - 1 && !canResolveApproval\(card\.session\)"/);
});

test("running tool activity shimmers without adding a separator", () => {
  assert.match(activity, /'ai-session-tool-activity-running': status === 'running'/);
  assert.match(activity, /ref="activityTextEl"/);
  assert.match(activity, /ResizeObserver/);
  assert.match(activity, /watch\(activityTextEl,[\s\S]*?flush: "post"/);
  assert.match(activity, /:data-status-text="statusText"/);
  assert.match(activity, /width: fit-content/);
  assert.match(activity, /ai-session-tool-activity-running > span::after/);
  assert.match(activity, /mask-size: 72px 100%/);
  assert.match(activity, /const sweepSeconds = \(width \+ 144\) \/ 200/);
  assert.match(activity, /const totalSeconds = sweepSeconds \+ 1\.5/);
  assert.match(activity, /--tool-activity-sweep-stop/);
  assert.match(activity, /animation: tool-activity-shimmer var\(--tool-activity-duration, 2\.2s\) infinite/);
  assert.match(activity, /animation-timing-function: linear\(0, 1 var\(--tool-activity-sweep-stop, 50%\), 1\)/);
  assert.match(activity, /mask-position: calc\(100% \+ 72px\) 0/);
  assert.match(activity, /@keyframes tool-activity-shimmer/);
  assert.match(activity, /prefers-reduced-motion: reduce/);
  assert.doesNotMatch(activity, /border-(?:top|bottom):/);
});

test("both detail surfaces share the complete AI result while cards remain unchanged", () => {
  for (const source of [panel, floatingDock]) {
    assert.match(source, /<AiSessionConversationContent/);
    assert.match(source, /:busy=/);
    assert.match(source, /:can-interrupt=/);
    assert.match(source, /:can-resolve-approval=/);
    assert.match(source, /:instance-id=/);
    assert.match(source, /:session=/);
    assert.match(source, /@steer-queued-message=/);
    assert.match(source, /@retry-queued-message=/);
    assert.match(source, /@remove-queued-message=/);
    assert.match(source, /@resolve-approval=/);
    assert.doesNotMatch(source, /<AiSessionSubAgents/);
  }
  assert.match(conversation, /<AiSessionResult/);
  assert.match(conversation, /:is-latest=/);
  assert.match(conversation, /:response-content=/);
  assert.match(result, /<AiSessionStreamingMarkdown/);
  assert.match(result, /<AiSessionToolActivity[\s\S]*?:current-tool="session\.currentTool"[\s\S]*?:phase="session\.phase"[\s\S]*?:status="session\.status"[\s\S]*?:summary="session\.summary"[\s\S]*?:tool-calls-since-last-message="session\.toolCallsSinceLastMessage"[\s\S]*?:tone="tone"/);
  assert.match(result, /<AiSessionSubAgents/);
  assert.match(result, /v-for="item in displayedQueueItems"/);
  assert.match(result, /v-if="isLatest && canResolveApproval"/);
  assert.match(result, /\$emit\('resolveApproval', 'allow'\)/);
  assert.doesNotMatch(conversation, /tone="board"/);
  assert.doesNotMatch(panel, /session-ai-card[\s\S]{0,180}toolCallsSinceLastMessage/);
});

test("context compaction uses the transient activity lane instead of a persistent turn result", () => {
  assert.match(sessions, /turn\.contextCompactions\?\.length/);
  assert.doesNotMatch(result, /contextCompactions/);
  assert.doesNotMatch(result, /ai-session-context-compaction/);
  assert.match(result, /<AiSessionToolActivity/);
  for (const source of [panel, floatingDock]) {
    assert.doesNotMatch(source, /:context-compactions=/);
  }
});

test("detail surfaces omit the legacy running response placeholder", () => {
  assert.match(sessions, /export function displayAiSessionResponse[\s\S]*?displayAiSessionContent\(session, promptIndex, false, t\)/);
  assert.match(result, /v-if="displayContent"/);
  assert.doesNotMatch(result, /v-show="displayContent"/);
  assert.match(result, /const displayContent = computed\(\(\) => streamingContent\.value \|\| props\.responseContent\)/);
  assert.match(result, /props\.isLatest[\s\S]*?streamingMessages\.activeMessage\(props\.instanceId, props\.session\.id\)/);
  assert.match(conversation, /:response-content="displayAiSessionResponse\(session, promptIndex, t\)"/);
  assert.match(sessions, /includeProgress \? aiSessionProgressText\(session, t\) : ""/);
});

test("active tool activity sits directly below the latest assistant response", () => {
  assert.match(result, /<section[\s\S]*'ai-session-detail-response-active': active[\s\S]*<AiSessionToolActivity/);
  assert.match(result, /ai-session-detail-response \{[\s\S]*?background: transparent;/);
  assert.match(result, /\.ai-session-result-detail \.ai-session-result-content \{\s*gap: 0;/);
  assert.match(result, /\.ai-session-result \{[\s\S]*?align-content: start;/);
  assert.match(result, /\.ai-session-result-detail > \.ai-session-result-content > \* \{\s*margin-top: 0;/);
  assert.match(result, /\.ai-session-result-detail > \.ai-session-result-content > \* \+ \* \{\s*margin-top: var\(--detail-activity-gap\);/);
  assert.match(result, /\.ai-session-result-detail \.ai-session-detail-response \{[\s\S]*padding-bottom: 0;/);
  assert.match(result, /\.ai-session-result-detail \.ai-session-detail-response-active \{\s*padding-bottom: 0;/);
  assert.doesNotMatch(result, /\.ai-session-result-detail\.has-response[\s\S]*margin-top: calc\(-1/);
  assert.match(panelCss, /\.session-ai-detail-content > \.ai-session-result \{\s*margin-top: 16px;/);
  assert.match(activity, /ai-session-tool-activity-board \{[\s\S]*?margin-top: -12px;/);
});

test("detail content reserves the visible bottom gap outside the floating composer", () => {
  assert.match(panelCss, /\.session-ai-panel \{[\s\S]*--session-ai-scrollbar-outset: 6px;[\s\S]*padding: 12px calc\(12px - var\(--session-ai-scrollbar-outset\)\) 12px 12px;/);
  assert.match(panelCss, /\.session-ai-detail \{[\s\S]*--session-ai-compose-bottom: 10px;[\s\S]*--session-ai-content-bottom-gap: 36px;/);
  assert.match(panelCss, /\.session-ai-detail \{[\s\S]*--session-ai-detail-right-inset: calc\(10px \+ var\(--session-ai-scrollbar-outset, 0px\)\);/);
  assert.match(panelCss, /\.session-ai-detail-content \{[\s\S]*padding: 0 var\(--session-ai-detail-right-inset\) calc\([\s\S]*var\(--session-ai-compose-offset, 84px\)[\s\S]*\+ var\(--session-ai-compose-bottom\)[\s\S]*\+ var\(--session-ai-content-bottom-gap\)[\s\S]*\) 10px;/);
  assert.match(panelCss, /\.session-ai-compose \{[\s\S]*bottom: var\(--session-ai-compose-bottom\);/);
  assert.match(panelCss, /\.session-ai-follow-latest \{[\s\S]*bottom: calc\([\s\S]*var\(--session-ai-compose-offset, 84px\)[\s\S]*\+ var\(--session-ai-compose-bottom\)[\s\S]*\+ var\(--session-ai-content-bottom-gap\)[\s\S]*\);/);
});

test("shared detail responses preserve the previous 14px typography", () => {
  assert.match(result, /--detail-response-line-height: 1\.55/);
  assert.match(result, /ai-session-result-board \{[\s\S]*?--detail-response-line-height: 1\.5/);
  assert.match(result, /ai-session-detail-response :deep\(> div\) \{[\s\S]*?font-size: 14px;[\s\S]*?line-height: var\(--detail-response-line-height\);/);
});

test("floating detail spacing below the prompt divider does not depend on response content", () => {
  assert.match(floatingDock, /ai-board-floating-content \{[\s\S]*?gap: 0;/);
  assert.match(floatingDock, /ai-board-floating-block \+ \.ai-board-floating-conversation \{\s*margin-top: 16px;/);
  assert.match(conversation, /<AiSessionResult/);
  assert.doesNotMatch(floatingDock, /ai-board-floating-block-assistant/);
});

test("detail user prompts collapse to three lines with a local toggle", () => {
  assert.match(panel, /ref="promptContentEl"/);
  assert.match(panel, /promptHasOverflow/);
  assert.match(panel, /promptExpanded = !promptExpanded/);
  assert.match(panel, /if \(promptExpanded\.value\) return;/);
  assert.match(panel, /watch\(\(\) => `\$\{props\.instance\.id\}\\u0000\$\{selectedSession\.value\?\.id \|\| ""\}`/);
  assert.doesNotMatch(panel, /watch\(selectedSession, \(\) => \{\s*promptExpanded\.value = false/);
  assert.match(panelCss, /max-height: calc\(1\.55em \* 3\)/);
  assert.match(panelCss, /\.session-ai-detail-prompt-content \{[\s\S]*?font-size: 14px;[\s\S]*?line-height: 1\.55;/);
  assert.match(panelCss, /session-ai-detail-prompt-toggle/);
  assert.match(panel, /v-else-if="effectiveTimelineViewMode === 'compact' && detailScrolled"[\s\S]*class="session-ai-timeline-sticky-prompt"/);
  assert.doesNotMatch(panelCss, /session-ai-detail\.is-scrolled header/);
  assert.doesNotMatch(panel, /session-ai-detail-head-placeholder|detailHeaderPlaceholderHeight/);
});

test("floating user prompts collapse to three lines and become compact when sticky", () => {
  assert.match(floatingDock, /ref="promptContentEl"/);
  assert.match(floatingDock, /class="ai-board-floating-prompt-toggle"/);
  assert.match(floatingDock, /promptStickyPlaceholderHeight/);
  assert.match(floatingDock, /\.ai-board-floating-scroll \[data-task-handoff-scroll-viewport\]/);
  assert.doesNotMatch(floatingDock, /data-reka-scroll-area-viewport/);
  assert.match(floatingDock, /viewport\.addEventListener\("scroll", handleDetailScroll, \{ passive: true \}\);\s*handleDetailScroll\(\);/);
  assert.match(floatingDock, /expandedDividerOffset - stickyHeight/);
  assert.match(floatingDock, /scrollTop > promptStickyThreshold/);
  assert.match(floatingDock, /scrollTop <= promptStickyThreshold/);
  assert.match(floatingDock, /max-height: calc\(1\.55em \* 3\)/);
  assert.match(floatingDock, /\.ai-board-floating-block-user \{\s*position: relative;/);
  assert.match(floatingDock, /ai-board-floating-detail\.is-scrolled \.ai-board-floating-block-user \{[\s\S]*?position: sticky;[\s\S]*?top: 0;/);
  assert.match(floatingDock, /ai-board-floating-detail\.is-scrolled \.ai-board-floating-block-user \{[\s\S]*?background: var\(--ai-board-column-head-bg\);/);
  assert.match(floatingDock, /ai-board-floating-detail\.is-scrolled \.ai-board-floating-prompt-content \{\s*max-height: 1\.55em;/);
  assert.match(floatingDock, /ai-board-floating-detail\.is-scrolled \.ai-board-floating-prompt-toggle \{\s*display: none;/);
});

test("detail sticky thresholds follow the complete user prompt height", () => {
  assert.doesNotMatch(floatingDock, /scrollTop > 24|scrollTop <= 24/);
  assert.doesNotMatch(panel, /scrollTop > 64|scrollTop <= 64/);
  assert.match(panel, /ref="detailPromptSectionEl"/);
  assert.match(panelCss, /--session-ai-sticky-prompt-height: 26px/);
  assert.match(panel, /expandedDividerOffset - stickyHeaderHeight/);
  assert.match(panel, /scrollTop > detailStickyThreshold/);
  assert.match(panel, /scrollTop <= detailStickyThreshold/);
  assert.doesNotMatch(panel, /detailScrollViewport\.scrollTop = previousScrollTop/);
});

test("all detail disclosures use one layout-change guard without scroll restoration", () => {
  assert.match(panel, /createUserLayoutChangeGuard/);
  assert.match(panel, /target\.closest<HTMLElement>\("summary, button\[aria-expanded\]"\)/);
  assert.match(panel, /scrollFollow\?\.stopFollowing\(\)[\s\S]*detailLayoutAnchor\.cancel\(\)[\s\S]*userDetailLayoutGuard\.begin\(\)/);
  assert.match(panel, /addEventListener\("click", handleDetailExpansionClick, true\)/);
  assert.match(panel, /if \(!userDetailLayoutGuard\.isActive\(\)\) scrollFollow\?\.notifyContentResize\(\)/);
  assert.match(panelCss, /\.session-ai-detail\.is-user-layout-changing \.session-ai-detail-content[\s\S]*overflow-anchor: none !important;/);
});

test("running activity fills the list card footer without competing with approval actions", () => {
  assert.match(panel, /v-if="!canResolveApproval\(session\)"[\s\S]*class="session-ai-card-activity"/);
  assert.match(panelCss, /\.session-ai-card-activity \{[\s\S]*right: 14px;[\s\S]*left: 14px;/);
  assert.match(card, /v-if="promptIndex >= promptCount - 1 && !canResolveApproval\(card\.session\)"[\s\S]*class="ai-board-card-activity"/);
  assert.match(card, /\.ai-board-card-activity \{[\s\S]*right: 96px;[\s\S]*left: 14px;/);
});

test("card footer gradients provide an opaque backdrop for floating controls", () => {
  assert.match(panelCss, /session-ai-select::after \{[\s\S]*?height: 34px;[\s\S]*?84%[\s\S]*?58%/);
  assert.match(panelCss, /session-ai-row\[data-state="running"\][\s\S]*?height: 52px;[\s\S]*?var\(--ai-session-card-content-bg\) 70%/);
  assert.match(card, /ai-board-content::after \{[\s\S]*?height: 34px;[\s\S]*?84%[\s\S]*?58%/);
  assert.match(card, /ai-board-card\[data-state="running"\][\s\S]*?height: 52px;[\s\S]*?var\(--ai-session-card-content-bg\) 70%/);
  assert.doesNotMatch(panelCss, /session-ai-preview-field-assistant::after/);
  assert.doesNotMatch(card, /ai-board-preview-field-assistant::after/);
  assert.match(panelCss, /session-ai-message::after \{[\s\S]*?height: 34px;/);
  assert.match(panelCss, /session-ai-row\[data-state="running"\] \.session-ai-message::after \{\s*height: 52px;/);
  assert.match(card, /ai-board-message::after \{[\s\S]*?height: 34px;/);
  assert.match(card, /ai-board-card\[data-state="running"\] \.ai-board-message::after \{\s*height: 52px;/);
});
