import { Profiler, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ProfilerOnRenderCallback } from 'react';
import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, View, type LayoutChangeEvent, type NativeScrollEvent, type NativeSyntheticEvent } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { LegendList, type LegendListRef } from '@legendapp/list/react-native';
import { Check, ChevronRight, Copy, Split, Timer } from 'lucide-react-native';
import { aiSessionElapsedSeconds, aiSessionStatusGroup, isAiSessionApprovalPending, type ControlPlaneAiSessionSummary, type ControlPlaneClient } from '@task-handoff/control-plane-client';
import { isAiSessionRetryActivity, type AiSessionTimelineActivity, type AiSessionTimelineItem, type AiSessionTurn, type AiSessionConversationAttachment } from '@task-handoff/protocol/ai-sessions';

import { SafeMarkdown } from '../components/SafeMarkdown';
import { MarkdownContent } from '../components/MarkdownContent';
import { Icon } from '../components/Icon';
import { EmptyState } from '../components/EmptyState';
import { LoadingState } from '../components/LoadingState';
import {
  ADAPTIVE_READING_MAX_WIDTH,
  adaptiveContentContainerStyle,
  useAdaptiveContentLayout,
} from '../components/adaptive-layout';
import { activeMobileStreamingMessage, type MobileStreamingMessage, type MobileTurnTimelineState } from './store';
import { mobileMetrics } from '../observability/mobile-metrics';
import { useMobileTheme } from '../components/theme';
import { AnimatedSegmentedControl } from '../components/AnimatedSegmentedControl';
import { ToolActivityText } from './ToolActivityText';
import { RetryWarning } from './RetryWarning';
import { SessionStatusIndicator } from './SessionStatusIndicator';
import { SessionContextRow } from './SessionContextRow';
import { translate, useI18n, type Translate } from '../i18n';
import { TimelineActivityGroup } from './TimelineActivityGroup';
import type { MobileToolActivityWindow } from './use-tool-activity-window';
import { formatSessionTurnTime } from '../session-time';
import { mobileWebMetric, mobileWebType } from '../components/mobile-web-typography';
import { AnimatedDisclosure, DisclosureChevron } from './AnimatedDisclosure';

import { MessageAttachments, SessionAttachmentContext } from './MessageAttachments';
import { CollapsibleUserMessage } from './CollapsibleUserMessage';

const english: Translate = (key, params) => translate('en-US', key, params);
const SCROLL_BOTTOM_THRESHOLD = 48;
export const conversationListOptions = {
  alignItemsAtEnd: true,
  contentInsetAdjustmentBehavior: 'automatic',
  initialScrollAtEnd: true,
  maintainScrollAtEnd: true,
  maintainVisibleContentPosition: true,
} as const;
type DetailTurn = Pick<AiSessionTurn, 'id' | 'providerTurnId' | 'status' | 'startedAt' | 'updatedAt' | 'completedAt'>;

type DetailItem = {
  id: string;
  role: 'user' | 'assistant' | 'warning' | 'error' | 'activity' | 'history' | 'current';
  streamKey?: string;
  streaming?: boolean;
  text?: string;
  messageId?: string;
  attachments?: AiSessionConversationAttachment[];
  activities?: AiSessionTimelineActivity[];
  history?: DetailItem[];
  historyStatus?: MobileTurnTimelineState['status'];
  historyError?: string;
  activityStatus?: 'idle' | MobileToolActivityWindow['status'];
  turn?: DetailTurn;
  interactive?: boolean;
  actions?: { timestamp?: string; continuable?: boolean };
};
export type SessionDetailMode = 'conversation' | 'turn';

