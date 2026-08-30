import { Profiler, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ProfilerOnRenderCallback } from 'react';
import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, View, type NativeScrollEvent, type NativeSyntheticEvent } from 'react-native';
import { ScrollViewMarker } from 'react-native-screens/experimental';
import * as Clipboard from 'expo-clipboard';
import { Check, ChevronDown, ChevronRight, Copy, Sparkles, Split, Timer } from 'lucide-react-native';
import { aiSessionElapsedSeconds, aiSessionStatusGroup, isAiSessionApprovalPending, type ControlPlaneAiSessionSummary } from '@task-handoff/control-plane-client';
import type { AiSessionTimelineActivity, AiSessionTimelineItem, AiSessionTurn } from '@task-handoff/protocol/ai-sessions';

import { SafeMarkdown } from '../components/SafeMarkdown';
import { SystemIcon } from '../components/SystemIcon';
import { EmptyState } from '../components/EmptyState';
import { activeMobileStreamingMessage, type MobileStreamingMessage, type MobileTurnTimelineState } from './store';
import { mobileMetrics } from '../observability/mobile-metrics';
import { useMobileTheme } from '../components/theme';
import { NativeSessionModePicker } from './NativeSessionModePicker';
import { ToolActivityText } from './ToolActivityText';
import { SessionStatusIndicator } from './SessionStatusIndicator';
import { translate, useI18n, type Translate } from '../i18n';
import { TimelineActivityGroup } from './TimelineActivityGroup';
import { formatSessionTurnTime } from '../session-time';
import { mobileWebMetric, mobileWebType } from '../components/mobile-web-typography';

const english: Translate = (key, params) => translate('en-US', key, params);
const SCROLL_BOTTOM_THRESHOLD = 48;
const CONVERSATION_WINDOW_ITEM_COUNT = 18;

type DetailTurn = Pick<AiSessionTurn, 'id' | 'providerTurnId' | 'status' | 'startedAt' | 'updatedAt' | 'completedAt'>;

type DetailItem = {
  id: string;
  role: 'user' | 'assistant' | 'warning' | 'error' | 'activity' | 'history' | 'current';
  streamKey?: string;
  streaming?: boolean;
  text?: string;
  activities?: AiSessionTimelineActivity[];
  history?: DetailItem[];
  historyStatus?: MobileTurnTimelineState['status'];
  historyError?: string;
  turn?: DetailTurn;
  interactive?: boolean;
  actions?: { timestamp?: string; continuable?: boolean };
};
export type SessionDetailMode = 'conversation' | 'turn';

