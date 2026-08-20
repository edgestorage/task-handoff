import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { supportsAiSessionTimelineCapability } from "@task-handoff/protocol/control-plane";
import { compactTimelineForTurn, conversationTimelineTurns, groupTimelineTurns, turnElapsedEnd, turnElapsedSeconds } from "../src/components/ai-session/timelineActivities.ts";
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

test("turn Timeline cache merges authoritative snapshots with live item upserts", () => {
  const store = useAiSessionTimelineStore();
  const turn = { id: "turn-public", providerTurnId: "turn-provider" };
  store.beginTurnLoad("instance-cache", "session-cache", turn);
  assert.equal(store.turnState("instance-cache", "session-cache", turn).status, "loading");
  store.resolveTurn("instance-cache", "session-cache", turn, [{
    id: "cmd-cache",
    turnId: "turn-provider",
    type: "activity",
    activityKind: "commandExecution",
    title: "Command",
    status: "running",
  }]);
  store.apply({
    instanceId: "instance-cache",
    sessionId: "session-cache",
    providerSessionId: "thread-cache",
    generatedAt: "2026-08-15T00:00:01.000Z",
    item: {
      id: "cmd-cache",
      turnId: "turn-provider",
      type: "activity",
      activityKind: "commandExecution",
      title: "Command",
      status: "completed",
      output: "ok",
    },
  });
  assert.deepEqual(store.turnState("instance-cache", "session-cache", turn), {
    status: "ready",
    items: [{
      id: "cmd-cache",
      turnId: "turn-provider",
      type: "activity",
      activityKind: "commandExecution",
      title: "Command",
      status: "completed",
      output: "ok",
    }],
  });
});

test("realtime Turn state excludes unavailable history snapshots and read errors", () => {
  const store = useAiSessionTimelineStore();
  const instanceId = "instance-realtime-only";
  const sessionId = "session-realtime-only";
  const turn = { id: "turn-public", providerTurnId: "turn-provider" };
  store.cleanupInstance(instanceId);
  store.resolveTurn(instanceId, sessionId, turn, [{
    id: "old-command",
    turnId: "turn-provider",
    type: "activity",
    activityKind: "commandExecution",
    title: "Old command",
    status: "completed",
  }]);
  store.rejectTurn(instanceId, sessionId, turn, "Timeline unsupported");
  store.apply({
    instanceId,
    sessionId,
    providerSessionId: "thread-realtime-only",
    generatedAt: "2026-08-16T00:00:00.000Z",
    item: {
      id: "live-command",
      turnId: "turn-provider",
      type: "activity",
      activityKind: "commandExecution",
      title: "Live command",
      status: "running",
    },
  });

  assert.deepEqual(store.realtimeTurnState(instanceId, sessionId, turn), {
    status: "ready",
    items: [{
      id: "live-command",
      turnId: "turn-provider",
      type: "activity",
      activityKind: "commandExecution",
      title: "Live command",
      status: "running",
    }],
  });
  assert.equal(store.turnState(instanceId, sessionId, turn).status, "error");
  assert.deepEqual(
    store.turnState(instanceId, sessionId, turn).items.map((item) => item.id),
    ["old-command", "live-command"],
  );
  store.cleanupInstance(instanceId);
});

test("live Timeline buckets are bounded and snapshots compact live events into the Turn cache", () => {
  const store = useAiSessionTimelineStore();
  store.recoverConnection();
  const base = {
    instanceId: "instance-bounded",
    sessionId: "session-bounded",
    providerSessionId: "thread-bounded",
    generatedAt: "2026-08-15T00:00:00.000Z",
  };
  for (let index = 0; index <= 500; index += 1) {
    store.apply({
      ...base,
      item: {
        id: `cmd-${index}`,
        turnId: `turn-${index}`,
        type: "activity",
        activityKind: "commandExecution",
        title: "Command",
        status: "completed",
      },
    });
  }
  assert.equal(store.items(base.instanceId, base.sessionId).length, 500);
  assert.equal(store.items(base.instanceId, base.sessionId).some((item) => item.id === "cmd-0"), false);
  const latestTurn = { id: "turn-public-500", providerTurnId: "turn-500" };
  store.resolveTurn(base.instanceId, base.sessionId, latestTurn, [{
    id: "cmd-500",
    turnId: "turn-500",
    type: "activity",
    activityKind: "commandExecution",
    title: "Command",
    status: "running",
  }]);
  assert.equal(store.items(base.instanceId, base.sessionId).some((item) => item.id === "cmd-500"), false);
  assert.equal(store.turnState(base.instanceId, base.sessionId, latestTurn).items[0]?.id, "cmd-500");
  assert.equal(store.turnState(base.instanceId, base.sessionId, latestTurn).items[0]?.status, "completed");
});