export function SessionDetail({
  client,
  instanceId,
  session,
  messages,
  timelines = {},
  toolActivityWindows = {},
  timelineEnabled = false,
  timelineHistoryEnabled = timelineEnabled,
  toolActivityEnabled = true,
  onLoadTimeline,
  onLoadToolActivity,
  onRetryTimeline,
  onContinueFromTurn,
  onAddToConversation,
  onOpenBuiltinBrowser,
  onOpenFile,
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
  contentError,
  onRetryContent,
  recovering = false,
  keyboardViewportRevision = 0,
  instanceName,
  workspaceName,
}: {
  client?: ControlPlaneClient;
  instanceId?: string;
  session?: ControlPlaneAiSessionSummary;
  messages: readonly MobileStreamingMessage[];
  timelines?: Readonly<Record<string, MobileTurnTimelineState>>;
  toolActivityWindows?: Readonly<Record<string, MobileToolActivityWindow>>;
  timelineEnabled?: boolean;
  timelineHistoryEnabled?: boolean;
  toolActivityEnabled?: boolean;
  onLoadTimeline?(turn: Pick<AiSessionTurn, 'id' | 'providerTurnId'>): void;
  onLoadToolActivity?(turn: Pick<AiSessionTurn, 'id' | 'providerTurnId'>): void;
  onRetryTimeline?(turn: Pick<AiSessionTurn, 'id' | 'providerTurnId'>): void;
  onContinueFromTurn?(turn: DetailTurn): void;
  onAddToConversation?(text: string): void;
  onOpenBuiltinBrowser?(url: string): void | Promise<void>;
  onOpenFile?(href: string): void | Promise<void>;
  onVisible?(): void;
  turnIndex?: number;
  pendingTurnIndex?: number;
  turnLoading?: boolean;
  onTurnIndexChange?(index: number): void;
  mode?: SessionDetailMode;
  onModeChange?(mode: SessionDetailMode): void;
  showModePicker?: boolean;
  bottomInset?: number;
  contentLoading?: boolean;
  contentError?: string;
  onRetryContent?(): void;
  /** The session is expected to reappear after a transient connection recovery. */
  recovering?: boolean;
  keyboardViewportRevision?: number;
  instanceName?: string;
  workspaceName?: string;
}) {
  const { colors } = useMobileTheme();
  const { locale, t } = useI18n();
  const adaptive = useAdaptiveContentLayout(ADAPTIVE_READING_MAX_WIDTH);
  const turns = useMemo(() => aiSessionDisplayTurns(session), [session]);
  const latestIndex = Math.max(0, turns.length - 1);
  const [localTurnSelection, setLocalTurnSelection] = useState({ sessionId: session?.id, index: latestIndex });
  const [localMode, setLocalMode] = useState<SessionDetailMode>('turn');
  const listRef = useRef<FlatList<DetailItem>>(null);
  const conversationListRef = useRef<LegendListRef>(null);
  const scrollFrame = useRef<number | undefined>(undefined);
  const userDragging = useRef(false);
  const scrollMetrics = useRef({ contentHeight: 0, offsetY: 0, viewportHeight: 0 });
  const followingRef = useRef(true);
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
    ? conversationDetailItems(session, messages, t, timelines, timelineVisible, timelineHistoryEnabled, toolActivityWindows)
    : detailItems(session, messages, selectedIndex, t, timelines, timelineVisible, timelineHistoryEnabled, toolActivityWindows), [contentLoading, session, messages, selectedIndex, selectedMode, t, timelineHistoryEnabled, timelineVisible, timelines, toolActivityWindows]);
  const projectionId = `${session?.id || ''}:${selectedMode}`;
  const trimEndItemIds = useMemo(() => new Set(items
    .filter((item, index) => items[index + 1]?.role === 'current')
    .map((item) => item.id)), [items]);
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
      if (selectedMode === 'conversation') {
        void conversationListRef.current?.scrollToEnd({ animated });
        return;
      }
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
  }, [selectedMode]);
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
  }, []);
  const handleLayout = useCallback((event: LayoutChangeEvent) => {
    scrollMetrics.current.viewportHeight = event.nativeEvent.layout.height;
    setCanScroll(scrollMetrics.current.contentHeight > event.nativeEvent.layout.height + SCROLL_BOTTOM_THRESHOLD);
  }, []);
  const resumeFollowing = useCallback(() => {
    setFollowing(true);
    scheduleScrollToBottom(true);
  }, [scheduleScrollToBottom, setFollowing]);
  const finishProgrammaticScroll = useCallback(() => {
    userDragging.current = false;
    if (followingRef.current && !isSessionScrollNearBottom(scrollMetrics.current)) scheduleScrollToBottom(false);
  }, [scheduleScrollToBottom]);
  useEffect(() => {
    if (session) onVisible?.();
  }, [onVisible, session]);
  useLayoutEffect(() => {
    if (resetSessionId.current === projectionId) return;
    resetSessionId.current = projectionId;
    userDragging.current = false;
    scrollMetrics.current = { contentHeight: 0, offsetY: 0, viewportHeight: 0 };
    setFollowing(selectedMode === 'conversation');
    setAtBottom(true);
  }, [projectionId, selectedMode, setAtBottom, setFollowing]);
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
  if (!session && recovering) return (
    <Profiler id="detail" onRender={recordDetailRender}>
      <LoadingState
        accessibilityLabel={t('sessions.loadingAccessibility')}
        description={t('sessions.recoveringDescription')}
        style={{ backgroundColor: colors.background }}
        testID="session-recovering"
        title={t('sessions.recovering')}
      />
    </Profiler>
  );
  if (!session) return (
    <Profiler id="detail" onRender={recordDetailRender}>
      <View style={[styles.empty, { backgroundColor: colors.background }]}>
        <Icon color={colors.textMuted} name="chatbubbles-outline" size={30} />
        <Text style={[styles.emptyTitle, { color: colors.text }]}>{t('sessions.unavailable')}</Text>
        <Text style={[styles.muted, styles.emptyText, { color: colors.textMuted }]}>{t('sessions.unavailableDescription')}</Text>
      </View>
    </Profiler>
  );
  const sessionStatusLabel = mobileAiSessionStatusLabel(session, t);
  const listHeader = <View style={styles.header}>
    {contentError ? <Pressable accessibilityRole="button" onPress={onRetryContent} style={[styles.contentError, { backgroundColor: colors.errorSoft }]} testID="session-content-load-error">
      <Icon color={colors.error} name="alert-circle" size={16} />
      <Text numberOfLines={3} style={[styles.contentErrorText, { color: colors.error }]}>{contentError}</Text>
      {onRetryContent ? <Text style={[styles.contentErrorAction, { color: colors.error }]}>{t('common.retry')}</Text> : null}
    </Pressable> : null}
    {showModePicker && turns.length ? <AnimatedSegmentedControl
      accessibilityLabel={t('sessions.sessionViewMode')}
      onChange={selectMode}
      options={[
        { label: t('sessions.conversation'), testID: 'session-mode-conversation', value: 'conversation' },
        { label: t('sessions.compact'), testID: 'session-mode-compact', value: 'turn' },
      ]}
      style={styles.modePicker}
      testID="session-mode-picker"
      value={selectedMode}
    /> : null}
    <View style={styles.sessionBar}>
      {instanceName && workspaceName ? <View style={styles.sessionContext} testID="session-detail-context">
        <SessionStatusIndicator group={aiSessionStatusGroup(session)} label={sessionStatusLabel} />
        <SessionContextRow
          agent={session.agent}
          instanceName={instanceName}
          instanceTestID="session-detail-instance-context"
          style={styles.sessionContextRow}
          testID="session-detail-workspace-context"
          workspace={workspaceName}
        />
      </View> : <View style={styles.metaRow}>
        <SessionStatusIndicator group={aiSessionStatusGroup(session)} label={sessionStatusLabel} />
        <Text style={[styles.meta, { color: colors.textMuted }]}>{sessionStatusLabel}</Text>
      </View>}
      {selectedMode === 'turn' && turns.length > 1 ? <View style={styles.turnNavigator} testID="session-turn-navigator">
        <Pressable accessibilityLabel={t('sessions.previousTurn')} accessibilityRole="button" accessibilityState={{ disabled: navigationIndex <= 0 }} disabled={navigationIndex <= 0} hitSlop={8} onPress={() => selectTurn(navigationIndex - 1)} style={[styles.turnButton, navigationIndex <= 0 && styles.turnButtonDisabled]}><Icon color={colors.primary} name="chevron-back" size={14} /></Pressable>
        <Text style={[styles.turnIndex, { color: colors.textMuted }]}>{selectedIndex + 1} / {turns.length}</Text>
        <Pressable accessibilityLabel={t('sessions.nextTurn')} accessibilityRole="button" accessibilityState={{ disabled: navigationIndex >= latestIndex }} disabled={navigationIndex >= latestIndex} hitSlop={8} onPress={() => selectTurn(navigationIndex + 1)} style={[styles.turnButton, navigationIndex >= latestIndex && styles.turnButtonDisabled]}><Icon color={colors.primary} name="chevron-forward" size={14} /></Pressable>
      </View> : null}
    </View>
  </View>;
  const listFooter = (!timelineVisible && showsLatest && activityText) || session.subAgents.length ? <View style={styles.footer}>
    {!timelineVisible && showsLatest && activityText ? <View style={styles.tool}><ToolActivityText containerStyle={styles.toolText} numberOfLines={1} running={session.status === 'running'} textStyle={styles.currentActivityText}>{activityText}</ToolActivityText></View> : null}
    <SubAgents agents={session.subAgents} locale={locale} />
  </View> : null;
  const listContentStyle = adaptiveContentContainerStyle([styles.list, {
    backgroundColor: colors.background,
    paddingBottom: Math.max(28, bottomInset + 16),
    paddingTop: 12,
  }], adaptive.contentInsets);
  const listEmptyComponent = contentLoading ? null : <EmptyState icon="chatbubble-outline" iconSize={26} message={t('sessions.noMessages')} style={styles.conversationEmpty} />;
  const renderDetailItem = ({ item }: { item: DetailItem }) => <View
    testID={`session-detail-item-${item.role}`}
  ><DetailItemContent conversation={selectedMode === 'conversation'} item={item} onAddToConversation={onAddToConversation} onContinueFromTurn={onContinueFromTurn} onLoadTimeline={onLoadTimeline} onLoadToolActivity={toolActivityEnabled ? onLoadToolActivity : undefined} onOpenBuiltinBrowser={onOpenBuiltinBrowser} onOpenFile={onOpenFile} onRetryTimeline={onRetryTimeline} trimEnd={trimEndItemIds.has(item.id)} /></View>;
  return (
    <SessionAttachmentContext.Provider value={instanceId && session ? { client, instanceId, sessionId: session.id } : undefined}>
    <Profiler id="detail" onRender={recordDetailRender}>
      <>
        {selectedMode === 'conversation' ? <LegendList
          key={`${session.id}:conversation`}
          ref={conversationListRef}
          {...conversationListOptions}
          contentContainerStyle={listContentStyle}
          data={items}
          estimatedItemSize={180}
          ItemSeparatorComponent={DetailItemSeparator}
          keyExtractor={(item) => item.id}
          keyboardDismissMode="interactive"
          ListEmptyComponent={listEmptyComponent}
          ListFooterComponent={listFooter}
          ListHeaderComponent={listHeader}
          onContentSizeChange={handleContentSizeChange}
          onLayout={handleLayout}
          onMomentumScrollBegin={() => { userDragging.current = true; }}
          onMomentumScrollEnd={finishProgrammaticScroll}
          onScroll={handleScroll}
          onScrollBeginDrag={() => { userDragging.current = true; }}
          onScrollEndDrag={() => { userDragging.current = false; }}
          recycleItems={false}
          renderItem={renderDetailItem}
          scrollIndicatorInsets={adaptive.scrollIndicatorInsets}
          style={[styles.fill, { backgroundColor: colors.background }]}
          testID="session-detail-scroll"
        /> : <FlatList
          key={`${session.id}:turn`}
          ref={listRef}
          contentContainerStyle={listContentStyle}
          contentInsetAdjustmentBehavior="automatic"
          data={items}
          initialNumToRender={6}
          ItemSeparatorComponent={DetailItemSeparator}
          keyExtractor={(item) => item.id}
          keyboardDismissMode="interactive"
          ListEmptyComponent={listEmptyComponent}
          ListFooterComponent={listFooter}
          ListHeaderComponent={listHeader}
          maxToRenderPerBatch={6}
          onContentSizeChange={handleContentSizeChange}
          onLayout={handleLayout}
          onMomentumScrollBegin={() => { userDragging.current = true; }}
          onMomentumScrollEnd={finishProgrammaticScroll}
          onScroll={handleScroll}
          onScrollBeginDrag={() => { userDragging.current = true; }}
          onScrollEndDrag={() => { userDragging.current = false; }}
          renderItem={renderDetailItem}
          scrollEventThrottle={16}
          scrollIndicatorInsets={adaptive.scrollIndicatorInsets}
          style={[styles.fill, { backgroundColor: colors.background }]}
          testID="session-detail-scroll"
          windowSize={7}
        />}
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
              {
                backgroundColor: colors.primaryButton,
                borderColor: colors.primaryButton,
                bottom: Math.max(16, bottomInset + 12),
                right: adaptive.contentInsets.right + 16,
              },
              pressed && styles.scrollToBottomPressed,
            ]}
            testID="session-scroll-to-bottom"
          >
            <Icon color="#ffffff" name="chevron-down" size={21} />
          </Pressable>
        ) : null}
      </>
    </Profiler>
    </SessionAttachmentContext.Provider>
  );
}