export function SessionDetail({
  session,
  messages,
  timelines = {},
  timelineEnabled = false,
  timelineHistoryEnabled = timelineEnabled,
  onRetryTimeline,
  onContinueFromTurn,
  onVisible,
  turnIndex,
  pendingTurnIndex,
  turnLoading = false,
  onTurnIndexChange,
  mode,
  onModeChange,
  showModePicker = true,
  bottomInset = 0,
  contentLoading = false,
  keyboardViewportRevision = 0,
}: {
  session?: ControlPlaneAiSessionSummary;
  messages: readonly MobileStreamingMessage[];
  timelines?: Readonly<Record<string, MobileTurnTimelineState>>;
  timelineEnabled?: boolean;
  timelineHistoryEnabled?: boolean;
  onRetryTimeline?(turn: Pick<AiSessionTurn, 'id' | 'providerTurnId'>): void;
  onContinueFromTurn?(turn: DetailTurn): void;
  onVisible?(sessionUpdatedAt: string): void;
  turnIndex?: number;
  pendingTurnIndex?: number;
  turnLoading?: boolean;
  onTurnIndexChange?(index: number): void;
  mode?: SessionDetailMode;
  onModeChange?(mode: SessionDetailMode): void;
  showModePicker?: boolean;
  bottomInset?: number;
  contentLoading?: boolean;
  keyboardViewportRevision?: number;
}) {
  const { colors } = useMobileTheme();
  const { locale, t } = useI18n();
  const turns = useMemo(() => aiSessionDisplayTurns(session), [session]);
  const latestIndex = Math.max(0, turns.length - 1);
  const [localTurnSelection, setLocalTurnSelection] = useState({ sessionId: session?.id, index: latestIndex });
  const [localMode, setLocalMode] = useState<SessionDetailMode>('turn');
  const listRef = useRef<FlatList<DetailItem>>(null);
  const scrollFrame = useRef<number | undefined>(undefined);
  const userDragging = useRef(false);
  const scrollMetrics = useRef({ contentHeight: 0, offsetY: 0, viewportHeight: 0 });
  const followingRef = useRef(true);
  const [conversationWindow, setConversationWindow] = useState({ projectionId: '', start: 0 });
  const [scrollPosition, setScrollPosition] = useState({ sessionId: session?.id, atBottom: true });
  const [canScroll, setCanScroll] = useState(false);
  const selectedMode = mode ?? localMode;
  const localTurnIndex = localTurnSelection.sessionId === session?.id ? localTurnSelection.index : latestIndex;
  const selectedIndex = Math.min(Math.max(turnIndex ?? localTurnIndex, 0), latestIndex);
  const navigationIndex = Math.min(Math.max(pendingTurnIndex ?? selectedIndex, 0), latestIndex);
  const atBottom = scrollPosition.sessionId === session?.id ? scrollPosition.atBottom : true;
  const resetSessionId = useRef<string | undefined>(undefined);
  const isLatest = selectedIndex >= latestIndex;
  const showsLatest = selectedMode === 'conversation' || isLatest;
  const activityText = session ? sessionActivityText(session, t) : undefined;
  const timelineVisible = timelineEnabled || Object.values(timelines).some((timeline) => timeline.items.length > 0);
  const items = useMemo(() => contentLoading ? [] : selectedMode === 'conversation'
    ? conversationDetailItems(session, messages, t, timelines, timelineVisible, timelineHistoryEnabled)
    : detailItems(session, messages, selectedIndex, t, timelines, timelineVisible, timelineHistoryEnabled), [contentLoading, session, messages, selectedIndex, selectedMode, t, timelineHistoryEnabled, timelineVisible, timelines]);
  const projectionId = `${session?.id || ''}:${selectedMode}`;
  const initialConversationStart = conversationWindowStart(items, items.length);
  const conversationStart = selectedMode === 'conversation' && conversationWindow.projectionId === projectionId
    ? Math.min(conversationWindow.start, initialConversationStart)
    : initialConversationStart;
  const displayItems = selectedMode === 'conversation' ? items.slice(conversationStart) : items;
  const expandConversationWindow = useCallback(() => {
    if (selectedMode !== 'conversation' || conversationStart <= 0) return;
    setConversationWindow({ projectionId, start: conversationWindowStart(items, conversationStart) });
  }, [conversationStart, items, projectionId, selectedMode]);
  const setFollowing = useCallback((next: boolean) => {
    followingRef.current = next;
  }, []);
  const setAtBottom = useCallback((next: boolean) => {
    setScrollPosition({ sessionId: session?.id, atBottom: next });
  }, [session?.id]);
  const scheduleScrollToBottom = useCallback((animated: boolean) => {
    if (scrollFrame.current !== undefined) cancelAnimationFrame(scrollFrame.current);
    scrollFrame.current = requestAnimationFrame(() => {
      scrollFrame.current = undefined;
      const { contentHeight, viewportHeight } = scrollMetrics.current;
      if (contentHeight > 0 && viewportHeight > 0) {
        listRef.current?.scrollToOffset({
          animated,
          offset: Math.max(0, contentHeight - viewportHeight),
        });
        return;
      }
      listRef.current?.scrollToEnd({ animated });
    });
  }, []);
  const handleScroll = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
    scrollMetrics.current = {
      contentHeight: contentSize.height,
      offsetY: Math.max(0, contentOffset.y),
      viewportHeight: layoutMeasurement.height,
    };
    const nextAtBottom = isSessionScrollNearBottom(scrollMetrics.current);
    setAtBottom(nextAtBottom);
    if (nextAtBottom && !followingRef.current) setFollowing(true);
    else if (!nextAtBottom && userDragging.current && followingRef.current) setFollowing(false);
  }, [setAtBottom, setFollowing]);
  const handleContentSizeChange = useCallback((_width: number, height: number) => {
    scrollMetrics.current.contentHeight = height;
    setCanScroll(height > scrollMetrics.current.viewportHeight + SCROLL_BOTTOM_THRESHOLD);
    if (selectedMode === 'conversation' && conversationStart > 0 && scrollMetrics.current.viewportHeight > 0 && height <= scrollMetrics.current.viewportHeight) {
      expandConversationWindow();
      return;
    }
    if (
      selectedMode === 'conversation'
      &&
      followingRef.current
      && !userDragging.current
      && scrollMetrics.current.viewportHeight > 0
      && height > scrollMetrics.current.viewportHeight + SCROLL_BOTTOM_THRESHOLD
    ) scheduleScrollToBottom(false);
  }, [conversationStart, expandConversationWindow, scheduleScrollToBottom, selectedMode]);
  const resumeFollowing = useCallback(() => {
    setFollowing(true);
    scheduleScrollToBottom(true);
  }, [scheduleScrollToBottom, setFollowing]);
  const finishProgrammaticScroll = useCallback(() => {
    userDragging.current = false;
    if (followingRef.current && !isSessionScrollNearBottom(scrollMetrics.current)) scheduleScrollToBottom(false);
  }, [scheduleScrollToBottom]);
  useEffect(() => {
    if (session) onVisible?.(session.updatedAt);
  }, [onVisible, session]);
  useLayoutEffect(() => {
    if (resetSessionId.current === projectionId) return;
    resetSessionId.current = projectionId;
    userDragging.current = false;
    scrollMetrics.current = { contentHeight: 0, offsetY: 0, viewportHeight: 0 };
    setFollowing(selectedMode === 'conversation');
    setAtBottom(true);
    if (selectedMode === 'conversation') scheduleScrollToBottom(false);
  }, [projectionId, scheduleScrollToBottom, selectedMode, setAtBottom, setFollowing]);
  useEffect(() => {
    if (selectedMode !== 'conversation' || bottomInset <= 0 || !followingRef.current || userDragging.current) return;
    scheduleScrollToBottom(false);
  }, [bottomInset, scheduleScrollToBottom, selectedMode]);
  useEffect(() => {
    if (selectedMode !== 'conversation' || keyboardViewportRevision <= 0 || !followingRef.current || userDragging.current) return;
    scheduleScrollToBottom(false);
  }, [keyboardViewportRevision, scheduleScrollToBottom, selectedMode]);
  useEffect(() => () => {
    if (scrollFrame.current !== undefined) cancelAnimationFrame(scrollFrame.current);
  }, []);
  const selectTurn = (index: number) => {
    const next = Math.min(Math.max(index, 0), latestIndex);
    if (turnIndex === undefined) setLocalTurnSelection({ sessionId: session?.id, index: next });
    onTurnIndexChange?.(next);
  };
  const selectMode = (next: SessionDetailMode) => {
    if (mode === undefined) setLocalMode(next);
    onModeChange?.(next);
  };
  if (!session) return (
    <Profiler id="detail" onRender={recordDetailRender}>
      <View style={[styles.empty, { backgroundColor: colors.background }]}>
        <SystemIcon android="chat_bubble_outline" color={colors.textMuted} ios="bubble.left.and.bubble.right" size={30} />
        <Text style={[styles.emptyTitle, { color: colors.text }]}>{t('sessions.unavailable')}</Text>
        <Text style={[styles.muted, styles.emptyText, { color: colors.textMuted }]}>{t('sessions.unavailableDescription')}</Text>
      </View>
    </Profiler>
  );
  const sessionStatusLabel = mobileAiSessionStatusLabel(session, t);
  const listHeader = <View style={styles.header}>
    {showModePicker && turns.length ? <View style={styles.modePicker}><NativeSessionModePicker mode={selectedMode} onChange={selectMode} /></View> : null}
    <View style={styles.sessionBar}>
      <View style={styles.metaRow}>
        <SessionStatusIndicator group={aiSessionStatusGroup(session)} label={sessionStatusLabel} />
        <Text style={[styles.meta, { color: colors.textMuted }]}>{sessionStatusLabel}</Text>
      </View>
      {selectedMode === 'turn' && turns.length > 1 ? <View style={styles.turnNavigator} testID="session-turn-navigator">
        <Pressable accessibilityLabel={t('sessions.previousTurn')} accessibilityRole="button" accessibilityState={{ disabled: navigationIndex <= 0 }} disabled={navigationIndex <= 0} hitSlop={8} onPress={() => selectTurn(navigationIndex - 1)} style={[styles.turnButton, navigationIndex <= 0 && styles.turnButtonDisabled]}><SystemIcon android="chevron_left" color={colors.primary} ios="chevron.left" size={14} /></Pressable>
        <Text style={[styles.turnIndex, { color: colors.textMuted }]}>{selectedIndex + 1} / {turns.length}</Text>
        <Pressable accessibilityLabel={t('sessions.nextTurn')} accessibilityRole="button" accessibilityState={{ disabled: navigationIndex >= latestIndex }} disabled={navigationIndex >= latestIndex} hitSlop={8} onPress={() => selectTurn(navigationIndex + 1)} style={[styles.turnButton, navigationIndex >= latestIndex && styles.turnButtonDisabled]}><SystemIcon android="chevron_right" color={colors.primary} ios="chevron.right" size={14} /></Pressable>
      </View> : null}
    </View>
  </View>;
  const listFooter = (!timelineVisible && showsLatest && activityText) || session.subAgents.length ? <View style={styles.footer}>
    {!timelineVisible && showsLatest && activityText ? <View style={styles.tool}><Sparkles color={colors.textMuted} size={mobileWebMetric(14)} /><ToolActivityText containerStyle={styles.toolText} numberOfLines={1} running={session.status === 'running'} textStyle={styles.currentActivityText}>{activityText}</ToolActivityText></View> : null}
    <SubAgents agents={session.subAgents} locale={locale} />
  </View> : null;
  return (
    <Profiler id="detail" onRender={recordDetailRender}>
      <ScrollViewMarker scrollEdgeEffects={{ top: 'soft' }} style={[styles.fill, { backgroundColor: colors.surface }]}>
        <FlatList
          key={`${session.id}:${selectedMode}`}
          ref={listRef}
          contentContainerStyle={[styles.list, {
            backgroundColor: colors.surface,
            paddingBottom: Math.max(28, bottomInset + 16),
          }]}
          contentInsetAdjustmentBehavior="automatic"
          data={displayItems}
          initialNumToRender={selectedMode === 'conversation' ? CONVERSATION_WINDOW_ITEM_COUNT : 6}
          ItemSeparatorComponent={DetailItemSeparator}
          keyExtractor={(item) => item.id}
          keyboardDismissMode="interactive"
          maintainVisibleContentPosition={selectedMode === 'conversation' ? { minIndexForVisible: 0 } : undefined}
          onContentSizeChange={handleContentSizeChange}
          onLayout={(event) => {
            scrollMetrics.current.viewportHeight = event.nativeEvent.layout.height;
            setCanScroll(scrollMetrics.current.contentHeight > event.nativeEvent.layout.height + SCROLL_BOTTOM_THRESHOLD);
            if (
              selectedMode === 'conversation'
              &&
              followingRef.current
              && !userDragging.current
              && scrollMetrics.current.contentHeight > event.nativeEvent.layout.height + SCROLL_BOTTOM_THRESHOLD
            ) scheduleScrollToBottom(false);
          }}
          onScroll={handleScroll}
          onScrollBeginDrag={() => { userDragging.current = true; }}
          onScrollEndDrag={() => { userDragging.current = false; }}
          onMomentumScrollBegin={() => { userDragging.current = true; }}
          onMomentumScrollEnd={finishProgrammaticScroll}
          onStartReached={selectedMode === 'conversation' ? () => {
            if (!followingRef.current) expandConversationWindow();
          } : undefined}
          onStartReachedThreshold={0.5}
          scrollEventThrottle={16}
          ListEmptyComponent={contentLoading ? null : <EmptyState icon={{ android: 'chat_bubble_outline', ios: 'bubble.left' }} iconSize={26} message={t('sessions.noMessages')} style={styles.conversationEmpty} />}
          ListFooterComponent={listFooter}
          ListHeaderComponent={selectedMode !== 'conversation' || conversationStart === 0 ? listHeader : null}
          maxToRenderPerBatch={6}
          renderItem={({ index, item }) => <View
            testID={`session-detail-item-${item.role}`}
          ><DetailItemContent conversation={selectedMode === 'conversation'} item={item} onContinueFromTurn={onContinueFromTurn} onRetryTimeline={onRetryTimeline} trimEnd={displayItems[index + 1]?.role === 'current'} /></View>}
          style={[styles.fill, { backgroundColor: colors.surface }]}
          testID="session-detail-scroll"
          windowSize={7}
        />
        {turnLoading ? <View
          accessibilityState={{ busy: true }}
          pointerEvents="none"
          style={styles.turnLoadingOverlay}
          testID="session-turn-loading-overlay"
        >
          <View style={[styles.turnLoadingIndicator, { backgroundColor: colors.surface, borderColor: colors.border }]}>
            <ActivityIndicator color={colors.textMuted} size="small" testID="session-turn-loading-indicator" />
          </View>
        </View> : null}
        {!atBottom && canScroll ? (
          <Pressable
            accessibilityLabel={t('sessions.scrollToBottom')}
            accessibilityRole="button"
            hitSlop={8}
            onPress={resumeFollowing}
            style={({ pressed }) => [
              styles.scrollToBottom,
              { backgroundColor: colors.primaryButton, borderColor: colors.primaryButton, bottom: Math.max(16, bottomInset + 12) },
              pressed && styles.scrollToBottomPressed,
            ]}
            testID="session-scroll-to-bottom"
          >
            <SystemIcon android="keyboard_arrow_down" color="#ffffff" ios="arrow.down" size={21} />
          </Pressable>
        ) : null}
      </ScrollViewMarker>
    </Profiler>
  );
}

