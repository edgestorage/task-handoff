import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const panel = fs.readFileSync(new URL("../src/apps/control-plane/instance-detail/AiSessionPanel.vue", import.meta.url), "utf8");
const styles = fs.readFileSync(new URL("../src/apps/control-plane/instance-detail/AiSessionPanel.css", import.meta.url), "utf8");
const queries = fs.readFileSync(new URL("../src/api/queries.ts", import.meta.url), "utf8");

test("AI session history is an on-demand sidebar mode entered from the current-list footer", () => {
  const emptyIndex = panel.indexOf("No conversations yet");
  const entryIndex = panel.indexOf("查看过往对话");
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
  assert.match(panel, /historyLoading[\s\S]*historyError[\s\S]*暂无过往对话[\s\S]*v-for="group in displayedHistoryGroups"/);
  assert.match(panel, /historyItemTitle\(item\)/);
  assert.match(panel, /item\.cwd/);
  assert.match(panel, /relativeHistoryTime\(item\.lastActiveAt\)/);
});

test("resume keeps one row busy, deduplicates clicks, and waits for authoritative session state", () => {
  assert.match(panel, /if \(resumingHistoryId\.value\) return;/);
  assert.match(panel, /resumingHistoryId === item\.id/);
  assert.match(panel, /const result = await resumeAiSession\(props\.instance\.id, item\.id\);/);
  assert.match(panel, /result\.disposition === "resumed"/);
  assert.match(panel, /session\.id === item\.id && session\.appSessionId === result\.appSessionId/);
  assert.match(panel, /for \(let attempt = 0; attempt < 12 && !authoritative; attempt \+= 1\)/);
  assert.match(panel, /refetchQueries\(\{ queryKey: \["control-plane-ai-sessions"\] \}\)/);
  assert.match(panel, /emit\("selectAiSession", props\.instance\.id, item\.id\);/);
  assert.match(panel, /showControlPlaneToast/);
  assert.doesNotMatch(panel, /historyItems\.value\s*=\s*historyItems\.value\.filter/);
});

test("history API clients send only instance and AI session identities", () => {
  assert.match(queries, /getAiSessionHistory\(instanceId: string\)[\s\S]*controlled-instances\/\$\{encodeURIComponent\(instanceId\)\}\/ai-sessions\/history/);
  assert.match(queries, /getAiSessionHistoryDetail\(instanceId: string, aiSessionId: string\)[\s\S]*ai-sessions\/history\/\$\{encodeURIComponent\(aiSessionId\)\}/);
  assert.match(queries, /resumeAiSession\(instanceId: string, aiSessionId: string\)[\s\S]*postApiData<AiSessionResumeResult>[\s\S]*\/resume`, \{\}\)/);
  assert.doesNotMatch(queries, /resumeAiSession\([^)]*providerSessionId/);
});

test("history reuses path grouping and opens stored turn details without resuming", () => {
  assert.match(panel, /Group by path/);
  assert.match(panel, /v-for="group in displayedHistoryGroups"/);
  assert.match(panel, /collapsedHistoryPathGroups\[group\.key\]/);
  assert.match(panel, /groupAiSessionHistoryByPath\(historyItems\.value\)/);
  assert.match(panel, /@click="selectHistoryItem\(item\)"/);
  assert.match(panel, /const detail = await getAiSessionHistoryDetail\(props\.instance\.id, item\.id\);/);
  assert.match(panel, /v-for="turn in historyDetail\.turns"/);
  assert.match(panel, /turn\.userPrompt/);
  assert.match(panel, /turn\.lastMessage \|\| turn\.summary/);
  assert.match(panel, /选择一条过往对话查看详情/);
  assert.doesNotMatch(panel, /selectHistoryItem[\s\S]{0,500}resumeAiSession/);
  assert.match(styles, /\.session-ai-history-row\[data-selected="true"\]/);
  assert.match(styles, /\.session-ai-history-row:hover\s*\{[^}]*background: var\(--surface-hover\);/s);
  assert.match(styles, /\.session-ai-history-head\s*\{[^}]*grid-template-columns: minmax\(0, 1fr\) auto minmax\(0, 1fr\);/s);
  assert.match(styles, /\.session-ai-history-head \.session-ai-options-trigger\s*\{[^}]*justify-self: end;/s);
  assert.match(styles, /\.session-ai-history-detail-content/);
});