function DetailItemSeparator() {
  return <View style={styles.itemSeparator} />;
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
  if (contentHeight <= viewportHeight) return true;
  return contentHeight - viewportHeight - offsetY <= SCROLL_BOTTOM_THRESHOLD;
}

export function detailItems(
  session: ControlPlaneAiSessionSummary | undefined,
  messages: readonly MobileStreamingMessage[],
  turnIndex?: number,
  t: Translate = english,
  timelines: Readonly<Record<string, MobileTurnTimelineState>> = {},
  timelineEnabled = Object.keys(timelines).length > 0,
  timelineHistoryEnabled = timelineEnabled,
  toolActivityWindows: Readonly<Record<string, MobileToolActivityWindow>> = {},
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
    let items = hasTimeline
      ? turnTimelineDetailItems(turn, timeline.items)
      : [];
    // Turn bodies retain the authoritative message IDs and attachment metadata,
    // independently of the lazily loaded process timeline (also in v0.0.49).
    if (turn.userMessages?.length) {
      items = [
        ...turn.userMessages.map((message): DetailItem => ({
          id: `timeline:${message.id}`,
          role: 'user',
          text: message.text,
          messageId: message.id,
          attachments: message.attachments,
          actions: { timestamp: turn.startedAt },
        })),
        ...items.filter((item) => item.role !== 'user'),
      ];
    }
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
        ...(responseIndex >= 0 ? items[responseIndex] : undefined),
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
    let projected = hasTimeline ? compactMobileTimeline(items, turn, active) : items;
    if ((!active || timelineEnabled) && !projected.some((item) => item.role === 'history')) {
      const responseIndex = projected.findIndex((item) => item.role === 'assistant');
      projected.splice(responseIndex < 0 ? Math.min(1, projected.length) : responseIndex, 0, {
        id: `${turn.id}:timeline-history`,
        role: 'history',
        history: [],
        historyError: timeline?.error,
        historyStatus: timelineHistoryEnabled ? timeline?.status ?? 'idle' : 'ready',
        turn,
      });
    }
    const currentActivity = isLatest ? sessionActivityText(session, t) : undefined;
    const withCurrentActivity = timelineEnabled && currentActivity ? appendCurrentActivity(projected, currentActivity, turn, session.status === 'running', toolActivityWindows[turn.id]) : projected;
    return placeRetryWarningBeforeResponse(withCurrentActivity);
  }
  const items: DetailItem[] = [];
  if (session.userPrompt) items.push({ id: 'session:user', role: 'user', text: session.userPrompt, actions: { timestamp: session.startedAt } });
  if (session.lastMessage || session.summary) items.push({ id: 'session:assistant', role: 'assistant', text: session.lastMessage || session.summary!, actions: session.status === 'idle' ? { timestamp: session.updatedAt || session.startedAt } : undefined });
  if (session.status === 'failed') items.push({ id: 'session:error', role: 'error', text: session.error || t('sessions.failedWithoutDiagnostic') });
  return items;
}