function DetailItemSeparator() {
  return <View style={styles.itemSeparator} />;
}

function conversationWindowStart(items: readonly DetailItem[], beforeIndex: number) {
  let start = Math.max(0, beforeIndex - CONVERSATION_WINDOW_ITEM_COUNT);
  while (start > 0 && items[start]?.role !== 'user') start -= 1;
  return start;
}

const recordDetailRender: ProfilerOnRenderCallback = (_id, _phase, actualDuration) => {
  mobileMetrics.record('render.duration', { screen: 'detail' }, actualDuration);
};

export function isSessionScrollNearBottom({
  contentHeight,
  offsetY,
  viewportHeight,
}: {
  contentHeight: number;
  offsetY: number;
  viewportHeight: number;
}) {
  return contentHeight <= viewportHeight
    || contentHeight - viewportHeight - offsetY <= SCROLL_BOTTOM_THRESHOLD;
}

export function detailItems(
  session: ControlPlaneAiSessionSummary | undefined,
  messages: readonly MobileStreamingMessage[],
  turnIndex?: number,
  t: Translate = english,
  timelines: Readonly<Record<string, MobileTurnTimelineState>> = {},
  timelineEnabled = Object.keys(timelines).length > 0,
  timelineHistoryEnabled = timelineEnabled,
): DetailItem[] {
  if (!session) return [];
  const turns = aiSessionDisplayTurns(session);
  if (turns.length) {
    const index = Math.min(Math.max(turnIndex ?? turns.length - 1, 0), turns.length - 1);
    const turn = turns[index];
    const isLatest = index >= turns.length - 1;
    const timeline = timelines[turn.id];
    const hasTimeline = Boolean(timeline?.items.length);
    const active = isLatest && ['running', 'waiting'].includes(session.status);
    const items = hasTimeline
      ? turnTimelineDetailItems(turn, timeline.items)
      : [];
    if (turn.userPrompt?.trim() && !items.some((item) => item.role === 'user')) {
      items.unshift({ id: `${turn.id}:user`, role: 'user', text: turn.userPrompt, actions: { timestamp: turn.startedAt } });
    }
    const streamed = isLatest ? activeMobileStreamingMessage(messages, turn.id) : undefined;
    const hasStreamedText = Boolean(streamed?.receivedText.trim());
    const response = hasStreamedText ? streamed!.receivedText : turn.lastMessage?.trim() || turn.summary?.trim();
    if (response) {
      const streamedItemIndex = hasStreamedText ? items.findIndex((item) => item.id === `timeline:${streamed!.itemId}`) : -1;
      const fallbackResponseIndex = items.findLastIndex((item) => item.role === 'assistant');
      const responseIndex = hasStreamedText && hasTimeline ? streamedItemIndex : fallbackResponseIndex;
      const responseItem: DetailItem = {
        id: hasStreamedText ? `timeline:${streamed!.itemId}` : `${turn.id}:assistant`,
        role: 'assistant',
        streamKey: hasStreamedText ? `${turn.id}:${streamed!.itemId}` : undefined,
        streaming: streamed?.status === 'streaming',
        text: response,
        turn,
        actions: turn.status === 'completed' ? {
          timestamp: turn.completedAt || turn.updatedAt || turn.startedAt,
          continuable: session.actions?.fork === true && Boolean(turn.providerTurnId),
        } : undefined,
      };
      if (responseIndex >= 0) items[responseIndex] = responseItem;
      else items.push(responseItem);
    }
    if (isLatest && session.status === 'failed') items.push({ id: 'session:error', role: 'error', text: session.error || t('sessions.failedWithoutDiagnostic') });
    let projected = hasTimeline ? compactMobileTimeline(items, turn) : items;
    if ((!active || timelineEnabled) && !projected.some((item) => item.role === 'history')) {
      const responseIndex = projected.findIndex((item) => item.role === 'assistant');
      projected.splice(responseIndex < 0 ? Math.min(1, projected.length) : responseIndex, 0, {
        id: `${turn.id}:timeline-history-status`,
        role: 'history',
        history: [],
        historyError: timeline?.error,
        historyStatus: active ? 'ready' : timelineHistoryEnabled ? timeline?.status ?? 'idle' : 'ready',
        turn,
      });
    }
    const currentActivity = isLatest ? sessionActivityText(session, t) : undefined;
    return timelineEnabled && currentActivity ? appendCurrentActivity(projected, currentActivity, turn, session.status === 'running') : projected;
  }
  const items: DetailItem[] = [];
  if (session.userPrompt) items.push({ id: 'session:user', role: 'user', text: session.userPrompt, actions: { timestamp: session.startedAt } });
  if (session.lastMessage || session.summary) items.push({ id: 'session:assistant', role: 'assistant', text: session.lastMessage || session.summary!, actions: session.status === 'idle' ? { timestamp: session.updatedAt || session.startedAt } : undefined });
  if (session.status === 'failed') items.push({ id: 'session:error', role: 'error', text: session.error || t('sessions.failedWithoutDiagnostic') });
  return items;
}

