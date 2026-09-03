import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const panel = fs.readFileSync(new URL("../src/apps/control-plane/instance-detail/AiSessionPanel.vue", import.meta.url), "utf8");
const styles = fs.readFileSync(new URL("../src/apps/control-plane/instance-detail/AiSessionPanel.css", import.meta.url), "utf8");
const timeline = fs.readFileSync(new URL("../src/components/ai-session/AiSessionTimelineView.vue", import.meta.url), "utf8");
const queries = fs.readFileSync(new URL("../src/api/queries.ts", import.meta.url), "utf8");
const zhSessions = fs.readFileSync(new URL("../src/i18n/locales/zh-CN/sessions.ts", import.meta.url), "utf8");
const enSessions = fs.readFileSync(new URL("../src/i18n/locales/en-US/sessions.ts", import.meta.url), "utf8");

test("AI session history is an on-demand sidebar mode entered from the current-list footer", () => {
  const emptyIndex = panel.indexOf('t("sessions.panel.noConversations")');
  const entryIndex = panel.indexOf('t("sessions.panel.viewHistory")');
  assert.ok(emptyIndex >= 0 && entryIndex > emptyIndex);
  assert.match(panel, /<Button v-if="!historyMode" variant="ghost" class="session-ai-history-entry" @click="enterHistoryMode">/);
  assert.match(panel, /<History :size="15" \/>/);
  assert.match(panel, /async function enterHistoryMode\(\) \{[\s\S]*historyMode\.value = true;[\s\S]*await loadHistory\(\);/);
  assert.doesNotMatch(panel, /useQuery\([^)]*history/);
  assert.match(panel, /<ScrollArea class="session-ai-list" :class="\{ 'has-history-entry': !historyMode \}">/);
  assert.match(panel, /<aside ref="sidebarEl" class="session-ai-sidebar" :class="\{ 'has-history-entry': !historyMode \}">/);
  assert.match(styles, /\.session-ai-sidebar\s*\{[^}]*grid-template-rows: auto minmax\(0, 1fr\);/s);
  assert.match(styles, /\.session-ai-sidebar\s*\{[^}]*gap: 6px;/s);
  assert.match(styles, /\.session-ai-list\.has-history-entry \.session-ai-list-content\s*\{[^}]*padding-bottom: 36px;/s);
  assert.match(styles, /\.session-ai-sidebar\.has-history-entry::after\s*\{[^}]*height: 52px;[^}]*background: linear-gradient\(to bottom, transparent, var\(--workspace-bg\) 72%\);[^}]*pointer-events: none;/s);
  assert.match(styles, /:global\(\.session-ai-sidebar-sheet \.session-ai-sidebar\)\s*\{[^}]*--session-ai-list-left-inset: 12px;[^}]*--session-ai-list-bottom-inset: 12px;/s);
  assert.match(styles, /\.session-ai-history-entry\s*\{[^}]*position: absolute;[^}]*bottom: var\(--session-ai-list-bottom-inset\);[^}]*left: var\(--session-ai-list-left-inset\);[^}]*width: calc\(100% - var\(--session-ai-list-left-inset\) - var\(--session-ai-list-right-inset\)\);[^}]*height: 30px;[^}]*min-height: 30px;[^}]*padding: 0 6px;/s);
  assert.match(styles, /\.session-ai-history-entry:hover,[\s\S]*?\.session-ai-history-entry:focus-visible\s*\{[^}]*background: var\(--surface-hover\);/s);
  assert.doesNotMatch(styles, /\.session-ai-empty\.session-ai-filter-empty\s*\{[^}]*border:/s);
});

test("history mode preserves the current-list scroll position and renders all request states", () => {
  assert.match(panel, /const historyMode = ref\(Boolean\(props\.initialHistoryMode\)\);/);
  assert.match(panel, /currentListScrollTop = sidebarViewport\(\)\?\.scrollTop \|\| 0;/);
  assert.match(panel, /if \(viewport\) viewport\.scrollTop = currentListScrollTop;/);
  assert.match(panel, /historyLoading[\s\S]*historyError[\s\S]*t\("sessions\.panel\.noHistory"\)[\s\S]*v-for="group in displayedHistoryGroups"/);
  assert.match(panel, /historyItemTitle\(item\)/);
  assert.match(panel, /item\.cwd/);
  assert.match(panel, /relativeHistoryTime\(item\.lastActiveAt\)/);
});

