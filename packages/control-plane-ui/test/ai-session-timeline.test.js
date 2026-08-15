import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { compactTimelineForTurn, conversationTimelineTurns, groupTimelineTurns } from "../src/components/ai-session/timelineActivities.ts";
import { useAiSessionTimelineStore } from "../src/apps/control-plane/useAiSessionTimelineStore.ts";

const panelUrl = new URL("../src/apps/control-plane/instance-detail/AiSessionPanel.vue", import.meta.url);

test("live Timeline store replaces item lifecycle updates in place", () => {
  const store = useAiSessionTimelineStore();
  store.recoverConnection();
  const base = {
    instanceId: "instance-live",
    sessionId: "session-live",
    providerSessionId: "thread-live",
    generatedAt: "2026-08-15T00:00:00.000Z",
  };
  store.apply({ ...base, item: { id: "cmd-live", turnId: "turn-live", type: "activity", activityKind: "commandExecution", title: "Command", status: "running" } });
  store.apply({ ...base, generatedAt: "2026-08-15T00:00:01.000Z", item: { id: "cmd-live", turnId: "turn-live", type: "activity", activityKind: "commandExecution", title: "Command", status: "completed", output: "passed" } });
  assert.deepEqual(store.items("instance-live", "session-live"), [{
    id: "cmd-live",
    turnId: "turn-live",
    type: "activity",
    activityKind: "commandExecution",
    title: "Command",
    status: "completed",
    output: "passed",
  }]);
});