export function conversationDetailItems(session: ControlPlaneAiSessionSummary | undefined, messages: readonly MobileStreamingMessage[], t: Translate = english, timelines: Readonly<Record<string, MobileTurnTimelineState>> = {}, timelineEnabled = Object.keys(timelines).length > 0, timelineHistoryEnabled = timelineEnabled): DetailItem[] {
  const turns = aiSessionDisplayTurns(session);
  if (!turns.length) return detailItems(session, messages, undefined, t);
  return turns.flatMap((_turn, index) => detailItems(session, messages, index, t, timelines, timelineEnabled, timelineHistoryEnabled));
}

function turnTimelineDetailItems(turn: DetailTurn, timeline: readonly AiSessionTimelineItem[]): DetailItem[] {
  const identities = new Set([turn.id, turn.providerTurnId].filter(Boolean));
  const items: DetailItem[] = [];
  for (const item of timeline) {
    if (!identities.has(item.turnId)) continue;
    if (item.type === 'activity') {
      if (item.activityKind === 'codexRetry') {
        if (item.status === 'waiting' && item.summary) items.push({ id: `timeline:${item.id}`, role: 'warning', text: item.summary });
        continue;
      }
      const previous = items.at(-1);
      if (previous?.role === 'activity') previous.activities!.push(item);
      else items.push({ id: `timeline-activities:${item.id}`, role: 'activity', activities: [item] });
    } else items.push({
      id: `timeline:${item.id}`,
      role: item.type === 'user-message' ? 'user' : 'assistant',
      text: item.text,
      actions: item.type === 'user-message' ? { timestamp: turn.startedAt } : undefined,
    });
  }
  return items;
}