export function conversationDetailItems(session: ControlPlaneAiSessionSummary | undefined, messages: readonly MobileStreamingMessage[], t: Translate = english, timelines: Readonly<Record<string, MobileTurnTimelineState>> = {}, timelineEnabled = Object.keys(timelines).length > 0, timelineHistoryEnabled = timelineEnabled, toolActivityWindows: Readonly<Record<string, MobileToolActivityWindow>> = {}): DetailItem[] {
  const turns = aiSessionDisplayTurns(session);
  if (!turns.length) return detailItems(session, messages, undefined, t);
  return turns.flatMap((_turn, index) => detailItems(session, messages, index, t, timelines, timelineEnabled, timelineHistoryEnabled, toolActivityWindows));
}

function turnTimelineDetailItems(turn: DetailTurn, timeline: readonly AiSessionTimelineItem[]): DetailItem[] {
  const identities = new Set([turn.id, turn.providerTurnId].filter(Boolean));
  const items: DetailItem[] = [];
  for (const item of timeline) {
    if (!identities.has(item.turnId)) continue;
    if (item.type === 'activity') {
      if (isAiSessionRetryActivity(item)) {
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
      messageId: item.id,
      attachments: item.type === 'user-message' ? item.attachments : undefined,
      actions: item.type === 'user-message' ? { timestamp: turn.startedAt } : undefined,
    });
  }
  return items;
}