test("a single live Turn retains only its newest bounded item window", () => {
  const store = useAiSessionTimelineStore();
  const instanceId = "instance-single-turn-bound";
  const sessionId = "session-single-turn-bound";
  store.cleanupInstance(instanceId);
  for (let index = 0; index <= 500; index += 1) {
    store.apply({
      instanceId,
      sessionId,
      providerSessionId: "thread-single-turn-bound",
      generatedAt: "2026-08-16T00:00:00.000Z",
      item: {
        id: `cmd-${index}`,
        turnId: "turn-single",
        type: "activity",
        activityKind: "commandExecution",
        title: "Command",
        status: "completed",
      },
    });
  }
  const items = store.items(instanceId, sessionId);
  assert.equal(items.length, 500);
  assert.equal(items.some((item) => item.id === "cmd-0"), false);
  assert.equal(items.some((item) => item.id === "cmd-500"), true);
  store.apply({
    instanceId,
    sessionId,
    providerSessionId: "thread-single-turn-bound",
    generatedAt: "2026-08-16T00:00:01.000Z",
    item: {
      id: "cmd-0",
      turnId: "turn-single",
      type: "activity",
      activityKind: "commandExecution",
      title: "Command",
      status: "completed",
      output: "late lifecycle update",
    },
  });
  assert.equal(store.items(instanceId, sessionId).some((item) => item.id === "cmd-0"), false);
  store.cleanupInstance(instanceId);
});

test("snapshot cache eviction does not delete a newer live Turn bucket", () => {
  const store = useAiSessionTimelineStore();
  const instanceId = "instance-independent-lru";
  const sessionId = "session-independent-lru";
  const activeTurn = { id: "turn-active", providerTurnId: "provider-turn-active" };
  store.cleanupInstance(instanceId);
  store.resolveTurn(instanceId, sessionId, activeTurn, []);
  store.apply({
    instanceId,
    sessionId,
    providerSessionId: "thread-independent-lru",
    generatedAt: "2026-08-16T00:00:00.000Z",
    item: {
      id: "cmd-active",
      turnId: "provider-turn-active",
      type: "activity",
      activityKind: "commandExecution",
      title: "Command",
      status: "running",
    },
  });
  for (let index = 0; index < 500; index += 1) {
    store.beginTurnLoad(instanceId, sessionId, { id: `other-${index}` });
  }
  assert.equal(
    store.turnState(instanceId, sessionId, activeTurn).items.some((item) => item.id === "cmd-active"),
    true,
  );
  store.cleanupInstance(instanceId);
});

test("Turn elapsed time ends only at an authoritative terminal timestamp", () => {
  assert.equal(turnElapsedEnd({ status: "running", updatedAt: "2026-08-17T00:00:05.000Z" }), undefined);
  assert.equal(turnElapsedEnd({ status: "waiting", updatedAt: "2026-08-17T00:00:05.000Z" }), undefined);
  assert.equal(turnElapsedEnd({ status: "completed", completedAt: "2026-08-17T00:00:09.000Z", updatedAt: "2026-08-17T00:00:08.000Z" }), "2026-08-17T00:00:09.000Z");
  assert.equal(turnElapsedEnd({ status: "failed" }), undefined);
});

test("Turn elapsed time is unavailable when an inactive Turn has no terminal timestamp", () => {
  const startedAt = "2026-08-17T00:00:00.000Z";
  assert.equal(turnElapsedSeconds(startedAt, undefined, false, Date.parse("2026-08-21T00:00:00.000Z")), undefined);
  assert.equal(turnElapsedSeconds(startedAt, undefined, true, Date.parse("2026-08-17T00:00:09.900Z")), 9);
  assert.equal(turnElapsedSeconds(startedAt, "2026-08-17T00:00:07.500Z", false, Date.parse("2026-08-21T00:00:00.000Z")), 7);
});

