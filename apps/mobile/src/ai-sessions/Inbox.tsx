import { Profiler, useEffect, useMemo, useState, useSyncExternalStore, type ProfilerOnRenderCallback, type ReactNode } from 'react';
import { Alert, Animated, Easing, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import * as Crypto from 'expo-crypto';
import { Boxes, Folder } from 'lucide-react-native';
import {
  aiSessionLastUserMessageAt,
  aiSessionStatusGroup,
  isAiSessionApprovalPending,
  type ControlPlaneClient,
  type ControlPlaneNodeLocalFolder,
} from '@task-handoff/control-plane-client';

import type { AiSessionScope, MobileAiSessionProfileState } from './store';
import type { MobileDirectoryProfileState } from '../directories/store';
import { mobileMetrics } from '../observability/mobile-metrics';
import { useMobileTheme } from '../components/theme';
import { AiAgentIcon, aiAgentKind } from '../components/AiAgentIcon';
import { Icon } from '../components/Icon';
import { EmptyState } from '../components/EmptyState';
import { InitialSyncLoading, type InitialSyncConnection } from '../components/InitialSyncLoading';
import { SwipeActionList } from '../components/SwipeActionList';
import { SwipeToClose } from '../components/SwipeToClose';
import { usePullToRefresh } from '../components/use-pull-to-refresh';
import { markdownPlainText } from '../components/SafeMarkdown';
import { sessionActivityText } from './SessionDetail';
import { ToolActivityText } from './ToolActivityText';
import { SessionStatusIndicator } from './SessionStatusIndicator';
import { useI18n } from '../i18n';
import {
  aiSessionInboxSections,
  inboxCardContent,
  inboxHierarchyEntries,
  inboxIsAwaitingInitialSync,
  inboxStatusMessage,
  statusFilterLabel,
  workspaceLabel,
  type AiSessionInboxGroupSection,
  type AiSessionHierarchyInboxEntry,
  type SessionStatusFilter,
} from './InboxModel';
import { getAiSessionInboxViewPreferences, subscribeAiSessionInboxViewPreferences, updateAiSessionInboxViewPreferences } from './inbox-view-preferences';
import { mobileAiSessionBusyKey, type MobileAiSessionActionCoordinator } from './actions';
import { formatSessionUpdatedTime } from '../session-time';

export { inboxCardContent, inboxEntries, sessionScopeOptions } from './InboxModel';

const ALL_SCOPE: AiSessionScope = { kind: 'all' };
const STATUS_FILTERS = ['all', 'active', 'waiting', 'idle', 'problem'] as const;
const STATUS_FILTER_PADDING = 3;
const GROUP_COLLAPSE_DURATION = 170;
const GROUP_EXPAND_DURATION = 220;
const GROUP_DISCLOSURE_DURATION = 200;
const LIST_ROW_PADDING_HORIZONTAL = 10;
const LIST_ROW_GAP = 8;
const LIST_LEADING_SLOT_WIDTH = 20;

export function AiSessionInbox({
  actions,
  api,
  state,
  onOpen,
  directory,
  initialScope,
  onRefresh,
  connection,
  selected,
}: {
  actions?: MobileAiSessionActionCoordinator;
  api?: Pick<ControlPlaneClient, 'resources'>;
  state: MobileAiSessionProfileState;
  onOpen?(entry: { instanceId: string; sessionId: string }): void;
  directory?: Pick<MobileDirectoryProfileState, 'nodes' | 'instances'>;
  initialScope?: AiSessionScope;
  onRefresh?: () => Promise<void>;
  connection?: InitialSyncConnection;
  selected?: { instanceId: string; sessionId: string };
}) {
  const { colors } = useMobileTheme();
  const { locale, t } = useI18n();
  const scope = initialScope ?? ALL_SCOPE;
  const [statusFilter, setStatusFilter] = useState<SessionStatusFilter>('all');
  const [closingKey, setClosingKey] = useState('');
  const [expandedSessionIds, setExpandedSessionIds] = useState<Set<string>>(() => new Set());
  const [folders, setFolders] = useState<readonly ControlPlaneNodeLocalFolder[]>([]);
  const preferences = useSyncExternalStore(subscribeAiSessionInboxViewPreferences, getAiSessionInboxViewPreferences, getAiSessionInboxViewPreferences);
  const collapsedGroupKeys = useMemo(() => new Set(preferences.collapsedGroupKeys), [preferences.collapsedGroupKeys]);
  const listLayout = preferences.layout === 'list';
  const pullToRefresh = usePullToRefresh(onRefresh);
  const instanceNodeIds = useMemo(() => new Map((directory?.instances ?? []).map((instance) => [instance.id, instance.nodeId])), [directory]);
  const instanceNames = useMemo(() => new Map((directory?.instances ?? []).map((instance) => [instance.id, instance.name])), [directory]);
  const entries = useMemo(() => inboxHierarchyEntries(state.snapshot, scope, instanceNodeIds, {
    expandedSessionIds,
    statusFilter,
  }), [expandedSessionIds, instanceNodeIds, scope, state.snapshot, statusFilter]);
  const pathGroupNodeIdsKey = useMemo(() => {
    if (preferences.groupBy !== 'path') return '';
    const nodeIds = new Set<string>();
    for (const entry of entries) {
      const nodeId = instanceNodeIds.get(entry.instanceId);
      if (nodeId) nodeIds.add(nodeId);
    }
    return [...nodeIds].sort().join('\u0000');
  }, [entries, instanceNodeIds, preferences.groupBy]);
  useEffect(() => {
    if (!api || !pathGroupNodeIdsKey) return;
    const controller = new AbortController();
    void Promise.all(pathGroupNodeIdsKey.split('\u0000').map((nodeId) => (
      api.resources.nodeLocalFolders(nodeId, controller.signal).catch(() => [])
    ))).then((folderLists) => {
      if (!controller.signal.aborted) setFolders(folderLists.flat());
    }).catch(() => undefined);
    return () => controller.abort();
  }, [api, pathGroupNodeIdsKey]);
  const sections = useMemo(
    () => aiSessionInboxSections(entries, directory, preferences.groupBy, preferences.sortByStatus, t, collapsedGroupKeys, folders, locale),
    [collapsedGroupKeys, directory, entries, folders, locale, preferences.groupBy, preferences.sortByStatus, t],
  );
  const messagesBySession = useMemo(() => {
    const grouped = new Map<string, MobileAiSessionProfileState['messages'][string][]>();
    for (const message of Object.values(state.messages)) {
      const key = sessionMessageGroupKey(message.instanceId, message.sessionId);
      const messages = grouped.get(key) ?? [];
      messages.push(message);
      grouped.set(key, messages);
    }
    return grouped;
  }, [state.messages]);
  const awaitingInitialSync = inboxIsAwaitingInitialSync(state);
  const statusMessage = inboxStatusMessage(state.sync, t);

  if (awaitingInitialSync) {
    return (
      <Profiler id="inbox" onRender={recordInboxRender}>
        <InitialSyncLoading
          connection={connection}
          resource="aiSessions"
          testID="session-inbox-loading"
        />
      </Profiler>
    );
  }

  return (
    <Profiler id="inbox" onRender={recordInboxRender}>
      <SwipeActionList
          style={[styles.screen, { backgroundColor: colors.background }]}
          data={sections}
          itemContainerStyle={(item) => item.type === 'group' ? styles.groupContainer : sessionContainerStyle(item, false)}
          keyExtractor={(item) => item.type === 'group' ? item.key : `${item.instanceId}:${item.session.id}`}
          ListHeaderComponent={<View style={styles.header}>
            <View
              accessibilityRole="tablist"
              style={[styles.statusFilters, { backgroundColor: colors.workbenchSelectionBackground }]}
              testID="session-status-filters"
            >
              <ScrollView
                bounces={false}
                contentContainerStyle={styles.statusFilterContent}
                contentInsetAdjustmentBehavior="never"
                horizontal
                keyboardShouldPersistTaps="handled"
                showsHorizontalScrollIndicator={false}
                testID="session-status-filter-scroll"
              >
                {STATUS_FILTERS.map((filter) => <Pressable accessibilityRole="tab" accessibilityState={{ selected: statusFilter === filter }} key={filter} onPress={() => setStatusFilter(filter)} style={[styles.statusFilter, { backgroundColor: statusFilter === filter ? colors.statusFilterSelectedBackground : 'transparent' }]} testID={`session-status-filter-${filter}`}><Text numberOfLines={1} style={[styles.statusFilterText, { color: statusFilter === filter ? colors.text : colors.textMuted }]}>{statusFilterLabel(filter, t)}</Text></Pressable>)}
              </ScrollView>
            </View>
            {statusMessage ? <Text accessibilityLiveRegion="polite" style={[styles.notice, { backgroundColor: colors.notice, color: colors.noticeText }]}>{statusMessage}</Text> : null}
          </View>}
          ListEmptyComponent={<EmptyState
            icon={state.sync.phase === 'error'
              ? 'alert-circle-outline'
              : 'chatbubbles-outline'}
            iconColor={state.sync.phase === 'error' ? colors.error : undefined}
            message={state.sync.phase === 'error' ? t('sessions.loadError') : t('sessions.empty')}
            style={styles.empty}
          />}
          onRefresh={pullToRefresh.onRefresh}
          refreshing={pullToRefresh.refreshing}
          swipeAction={(item) => item.type === 'group' ? null : sessionSwipeAction(item)}
          renderItem={({ item }) => item.type === 'group'
            ? <AiSessionGroup group={item} onToggle={() => toggleGroup(item.key)} renderEntry={renderSwipeableSession} />
            : renderSessionEntry(item)}
          />
    </Profiler>
  );

  function sessionSwipeAction(item: AiSessionHierarchyInboxEntry) {
    const key = `${item.instanceId}:${item.session.id}`;
    return {
      disabled: !actions || state.sync.phase !== 'ready' || Boolean(closingKey),
      label: closingKey === key ? t('sessions.closing') : t('sessions.close'),
      onPress: () => requestCloseAiSession(item, key),
    };
  }

  function sessionContainerStyle(item: AiSessionHierarchyInboxEntry, grouped: boolean) {
    const container = grouped
      ? (listLayout ? styles.groupListRowContainer : styles.groupCardContainer)
      : (listLayout ? styles.listRowContainer : styles.cardContainer);
    return [container, item.depth ? { marginLeft: (grouped ? 0 : 20) + item.depth * 14 } : null];
  }

  function renderSwipeableSession(item: AiSessionHierarchyInboxEntry) {
    const action = sessionSwipeAction(item);
    return <SwipeToClose
      containerStyle={sessionContainerStyle(item, true)}
      disabled={action.disabled}
      key={`${item.instanceId}:${item.session.id}`}
      label={action.label}
      onClose={action.onPress}
    >{renderSessionEntry(item)}</SwipeToClose>;
  }

  function renderSessionEntry(item: AiSessionHierarchyInboxEntry) {
    const error = item.session.status === 'failed' ? item.session.error : undefined;
    const content = inboxCardContent(item.session, messagesBySession.get(sessionMessageGroupKey(item.instanceId, item.session.id)), t);
    const approvalPending = isAiSessionApprovalPending(item.session);
    const activityText = sessionActivityText(item.session, t);
    const statusGroup = aiSessionStatusGroup(item.session);
    const statusLabel = statusFilterLabel(statusGroup, t);
    const workspace = workspaceLabel(item.session.cwd, t);
    const agent = aiAgentKind(item.session.agent);
    const instanceName = instanceNames.get(item.instanceId) || item.instanceId;
    const isSelected = selected?.instanceId === item.instanceId && selected.sessionId === item.session.id;
    const updatedAt = aiSessionLastUserMessageAt(item.session) || item.session.startedAt;
    const timeLabel = formatSessionUpdatedTime(updatedAt, locale, t('sessions.yesterday'));
    if (listLayout) return (
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ selected: isSelected }}
        onPress={() => onOpen?.({ instanceId: item.instanceId, sessionId: item.session.id })}
        style={({ pressed }) => [styles.listRow, isSelected && { backgroundColor: colors.workbenchSelectionBackground }, pressed && styles.pressed]}
        testID="session-list-row"
      >
        {item.hasChildren ? <Pressable
          accessibilityLabel={t(expandedSessionIds.has(item.session.id) ? 'sessions.collapseSubSessions' : 'sessions.expandSubSessions')}
          accessibilityRole="button"
          accessibilityState={{ expanded: expandedSessionIds.has(item.session.id) }}
          hitSlop={10}
          onPress={(event) => { event.stopPropagation(); toggleSessionExpanded(item.session.id); }}
          style={styles.listDisclosure}
          testID="session-disclosure"
        ><Icon color={colors.textMuted} name={expandedSessionIds.has(item.session.id) ? 'chevron-down' : 'chevron-forward'} size={17} /></Pressable> : <View style={styles.listStatus} testID="session-status-leading"><SessionStatusIndicator group={statusGroup} hideIdle label={statusLabel} /></View>}
        <View style={styles.listCopy}>
          <Text numberOfLines={1} style={[styles.listTitle, { color: colors.text }]}>{markdownPlainText(content.prompt)}</Text>
          <Text numberOfLines={1} style={[styles.listMeta, { color: colors.textMuted }]}>{instanceName} · {workspace}</Text>
        </View>
        {item.session.unread ? <View accessibilityLabel={t('sessions.unread')} style={[styles.listUnread, { backgroundColor: colors.primary }]} /> : null}
        <Text style={[styles.listTime, { color: colors.textMuted }]}>{timeLabel}</Text>
      </Pressable>
    );
    return (
      <Pressable accessibilityRole="button" accessibilityState={{ selected: isSelected }} onPress={() => onOpen?.({ instanceId: item.instanceId, sessionId: item.session.id })} style={[styles.cardContent, {
        backgroundColor: isSelected ? colors.workbenchSelectionBackground : colors.surface,
        borderColor: isSelected ? colors.workbenchSelectionBorder : colors.workbenchCardBorder,
      }]} testID="session-card">
        {item.session.unread ? <View accessibilityLabel={t('sessions.unread')} style={styles.unread} /> : null}
        <View style={[styles.row, item.session.unread && styles.rowWithUnread]}>
          <View style={styles.sessionIdentity} testID="session-identity">
            {item.hasChildren ? <Pressable
              accessibilityLabel={t(expandedSessionIds.has(item.session.id) ? 'sessions.collapseSubSessions' : 'sessions.expandSubSessions')}
              accessibilityRole="button"
              accessibilityState={{ expanded: expandedSessionIds.has(item.session.id) }}
              hitSlop={12}
              onPress={(event) => { event.stopPropagation(); toggleSessionExpanded(item.session.id); }}
              style={styles.disclosure}
              testID="session-disclosure"
            ><Icon color={colors.textMuted} name={expandedSessionIds.has(item.session.id) ? 'chevron-down' : 'chevron-forward'} size={18} /></Pressable> : <View style={styles.leadingIcon} testID="session-status-leading"><SessionStatusIndicator group={statusGroup} label={statusLabel} /></View>}
            <View style={styles.sessionIdentityText}>
              <View style={styles.workspaceContext} testID="session-workspace-context">
                <View style={styles.contextItem}>
                  <Folder color={colors.textMuted} size={14} />
                  <Text numberOfLines={1} style={[styles.workspaceName, { color: colors.textMuted }]}>{workspace}</Text>
                </View>
                <Text aria-hidden style={[styles.contextSeparator, { color: colors.textMuted }]}>·</Text>
                <View style={[styles.contextItem, styles.instanceContext]} testID="session-instance-context">
                  <Boxes color={colors.textMuted} size={14} />
                  <Text numberOfLines={1} style={[styles.instanceName, { color: colors.textMuted }]}>{instanceName}</Text>
                </View>
                <Text aria-hidden style={[styles.contextSeparator, { color: colors.textMuted }]}>·</Text>
                {agent
                  ? <AiAgentIcon agent={agent} color={colors.textMuted} label={item.session.agent} />
                  : <Text numberOfLines={1} style={[styles.agentFallback, { color: colors.textMuted }]}>{item.session.agent}</Text>}
              </View>
            </View>
          </View>
        </View>
        <Text numberOfLines={2} style={[styles.promptPreview, { color: colors.text }]}>{markdownPlainText(content.prompt)}</Text>
        <Text numberOfLines={3} style={[styles.responsePreview, { color: colors.textMuted }]}>{markdownPlainText(content.response)}</Text>
        {approvalPending ? <View style={styles.activity}><Icon color={colors.noticeText} name="hand-left" size={13} /><Text style={[styles.activityText, { color: colors.noticeText }]}>{t('sessions.approvalNeeded')}</Text></View> : null}
        <View style={styles.footerRow} testID="session-card-footer-row">
          {activityText ? <View style={styles.footerActivity} testID="session-card-footer-activity"><ToolActivityText containerStyle={styles.activityTextContainer} running={item.session.status === 'running'} textStyle={styles.footerActivityText}>{activityText}</ToolActivityText></View> : null}
          <Text style={[styles.time, { color: colors.textMuted }]}>{timeLabel}</Text>
        </View>
        {error ? <Text numberOfLines={3} style={[styles.error, { color: colors.error }]}>{error}</Text> : null}
      </Pressable>
    );
  }

  function requestCloseAiSession(item: AiSessionHierarchyInboxEntry, key: string) {
    const content = inboxCardContent(item.session, messagesBySession.get(sessionMessageGroupKey(item.instanceId, item.session.id)), t);
    Alert.alert(
      t('sessions.closeConfirmTitle', { name: (item.session.title || content.prompt).slice(0, 80) }),
      t('sessions.closeConfirmDescription'),
      [
        { text: t('common.cancel'), style: 'cancel' },
        {
          text: t('sessions.close'),
          style: 'destructive',
          onPress: () => {
            if (!actions) return;
            setClosingKey(key);
            void actions.close(item.instanceId, item.session.id, Crypto.randomUUID()).then((result) => {
              if (result.disposition !== 'accepted') {
                const actionState = actions.state(mobileAiSessionBusyKey(state.controlPlaneId, item.instanceId, item.session.id, 'close'));
                Alert.alert(t('sessions.closeFailed'), actionState.error);
              }
            }).finally(() => setClosingKey((current) => current === key ? '' : current));
          },
        },
      ],
    );
  }

  function toggleSessionExpanded(sessionId: string) {
    setExpandedSessionIds((current) => {
      const next = new Set(current);
      if (next.has(sessionId)) next.delete(sessionId);
      else next.add(sessionId);
      return next;
    });
  }

  function toggleGroup(groupKey: string) {
    const next = new Set(preferences.collapsedGroupKeys);
    if (next.has(groupKey)) next.delete(groupKey);
    else next.add(groupKey);
    updateAiSessionInboxViewPreferences({ collapsedGroupKeys: [...next] });
  }
}