function compactMobileTimeline(items: DetailItem[], turn: DetailTurn, active: boolean) {
  const userMessages = items.filter((item) => item.role === 'user');
  const latestResponseIndex = items.findLastIndex((item) => item.role === 'assistant');
  const retryWarning = items.findLast((item) => item.role === 'warning');
  if (latestResponseIndex < 0 && active) return items;
  // Like Web's active-only tool disclosure, only the active latest turn owns
  // trailing activity. Keep terminal activity in process history, even when
  // the live timeline has not received the final assistant message yet.
  const history = items.filter((item, index) => item.role !== 'user' && index !== latestResponseIndex
    && item.role !== 'warning' && item.role !== 'error' && (!active || index < latestResponseIndex));
  const trailing = items.filter((item, index) => item.role !== 'user' && index > latestResponseIndex
    && item.role !== 'warning' && (active || item.role === 'error'));
  return [
    ...userMessages,
    ...(history.length ? [{ id: `${turn.id}:timeline-history`, role: 'history' as const, history, turn }] : []),
    ...(latestResponseIndex >= 0 ? [items[latestResponseIndex]] : []),
    ...trailing,
    ...(retryWarning ? [retryWarning] : []),
  ];
}

function placeRetryWarningBeforeResponse(items: DetailItem[]) {
  const retryWarning = items.findLast((item) => item.role === 'warning');
  if (!retryWarning) return items;
  const withoutWarnings = items.filter((item) => item.role !== 'warning');
  const responseIndex = withoutWarnings.findLastIndex((item) => item.role === 'assistant');
  if (responseIndex < 0) return [...withoutWarnings, retryWarning];
  return [
    ...withoutWarnings.slice(0, responseIndex),
    retryWarning,
    ...withoutWarnings.slice(responseIndex),
  ];
}

function appendCurrentActivity(items: DetailItem[], text: string, turn: DetailTurn, running: boolean, window?: MobileToolActivityWindow) {
  const responseIndex = items.findLastIndex((item) => item.role === 'assistant');
  const historyIndex = items.findIndex((item) => item.role === 'history');
  const splitIndex = responseIndex >= 0 ? responseIndex + 1 : historyIndex >= 0 ? historyIndex + 1 : Math.min(1, items.length);
  const trailing = items.slice(splitIndex).filter((item) => item.role !== 'error' && item.role !== 'warning');
  const notices = items.slice(splitIndex).filter((item) => item.role === 'error' || item.role === 'warning');
  const activityHistory: DetailItem[] = window
    ? window.status === 'ready' && window.items.length
      ? [{ id: `${turn.id}:tool-window`, role: 'activity', activities: [...window.items] }]
      : []
    : trailing;
  const currentActivity: DetailItem = {
    id: `${turn.id}:current-activity`,
    role: 'current',
    text,
    history: activityHistory,
    activityStatus: window?.status ?? 'idle',
    interactive: true,
    streaming: running,
    turn,
  };
  return [
    ...items.slice(0, splitIndex),
    currentActivity,
    ...notices,
  ];
}

