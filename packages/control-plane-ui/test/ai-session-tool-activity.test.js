import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const activity = fs.readFileSync(new URL("../src/components/ai-session/AiSessionToolActivity.vue", import.meta.url), "utf8");
const result = fs.readFileSync(new URL("../src/components/ai-session/AiSessionResult.vue", import.meta.url), "utf8");
const panel = fs.readFileSync(new URL("../src/apps/control-plane/instance-detail/AiSessionPanel.vue", import.meta.url), "utf8");
const panelCss = fs.readFileSync(new URL("../src/apps/control-plane/instance-detail/AiSessionPanel.css", import.meta.url), "utf8");
const card = fs.readFileSync(new URL("../src/apps/control-plane/ai-board/AiSessionCard.vue", import.meta.url), "utf8");
const floatingDock = fs.readFileSync(new URL("../src/apps/control-plane/ai-board/AiSessionFloatingDock.vue", import.meta.url), "utf8");
const sessions = fs.readFileSync(new URL("../src/apps/control-plane/useInstanceSessions.ts", import.meta.url), "utf8");
const types = fs.readFileSync(new URL("../src/api/types.ts", import.meta.url), "utf8");

test("tool activity uses the authoritative API projection", () => {
  assert.match(types, /export type AiSessionTool = \{[\s\S]*?id\?: string;[\s\S]*?kind\?: string;[\s\S]*?name: string;/);
  assert.match(types, /currentTool\?: AiSessionTool;\s*toolCallsSinceLastMessage: number;/);
  assert.match(activity, /props\.toolCallsSinceLastMessage/);
  assert.match(activity, /props\.currentTool\?\.name/);
  assert.match(activity, /props\.summary/);
  assert.doesNotMatch(activity, /watch\(\(\) => props/);
});

test("tool activity projects the current execution into one line", () => {
  assert.match(activity, /`\$\{props\.currentTool\.name\} · \$\{props\.currentTool\.inputPreview\}`/);
  assert.match(activity, /"Thinking\.\.\."/);
  assert.match(activity, /`Thinking\.\.\. · \$\{count\.value\} \$\{count\.value === 1 \? "tool" : "tools"\} completed`/);
  assert.match(activity, /"Waiting for approval\.\.\."/);
  assert.match(activity, /`Waiting for approval · \$\{props\.summary\}`/);
  assert.match(activity, /"Responding\.\.\."/);
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
    assert.match(source, /<AiSessionResult/);
    assert.match(source, /:busy=/);
    assert.match(source, /:can-interrupt=/);
    assert.match(source, /:can-resolve-approval=/);
    assert.match(source, /:instance-id=/);
    assert.match(source, /:is-latest=/);
    assert.match(source, /:response-content=/);
    assert.match(source, /:session=/);
    assert.match(source, /@steer-queued-message=/);
    assert.match(source, /@retry-queued-message=/);
    assert.match(source, /@remove-queued-message=/);
    assert.match(source, /@resolve-approval=/);
    assert.doesNotMatch(source, /<AiSessionSubAgents/);
  }
  assert.match(result, /<AiSessionStreamingMarkdown/);
  assert.match(result, /<AiSessionToolActivity[\s\S]*?:current-tool="session\.currentTool"[\s\S]*?:phase="session\.phase"[\s\S]*?:status="session\.status"[\s\S]*?:summary="session\.summary"[\s\S]*?:tool-calls-since-last-message="session\.toolCallsSinceLastMessage"[\s\S]*?:tone="tone"/);
  assert.match(result, /<AiSessionSubAgents/);
  assert.match(result, /v-for="item in session\.queue\.items"/);
  assert.match(result, /v-if="canResolveApproval"/);
  assert.match(result, /\$emit\('resolveApproval', 'allow'\)/);
  assert.match(floatingDock, /tone="board"/);
  assert.doesNotMatch(panel, /session-ai-card[\s\S]{0,180}toolCallsSinceLastMessage/);
});

test("context compaction results are rendered from the selected structured turn", () => {
  assert.match(sessions, /turn\.contextCompactions\?\.length/);
  assert.match(sessions, /turns\[index\]\?\.contextCompactions \|\| \[\]/);
  assert.match(result, /v-if="contextCompactions\.length"/);
  assert.match(result, /Context compacted/);
  assert.match(result, /Compacting context…/);
  for (const source of [panel, floatingDock]) {
    assert.match(source, /:context-compactions="displayAiSessionContextCompactions/);
  }
});

test("detail surfaces omit the legacy running response placeholder", () => {
  assert.match(sessions, /export function displayAiSessionResponse[\s\S]*?displayAiSessionContent\(session, promptIndex, false\)/);
  assert.match(result, /v-show="displayContent"/);
  assert.match(result, /const displayContent = computed\(\(\) => streamingContent\.value \|\| props\.responseContent\)/);
  assert.match(result, /props\.isLatest[\s\S]*?streamingMessages\.activeMessage\(props\.instanceId, props\.session\.id\)/);
  assert.match(panel, /:response-content="displayAiSessionResponse\(selectedSession, promptIndexFor\(selectedSession\)\)"/);
  assert.match(floatingDock, /:response-content="displayAiSessionResponse\(card\.session, promptIndex\)"/);
  assert.match(sessions, /includeProgress \? aiSessionProgressText\(session\) : ""/);
});

test("active tool activity sits directly below the assistant response", () => {
  assert.match(result, /'ai-session-detail-response-active': session\.status === 'running' \|\| session\.status === 'waiting'/);
  assert.match(result, /ai-session-detail-response \{[\s\S]*?background: transparent;/);
  assert.match(result, /ai-session-detail-response-active \{\s*padding-bottom: 4px;/);
  assert.match(result, /ai-session-result\.has-response \.ai-session-detail-response \+ :deep\(\.ai-session-tool-activity\) \{\s*margin-top: calc\(-1 \* var\(--detail-activity-gap\)\);/);
  assert.match(activity, /ai-session-tool-activity-board \{[\s\S]*?margin-top: -12px;/);
});

test("shared detail responses preserve the previous 14px typography", () => {
  assert.match(result, /--detail-response-line-height: 1\.55/);
  assert.match(result, /ai-session-result-board \{[\s\S]*?--detail-response-line-height: 1\.5/);
  assert.match(result, /ai-session-detail-response :deep\(> div\) \{[\s\S]*?font-size: 14px;[\s\S]*?line-height: var\(--detail-response-line-height\);/);
});

test("floating detail spacing below the prompt divider does not depend on response content", () => {
  assert.match(floatingDock, /ai-board-floating-content \{[\s\S]*?gap: 8px;/);
  assert.match(result, /ai-session-result-board \{[\s\S]*?--detail-activity-gap: 8px;[\s\S]*?padding-top: 4px;/);
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
  assert.match(panelCss, /session-ai-detail\.is-scrolled \.session-ai-detail-prompt-toggle \{\s*display: none;/);
});

test("floating user prompts collapse to three lines and become compact when sticky", () => {
  assert.match(floatingDock, /ref="promptContentEl"/);
  assert.match(floatingDock, /class="ai-board-floating-prompt-toggle"/);
  assert.match(floatingDock, /promptStickyPlaceholderHeight/);
  assert.match(floatingDock, /scrollTop > 24/);
  assert.match(floatingDock, /max-height: calc\(1\.55em \* 3\)/);
  assert.match(floatingDock, /\.ai-board-floating-block-user \{[\s\S]*?position: sticky;[\s\S]*?top: 0;/);
  assert.match(floatingDock, /ai-board-floating-detail\.is-scrolled \.ai-board-floating-block-user \{[\s\S]*?background: var\(--ai-board-column-head-bg\);/);
  assert.match(floatingDock, /ai-board-floating-detail\.is-scrolled \.ai-board-floating-prompt-content \{\s*max-height: 1\.55em;/);
  assert.match(floatingDock, /ai-board-floating-detail\.is-scrolled \.ai-board-floating-prompt-toggle \{\s*display: none;/);
});

test("running activity floats in the card without competing with approval or turn controls", () => {
  assert.match(panel, /v-if="!canResolveApproval\(session\)"[\s\S]*class="session-ai-card-activity"/);
  assert.match(panelCss, /\.session-ai-card-activity \{[\s\S]*right: 104px;[\s\S]*left: 14px;/);
  assert.match(card, /v-if="!canResolveApproval\(card\.session\)"[\s\S]*class="ai-board-card-activity"/);
  assert.match(card, /\.ai-board-card-activity \{[\s\S]*right: 96px;[\s\S]*left: 14px;/);
});

test("card footer gradients provide an opaque backdrop for floating controls", () => {
  assert.match(panelCss, /session-ai-preview-field-assistant::after \{[\s\S]*?height: 34px;[\s\S]*?84%[\s\S]*?58%/);
  assert.match(panelCss, /session-ai-row\[data-state="running"\][\s\S]*?height: 52px;[\s\S]*?var\(--surface-inset\) 70%/);
  assert.match(card, /ai-board-preview-field-assistant::after \{[\s\S]*?height: 34px;[\s\S]*?84%[\s\S]*?58%/);
  assert.match(card, /ai-board-card\[data-state="running"\][\s\S]*?height: 52px;[\s\S]*?var\(--ai-board-assistant-bg\) 70%/);
});