function AiSessionGroup({ group, onToggle, renderEntry }: {
  group: AiSessionInboxGroupSection;
  onToggle(): void;
  renderEntry(entry: AiSessionHierarchyInboxEntry): ReactNode;
}) {
  const { colors } = useMobileTheme();
  const { t } = useI18n();
  const [progress] = useState(() => new Animated.Value(group.collapsed ? 0 : 1));
  const [contentHeight, setContentHeight] = useState<number>();
  const [keepMounted, setKeepMounted] = useState(!group.collapsed);
  useEffect(() => {
    if (!group.collapsed && contentHeight === undefined) return;
    const animation = Animated.timing(progress, {
      duration: group.collapsed ? GROUP_COLLAPSE_DURATION : GROUP_EXPAND_DURATION,
      easing: group.collapsed ? Easing.in(Easing.cubic) : Easing.out(Easing.cubic),
      toValue: group.collapsed ? 0 : 1,
      useNativeDriver: false,
    });
    animation.start(({ finished }) => {
      if (!finished) return;
      setKeepMounted(!group.collapsed);
      if (group.collapsed) setContentHeight(undefined);
    });
    return () => animation.stop();
  }, [contentHeight, group.collapsed, progress]);
  return <View>
    <Pressable
      accessibilityLabel={t(group.collapsed ? 'sessions.inbox.expandGroup' : 'sessions.inbox.collapseGroup', { name: group.label })}
      accessibilityRole="button"
      accessibilityState={{ expanded: !group.collapsed }}
      onPress={onToggle}
      style={({ pressed }) => [styles.groupHeader, pressed && styles.groupHeaderPressed]}
      testID="session-group-header"
    >
      <View style={styles.groupDisclosure} testID="session-group-disclosure"><GroupDisclosure collapsed={group.collapsed} color={colors.textMuted} /></View>
      <Text numberOfLines={1} style={[styles.groupLabel, { color: colors.text }]} testID="session-group-label">{group.label}</Text>
      <Text style={[styles.groupCount, { color: colors.textMuted }]}>{group.count}</Text>
    </Pressable>
    {(!group.collapsed || keepMounted) ? <Animated.View
      accessibilityElementsHidden={group.collapsed}
      importantForAccessibility={group.collapsed ? 'no-hide-descendants' : 'auto'}
      pointerEvents={group.collapsed ? 'none' : 'auto'}
      style={[styles.groupChildren, { height: progress.interpolate({ inputRange: [0, 1], outputRange: [0, contentHeight ?? 0] }), opacity: progress }]}
      testID="session-group-content"
    >
      <View onLayout={(event) => {
        const next = event.nativeEvent.layout.height;
        setContentHeight((current) => (current !== undefined && Math.abs(current - next) < 0.5 ? current : next));
      }} style={styles.groupChildrenInner}>
        {group.entries.map(renderEntry)}
      </View>
    </Animated.View> : null}
  </View>;
}