test("Timeline capabilities are provider-scoped, independent, and queried through the protocol model", () => {
  const current = { features: { aiSessionTimeline: {
    sessionReadAgents: ["claude"],
    turnReadAgents: ["turn-only"],
    liveItemAgents: ["live-only"],
  } } };
  assert.equal(supportsAiSessionTimelineCapability(current, "claude", "session-read"), true);
  assert.equal(supportsAiSessionTimelineCapability(current, "turn-only", "turn-read"), true);
  assert.equal(supportsAiSessionTimelineCapability(current, "live-only", "live-items"), true);
  assert.equal(supportsAiSessionTimelineCapability(current, "codex", "session-read"), false);
  assert.equal(supportsAiSessionTimelineCapability({ features: {} }, "codex", "session-read"), false);
  assert.equal(supportsAiSessionTimelineCapability({ features: { aiSessionTimeline: true } }, "codex", "session-read"), false);
});

test("AI session turns render immediately while Timeline loads per turn", () => {
  const panel = fs.readFileSync(panelUrl, "utf8");
  const result = fs.readFileSync(new URL("../src/components/ai-session/AiSessionResult.vue", import.meta.url), "utf8");
  const presentation = fs.readFileSync(new URL("../src/apps/control-plane/useAiSessionTimelinePresentation.ts", import.meta.url), "utf8");
  const conversation = fs.readFileSync(new URL("../src/components/ai-session/AiSessionConversationContent.vue", import.meta.url), "utf8");
  const board = fs.readFileSync(new URL("../src/apps/control-plane/ai-board/AiSessionCard.vue", import.meta.url), "utf8");
  assert.match(panel, /:turn-timelines="conversationTurnTimelines"/);
  assert.match(panel, /@load-turn-timeline="loadTurnTimeline"/);
  assert.match(conversation, /<AiSessionTimelineView/);
  assert.match(presentation, /getAiSessionTurnTimeline\(instanceId, current\.id, turn\.id\)/);
  assert.doesNotMatch(presentation, /shouldDeferTurnTimelineLoad/);
  assert.match(presentation, /if \(!supportsTurnRead\.value\)[\s\S]*state\.status === "ready" \|\| state\.status === "loading"[\s\S]*loadFullTimeline\(current, true\)/);
  assert.match(panel, /selectedTimelineTurn\.value\.id}:\$\{selectedTimelineTurn\.value\.status}/);
  assert.match(panel, /class="session-ai-detail-actions-view-mode"[\s\S]*:model-value="effectiveTimelineViewMode"/);
  assert.match(presentation, /supportsAiSessionTimelineCapability/);
  assert.doesNotMatch(panel, /supportsAiSessionTimeline && selectedSession\.agent === 'codex'/);
  const panelStyles = fs.readFileSync(new URL("../src/apps/control-plane/instance-detail/AiSessionPanel.css", import.meta.url), "utf8");
  assert.doesNotMatch(panelStyles, /\.session-ai-detail-head-actions \.session-ai-timeline-mode/);
  assert.match(panelStyles, /\.session-ai-detail-actions-view-mode/);
  assert.doesNotMatch(panel, /request-activity-timeline/);
  assert.doesNotMatch(result, /requestActivityTimeline/);
  assert.match(panel, /:selected-turn-state="selectedTurnTimelineState"/);
  assert.match(presentation, /timelineStore\.turnState\(currentInstance\.id, current\.id, turn\)/);
  assert.match(presentation, /supportsTimelineReads\.value[\s\S]*timelineStore\.realtimeTurnState/);
  assert.doesNotMatch(board, /AiSessionTimelineView|getAiSessionTimeline/);
});

test("board floating detail consumes the same Timeline presentation as instance detail", () => {
  const panel = fs.readFileSync(panelUrl, "utf8");
  const board = fs.readFileSync(new URL("../src/apps/control-plane/ai-board/AiSessionBoardView.vue", import.meta.url), "utf8");
  const dock = fs.readFileSync(new URL("../src/apps/control-plane/ai-board/AiSessionFloatingDock.vue", import.meta.url), "utf8");
  const conversation = fs.readFileSync(new URL("../src/components/ai-session/AiSessionConversationContent.vue", import.meta.url), "utf8");
  for (const source of [panel, board]) {
    assert.match(source, /useAiSessionTimelinePresentation/);
    assert.match(source, /useAiSessionTimelineDemand/);
    assert.match(source, /conversationTurnTimelines/);
    assert.match(source, /selectedTurnTimelineState/);
  }
  for (const source of [panel, dock]) assert.match(source, /<AiSessionConversationContent/);
  assert.match(dock, /:mode="timelineMode"/);
  assert.match(conversation, /v-if="mode === 'full'"[\s\S]*<AiSessionTimelineView[\s\S]*<AiSessionResult/);
  assert.match(board, /getAiSessionDetail\(card\.instance\.id, card\.session\.id\)/);
  assert.match(board, /@continue-from-turn="forkCardSession\(selectedCard, 'current', \$event\)"/);
  assert.doesNotMatch(dock, /<AiSessionResult/);
});