function compactMobileTimeline(items: DetailItem[], turn: DetailTurn) {
  const primaryUserIndex = items.findIndex((item) => item.role === 'user');
  const latestResponseIndex = items.findLastIndex((item) => item.role === 'assistant');
  if (latestResponseIndex < 0) return items;
  const primaryUser = primaryUserIndex >= 0 ? items[primaryUserIndex] : undefined;
  const history = items.slice(0, latestResponseIndex).filter((_item, index) => index !== primaryUserIndex);
  const trailing = items.slice(latestResponseIndex + 1).filter((_item, offset) => latestResponseIndex + 1 + offset !== primaryUserIndex);
  return [
    ...(primaryUser ? [primaryUser] : []),
    ...(history.length ? [{ id: `timeline-history:${history[0].id}`, role: 'history' as const, history, turn }] : []),
    items[latestResponseIndex],
    ...trailing,
  ];
}

function appendCurrentActivity(items: DetailItem[], text: string, turn: DetailTurn, running: boolean) {
  const responseIndex = items.findLastIndex((item) => item.role === 'assistant');
  const historyIndex = items.findIndex((item) => item.role === 'history');
  const splitIndex = responseIndex >= 0 ? responseIndex + 1 : historyIndex >= 0 ? historyIndex + 1 : Math.min(1, items.length);
  const trailing = items.slice(splitIndex).filter((item) => item.role !== 'error' && item.role !== 'warning');
  const notices = items.slice(splitIndex).filter((item) => item.role === 'error' || item.role === 'warning');
  return [
    ...items.slice(0, splitIndex),
    { id: `${turn.id}:current-activity`, role: 'current' as const, text, history: trailing, interactive: true, streaming: running, turn },
    ...notices,
  ];
}

function DetailItemContent({
  conversation,
  item,
  onContinueFromTurn,
  onRetryTimeline,
  timelineNested = false,
  trimEnd = false,
}: {
  conversation: boolean;
  item: DetailItem;
  onContinueFromTurn?(turn: DetailTurn): void;
  onRetryTimeline?(turn: Pick<AiSessionTurn, 'id' | 'providerTurnId'>): void;
  timelineNested?: boolean;
  trimEnd?: boolean;
}) {
  const { colors } = useMobileTheme();
  const { t } = useI18n();
  if (item.role === 'activity') return <TimelineActivityGroup activities={item.activities ?? []} />;
  if (item.role === 'history') return <TimelineHistory error={item.historyError} items={item.history ?? []} onRetry={item.turn && onRetryTimeline ? () => onRetryTimeline(item.turn!) : undefined} status={item.historyStatus} turn={item.turn} />;
  if (item.role === 'current') return <TimelineCurrentActivity item={item} />;
  if (conversation && item.role === 'user') return <View style={styles.userMessage}><View style={[styles.conversationUser, { backgroundColor: colors.primarySoft }]}><SafeMarkdown trimEnd>{item.text ?? ''}</SafeMarkdown></View><MessageActions item={item} onContinueFromTurn={onContinueFromTurn} /></View>;
  if (conversation && item.role === 'assistant') return <View style={styles.assistantMessage}><View style={styles.conversationResponse}><SafeMarkdown streamKey={item.streamKey} streaming={item.streaming} trimEnd={timelineNested || trimEnd}>{item.text ?? ''}</SafeMarkdown></View><MessageActions item={item} onContinueFromTurn={onContinueFromTurn} /></View>;
  if (item.role === 'user') return <View style={styles.userMessage}><View style={[styles.promptBlock, { backgroundColor: colors.primarySoft }]}><SafeMarkdown trimEnd>{item.text ?? ''}</SafeMarkdown></View><MessageActions item={item} onContinueFromTurn={onContinueFromTurn} /></View>;
  if (item.role === 'assistant') return <View style={styles.assistantMessage}><View style={styles.responseBlock}><SafeMarkdown streamKey={item.streamKey} streaming={item.streaming} trimEnd={timelineNested || trimEnd}>{item.text ?? ''}</SafeMarkdown></View><MessageActions item={item} onContinueFromTurn={onContinueFromTurn} /></View>;
  if (item.role === 'warning') return <View style={[styles.errorBlock, { backgroundColor: colors.notice }]}><SystemIcon android="warning" color={colors.noticeText} ios="exclamationmark.triangle.fill" size={16} /><View style={styles.errorText}><Text style={[styles.role, { color: colors.noticeText }]}>{t('sessions.retryWarning')}</Text><SafeMarkdown>{item.text ?? ''}</SafeMarkdown></View></View>;
  return <View style={[styles.errorBlock, { backgroundColor: colors.errorSoft }]}><SystemIcon android="error" color={colors.error} ios="exclamationmark.triangle.fill" size={16} /><View style={styles.errorText}><Text style={[styles.role, { color: colors.error }]}>{t('sessions.error')}</Text><SafeMarkdown>{item.text ?? ''}</SafeMarkdown></View></View>;
}