test("history detail composer resumes, waits for authoritative state, and then sends", () => {
  assert.match(panel, /v-model="historyMessageDraft"/);
  assert.match(panel, /v-model:attachments="historyMessageAttachments"/);
  assert.match(panel, /@run="sendHistoryMessage"/);
  assert.match(panel, /if \(!item \|\| resumingHistoryId\.value/);
  assert.match(panel, /const result = await resumeAiSession\(props\.instance\.id, item\.id\);/);
  assert.match(panel, /session\.id === result\.aiSessionId/);
  assert.match(panel, /session\.providerSessionId === result\.providerSessionId/);
  assert.match(panel, /session\.creationSource === result\.creationSource/);
  assert.match(panel, /result\.appSessionId \? session\.appSessionId === result\.appSessionId : !session\.appSessionId/);
  assert.match(panel, /waitForAiSessionProjection\(findAuthoritativeSession\)/);
  assert.doesNotMatch(panel, /for \(let attempt = 0; attempt < 12/);
  assert.doesNotMatch(panel, /refetchQueries\(\{ queryKey: \["control-plane-ai-sessions"\] \}\)/);
  assert.match(panel, /await sendAiSessionMessage\([\s\S]*session\.id[\s\S]*aiSessionMessageText\(message\)[\s\S]*attachments/);
  assert.match(panel, /emit\("selectAiSession", props\.instance\.id, session\.id\);/);
  assert.match(panel, /showControlPlaneToast/);
  assert.doesNotMatch(panel, />继续对话</);
  assert.doesNotMatch(panel, /historyItems\.value\s*=\s*historyItems\.value\.filter/);
  assert.match(zhSessions, /continue: "继续对话", continueConversation:/);
  assert.match(enSessions, /continue: "Continue conversation", continueConversation:/);
});

test("history continue action shows immediate button loading state", () => {
  assert.match(panel, /class="session-ai-history-continue"[\s\S]*:disabled="resumingHistoryId === historyDetail\.item\.id"[\s\S]*:aria-busy="resumingHistoryId === historyDetail\.item\.id"/);
  assert.match(panel, /<LoaderCircle[\s\S]*v-if="resumingHistoryId === historyDetail\.item\.id"[\s\S]*class="session-ai-spin"[\s\S]*:size="14"/);
  assert.match(panel, /resumingHistoryId === historyDetail\.item\.id \? t\("sessions\.actions\.forking"\) : t\("sessions\.panel\.continue"\)/);
  assert.match(styles, /\.session-ai-detail-head-actions \.session-ai-history-continue\s*\{[^}]*gap: 6px;/s);
  assert.match(styles, /\.session-ai-detail-head-actions \.session-ai-history-continue:disabled\s*\{[^}]*cursor: wait;[^}]*opacity: 0\.72;/s);
});

test("history API clients send only instance and AI session identities", () => {
  assert.match(queries, /getAiSessionHistory\(instanceId: string\)[\s\S]*sharedAiSessionsApi\.history\(instanceId\)/);
  assert.match(queries, /getAiSessionHistoryDetail\(instanceId: string, aiSessionId: string\)[\s\S]*sharedAiSessionsApi\.historyDetail\(instanceId, aiSessionId\)/);
  assert.match(queries, /resumeAiSession\(instanceId: string, aiSessionId: string\)[\s\S]*sharedAiSessionsApi\.resume\(instanceId, aiSessionId\)/);
  assert.doesNotMatch(queries, /resumeAiSession\([^)]*providerSessionId/);
});

test("history reuses path grouping and opens stored turn details without resuming", () => {
  assert.match(panel, /t\("sessions\.panel\.groupByPath"\)/);
  assert.match(panel, /v-for="group in displayedHistoryGroups"/);
  assert.match(panel, /collapsedHistoryPathGroups\[group\.key\]/);
  assert.match(panel, /groupAiSessionHistoryByPath\(historyItems\.value\)/);
  assert.match(panel, /@click="selectHistoryItem\(item\)"/);
  assert.match(panel, /const detail = await getAiSessionHistoryDetail\(props\.instance\.id, item\.id\);/);
  assert.match(panel, /<AiSessionTimelineView[\s\S]*:stored-turns="historyDetail\.turns"/);
  assert.match(panel, /:stored-turns="historyDetail\.turns"/);
  assert.match(panel, /:stored-turns="historyDetail\.turns"[\s\S]*@sticky-user-message-change="timelineStickyUserMessage = \$event"/);
  assert.match(panel, /v-if="historyDetail && timelineStickyUserMessage"[\s\S]*class="session-ai-timeline-sticky-prompt"[\s\S]*timelineStickyUserMessage\.text/);
  assert.match(panel, /async function selectHistoryItem[\s\S]*timelineStickyUserMessage\.value = undefined;/);
  assert.match(panel, /async function leaveHistoryMode[\s\S]*timelineStickyUserMessage\.value = undefined;/);
  assert.match(panel, /v-else-if="historyDetail" class="session-ai-detail-content"[\s\S]*class="session-ai-detail-fixed-actions session-ai-detail-head-actions"[\s\S]*class="session-ai-history-continue"[\s\S]*@click="continueHistoryConversation"[\s\S]*sessions\.panel\.continue/);
  assert.match(panel, /async function continueHistoryConversation\(\) \{[\s\S]*resumeHistorySession\(item\)[\s\S]*emit\("selectAiSession", props\.instance\.id, session\.id\);[\s\S]*await leaveHistoryMode\(\);/);
  assert.doesNotMatch(panel, /session-ai-history-detail-head/);
  assert.match(timeline, /sourceTurns = computed\(\(\) => props\.session\?\.turns \|\| props\.storedTurns\)/);
  assert.match(timeline, /function loadVisibleTurnTimelines\(\)[\s\S]*if \(!props\.session \|\| !viewport \|\| !timeline\) return;/);
  assert.doesNotMatch(panel, /<small>你<\/small>/);
  assert.match(panel, /t\("sessions\.panel\.selectHistory"\)/);
  assert.doesNotMatch(panel, /selectHistoryItem[\s\S]{0,500}resumeAiSession/);
  assert.match(styles, /\.session-ai-history-row\[data-selected="true"\]/);
  assert.match(styles, /\.session-ai-history-row:hover\s*\{[^}]*background: var\(--ai-session-row-hover-bg, var\(--surface-hover\)\);/s);
  assert.match(styles, /\.session-ai-history-head\s*\{[^}]*grid-template-columns: 30px minmax\(0, 1fr\) 30px;/s);
  assert.match(styles, /\.session-ai-history-head \.session-ai-options-trigger\s*\{[^}]*justify-self: end;/s);
  assert.match(styles, /\.session-ai-detail-head-actions \.session-ai-history-continue\s*\{[^}]*width: auto;/s);
  assert.doesNotMatch(styles, /\.session-ai-history-message/);
});