test("conversation Timeline composes every turn from the same compact result component", () => {
  const panel = fs.readFileSync(panelUrl, "utf8");
  const styles = fs.readFileSync(new URL("../src/apps/control-plane/instance-detail/AiSessionPanel.css", import.meta.url), "utf8");
  const timeline = fs.readFileSync(new URL("../src/components/ai-session/AiSessionTimelineView.vue", import.meta.url), "utf8");
  const group = fs.readFileSync(new URL("../src/components/ai-session/AiSessionActivityGroup.vue", import.meta.url), "utf8");
  const history = fs.readFileSync(new URL("../src/components/ai-session/AiSessionTurnHistory.vue", import.meta.url), "utf8");
  const result = fs.readFileSync(new URL("../src/components/ai-session/AiSessionResult.vue", import.meta.url), "utf8");
  const streamingMarkdown = fs.readFileSync(new URL("../src/components/ai-session/AiSessionStreamingMarkdown.vue", import.meta.url), "utf8");
  const markdownContent = fs.readFileSync(new URL("../../web-theme/MarkdownContent.vue", import.meta.url), "utf8");
  const english = fs.readFileSync(new URL("../src/i18n/locales/en-US/sessions.ts", import.meta.url), "utf8");
  const chinese = fs.readFileSync(new URL("../src/i18n/locales/zh-CN/sessions.ts", import.meta.url), "utf8");
  assert.match(timeline, /sourceTurns = computed\(\(\) => props\.session\?\.turns \|\| props\.storedTurns\)/);
  assert.match(timeline, /compactTimelineForTurn\(state\.items, turn\)/);
  assert.match(timeline, /turn\.lastMessage\?\.trim\(\)/);
  assert.doesNotMatch(timeline, /projected\?\.latestResponse|projected\?\.userMessages/);
  assert.match(timeline, /loadVisibleTurnTimelines/);
  assert.doesNotMatch(timeline, /shouldDeferTurnTimelineLoad/);
  assert.match(timeline, /sourceTurns\.value\.map\(\(turn\) => `\$\{turn\.id\}:\$\{turn\.status\}`\)\.join\("\|"\)/);
  assert.match(timeline, /\.ai-session-timeline-turn \{[\s\S]*gap: 24px;/);
  assert.match(history, /\.ai-session-turn-history > summary \{[\s\S]*user-select: none;/);
  assert.match(history, /<details v-else-if="nodes\.length"[\s\S]*<span>\{\{ elapsedLabel \}\}<\/span>/);
  assert.match(history, /v-else class="ai-session-turn-history-status ai-session-turn-history-empty"[\s\S]*<Timer[\s\S]*<span>\{\{ elapsedLabel \}\}<\/span>/);
  assert.match(history, /elapsedSeconds[\s\S]*sessions\.timeline\.processedSeconds[\s\S]*sessions\.timeline\.processedMinutes[\s\S]*sessions\.timeline\.processedHours[\s\S]*sessions\.timeline\.processedDays/);
  assert.doesNotMatch(history, /runningElapsed|elapsedUnavailable|elapsedSeconds"|elapsedMinutes|elapsedHours|elapsedDays/);
  assert.match(english, /processedSeconds: "Processed in \{seconds\}s"/);
  assert.match(chinese, /processedSeconds: "已处理 \{seconds\}秒"/);
  assert.match(english, /processedUnavailable: "-"/);
  assert.match(chinese, /processedUnavailable: "-"/);
  assert.match(timeline, /\.ai-session-timeline-user-message \{[\s\S]*justify-self: end;[\s\S]*width: fit-content;[\s\S]*max-width: min\(78%, 620px\);/);
  assert.match(timeline, /\.ai-session-timeline-message\[data-role="user-message"\] \{[\s\S]*border-radius: 14px;[\s\S]*background: var\(--surface-hover\);[\s\S]*padding: 12px 14px;/);
  assert.doesNotMatch(timeline, /\.ai-session-timeline-message\[data-role="ai-message"\] \{[\s\S]*padding-(?:top|bottom):/);
  assert.match(result, /\.ai-session-result \{[\s\S]*--detail-activity-gap: 16px;/);
  assert.match(result, /\.ai-session-result-detail \.ai-session-result-content \{[\s\S]*gap: 0;/);
  assert.match(result, /\.ai-session-result-detail > \.ai-session-result-content > \* \{[\s\S]*margin-top: 0;/);
  assert.match(result, /\.ai-session-result-detail > \.ai-session-result-content > \* \+ \* \{[\s\S]*margin-top: var\(--detail-activity-gap\);/);
  assert.match(result, /ref="turnContentElement" class="ai-session-result-content"/);
  assert.match(result, /ref="turnContentElement" class="ai-session-result-content"[\s\S]*<slot name="turn-footer" \/>/);
  assert.match(result, /turnHeightBuffer\.update\(content\.getBoundingClientRect\(\)\.height, enabled\)/);
  assert.match(streamingMarkdown, /\.ai-session-streaming-markdown :deep\(\.markstream-vue > \.node-slot:first-child > \.node-content > :first-child\) \{\s*margin-top: 0;/);
  assert.match(streamingMarkdown, /\.ai-session-streaming-markdown :deep\(\.markstream-vue > \.node-slot:last-child > \.node-content > :last-child\) \{\s*margin-bottom: 0;/);
  assert.match(markdownContent, /\.markdown-content :deep\(> :first-child\) \{\s*margin-top: 0 !important;/);
  assert.match(markdownContent, /\.markdown-content :deep\(> :last-child\) \{\s*margin-bottom: 0 !important;/);
  assert.doesNotMatch(markdownContent, /:where\(\.markdown-content\) :deep\(> :(?:first|last)-child\)/);
  assert.match(timeline, /<AiSessionResult[\s\S]*:is-latest="isLatestTurn\(virtualTurn\.index\)"[\s\S]*:response-content="turns\[virtualTurn\.index\]\.latestResponse\?\.text \|\| ''"[\s\S]*:session="session"[\s\S]*:activities="turns\[virtualTurn\.index\]\.activities"[\s\S]*:activity-history="turns\[virtualTurn\.index\]\.history"[\s\S]*activity-interactive/);
  assert.doesNotMatch(timeline, /<AiSessionTurnHistory|<AiSessionActivityGroup/);
  assert.match(timeline, /return index === turns\.value\.length - 1/);
  assert.match(timeline, /import \{ elementScroll, useVirtualizer \} from "@tanstack\/vue-virtual"/);
  assert.match(timeline, /v-for="virtualTurn in virtualTurns"[\s\S]*:ref="measureVirtualTurn"[\s\S]*:data-index="virtualTurn\.index"[\s\S]*virtualTurn\.start - scrollMargin/);
  assert.match(timeline, /useVirtualizer\(computed\(\(\) => \(\{[\s\S]*count: turns\.value\.length,[\s\S]*gap: 24,[\s\S]*getItemKey:[\s\S]*getScrollElement:[\s\S]*overscan: 3,[\s\S]*scrollMargin: scrollMargin\.value/);
  assert.match(panel, /classList\.toggle\("is-user-layout-changing", active\)/);
  assert.match(timeline, /anchorTo:\s*"end"/);
  assert.match(timeline, /scrollToFn:[\s\S]*options\.adjustments[\s\S]*closest\("\.is-user-layout-changing"\)[\s\S]*return/);
  assert.match(timeline, /scrollEndThreshold: 48/);
  assert.match(timeline, /measureElement: \(element\) => Math\.ceil\(element\.getBoundingClientRect\(\)\.height\)/);
  assert.match(timeline, /function measureVirtualTurn\(element: unknown\) \{[\s\S]*turnVirtualizer\.value\.measureElement\(element\)[\s\S]*turnVirtualizer\.value\.resizeItem\(index, Math\.ceil\(element\.getBoundingClientRect\(\)\.height\)\)/);
  assert.doesNotMatch(timeline, /pendingVirtualRangeAnchor|beginVirtualRangeAnchor|commitVirtualRangeAnchor/);
  assert.match(timeline, /\.ai-session-timeline-turn :deep\(\.markdown-renderer\) \{\s*content-visibility: visible;\s*contain-intrinsic-size: none;/);
  assert.match(timeline, /@layout-will-change="\$emit\('layoutWillChange'\)"/);
  assert.match(timeline, /@layout-committed="commitVirtualTurnLayout\(virtualTurn\.index, \$event\)"/);
  assert.match(timeline, /turnVirtualizer\.value\.resizeItem\(index, Math\.ceil\(turn\.getBoundingClientRect\(\)\.height\)\)/);
  assert.match(timeline, /closest<HTMLElement>\("\[data-task-handoff-scroll-viewport\]"\)/);
  assert.match(timeline, /turnVirtualizer\.value\.measureElement\(element\)/);
  assert.match(timeline, /:data-message-id="message\.id"/);
  assert.match(timeline, /class="ai-session-turn-actions"/);
  assert.match(timeline, /<AiSessionResult[\s\S]*<template #turn-footer>[\s\S]*class="ai-session-turn-actions"[\s\S]*<\/AiSessionResult>/);
  assert.doesNotMatch(timeline, /<\/AiSessionResult>\s*<footer[^>]*class="ai-session-turn-actions"/);
  assert.match(result, /\.ai-session-result-detail :slotted\(\.ai-session-turn-actions\) \{[\s\S]*margin-top: 8px;/);
  assert.match(timeline, /latestResponse && completedTurn\(turns\[virtualTurn\.index\]\.id\)/);
  assert.match(timeline, /class="ai-session-user-message-copy"[\s\S]*@click="copyMessage\(message\)"/);
  assert.match(timeline, /class="ai-session-user-message-actions"[\s\S]*v-if="turns\[virtualTurn\.index\]\.startedAt"[\s\S]*formatTurnTime\(turns\[virtualTurn\.index\]\.startedAt \|\| ''\)/);
  assert.match(timeline, /class="ai-session-user-message-actions"[\s\S]*class="ai-session-turn-time"[\s\S]*class="ai-session-user-message-copy"/);
  assert.match(timeline, /startedAt: turn\.startedAt/);
  assert.match(timeline, /@click="copyMessage\(turns\[virtualTurn\.index\]\.latestResponse\)"/);
  assert.match(timeline, /copiedMessageId === message\.id/);
  assert.match(timeline, /\.ai-session-timeline-user-message:hover \.ai-session-user-message-actions,[\s\S]*\.ai-session-timeline-user-message:focus-within \.ai-session-user-message-actions \{[\s\S]*opacity: 1;[\s\S]*pointer-events: auto;/);
  assert.match(timeline, /\.ai-session-user-message-actions \{[\s\S]*margin-top: 8px;/);
  assert.match(timeline, /@click="continueFromTurn\(turns\[virtualTurn\.index\]\.id\)"/);
  assert.match(timeline, /turn\.id === turnId \|\| turn\.providerTurnId === turnId/);
  assert.match(timeline, /turn\?\.completedAt \|\| turn\?\.updatedAt \|\| turn\?\.startedAt/);
  assert.match(timeline, /\.ai-session-turn-actions \{[\s\S]*min-height: 26px;[\s\S]*opacity: 0;[\s\S]*pointer-events: none;/);
  assert.match(timeline, /\.ai-session-turn-actions :deep\(\.ai-session-turn-action\) \{[\s\S]*width: 26px;[\s\S]*height: 26px;[\s\S]*padding: 0;/);
  assert.match(timeline, /\.ai-session-turn-actions :deep\(\.ai-session-turn-action svg\) \{[\s\S]*width: 13px;[\s\S]*height: 13px;/);
  assert.match(timeline, /\.ai-session-timeline-turn:hover \.ai-session-turn-actions,[\s\S]*\.ai-session-timeline-turn:focus-within \.ai-session-turn-actions \{[\s\S]*opacity: 1;[\s\S]*pointer-events: auto;/);
  assert.match(panel, /@continue-from-turn="forkSession\(selectedSession, 'current', \$event\)"/);
  assert.match(timeline, /stickyUserMessageChange: \[message: \{ id: string; text: string \} \| undefined\]/);
  assert.match(timeline, /naturalTop <= viewport\.scrollTop \+ 0\.5 && naturalTop > nearestTop/);
  assert.match(timeline, /scrollElement\.value\?\.removeEventListener\("scroll", scheduleStickyUserMessageUpdate\)/);
  assert.match(panel, /@sticky-user-message-change="timelineStickyUserMessage = \$event"/);
  assert.match(panel, /effectiveTimelineViewMode === 'full' && timelineStickyUserMessage[\s\S]*session-ai-timeline-sticky-prompt[\s\S]*timelineStickyUserMessage\.text/);
  assert.match(styles, /\.session-ai-timeline-sticky-prompt \{[\s\S]*position: absolute;[\s\S]*z-index: 5;[\s\S]*height: calc\([\s\S]*background: var\(--workspace-bg\);/);
  assert.match(styles, /\.session-ai-timeline-sticky-prompt :deep\(\.markdown-content\) \{[\s\S]*overflow: hidden;[\s\S]*text-overflow: ellipsis;[\s\S]*white-space: nowrap;/);
  assert.match(styles, /\.session-ai-timeline-sticky-prompt :deep\(\.markdown-content \*\) \{[\s\S]*display: inline;[\s\S]*white-space: nowrap;/);
  assert.match(styles, /\.session-ai-timeline-sticky-prompt :deep\(\.markdown-content > \* \+ \*::before\) \{[\s\S]*content: " ";/);
  assert.match(styles, /@media \(max-width: 920px\) \{[\s\S]*\.session-ai-timeline-sticky-prompt \{[\s\S]*padding-left: 24px;/);
  assert.doesNotMatch(timeline, /sessions\.timeline\.user|agentLabel/);
  assert.doesNotMatch(timeline, /surface-subtle/);
  assert.match(group, /:is="summaryVisible \? 'details' : 'div'"[\s\S]*ai-session-activity-group/);
  assert.match(group, /:is="hasDetails\(activity\) \? 'details' : 'div'"/);
  assert.match(group, /<summary v-if="hasDetails\(activity\)" class="ai-session-activity-item-head">/);
  assert.doesNotMatch(group, /<strong>\{\{ activity\.title \}\}<\/strong>/);
  assert.match(group, /ai-session-activity-title[\s\S]*font-weight: 400;/);
  assert.match(group, /\.ai-session-activity-item-head \{[\s\S]*font-size: 14px;/);
  assert.match(group, /\.ai-session-activity-item-head small \{[\s\S]*font-size: inherit;/);
  assert.match(group, /\.ai-session-activity-item \{[\s\S]*gap: 0;/);
  assert.match(group, /\.ai-session-activity-item\[open\] \{ gap: 5px; \}/);
  assert.match(group, /\.ai-session-activity-group > summary small \{[\s\S]*font-size: inherit;[\s\S]*line-height: inherit;/);
  assert.doesNotMatch(group, /sessions\.timeline\.details/);
  assert.match(group, /activity\.activityKind === "fileChange"[\s\S]*activity\.paths\.map\(runtimePathBasename\)/);
  assert.match(group, /FilePenLine,[\s\S]*Image as ImageIcon,[\s\S]*SquareTerminal,/);
  assert.match(group, /activity\.activityKind === "commandExecution"/);
  for (const kind of [
    "reasoning", "plan", "hookPrompt", "commandExecution", "fileChange", "mcpToolCall", "dynamicToolCall", "collabAgentToolCall",
    "subAgentActivity", "webSearch", "imageView", "sleep", "imageGeneration", "enteredReviewMode", "exitedReviewMode", "contextCompaction",
  ]) assert.match(group, new RegExp(`\\b${kind}:`));
  assert.match(group, /<ChevronRight v-if="!activityIcon\(activity\)" class="ai-session-activity-disclosure-icon"/);
  assert.match(group, /<component :is="activityIcon\(activity\)" v-else class="ai-session-activity-kind-icon"/);
  assert.match(group, /sessions\.timeline\.commandStatus\.\$\{activity\.status \|\| "unknown"\}/);
  assert.match(group, /isCommandActivity\(activity\)[\s\S]*activity\.input\?\.trim\(\) \|\| ""/);
  assert.doesNotMatch(group, /activity\.title === "Command"/);
  assert.match(group, /:title="activityHoverText\(activity\)"/);
  assert.doesNotMatch(group, /ai-session-activity-dot/);
  assert.match(group, /border-left: 1px solid var\(--line-subtle\)/);
  assert.match(history, /\.ai-session-turn-history-content \{[\s\S]*gap: 12px;[\s\S]*margin: 12px 0 0 7px;[\s\S]*padding-left: 12px;[\s\S]*border-left: 1px solid var\(--line-subtle\);/);
  assert.match(history, /\.ai-session-turn-history-message :deep\(\.markdown-content > :first-child\) \{ margin-top: 0; \}/);
  assert.match(history, /\.ai-session-turn-history-message :deep\(\.markdown-content > :last-child\) \{ margin-bottom: 0; \}/);
  assert.match(history, /v-else class="ai-session-turn-history-status ai-session-turn-history-empty"[\s\S]*<Timer[\s\S]*\{\{ elapsedLabel \}\}/);
  assert.match(history, /<LoaderCircle class="ai-session-turn-history-loading-icon" :size="15"/);
  assert.match(history, /<Timer :size="15"/);
  assert.doesNotMatch(history, /ai-session-turn-history-empty svg \{ visibility: hidden; \}/);
  assert.match(history, /node\.message\.type === 'user-message'/);
  assert.match(history, /\.ai-session-turn-history-message-user \{[\s\S]*justify-self: end;[\s\S]*width: fit-content;[\s\S]*max-width: min\(78%, 620px\);[\s\S]*border-radius: 14px;[\s\S]*background: var\(--surface-hover\);[\s\S]*padding: 12px 14px;/);
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

test("compact Timeline keeps user messages inserted after the primary prompt in earlier process", () => {
  const items = [
    { id: "user-primary", turnId: "turn-1", type: "user-message", text: "initial prompt" },
    { id: "ai-progress", turnId: "turn-1", type: "ai-message", text: "working" },
    { id: "activity-before", turnId: "turn-1", type: "activity", activityKind: "commandExecution", title: "Command" },
    { id: "user-followup", turnId: "turn-1", type: "user-message", text: "additional direction" },
    { id: "activity-after", turnId: "turn-1", type: "activity", activityKind: "fileChange", title: "File change" },
    { id: "ai-final", turnId: "turn-1", type: "ai-message", text: "done" },
  ];

  const compact = compactTimelineForTurn(items, { id: "turn-1" });

  assert.deepEqual(compact.history.map((node) => node.id), [
    "ai-progress",
    "activities:activity-before",
    "user-followup",
    "activities:activity-after",
  ]);
  assert.equal(compact.history.some((node) => node.id === "user-primary"), false);
});

test("compact Timeline preserves follow-up user messages after the latest AI response in the live process", () => {
  const compact = compactTimelineForTurn([
    { id: "user-primary", turnId: "turn-1", type: "user-message", text: "initial prompt" },
    { id: "ai-latest", turnId: "turn-1", type: "ai-message", text: "current answer" },
    { id: "activity-before", turnId: "turn-1", type: "activity", activityKind: "commandExecution", title: "Command" },
    { id: "user-followup", turnId: "turn-1", type: "user-message", text: "additional direction" },
    { id: "activity-after", turnId: "turn-1", type: "activity", activityKind: "fileChange", title: "File change" },
  ], { id: "turn-1" });

  assert.deepEqual(compact.activityNodes.map((node) => node.id), [
    "activities:activity-before",
    "user-followup",
    "activities:activity-after",
  ]);
  assert.deepEqual(compact.activities.map((activity) => activity.id), ["activity-before", "activity-after"]);
});

test("compact Timeline preserves follow-up user messages before the first AI response", () => {
  const compact = compactTimelineForTurn([
    { id: "user-primary", turnId: "turn-1", type: "user-message", text: "initial prompt" },
    { id: "activity-before", turnId: "turn-1", type: "activity", activityKind: "commandExecution", title: "Command" },
    { id: "user-followup", turnId: "turn-1", type: "user-message", text: "additional direction" },
  ], { id: "turn-1" });

  assert.deepEqual(compact.activityNodes.map((node) => node.id), ["activities:activity-before", "user-followup"]);
  assert.equal(compact.activityNodes.some((node) => node.id === "user-primary"), false);
});

test("compact mode renders history, latest AI response, then only the live activity expansion", () => {
  const conversation = fs.readFileSync(new URL("../src/components/ai-session/AiSessionConversationContent.vue", import.meta.url), "utf8");
  const result = fs.readFileSync(new URL("../src/components/ai-session/AiSessionResult.vue", import.meta.url), "utf8");
  assert.match(conversation, /aiSessionTurns\(props\.session\)\[props\.promptIndex\]/);
  assert.match(conversation, /:activities="selectedTimeline\.activities"/);
  assert.match(conversation, /:activity-nodes="selectedTimeline\.activityNodes"/);
  assert.match(conversation, /:activity-history="selectedTimeline\.history"/);
  assert.match(result, /<AiSessionTurnHistory[\s\S]*<section[\s\S]*class="ai-session-detail-response"[\s\S]*<AiSessionToolActivity/);
  assert.match(result, /<AiSessionTurnHistory\s+:nodes="activityHistory"/);
  assert.match(result, /:loading="!active && \(activityHistoryStatus === 'idle' \|\| activityHistoryStatus === 'loading' \|\| activityHistoryStatus === 'stale'\)"/);
  assert.doesNotMatch(result, /<AiSessionTurnHistory\s+v-if=/);
  assert.match(result, /<AiSessionToolActivity\s+v-if="isLatest && active"/);
  assert.doesNotMatch(result, /v-else-if="activities\.length"/);
});