function MessageActions({ item, onContinueFromTurn }: { item: DetailItem; onContinueFromTurn?(turn: DetailTurn): void }) {
  const { colors } = useMobileTheme();
  const { locale, t } = useI18n();
  const [copied, setCopied] = useState(false);
  const resetTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(resetTimer.current), []);
  if (!item.actions || !item.text) return null;
  const copy = async () => {
    try {
      await Clipboard.setStringAsync(item.text!);
    } catch {
      return;
    }
    setCopied(true);
    clearTimeout(resetTimer.current);
    resetTimer.current = setTimeout(() => setCopied(false), 1_500);
  };
  const label = copied ? t('sessions.codeCopied') : t('sessions.copyCode');
  return <View style={[styles.messageActions, item.role === 'user' ? styles.messageActionsUser : styles.messageActionsAssistant]} testID={`session-message-actions-${item.role}`}>
    <Text style={[styles.messageTime, { color: colors.textMuted }]}>{item.actions.timestamp ? formatSessionTurnTime(item.actions.timestamp, locale) : ''}</Text>
    <View style={styles.messageActionButtons}>
      {item.actions.continuable && item.turn && onContinueFromTurn ? <Pressable accessibilityLabel={t('sessions.continueFromTurn')} accessibilityRole="button" hitSlop={6} onPress={() => onContinueFromTurn(item.turn!)} style={({ pressed }) => [styles.messageCopy, pressed && styles.messageCopyPressed]}>
        <Split color={colors.textMuted} size={mobileWebMetric(13)} />
      </Pressable> : null}
      <Pressable accessibilityLabel={label} accessibilityRole="button" hitSlop={6} onPress={() => void copy()} style={({ pressed }) => [styles.messageCopy, pressed && styles.messageCopyPressed]}>
        {copied ? <Check color={colors.textMuted} size={mobileWebMetric(13)} /> : <Copy color={colors.textMuted} size={mobileWebMetric(13)} />}
      </Pressable>
    </View>
  </View>;
}

function TimelineHistory({
  error,
  items,
  onRetry,
  status = 'ready',
  turn,
}: {
  error?: string;
  items: readonly DetailItem[];
  onRetry?(): void;
  status?: MobileTurnTimelineState['status'];
  turn?: DetailTurn;
}) {
  const { colors } = useMobileTheme();
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const processedLabel = useProcessedLabel(turn, t);
  if (!items.length && ['idle', 'loading', 'stale'].includes(status)) return <View accessibilityState={{ busy: true }} style={styles.timelineHistoryHeader}>
    <ActivityIndicator animating color={colors.textMuted} size="small" testID="session-timeline-loading-indicator" />
    <Text style={[styles.timelineHistoryTitle, { color: colors.textMuted }]}>{processedLabel} · {t('sessions.timelineLoading')}</Text>
  </View>;
  if (!items.length && status === 'error') return <Pressable accessibilityRole="button" onPress={onRetry} style={styles.timelineHistoryHeader}>
    <ChevronRight color={colors.textMuted} size={mobileWebMetric(15)} />
    <Text style={[styles.timelineHistoryTitle, { color: colors.textMuted }]}>{processedLabel} · {t('sessions.timelineLoadFailed')}</Text>
    {error ? <Text numberOfLines={1} style={[styles.timelineHistoryError, { color: colors.textMuted }]}>{error}</Text> : null}
  </Pressable>;
  if (!items.length) return <View style={styles.timelineHistoryHeader}>
    <Timer color={colors.textMuted} size={mobileWebMetric(15)} />
    <Text style={[styles.timelineHistoryTitle, { color: colors.textMuted }]}>{processedLabel}</Text>
  </View>;
  return <View style={styles.timelineHistory}>
    <Pressable accessibilityLabel={t('sessions.timelineDetails')} accessibilityRole="button" accessibilityState={{ expanded }} onPress={() => setExpanded((value) => !value)} style={styles.timelineHistoryHeader}>
    {expanded ? <ChevronDown color={colors.textMuted} size={mobileWebMetric(15)} /> : <ChevronRight color={colors.textMuted} size={mobileWebMetric(15)} />}
      <Text style={[styles.timelineHistoryTitle, { color: colors.textMuted }]}>{processedLabel}</Text>
    </Pressable>
    {expanded ? <View style={[styles.timelineHistoryItems, { borderLeftColor: colors.border }]} testID="session-timeline-history-items">{items.map((item) => <DetailItemContent conversation={false} item={item} key={item.id} timelineNested />)}</View> : null}
  </View>;
}

function useProcessedLabel(turn: DetailTurn | undefined, t: Translate) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!turn?.startedAt || !['running', 'waiting'].includes(turn.status)) return;
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [turn?.startedAt, turn?.status]);
  return processedDurationLabel(turn, t, now);
}

export function processedDurationLabel(turn: DetailTurn | undefined, t: Translate = english, now = Date.now()) {
  const active = turn?.status === 'running' || turn?.status === 'waiting';
  const totalSeconds = aiSessionElapsedSeconds(turn?.startedAt, turn?.completedAt, active, now);
  if (totalSeconds === undefined) return t('sessions.timelineProcessedUnavailable');
  if (totalSeconds < 60) return t('sessions.timelineProcessedSeconds', { seconds: totalSeconds });
  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes < 60) return t('sessions.timelineProcessedMinutes', { minutes: totalMinutes, seconds: totalSeconds % 60 });
  const totalHours = Math.floor(totalMinutes / 60);
  if (totalHours < 24) return t('sessions.timelineProcessedHours', { hours: totalHours, minutes: totalMinutes % 60, seconds: totalSeconds % 60 });
  return t('sessions.timelineProcessedDays', {
    days: Math.floor(totalHours / 24),
    hours: totalHours % 24,
    minutes: totalMinutes % 60,
    seconds: totalSeconds % 60,
  });
}

