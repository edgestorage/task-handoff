import { Profiler, useEffect, useMemo, useState, type ProfilerOnRenderCallback } from 'react';
import { ActivityIndicator, Alert, Animated, Pressable, StyleSheet, Text, View } from 'react-native';
import * as Crypto from 'expo-crypto';
import {
  aiSessionLastUserMessageAt,
  aiSessionStatusGroup,
  isAiSessionApprovalPending,
  redactedAiSessionError,
} from '@task-handoff/control-plane-client';

import type { AiSessionScope, MobileAiSessionProfileState } from './store';
import type { MobileDirectoryProfileState } from '../directories/store';
import { mobileMetrics } from '../observability/mobile-metrics';
import { useMobileTheme } from '../components/theme';
import { SystemIcon } from '../components/SystemIcon';
import { EmptyState } from '../components/EmptyState';
import { SwipeActionList } from '../components/SwipeActionList';
import { usePullToRefresh } from '../components/use-pull-to-refresh';
import { markdownPlainText } from '../components/SafeMarkdown';
import { sessionActivityText } from './SessionDetail';
import { ToolActivityText } from './ToolActivityText';
import { SessionStatusIndicator } from './SessionStatusIndicator';
import { useI18n } from '../i18n';
import {
  inboxCardContent,
  inboxEntries,
  inboxStatusMessage,
  matchesStatusFilter,
  statusFilterLabel,
  workspaceLabel,
  type SessionStatusFilter,
} from './InboxModel';
import { mobileAiSessionBusyKey, type MobileAiSessionActionCoordinator } from './actions';
import { formatSessionUpdatedTime } from '../session-time';

export { inboxCardContent, inboxEntries, sessionScopeOptions } from './InboxModel';

const ALL_SCOPE: AiSessionScope = { kind: 'all' };
const STATUS_FILTERS = ['all', 'active', 'waiting', 'idle', 'problem'] as const;
const STATUS_FILTER_PADDING = 3;