function GroupDisclosure({ collapsed, color }: { collapsed: boolean; color: string }) {
  const [rotation] = useState(() => new Animated.Value(collapsed ? 0 : 1));
  useEffect(() => {
    const animation = Animated.timing(rotation, {
      duration: GROUP_DISCLOSURE_DURATION,
      easing: Easing.out(Easing.cubic),
      toValue: collapsed ? 0 : 1,
      useNativeDriver: true,
    });
    animation.start();
    return () => animation.stop();
  }, [collapsed, rotation]);
  return <Animated.View style={{ transform: [{ rotate: rotation.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '90deg'] }) }] }}>
    <Icon color={color} name="chevron-forward" size={15} />
  </Animated.View>;
}

function sessionMessageGroupKey(instanceId: string, sessionId: string) {
  return JSON.stringify([instanceId, sessionId]);
}

const recordInboxRender: ProfilerOnRenderCallback = (_id, _phase, actualDuration) => {
  mobileMetrics.record('render.duration', { screen: 'inbox' }, actualDuration);
};

const styles = StyleSheet.create({
  screen: { backgroundColor: '#f8fafc', flex: 1 },
  header: { alignItems: 'flex-start', gap: 12, paddingHorizontal: 20, paddingBottom: 12, paddingTop: 16 },
  notice: { backgroundColor: '#fef3c7', borderRadius: 10, color: '#854d0e', fontSize: 13, lineHeight: 18, padding: 12, width: '100%' },
  empty: { minHeight: 240 },
  statusFilters: { borderRadius: 999, overflow: 'hidden', width: '100%' },
  statusFilterContent: { flexDirection: 'row', flexGrow: 1, minWidth: '100%', padding: STATUS_FILTER_PADDING },
  statusFilter: { alignItems: 'center', borderRadius: 999, flexGrow: 1, flexShrink: 0, justifyContent: 'center', minHeight: 34, minWidth: 44, paddingHorizontal: 5 },
  statusFilterText: { fontSize: 14, fontWeight: '600', lineHeight: 20 },
  cardContainer: { borderRadius: 16, marginBottom: 12, marginHorizontal: 20 },
  listRowContainer: { marginBottom: 2, marginHorizontal: 20 },
  groupContainer: { marginHorizontal: 20 },
  groupCardContainer: { borderRadius: 16, marginBottom: 12 },
  groupListRowContainer: { marginBottom: 2 },
  groupChildren: { overflow: 'hidden' },
  groupChildrenInner: { left: 0, position: 'absolute', right: 0, top: 0 },
  groupDisclosure: { alignItems: 'center', height: 24, justifyContent: 'center', width: LIST_LEADING_SLOT_WIDTH },
  groupHeader: { alignItems: 'center', flexDirection: 'row', gap: LIST_ROW_GAP, minHeight: 36, paddingBottom: 6, paddingLeft: LIST_ROW_PADDING_HORIZONTAL, paddingRight: 2, paddingTop: 4 },
  groupHeaderPressed: { opacity: 0.65 },
  groupLabel: { flex: 1, fontSize: 14, fontWeight: '600', lineHeight: 20 },
  groupCount: { fontSize: 13, fontWeight: '400', lineHeight: 18 },
  cardContent: { borderRadius: 16, borderWidth: 1, gap: 8, paddingBottom: 12, paddingHorizontal: 16, paddingTop: 10 },
  listRow: { alignItems: 'center', borderRadius: 10, flexDirection: 'row', gap: LIST_ROW_GAP, minHeight: 50, paddingHorizontal: LIST_ROW_PADDING_HORIZONTAL, paddingVertical: 7 },
  listDisclosure: { alignItems: 'center', height: 24, justifyContent: 'center', width: LIST_LEADING_SLOT_WIDTH },
  listStatus: { alignItems: 'center', height: 24, justifyContent: 'center', width: LIST_LEADING_SLOT_WIDTH },
  listCopy: { flex: 1, gap: 1, minWidth: 0 },
  listTitle: { fontSize: 15, fontWeight: '500', lineHeight: 20 },
  listMeta: { fontSize: 12, lineHeight: 16 },
  listUnread: { borderRadius: 999, flexShrink: 0, height: 7, width: 7 },
  listTime: { flexShrink: 0, fontSize: 12, lineHeight: 17 },
  pressed: { opacity: 0.65 },
  row: { alignItems: 'center', flexDirection: 'row', minHeight: 20 },
  rowWithUnread: { paddingRight: 18 },
  footerRow: { alignItems: 'center', flexDirection: 'row', gap: 12, justifyContent: 'flex-end', minHeight: 18 },
  footerActivity: { alignItems: 'center', flex: 1, flexDirection: 'row', gap: 8, minWidth: 0 },
  sessionIdentity: { alignItems: 'center', flex: 1, flexDirection: 'row', gap: 6, minWidth: 0 },
  leadingIcon: { alignItems: 'center', height: 14, justifyContent: 'center', width: 14 },
  disclosure: { alignItems: 'center', height: 20, justifyContent: 'center', width: 18 },
  sessionIdentityText: { flex: 1, minWidth: 0 },
  workspaceContext: { alignItems: 'center', flex: 1, flexDirection: 'row', gap: 6, minWidth: 0, overflow: 'hidden' },
  contextItem: { alignItems: 'center', flexDirection: 'row', flexShrink: 1, gap: 5, minWidth: 0 },
  instanceContext: { flexShrink: 1.2 },
  workspaceName: { flexShrink: 1, fontSize: 13, fontWeight: '400', lineHeight: 20, minWidth: 0 },
  contextSeparator: { flexShrink: 0, fontSize: 13, lineHeight: 20 },
  agentFallback: { flexShrink: 0, fontSize: 13, lineHeight: 20 },
  instanceName: { flexShrink: 1, fontSize: 13, fontWeight: '400', lineHeight: 20, minWidth: 0 },
  promptPreview: { fontSize: 17, fontWeight: '600', lineHeight: 22 },
  responsePreview: { fontSize: 15, lineHeight: 20, minHeight: 60 },
  unread: { backgroundColor: '#2563eb', borderRadius: 5, height: 10, position: 'absolute', right: 16, top: 16, width: 10, zIndex: 1 },
  activity: { alignItems: 'center', alignSelf: 'stretch', flexDirection: 'row', gap: 8, minHeight: 24 },
  activityTextContainer: { flexShrink: 1 },
  activityText: { fontSize: 13, fontWeight: '500', lineHeight: 18 },
  footerActivityText: { fontSize: 14, fontWeight: '400', lineHeight: 20 },
  time: { color: '#64748b', flexShrink: 0, fontSize: 12, lineHeight: 17 },
  error: { color: '#b91c1c', fontSize: 13, lineHeight: 18 },
});