function TimelineCurrentActivity({ item }: { item: DetailItem }) {
  const { colors } = useMobileTheme();
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const nodes = item.history ?? [];
  const interactive = Boolean(item.interactive);
  const content = <>
    {interactive ? expanded ? <ChevronDown color={colors.textMuted} size={mobileWebMetric(15)} /> : <ChevronRight color={colors.textMuted} size={mobileWebMetric(15)} />
      : <Sparkles color={colors.textMuted} size={mobileWebMetric(15)} />}
    <ToolActivityText containerStyle={styles.toolText} numberOfLines={1} running={Boolean(item.streaming)} textStyle={styles.currentActivityText}>{item.text ?? ''}</ToolActivityText>
  </>;
  return <View style={styles.currentActivity}>
    {interactive ? <Pressable accessibilityRole="button" accessibilityState={{ expanded }} onPress={() => setExpanded((value) => !value)} style={styles.currentActivityHeader}>{content}</Pressable>
      : <View style={styles.currentActivityHeader}>{content}</View>}
    {expanded ? <View style={styles.currentActivityItems} testID="session-current-activity-items">{nodes.length ? nodes.map((node) => node.role === 'activity'
      ? <TimelineActivityGroup activities={node.activities ?? []} key={node.id} summaryVisible={false} />
      : <DetailItemContent conversation={false} item={node} key={node.id} timelineNested />) : <Text style={[styles.currentActivityEmpty, { color: colors.textMuted }]}>{t('sessions.timelineNoActivities')}</Text>}</View> : null}
  </View>;
}

export function aiSessionDisplayTurns(session: ControlPlaneAiSessionSummary | undefined) {
  return session?.turns ?? [];
}

export function sessionActivityText(session: ControlPlaneAiSessionSummary, t: Translate = english) {
  if (!['running', 'waiting'].includes(session.status) || isAiSessionApprovalPending(session)) return undefined;
  if (session.currentTool?.name) return session.currentTool.inputPreview
    ? `${session.currentTool.name} · ${session.currentTool.inputPreview}`
    : session.currentTool.name;
  if (session.phase === 'responding') return t('sessions.responding');
  if (session.phase === 'editing') return t('sessions.editing');
  if (session.status === 'waiting') return t('sessions.waiting');
  return session.toolCallsSinceLastMessage > 0 ? t('sessions.thinkingTools', { count: session.toolCallsSinceLastMessage }) : t('sessions.thinking');
}

export function mobileAiSessionStatusLabel(session: ControlPlaneAiSessionSummary, t: Translate = english) {
  if (session.status === 'waiting') return session.phase === 'approval' ? t('sessions.statusWaitingApproval') : t('sessions.statusWaiting');
  if (session.status === 'failed') return t('sessions.statusFailed');
  if (session.status === 'idle') return t('sessions.statusIdle');
  if (session.currentTool?.name) return t('sessions.statusRunningWith', { detail: session.currentTool.name });
  if (session.phase === 'tool') return t('sessions.statusRunningWith', { detail: t('sessions.statusTool') });
  if (session.phase === 'editing') return t('sessions.statusRunningWith', { detail: t('sessions.statusEditing') });
  if (session.phase === 'responding') return t('sessions.statusRunningWith', { detail: t('sessions.statusResponding') });
  return t('sessions.statusRunning');
}

