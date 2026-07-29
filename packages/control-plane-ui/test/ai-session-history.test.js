import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const panel = fs.readFileSync(new URL("../src/apps/control-plane/instance-detail/AiSessionPanel.vue", import.meta.url), "utf8");
const styles = fs.readFileSync(new URL("../src/apps/control-plane/instance-detail/AiSessionPanel.css", import.meta.url), "utf8");
const queries = fs.readFileSync(new URL("../src/api/queries.ts", import.meta.url), "utf8");

test("AI session history is an on-demand sidebar mode entered from the current-list footer", () => {
  const emptyIndex = panel.indexOf('t("sessions.panel.noConversations")');
  const entryIndex = panel.indexOf('t("sessions.panel.viewHistory")');
  assert.ok(emptyIndex >= 0 && entryIndex > emptyIndex);
  assert.match(panel, /<Button v-if="!historyMode" variant="ghost" class="session-ai-history-entry" @click="enterHistoryMode">/);
  assert.match(panel, /<History :size="15" \/>/);
  assert.match(panel, /async function enterHistoryMode\(\) \{[\s\S]*historyMode\.value = true;[\s\S]*await loadHistory\(\);/);
  assert.doesNotMatch(panel, /useQuery\([^)]*history/);
  assert.match(styles, /\.session-ai-sidebar\s*\{[^}]*grid-template-rows: auto minmax\(0, 1fr\) auto;/s);
  assert.doesNotMatch(styles, /\.session-ai-empty\.session-ai-filter-empty\s*\{[^}]*border:/s);
});

test("history mode preserves the current-list scroll position and renders all request states", () => {
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
  assert.match(panel, /session\.id === result\.aiSessionId && session\.appSessionId === result\.appSessionId/);
  assert.match(panel, /for \(let attempt = 0; attempt < 12 && !session; attempt \+= 1\)/);
  assert.match(panel, /refetchQueries\(\{ queryKey: \["control-plane-ai-sessions"\] \}\)/);
  assert.match(panel, /await sendAiSessionMessage\([\s\S]*session\.id[\s\S]*aiSessionMessageText\(message\)[\s\S]*attachments/);
  assert.match(panel, /emit\("selectAiSession", props\.instance\.id, session\.id\);/);
  assert.match(panel, /showControlPlaneToast/);
  assert.doesNotMatch(panel, />继续对话</);
  assert.doesNotMatch(panel, /historyItems\.value\s*=\s*historyItems\.value\.filter/);
});

test("history API clients send only instance and AI session identities", () => {
  assert.match(queries, /getAiSessionHistory\(instanceId: string\)[\s\S]*controlled-instances\/\$\{encodeURIComponent\(instanceId\)\}\/ai-sessions\/history/);
  assert.match(queries, /getAiSessionHistoryDetail\(instanceId: string, aiSessionId: string\)[\s\S]*ai-sessions\/history\/\$\{encodeURIComponent\(aiSessionId\)\}/);
  assert.match(queries, /resumeAiSession\(instanceId: string, aiSessionId: string\)[\s\S]*postApiData<AiSessionResumeResult>[\s\S]*\/resume`, \{\}\)/);
  assert.doesNotMatch(queries, /resumeAiSession\([^)]*providerSessionId/);
});

test("history reuses path grouping and opens stored turn details without resuming", () => {
  assert.match(panel, /t\("sessions\.panel\.groupByPath"\)/);
  assert.match(panel, /v-for="group in displayedHistoryGroups"/);
  assert.match(panel, /collapsedHistoryPathGroups\[group\.key\]/);
  assert.match(panel, /groupAiSessionHistoryByPath\(historyItems\.value\)/);
  assert.match(panel, /@click="selectHistoryItem\(item\)"/);
  assert.match(panel, /const detail = await getAiSessionHistoryDetail\(props\.instance\.id, item\.id\);/);
  assert.match(panel, /v-for="turn in historyDetail\.turns"/);
  assert.match(panel, /turn\.userPrompt/);
  assert.match(panel, /turn\.lastMessage \|\| turn\.summary/);
  assert.doesNotMatch(panel, /<small>你<\/small>/);
  assert.match(panel, /t\("sessions\.panel\.selectHistory"\)/);
  assert.doesNotMatch(panel, /selectHistoryItem[\s\S]{0,500}resumeAiSession/);
  assert.match(styles, /\.session-ai-history-row\[data-selected="true"\]/);
  assert.match(styles, /\.session-ai-history-row:hover\s*\{[^}]*background: var\(--surface-hover\);/s);
  assert.match(styles, /\.session-ai-history-head\s*\{[^}]*grid-template-columns: 30px minmax\(0, 1fr\) 30px;/s);
  assert.match(styles, /\.session-ai-history-head \.session-ai-options-trigger\s*\{[^}]*justify-self: end;/s);
  assert.match(styles, /\.session-ai-history-detail-content/);
  assert.match(styles, /\.session-ai-history-message\s*\{[^}]*font-size: 14px;/s);
});