test("AI session Timeline is detail-only and loaded for both turn display modes", () => {
  const panel = fs.readFileSync(panelUrl, "utf8");
  const result = fs.readFileSync(new URL("../src/components/ai-session/AiSessionResult.vue", import.meta.url), "utf8");
  const board = fs.readFileSync(new URL("../src/apps/control-plane/ai-board/AiSessionCard.vue", import.meta.url), "utf8");
  assert.match(panel, /effectiveTimelineViewMode === 'full'[\s\S]*loadTimeline/);
  assert.match(panel, /session-ai-timeline-mode/);
  const panelStyles = fs.readFileSync(new URL("../src/apps/control-plane/instance-detail/AiSessionPanel.css", import.meta.url), "utf8");
  assert.match(panelStyles, /\.session-ai-detail-head-actions \.session-ai-timeline-mode \{[\s\S]*height: 26px;[\s\S]*gap: 0;[\s\S]*border: 1px solid var\(--line-subtle\);[\s\S]*background: var\(--surface-inset\);[\s\S]*padding: 2px;/);
  assert.match(panelStyles, /\.session-ai-detail-head-actions \.session-ai-timeline-mode button \{[\s\S]*height: 20px;[\s\S]*border: 0;[\s\S]*border-radius: 4px;[\s\S]*background: transparent;[\s\S]*font-weight: 600;/);
  assert.match(panelStyles, /\.session-ai-detail-head-actions \.session-ai-timeline-mode button\[data-state="on"\] \{[\s\S]*background: var\(--surface-elevated\);[\s\S]*color: var\(--text-strong\);[\s\S]*box-shadow: var\(--shadow-soft\);/);
  assert.doesNotMatch(panel, /request-activity-timeline/);
  assert.match(panel, /timeline\.value = undefined;[\s\S]*void loadTimeline\(\);/);
  assert.doesNotMatch(result, /requestActivityTimeline/);
  assert.match(panel, /timelineReloadPending[\s\S]*if \(reload\) void loadTimeline\(true\)/);
  assert.match(panel, /timelineLoading && !timeline/);
  assert.match(panel, /:activity-loading="timelineLoading && !timeline"/);
  assert.match(panel, /watch\(timelineItemStore\.revision[\s\S]*mergeTimelineItems/);
  assert.doesNotMatch(board, /AiSessionTimelineView|getAiSessionTimeline/);
});

test("conversation Timeline composes every turn from the same compact result component", () => {
  const timeline = fs.readFileSync(new URL("../src/components/ai-session/AiSessionTimelineView.vue", import.meta.url), "utf8");
  const group = fs.readFileSync(new URL("../src/components/ai-session/AiSessionActivityGroup.vue", import.meta.url), "utf8");
  const history = fs.readFileSync(new URL("../src/components/ai-session/AiSessionTurnHistory.vue", import.meta.url), "utf8");
  const result = fs.readFileSync(new URL("../src/components/ai-session/AiSessionResult.vue", import.meta.url), "utf8");
  const streamingMarkdown = fs.readFileSync(new URL("../src/components/ai-session/AiSessionStreamingMarkdown.vue", import.meta.url), "utf8");
  const markdownContent = fs.readFileSync(new URL("../../web-theme/MarkdownContent.vue", import.meta.url), "utf8");
  assert.match(timeline, /conversationTimelineTurns\(props\.items\)/);
  assert.match(timeline, /\.ai-session-timeline-turn \{[\s\S]*gap: 24px;/);
  assert.doesNotMatch(timeline, /\.ai-session-timeline-message\[data-role="ai-message"\] \{[\s\S]*padding-(?:top|bottom):/);
  assert.match(result, /\.ai-session-result \{[\s\S]*--detail-activity-gap: 24px;/);
  assert.match(result, /\.ai-session-result-detail \{[\s\S]*gap: 0;/);
  assert.match(result, /\.ai-session-result-detail > \* \{[\s\S]*margin-top: 0;/);
  assert.match(result, /\.ai-session-result-detail > \* \+ \* \{[\s\S]*margin-top: var\(--detail-activity-gap\);/);
  assert.match(streamingMarkdown, /\.ai-session-streaming-markdown :deep\(\.markstream-vue > \.node-slot:first-child > \.node-content > :first-child\) \{\s*margin-top: 0;/);
  assert.match(streamingMarkdown, /\.ai-session-streaming-markdown :deep\(\.markstream-vue > \.node-slot:last-child > \.node-content > :last-child\) \{\s*margin-bottom: 0;/);
  assert.match(markdownContent, /\.markdown-content :deep\(> :first-child\) \{\s*margin-top: 0 !important;/);
  assert.match(markdownContent, /\.markdown-content :deep\(> :last-child\) \{\s*margin-bottom: 0 !important;/);
  assert.doesNotMatch(markdownContent, /:where\(\.markdown-content\) :deep\(> :(?:first|last)-child\)/);
  assert.match(timeline, /<AiSessionResult[\s\S]*:is-latest="isLatestTurn\(virtualTurn\.index\)"[\s\S]*:response-content="turns\[virtualTurn\.index\]\.latestResponse\?\.text \|\| ''"[\s\S]*:session="session"[\s\S]*:activities="trailingActivities\(turns\[virtualTurn\.index\]\)"[\s\S]*:activity-history="turns\[virtualTurn\.index\]\.history"[\s\S]*activity-interactive/);
  assert.doesNotMatch(timeline, /<AiSessionTurnHistory|<AiSessionActivityGroup/);
  assert.match(timeline, /return index === turns\.value\.length - 1/);
  assert.match(timeline, /import \{ useVirtualizer \} from "@tanstack\/vue-virtual"/);
  assert.match(timeline, /v-for="virtualTurn in virtualTurns"[\s\S]*:ref="measureVirtualTurn"[\s\S]*:data-index="virtualTurn\.index"[\s\S]*virtualTurn\.start - scrollMargin/);
  assert.match(timeline, /useVirtualizer\(computed\(\(\) => \(\{[\s\S]*count: turns\.value\.length,[\s\S]*gap: 24,[\s\S]*getItemKey:[\s\S]*getScrollElement:[\s\S]*overscan: 3,[\s\S]*scrollMargin: scrollMargin\.value/);
  assert.match(timeline, /closest<HTMLElement>\("\[data-task-handoff-scroll-viewport\]"\)/);
  assert.match(timeline, /turnVirtualizer\.value\.measureElement\(element\)/);
  assert.doesNotMatch(timeline, /sessions\.timeline\.user|agentLabel/);
  assert.doesNotMatch(timeline, /border-radius|surface-subtle/);
  assert.match(group, /:is="summaryVisible \? 'details' : 'div'"[\s\S]*ai-session-activity-group/);
  assert.match(group, /:is="hasDetails\(activity\) \? 'details' : 'div'"/);
  assert.match(group, /<summary v-if="hasDetails\(activity\)" class="ai-session-activity-item-head">/);
  assert.doesNotMatch(group, /<strong>\{\{ activity\.title \}\}<\/strong>/);
  assert.match(group, /ai-session-activity-title[\s\S]*font-weight: 400;/);
  assert.match(group, /\.ai-session-activity-group > summary small \{[\s\S]*font-size: inherit;[\s\S]*line-height: inherit;/);
  assert.doesNotMatch(group, /sessions\.timeline\.details/);
  assert.match(group, /activity\.activityKind === "fileChange"[\s\S]*activity\.paths\.map\(runtimePathBasename\)/);
  assert.match(group, /:title="activityHoverText\(activity\)"/);
  assert.doesNotMatch(group, /ai-session-activity-dot/);
  assert.match(group, /border-left: 1px solid var\(--line-subtle\)/);
  assert.match(history, /\.ai-session-turn-history-content \{[\s\S]*gap: 6px;[\s\S]*margin: 6px 0 0 7px;[\s\S]*padding-left: 12px;[\s\S]*border-left: 1px solid var\(--line-subtle\);/);
});

test("conversation Timeline keeps only the final AI message visible for every turn", () => {
  const turns = conversationTimelineTurns([
    { id: "user-1", turnId: "turn-1", type: "user-message", text: "question" },
    { id: "ai-1a", turnId: "turn-1", type: "ai-message", text: "checking" },
    { id: "command-1", turnId: "turn-1", type: "activity", activityKind: "commandExecution", title: "Command" },
    { id: "ai-1b", turnId: "turn-1", type: "ai-message", text: "answer" },
    { id: "user-2", turnId: "turn-2", type: "user-message", text: "next" },
    { id: "ai-2a", turnId: "turn-2", type: "ai-message", text: "working" },
    { id: "file-2", turnId: "turn-2", type: "activity", activityKind: "fileChange", title: "File change" },
  ]);

  assert.deepEqual(turns.map((turn) => turn.latestResponse?.id), ["ai-1b", "ai-2a"]);
  assert.deepEqual(turns[0].history.map((node) => node.id), ["ai-1a", "activities:command-1"]);
  assert.deepEqual(turns[0].trailing, []);
  assert.deepEqual(turns[1].history, []);
  assert.deepEqual(turns[1].trailing.map((node) => node.id), ["activities:file-2"]);
  assert.deepEqual(turns.map((turn) => turn.userMessages.map((message) => message.id)), [["user-1"], ["user-2"]]);
});

test("conversation Timeline forms one block per turn without flattening event order", () => {
  const turns = groupTimelineTurns([
    { id: "user-1", turnId: "turn-1", type: "user-message", text: "question" },
    { id: "commentary-1", turnId: "turn-1", type: "ai-message", text: "checking" },
    { id: "command-1", turnId: "turn-1", type: "activity", activityKind: "commandExecution", title: "Command" },
    { id: "response-1", turnId: "turn-1", type: "ai-message", text: "answer" },
    { id: "user-2", turnId: "turn-2", type: "user-message", text: "next" },
  ]);
  assert.deepEqual(turns.map((turn) => turn.id), ["turn-1", "turn-2"]);
  assert.deepEqual(turns[0].nodes.map((node) => node.type), ["message", "message", "activities", "message"]);
  assert.deepEqual(turns[0].nodes[2].activities.map((activity) => activity.id), ["command-1"]);
  assert.deepEqual(turns[1].nodes.map((node) => node.type), ["message"]);
});

test("compact Timeline splits history from only the activities after the latest AI message", () => {
  const items = [
    { id: "user", turnId: "turn-1", type: "user-message", text: "question" },
    { id: "ai-0", turnId: "turn-1", type: "ai-message", text: "first progress" },
    { id: "activity-0", turnId: "turn-1", type: "activity", activityKind: "commandExecution", title: "Command" },
    { id: "activity-1", turnId: "turn-1", type: "activity", activityKind: "fileChange", title: "File change" },
    { id: "ai-1", turnId: "turn-1", type: "ai-message", text: "latest response" },
    { id: "activity-2", turnId: "turn-1", type: "activity", activityKind: "commandExecution", title: "Command" },
    { id: "activity-3", turnId: "turn-1", type: "activity", activityKind: "commandExecution", title: "Command" },
    { id: "other-turn", turnId: "turn-2", type: "activity", activityKind: "commandExecution", title: "Command" },
  ];
  const compact = compactTimelineForTurn(items, { id: "local-1", providerTurnId: "turn-1" });
  assert.deepEqual(compact.history.map((node) => node.type), ["message", "activities"]);
  assert.deepEqual(compact.history[1].activities.map((activity) => activity.id), ["activity-0", "activity-1"]);
  assert.deepEqual(compact.activities.map((activity) => activity.id), ["activity-2", "activity-3"]);
});

test("compact mode renders history, latest AI response, then only the live activity expansion", () => {
  const panel = fs.readFileSync(panelUrl, "utf8");
  const result = fs.readFileSync(new URL("../src/components/ai-session/AiSessionResult.vue", import.meta.url), "utf8");
  assert.match(panel, /aiSessionTurns\(session\)\[promptIndexFor\(session\)\]/);
  assert.match(panel, /:activities="selectedTurnTimeline\.activities"/);
  assert.match(panel, /:activity-history="selectedTurnTimeline\.history"/);
  assert.match(result, /<AiSessionTurnHistory[\s\S]*<section[\s\S]*class="ai-session-detail-response"[\s\S]*<AiSessionToolActivity/);
  assert.match(result, /<AiSessionToolActivity\s+v-if="isLatest && active"/);
  assert.doesNotMatch(result, /v-else-if="activities\.length"/);
});