function SubAgents({ agents, locale }: { agents: ControlPlaneAiSessionSummary['subAgents']; locale: string }) {
  const { colors } = useMobileTheme();
  const { t } = useI18n();
  const active = agents.filter((agent) => ['pending-init', 'running', 'interrupted', 'errored', 'not-found'].includes(agent.status));
  const [userExpanded, setUserExpanded] = useState<boolean>();
  const expanded = userExpanded ?? active.length > 0;
  if (!agents.length) return null;
  return (
    <View style={[styles.subAgents, { borderTopColor: colors.border }]}> 
      <Pressable accessibilityRole="button" accessibilityState={{ expanded }} onPress={() => setUserExpanded(!expanded)} style={styles.subAgentHeader}>
        <Text style={[styles.subAgentTitle, { color: colors.text }]}>{t('sessions.subAgents', { count: agents.length, action: expanded ? t('common.hide') : t('common.show') })}</Text>
        <ChevronDown color={colors.textMuted} size={mobileWebMetric(14)} style={expanded ? styles.subAgentDisclosureOpen : undefined} />
      </Pressable>
      {expanded ? agents.slice(0, 50).map((agent) => (
        <View key={agent.threadId} style={[styles.subAgent, { backgroundColor: colors.surface, borderColor: colors.border }]}> 
          <View style={styles.subAgentNameRow}>
            <View style={[styles.statusDot, { backgroundColor: ['running', 'pending-init'].includes(agent.status) ? colors.primary : colors.textMuted }]} />
            <Text numberOfLines={1} style={[styles.subAgentName, { color: colors.text }]}>{agent.path || agent.threadId}</Text>
          </View>
          <Text style={[styles.subAgentMeta, { color: colors.textMuted }]}>{agent.status} · {agent.activity || t('sessions.activityUnknown')} · {new Date(agent.updatedAt).toLocaleString(locale)}</Text>
          <Text style={[styles.subAgentMessage, { color: colors.textMuted }]}>{agent.message || t('sessions.noAgentMessage')}</Text>
        </View>
      )) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  scrollToBottom: {
    alignItems: 'center',
    borderRadius: 22,
    borderWidth: StyleSheet.hairlineWidth,
    elevation: 4,
    height: 44,
    justifyContent: 'center',
    position: 'absolute',
    right: 16,
    shadowColor: '#000',
    shadowOffset: { height: 2, width: 0 },
    shadowOpacity: 0.16,
    shadowRadius: 5,
    width: 44,
  },
  scrollToBottomPressed: { opacity: 0.72, transform: [{ scale: 0.96 }] },
  list: { paddingHorizontal: 16, paddingBottom: 28, paddingTop: 12 },
  empty: { alignItems: 'center', flex: 1, gap: 8, justifyContent: 'center', padding: 32 },
  emptyTitle: { fontSize: 17, fontWeight: '700' },
  emptyText: { maxWidth: 260, textAlign: 'center' },
  footer: { gap: 18, marginTop: 6 },
  tool: { alignItems: 'center', flexDirection: 'row', gap: 8, minHeight: 24, paddingHorizontal: 2 },
  header: { gap: 12, marginBottom: 20 },
  itemSeparator: { height: mobileWebMetric(16) },
  modePicker: { alignItems: 'center' },
  sessionBar: { alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between', minHeight: 36 },
  metaRow: { alignItems: 'center', flexDirection: 'row', gap: 8 },
  turnNavigator: { alignItems: 'center', flexDirection: 'row', gap: 4 },
  turnButton: { alignItems: 'center', height: 32, justifyContent: 'center', width: 32 },
  turnButtonDisabled: { opacity: 0.3 },
  turnIndex: { fontSize: mobileWebType.meta, fontVariant: ['tabular-nums'], fontWeight: '600', lineHeight: mobileWebType.metaLine, minWidth: 44, textAlign: 'center' },
  turnLoadingOverlay: { alignItems: 'center', left: 0, pointerEvents: 'none', position: 'absolute', right: 0, top: 104, zIndex: 2 },
  turnLoadingIndicator: { alignItems: 'center', borderRadius: 18, borderWidth: StyleSheet.hairlineWidth, height: 36, justifyContent: 'center', width: 36 },
  statusDot: { borderRadius: 4, height: 8, width: 8 },
  meta: { fontSize: mobileWebType.meta, lineHeight: mobileWebType.metaLine, textTransform: 'capitalize' },
  muted: { fontSize: mobileWebType.small, lineHeight: mobileWebType.smallLine },
  toolText: { flex: 1 },
  currentActivity: { gap: mobileWebMetric(10), minWidth: 0 },
  currentActivityHeader: { alignItems: 'center', flexDirection: 'row', gap: mobileWebMetric(5), minHeight: mobileWebType.bodyLine },
  currentActivityText: { fontSize: mobileWebType.body, fontWeight: '400', lineHeight: mobileWebType.bodyLine },
  currentActivityEmpty: { fontSize: mobileWebType.small, lineHeight: mobileWebType.smallLine },
  currentActivityItems: { gap: mobileWebMetric(6), marginLeft: mobileWebMetric(20) },
  conversationEmpty: { paddingVertical: 32 },
  userMessage: { alignSelf: 'flex-end', maxWidth: '90%', minWidth: 0 },
  assistantMessage: { alignSelf: 'stretch', minWidth: 0 },
  messageActions: { alignItems: 'center', flexDirection: 'row', gap: mobileWebMetric(6), marginTop: mobileWebMetric(8), minHeight: mobileWebMetric(26) },
  messageActionsUser: { justifyContent: 'flex-end' },
  messageActionsAssistant: { justifyContent: 'flex-start' },
  messageTime: { fontSize: mobileWebType.meta, lineHeight: mobileWebType.timeLine, paddingHorizontal: mobileWebMetric(6) },
  messageCopy: { alignItems: 'center', borderRadius: 6, height: mobileWebMetric(26), justifyContent: 'center', width: mobileWebMetric(26) },
  messageActionButtons: { alignItems: 'center', flexDirection: 'row', gap: mobileWebMetric(2) },
  messageCopyPressed: { opacity: 0.62 },
  promptBlock: { borderRadius: 18, borderTopRightRadius: 6, paddingHorizontal: mobileWebMetric(14), paddingVertical: mobileWebMetric(12) },
  responseBlock: { alignSelf: 'stretch', paddingHorizontal: 2, paddingVertical: 4 },
  conversationUser: { borderRadius: 18, borderTopRightRadius: 6, paddingHorizontal: mobileWebMetric(14), paddingVertical: mobileWebMetric(12) },
  conversationResponse: { alignSelf: 'flex-start', maxWidth: '98%', paddingHorizontal: 2, paddingVertical: 4 },
  errorBlock: { alignItems: 'flex-start', borderRadius: 12, flexDirection: 'row', gap: 8, padding: 12 },
  errorText: { flex: 1, gap: 6 },
  role: { fontSize: mobileWebType.meta, fontWeight: '600', lineHeight: mobileWebType.metaLine, textTransform: 'capitalize' },
  timelineHistory: { gap: mobileWebMetric(12) },
  timelineHistoryHeader: { alignItems: 'center', flexDirection: 'row', gap: mobileWebMetric(5), minHeight: mobileWebType.bodyLine },
  timelineHistoryTitle: { fontSize: mobileWebType.body, lineHeight: mobileWebType.bodyLine },
  timelineHistoryError: { flex: 1, fontSize: mobileWebType.body, lineHeight: mobileWebType.bodyLine },
  timelineHistoryItems: {
    borderLeftWidth: StyleSheet.hairlineWidth,
    gap: mobileWebMetric(12),
    marginLeft: mobileWebMetric(7),
    paddingLeft: mobileWebMetric(12),
  },
  subAgents: { borderTopWidth: StyleSheet.hairlineWidth, gap: 12, marginTop: 8, paddingTop: 16 },
  subAgentHeader: { alignItems: 'center', flexDirection: 'row', gap: 10, minHeight: 44 },
  subAgentDisclosureOpen: { transform: [{ rotate: '180deg' }] },
  subAgentTitle: { flex: 1, fontSize: mobileWebType.meta, fontWeight: '700', lineHeight: mobileWebType.metaLine },
  subAgent: { borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, gap: 8, padding: 12 },
  subAgentNameRow: { alignItems: 'center', flexDirection: 'row', gap: 8 },
  subAgentName: { flex: 1, fontSize: mobileWebType.small, fontWeight: '600', lineHeight: mobileWebType.smallLine },
  subAgentMeta: { fontSize: mobileWebType.tiny, lineHeight: mobileWebMetric(15) },
  subAgentMessage: { fontSize: mobileWebType.small, lineHeight: mobileWebMetric(12 * 1.4) },
});