function DetailItemContent({
  conversation,
  item,
  onAddToConversation,
  onContinueFromTurn,
  onLoadTimeline,
  onLoadToolActivity,
  onOpenBuiltinBrowser,
  onOpenFile,
  onRetryTimeline,
  timelineNested = false,
  trimEnd = false,
}: {
  conversation: boolean;
  item: DetailItem;
  onAddToConversation?(text: string): void;
  onContinueFromTurn?(turn: DetailTurn): void;
  onLoadTimeline?(turn: Pick<AiSessionTurn, 'id' | 'providerTurnId'>): void;
  onLoadToolActivity?(turn: Pick<AiSessionTurn, 'id' | 'providerTurnId'>): void;
  onOpenBuiltinBrowser?(url: string): void | Promise<void>;
  onOpenFile?(href: string): void | Promise<void>;
  onRetryTimeline?(turn: Pick<AiSessionTurn, 'id' | 'providerTurnId'>): void;
  timelineNested?: boolean;
  trimEnd?: boolean;
}) {
  const { colors } = useMobileTheme();
  const { t } = useI18n();
  if (item.role === 'activity') return <TimelineActivityGroup activities={item.activities ?? []} />;
  if (item.role === 'history') return <TimelineHistory error={item.historyError} items={item.history ?? []} onAddToConversation={onAddToConversation} onLoad={item.turn && onLoadTimeline ? () => onLoadTimeline(item.turn!) : undefined} onOpenBuiltinBrowser={onOpenBuiltinBrowser} onOpenFile={onOpenFile} onRetry={item.turn && onRetryTimeline ? () => onRetryTimeline(item.turn!) : undefined} status={item.historyStatus} turn={item.turn} />;
  if (item.role === 'current') return <TimelineCurrentActivity item={item} onLoad={item.turn && onLoadToolActivity ? () => onLoadToolActivity(item.turn!) : undefined} onAddToConversation={onAddToConversation} onOpenBuiltinBrowser={onOpenBuiltinBrowser} onOpenFile={onOpenFile} />;
  if (item.role === 'user') return <View style={styles.userMessage}>
    {item.messageId && item.attachments?.length ? <MessageAttachments attachments={item.attachments} messageId={item.messageId} /> : null}
    {item.text?.trim() ? <View style={[conversation ? styles.conversationUser : styles.promptBlock, { backgroundColor: colors.workbenchSelectionBackground }]} testID="session-user-message">
      <CollapsibleUserMessage key={item.id}>
        <SafeMarkdown nativeSelectable={false} onOpenBuiltinBrowser={onOpenBuiltinBrowser} onOpenFile={onOpenFile} trimEnd>{item.text}</SafeMarkdown>
      </CollapsibleUserMessage>
    </View> : null}
    <MessageActions item={item} onContinueFromTurn={onContinueFromTurn} />
  </View>;
  if (conversation && item.role === 'assistant') return <View style={styles.assistantMessage}><View style={styles.conversationResponse}><MarkdownContent onAddToConversation={onAddToConversation} onOpenBuiltinBrowser={onOpenBuiltinBrowser} onOpenFile={onOpenFile} streamKey={item.streamKey} streaming={item.streaming} trimEnd={timelineNested || trimEnd}>{item.text ?? ''}</MarkdownContent></View><MessageActions item={item} onContinueFromTurn={onContinueFromTurn} /></View>;
  if (item.role === 'assistant') return <View style={styles.assistantMessage}><View style={styles.responseBlock}><MarkdownContent onAddToConversation={onAddToConversation} onOpenBuiltinBrowser={onOpenBuiltinBrowser} onOpenFile={onOpenFile} streamKey={item.streamKey} streaming={item.streaming} trimEnd={timelineNested || trimEnd}>{item.text ?? ''}</MarkdownContent></View><MessageActions item={item} onContinueFromTurn={onContinueFromTurn} /></View>;
  if (item.role === 'warning') return <RetryWarning text={item.text ?? ''} />;
  return <View style={[styles.errorBlock, { backgroundColor: colors.errorSoft }]}><Icon color={colors.error} name="alert-circle" size={16} /><View style={styles.errorText}><Text style={[styles.role, { color: colors.error }]}>{t('sessions.error')}</Text><MarkdownContent onAddToConversation={onAddToConversation} onOpenBuiltinBrowser={onOpenBuiltinBrowser} onOpenFile={onOpenFile}>{item.text ?? ''}</MarkdownContent></View></View>;
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
  onAddToConversation,
  onLoad,
  onOpenBuiltinBrowser,
  onOpenFile,
  onRetry,
  status = 'ready',
  turn,
}: {
  error?: string;
  items: readonly DetailItem[];
  onAddToConversation?(text: string): void;
  onLoad?(): void;
  onOpenBuiltinBrowser?(url: string): void | Promise<void>;
  onOpenFile?(href: string): void | Promise<void>;
  onRetry?(): void;
  status?: MobileTurnTimelineState['status'];
  turn?: DetailTurn;
}) {
  const { colors } = useMobileTheme();
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const processedLabel = useProcessedLabel(turn, t);
  const toggleHistory = () => {
    const next = !expanded;
    setExpanded(next);
    if (next && ['idle', 'stale'].includes(status)) onLoad?.();
  };
  if (!items.length && status === 'idle') return <Pressable accessibilityLabel={t('sessions.timelineDetails')} accessibilityRole="button" onPress={toggleHistory} style={styles.timelineHistoryHeader} testID="session-timeline-load-button">
    <DisclosureChevron color={colors.textMuted} expanded={false} size={mobileWebMetric(15)} />
    <Text style={[styles.timelineHistoryTitle, { color: colors.textMuted }]}>{processedLabel}</Text>
  </Pressable>;
  if (!items.length && ['loading', 'stale'].includes(status)) return <View accessibilityState={{ busy: true }} style={styles.timelineHistoryHeader}>
    <ActivityIndicator animating color={colors.textMuted} size="small" testID="session-timeline-loading-indicator" />
    <Text style={[styles.timelineHistoryTitle, { color: colors.textMuted }]}>{processedLabel} · {t('sessions.timelineLoading')}</Text>
  </View>;
  if (!items.length && status === 'error') return <Pressable accessibilityRole="button" onPress={() => { setExpanded(true); onRetry?.(); }} style={styles.timelineHistoryHeader}>
    <ChevronRight color={colors.textMuted} size={mobileWebMetric(15)} />
    <Text style={[styles.timelineHistoryTitle, { color: colors.textMuted }]}>{processedLabel} · {t('sessions.timelineLoadFailed')}</Text>
    {error ? <Text numberOfLines={1} style={[styles.timelineHistoryError, { color: colors.textMuted }]}>{error}</Text> : null}
  </Pressable>;
  if (!items.length) return <View style={styles.timelineHistoryHeader}>
    <Timer color={colors.textMuted} size={mobileWebMetric(15)} />
    <Text style={[styles.timelineHistoryTitle, { color: colors.textMuted }]}>{processedLabel}</Text>
  </View>;
  return <View style={styles.timelineHistory}>
    <Pressable accessibilityLabel={t('sessions.timelineDetails')} accessibilityRole="button" accessibilityState={{ expanded }} onPress={toggleHistory} style={styles.timelineHistoryHeader}>
      <DisclosureChevron color={colors.textMuted} expanded={expanded} size={mobileWebMetric(15)} />
      <Text style={[styles.timelineHistoryTitle, { color: colors.textMuted }]}>{processedLabel}</Text>
    </Pressable>
    <AnimatedDisclosure expanded={expanded} spacing={mobileWebMetric(12)}>
      <View style={[styles.timelineHistoryItems, { borderLeftColor: colors.border }]} testID="session-timeline-history-items">{items.map((item) => <DetailItemContent conversation={false} item={item} key={item.id} onAddToConversation={onAddToConversation} onOpenBuiltinBrowser={onOpenBuiltinBrowser} onOpenFile={onOpenFile} timelineNested />)}</View>
    </AnimatedDisclosure>
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

function TimelineCurrentActivity({ item, onLoad, onAddToConversation, onOpenBuiltinBrowser, onOpenFile }: { item: DetailItem; onLoad?(): void; onAddToConversation?(text: string): void; onOpenBuiltinBrowser?(url: string): void | Promise<void>; onOpenFile?(href: string): void | Promise<void> }) {
  const { colors } = useMobileTheme();
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const [expandPending, setExpandPending] = useState(false);
  const nodes = item.history ?? [];
  const interactive = Boolean(item.interactive);
  const status = item.activityStatus ?? 'idle';
  const failed = status === 'error';
  const loading = expandPending && status !== 'ready' && status !== 'error';
  const revealed = expanded || (expandPending && status === 'ready');
  const toggleExpanded = () => {
    if (revealed) {
      setExpanded(false);
      setExpandPending(false);
      return;
    }
    if (expandPending) {
      if (failed) onLoad?.();
      else setExpandPending(false);
      return;
    }
    if (status === 'ready' || !onLoad) {
      setExpanded(true);
      return;
    }
    setExpandPending(true);
    onLoad();
  };
  const content = <>
    {interactive ? loading
      ? <ActivityIndicator animating color={colors.textMuted} size="small" testID="session-current-activity-loading" />
      : <DisclosureChevron color={colors.textMuted} expanded={revealed} size={mobileWebMetric(15)} /> : null}
    <ToolActivityText containerStyle={styles.toolText} numberOfLines={1} running={Boolean(item.streaming)} textStyle={styles.currentActivityText}>{item.text ?? ''}</ToolActivityText>
  </>;
  return <View style={styles.currentActivity}>
    {interactive ? <Pressable accessibilityRole="button" accessibilityState={{ busy: loading, expanded: revealed }} onPress={toggleExpanded} style={styles.currentActivityHeader}>{content}</Pressable>
      : <View style={styles.currentActivityHeader}>{content}</View>}
    {failed ? <Text accessibilityLiveRegion="polite" style={[styles.currentActivityError, { color: colors.textMuted }]}>{t('sessions.timelineLoadFailed')}</Text> : null}
    <AnimatedDisclosure expanded={revealed} spacing={mobileWebMetric(10)}><View style={styles.currentActivityItems} testID="session-current-activity-items">{nodes.length ? nodes.map((node) => node.role === 'activity'
      ? <TimelineActivityGroup activities={node.activities ?? []} key={node.id} summaryVisible={false} />
      : <DetailItemContent conversation={false} item={node} key={node.id} onAddToConversation={onAddToConversation} onOpenBuiltinBrowser={onOpenBuiltinBrowser} onOpenFile={onOpenFile} timelineNested />) : <Text style={[styles.currentActivityEmpty, { color: colors.textMuted }]}>{t('sessions.timelineNoActivities')}</Text>}</View></AnimatedDisclosure>
  </View>;
}

export function aiSessionDisplayTurns(session: ControlPlaneAiSessionSummary | undefined): AiSessionTurn[] {
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

export function latestAiSessionMessage(
  session: ControlPlaneAiSessionSummary | undefined,
  messages: readonly MobileStreamingMessage[],
) {
  if (!session) return undefined;
  const turns = aiSessionDisplayTurns(session);
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index];
    const streamed = activeMobileStreamingMessage(messages, turn.id)?.receivedText.trim();
    const message = streamed || turn.lastMessage?.trim() || turn.summary?.trim();
    if (message) return message;
  }
  return session.lastMessage?.trim() || session.summary?.trim() || undefined;
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
        <DisclosureChevron color={colors.textMuted} expanded={expanded} size={mobileWebMetric(14)} />
      </Pressable>
      <AnimatedDisclosure expanded={expanded} spacing={12}><View style={styles.subAgentList}>{agents.slice(0, 50).map((agent) => (
        <View key={agent.threadId} style={[styles.subAgent, { backgroundColor: colors.surface, borderColor: colors.border }]}> 
          <View style={styles.subAgentNameRow}>
            <View style={[styles.statusDot, { backgroundColor: ['running', 'pending-init'].includes(agent.status) ? colors.primary : colors.textMuted }]} />
            <Text numberOfLines={1} style={[styles.subAgentName, { color: colors.text }]}>{agent.path || agent.threadId}</Text>
          </View>
          <Text style={[styles.subAgentMeta, { color: colors.textMuted }]}>{agent.status} · {agent.activity || t('sessions.activityUnknown')} · {new Date(agent.updatedAt).toLocaleString(locale)}</Text>
          <Text style={[styles.subAgentMessage, { color: colors.textMuted }]}>{agent.message || t('sessions.noAgentMessage')}</Text>
        </View>
      ))}</View></AnimatedDisclosure>
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
  modePicker: { alignSelf: 'center', maxWidth: '100%', width: 210 },
  sessionBar: { alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between', minHeight: 36 },
  metaRow: { alignItems: 'center', flexDirection: 'row', gap: 8 },
  sessionContext: { alignItems: 'center', flex: 1, flexDirection: 'row', gap: 6, minWidth: 0 },
  sessionContextRow: { flex: 1 },
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
  currentActivity: { minWidth: 0 },
  currentActivityHeader: { alignItems: 'center', flexDirection: 'row', gap: mobileWebMetric(5), minHeight: mobileWebType.bodyLine },
  currentActivityText: { fontSize: mobileWebType.body, fontWeight: '400', lineHeight: mobileWebType.bodyLine },
  currentActivityEmpty: { fontSize: mobileWebType.small, lineHeight: mobileWebType.smallLine },
  currentActivityError: { fontSize: mobileWebType.small, lineHeight: mobileWebType.smallLine, marginLeft: mobileWebMetric(20) },
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
  promptBlock: { alignSelf: 'flex-end', borderRadius: 18, borderTopRightRadius: 6, paddingHorizontal: mobileWebMetric(14), paddingVertical: mobileWebMetric(12) },
  responseBlock: { alignSelf: 'stretch', paddingHorizontal: 2, paddingVertical: 4 },
  conversationUser: { alignSelf: 'flex-end', borderRadius: 18, borderTopRightRadius: 6, paddingHorizontal: mobileWebMetric(14), paddingVertical: mobileWebMetric(12) },
  conversationResponse: { alignSelf: 'stretch', maxWidth: '98%', minWidth: 0, paddingHorizontal: 2, paddingVertical: 4 },
  errorBlock: { alignItems: 'flex-start', borderRadius: 12, flexDirection: 'row', gap: 8, padding: 12 },
  contentError: { alignItems: 'center', borderRadius: 12, flexDirection: 'row', gap: 8, padding: 12 },
  contentErrorText: { flex: 1, fontSize: 13, lineHeight: 18 },
  contentErrorAction: { fontSize: 13, fontWeight: '500', lineHeight: 18 },
  errorText: { flex: 1, gap: 6 },
  role: { fontSize: mobileWebType.meta, fontWeight: '600', lineHeight: mobileWebType.metaLine, textTransform: 'capitalize' },
  timelineHistory: { minWidth: 0 },
  timelineHistoryHeader: { alignItems: 'center', flexDirection: 'row', gap: mobileWebMetric(5), minHeight: mobileWebType.bodyLine },
  timelineHistoryTitle: { fontSize: mobileWebType.body, lineHeight: mobileWebType.bodyLine },
  timelineHistoryError: { flex: 1, fontSize: mobileWebType.body, lineHeight: mobileWebType.bodyLine },
  timelineHistoryItems: {
    borderLeftWidth: StyleSheet.hairlineWidth,
    gap: mobileWebMetric(12),
    marginLeft: mobileWebMetric(7),
    paddingLeft: mobileWebMetric(12),
  },
  subAgents: { borderTopWidth: StyleSheet.hairlineWidth, marginTop: 8, paddingTop: 16 },
  subAgentHeader: { alignItems: 'center', flexDirection: 'row', gap: 10, minHeight: 44 },
  subAgentList: { gap: 12 },
  subAgentTitle: { flex: 1, fontSize: mobileWebType.meta, fontWeight: '700', lineHeight: mobileWebType.metaLine },
  subAgent: { borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, gap: 8, padding: 12 },
  subAgentNameRow: { alignItems: 'center', flexDirection: 'row', gap: 8 },
  subAgentName: { flex: 1, fontSize: mobileWebType.small, fontWeight: '600', lineHeight: mobileWebType.smallLine },
  subAgentMeta: { fontSize: mobileWebType.tiny, lineHeight: mobileWebMetric(15) },
  subAgentMessage: { fontSize: mobileWebType.small, lineHeight: mobileWebMetric(12 * 1.4) },
});