export function AiSessionInbox({
  actions,
  state,
  onOpen,
  directory,
  initialScope,
  onRefresh,
}: {
  actions?: MobileAiSessionActionCoordinator;
  state: MobileAiSessionProfileState;
  onOpen?(entry: { instanceId: string; sessionId: string }): void;
  directory?: Pick<MobileDirectoryProfileState, 'nodes' | 'instances'>;
  initialScope?: AiSessionScope;
  onRefresh?: () => Promise<void>;
}) {
  const { colors, dark } = useMobileTheme();
  const { locale, t } = useI18n();
  const scope = initialScope ?? ALL_SCOPE;
  const [statusFilter, setStatusFilter] = useState<SessionStatusFilter>('all');
  const [statusFilterTrackWidth, setStatusFilterTrackWidth] = useState(0);
  const [statusFilterOffset] = useState(() => new Animated.Value(0));
  const [closingKey, setClosingKey] = useState('');
  const pullToRefresh = usePullToRefresh(onRefresh);
  const instanceNodeIds = useMemo(() => new Map((directory?.instances ?? []).map((instance) => [instance.id, instance.nodeId])), [directory]);
  const instanceNames = useMemo(() => new Map((directory?.instances ?? []).map((instance) => [instance.id, instance.name])), [directory]);
  const allEntries = useMemo(() => inboxEntries(state.snapshot, scope, instanceNodeIds), [state.snapshot, scope, instanceNodeIds]);
  const entries = useMemo(() => allEntries.filter((entry) => matchesStatusFilter(entry.session, statusFilter)), [allEntries, statusFilter]);
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
  const statusMessage = inboxStatusMessage(state.sync, t);
  const statusFilterWidth = Math.max(0, (statusFilterTrackWidth - STATUS_FILTER_PADDING * 2) / STATUS_FILTERS.length);

  useEffect(() => {
    if (!statusFilterWidth) return;
    const animation = Animated.spring(statusFilterOffset, {
      damping: 24,
      mass: 0.75,
      stiffness: 260,
      toValue: STATUS_FILTERS.indexOf(statusFilter) * statusFilterWidth,
      useNativeDriver: true,
    });
    animation.start();
    return () => animation.stop();
  }, [statusFilter, statusFilterOffset, statusFilterWidth]);

  return (
    <Profiler id="inbox" onRender={recordInboxRender}>
      <>
      {state.sync.phase === 'loading' && !state.snapshot ? <ActivityIndicator accessibilityLabel={t('sessions.loadingAccessibility')} style={styles.loading} /> : (
        <SwipeActionList
          style={[styles.screen, { backgroundColor: colors.background }]}
          data={entries}
          itemContainerStyle={styles.cardContainer}
          keyExtractor={(item) => `${item.instanceId}:${item.session.id}`}
          ListHeaderComponent={<View style={styles.header}>
            <View
              accessibilityRole="tablist"
              onLayout={(event) => setStatusFilterTrackWidth(event.nativeEvent.layout.width)}
              style={[styles.statusFilters, { backgroundColor: colors.surfaceMuted }]}
            >
              {statusFilterWidth > 0 ? <Animated.View
                pointerEvents="none"
                style={[
                  styles.statusFilterSelection,
                  {
                    backgroundColor: colors.surface,
                    transform: [{ translateX: statusFilterOffset }],
                    width: statusFilterWidth,
                  },
                ]}
              /> : null}
              {STATUS_FILTERS.map((filter) => <Pressable accessibilityRole="tab" accessibilityState={{ selected: statusFilter === filter }} key={filter} onPress={() => setStatusFilter(filter)} style={styles.statusFilter}><Text style={[styles.statusFilterText, { color: statusFilter === filter ? colors.text : colors.textMuted }]}>{statusFilterLabel(filter, t)}</Text></Pressable>)}
            </View>
            {statusMessage ? <Text accessibilityLiveRegion="polite" style={[styles.notice, { backgroundColor: colors.notice, color: colors.noticeText }]}>{statusMessage}</Text> : null}
          </View>}
          ListEmptyComponent={<EmptyState
            icon={state.sync.phase === 'error'
              ? { android: 'error_outline', ios: 'exclamationmark.circle' }
              : { android: 'chat_bubble_outline', ios: 'bubble.left.and.bubble.right' }}
            iconColor={state.sync.phase === 'error' ? colors.error : undefined}
            message={state.sync.phase === 'error' ? t('sessions.loadError') : t('sessions.empty')}
            style={styles.empty}
          />}
          onRefresh={pullToRefresh.onRefresh}
          refreshing={pullToRefresh.refreshing}
          swipeAction={(item) => {
            const key = `${item.instanceId}:${item.session.id}`;
            return {
              disabled: !actions || state.sync.phase !== 'ready' || Boolean(closingKey),
              label: closingKey === key ? t('sessions.closing') : t('sessions.close'),
              onPress: () => requestCloseAiSession(item, key),
            };
          }}
          renderItem={({ item }) => {
            const error = redactedAiSessionError(item.session);
            const content = inboxCardContent(item.session, messagesBySession.get(sessionMessageGroupKey(item.instanceId, item.session.id)), t);
            const approvalPending = isAiSessionApprovalPending(item.session);
            const activityText = sessionActivityText(item.session, t);
            const statusGroup = aiSessionStatusGroup(item.session);
            const statusLabel = statusFilterLabel(statusGroup, t);
            const workspace = workspaceLabel(item.session.cwd, t);
            const identity = workspace.toLocaleLowerCase() === item.session.agent.toLocaleLowerCase()
              ? item.session.agent
              : `${item.session.agent} · ${workspace}`;
            const instanceName = instanceNames.get(item.instanceId) || item.instanceId;
            return (
              <Pressable accessibilityRole="button" onPress={() => onOpen?.({ instanceId: item.instanceId, sessionId: item.session.id })} style={[styles.cardContent, { backgroundColor: colors.surface, borderColor: colors.border, borderWidth: dark ? StyleSheet.hairlineWidth : 0 }]} testID="session-card">
                {item.session.unread ? <View accessibilityLabel={t('sessions.unread')} style={styles.unread} /> : null}
                <View style={[styles.row, item.session.unread && styles.rowWithUnread]}>
                  <View style={styles.sessionIdentity}>
                    <SessionStatusIndicator group={statusGroup} label={statusLabel} />
                    <View style={styles.sessionIdentityText}>
                      <Text numberOfLines={1} style={[styles.instanceName, { color: colors.text }]}>{instanceName}</Text>
                      <Text numberOfLines={1} style={[styles.meta, { color: colors.textMuted }]}>{identity}</Text>
                    </View>
                  </View>
                </View>
                <Text numberOfLines={2} style={[styles.promptPreview, { color: colors.text }]}>{markdownPlainText(content.prompt)}</Text>
                <Text numberOfLines={3} style={[styles.responsePreview, { color: colors.textMuted }]}>{markdownPlainText(content.response)}</Text>
                {approvalPending ? <View style={styles.activity}><SystemIcon android="approval" color={colors.noticeText} ios="hand.raised.fill" size={13} /><Text style={[styles.activityText, { color: colors.noticeText }]}>{t('sessions.approvalNeeded')}</Text></View> : null}
                <View style={styles.footerRow} testID="session-card-footer-row">
                  {activityText ? <View style={styles.footerActivity} testID="session-card-footer-activity"><SystemIcon android="auto_awesome" color={colors.textMuted} ios="sparkles" size={13} /><ToolActivityText containerStyle={styles.activityTextContainer} running={item.session.status === 'running'} textStyle={styles.footerActivityText}>{activityText}</ToolActivityText></View> : null}
                  <Text style={[styles.time, { color: colors.textMuted }]}>{formatSessionUpdatedTime(aiSessionLastUserMessageAt(item.session) || item.session.startedAt, locale, t('sessions.yesterday'))}</Text>
                </View>
                {error ? <Text style={[styles.error, { color: colors.error }]}>{error}</Text> : null}
              </Pressable>
            );
          }}
          />
      )}
      </>
    </Profiler>
  );

  function requestCloseAiSession(item: (typeof entries)[number], key: string) {
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
  loading: { flex: 1 },
  empty: { minHeight: 240 },
  statusFilters: { borderRadius: 999, flexDirection: 'row', padding: STATUS_FILTER_PADDING, position: 'relative', width: '100%' },
  statusFilterSelection: { borderRadius: 999, bottom: STATUS_FILTER_PADDING, left: STATUS_FILTER_PADDING, position: 'absolute', top: STATUS_FILTER_PADDING },
  statusFilter: { alignItems: 'center', borderRadius: 999, flex: 1, justifyContent: 'center', minHeight: 34, paddingHorizontal: 4, zIndex: 1 },
  statusFilterText: { fontSize: 14, fontWeight: '600', lineHeight: 20 },
  cardContainer: { borderRadius: 16, marginBottom: 12, marginHorizontal: 20 },
  cardContent: { borderRadius: 16, borderWidth: StyleSheet.hairlineWidth, gap: 10, padding: 16, paddingVertical: 12 },
  row: { alignItems: 'center', flexDirection: 'row', gap: 8 },
  rowWithUnread: { paddingRight: 18 },
  footerRow: { alignItems: 'center', flexDirection: 'row', gap: 12, justifyContent: 'flex-end', minHeight: 18 },
  footerActivity: { alignItems: 'center', flex: 1, flexDirection: 'row', gap: 8, minWidth: 0 },
  sessionIdentity: { alignItems: 'center', flex: 1, flexDirection: 'row', gap: 9, minWidth: 0 },
  sessionIdentityText: { flex: 1, gap: 1, minWidth: 0 },
  instanceName: { fontSize: 15, fontWeight: '700', lineHeight: 20 },
  cardTitle: { color: '#0f172a', flex: 1, fontSize: 16, fontWeight: '700' },
  promptPreview: { fontSize: 17, fontWeight: '600', lineHeight: 22 },
  responsePreview: { fontSize: 15, lineHeight: 20, minHeight: 60 },
  unread: { backgroundColor: '#2563eb', borderRadius: 5, height: 10, position: 'absolute', right: 16, top: 16, width: 10, zIndex: 1 },
  summary: { color: '#475569', fontSize: 13, lineHeight: 19 },
  meta: { color: '#475569', fontSize: 13, lineHeight: 18, textTransform: 'capitalize' },
  activity: { alignItems: 'center', alignSelf: 'stretch', flexDirection: 'row', gap: 8, minHeight: 24 },
  activityTextContainer: { flexShrink: 1 },
  activityText: { fontSize: 13, fontWeight: '500', lineHeight: 18 },
  footerActivityText: { fontSize: 15, fontWeight: '500', lineHeight: 20 },
  time: { color: '#64748b', flexShrink: 0, fontSize: 12, lineHeight: 17 },
  error: { color: '#b91c1c', fontSize: 13, lineHeight: 18 },
});
