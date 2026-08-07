import { Profiler, useEffect, useMemo, useState, type ProfilerOnRenderCallback } from 'react';
import { ActivityIndicator, Alert, Animated, FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
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
import { SwipeToClose } from '../components/SwipeToClose';
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

export { inboxCardContent, inboxEntries, sessionScopeOptions } from './InboxModel';

const ALL_SCOPE: AiSessionScope = { kind: 'all' };
const STATUS_FILTERS = ['all', 'active', 'waiting', 'idle', 'problem'] as const;
const STATUS_FILTER_PADDING = 2;

export function AiSessionInbox({
  actions,
  state,
  onOpen,
  directory,
  initialScope,
}: {
  actions?: MobileAiSessionActionCoordinator;
  state: MobileAiSessionProfileState;
  onOpen?(entry: { instanceId: string; sessionId: string }): void;
  directory?: Pick<MobileDirectoryProfileState, 'nodes' | 'instances'>;
  initialScope?: AiSessionScope;
}) {
  const { colors, dark } = useMobileTheme();
  const { locale, t } = useI18n();
  const scope = initialScope ?? ALL_SCOPE;
  const [statusFilter, setStatusFilter] = useState<SessionStatusFilter>('all');
  const [statusFilterTrackWidth, setStatusFilterTrackWidth] = useState(0);
  const [statusFilterOffset] = useState(() => new Animated.Value(0));
  const [closingKey, setClosingKey] = useState('');
  const instanceNodeIds = useMemo(() => new Map((directory?.instances ?? []).map((instance) => [instance.id, instance.nodeId])), [directory]);
  const instanceNames = useMemo(() => new Map((directory?.instances ?? []).map((instance) => [instance.id, instance.name])), [directory]);
  const allEntries = useMemo(() => inboxEntries(state.snapshot, scope, instanceNodeIds), [state.snapshot, scope, instanceNodeIds]);
  const entries = useMemo(() => allEntries.filter((entry) => matchesStatusFilter(entry.session, statusFilter)), [allEntries, statusFilter]);
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
        <FlatList
          style={[styles.screen, { backgroundColor: colors.background }]}
          contentInsetAdjustmentBehavior="automatic"
          contentContainerStyle={styles.list}
          data={entries}
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
          ListEmptyComponent={<View style={styles.empty}><Text style={[styles.emptyText, { color: colors.textMuted }]}>{state.sync.phase === 'error' ? t('sessions.loadError') : t('sessions.empty')}</Text></View>}
          renderItem={({ item }) => {
            const error = redactedAiSessionError(item.session);
            const content = inboxCardContent(item.session, Object.values(state.messages).filter((message) => message.instanceId === item.instanceId && message.sessionId === item.session.id), t);
            const approvalPending = isAiSessionApprovalPending(item.session);
            const activityText = sessionActivityText(item.session, t);
            const statusGroup = aiSessionStatusGroup(item.session);
            const statusLabel = statusFilterLabel(statusGroup, t);
            const workspace = workspaceLabel(item.session.cwd, t);
            const identity = workspace.toLocaleLowerCase() === item.session.agent.toLocaleLowerCase()
              ? item.session.agent
              : `${item.session.agent} · ${workspace}`;
            const instanceName = instanceNames.get(item.instanceId) || item.instanceId;
            const key = `${item.instanceId}:${item.session.id}`;
            const close = () => Alert.alert(
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
            return (
              <SwipeToClose
                containerStyle={styles.cardContainer}
                disabled={!actions || state.sync.phase !== 'ready' || Boolean(closingKey)}
                label={closingKey === key ? t('sessions.closing') : t('sessions.close')}
                onClose={close}
              >
                <Pressable accessibilityRole="button" onPress={() => onOpen?.({ instanceId: item.instanceId, sessionId: item.session.id })} style={[styles.cardContent, { backgroundColor: colors.surface, borderColor: colors.border, borderWidth: dark ? StyleSheet.hairlineWidth : 0 }]}>
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
                <View style={styles.footerRow}>
                  {activityText ? <View style={styles.footerActivity} testID="session-card-footer-activity"><SystemIcon android="auto_awesome" color={colors.textMuted} ios="sparkles" size={13} /><ToolActivityText containerStyle={styles.activityTextContainer} running={item.session.status === 'running'} textStyle={styles.activityText}>{activityText}</ToolActivityText></View> : null}
                  <Text style={[styles.time, { color: colors.textMuted }]}>{formatInboxUpdatedTime(aiSessionLastUserMessageAt(item.session) || item.session.startedAt, locale, t('sessions.yesterday'))}</Text>
                </View>
                {error ? <Text style={[styles.error, { color: colors.error }]}>{error}</Text> : null}
                </Pressable>
              </SwipeToClose>
            );
          }}
          />
      )}
      </>
    </Profiler>
  );
}

const recordInboxRender: ProfilerOnRenderCallback = (_id, _phase, actualDuration) => {
  mobileMetrics.record('render.duration', { screen: 'inbox' }, actualDuration);
};

export function formatInboxUpdatedTime(value: string, locale: string, yesterdayLabel: string, now = new Date()) {
  const updatedAt = new Date(value);
  if (Number.isNaN(updatedAt.getTime())) return '';

  const time = updatedAt.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });
  if (isSameCalendarDay(updatedAt, now)) return time;

  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (isSameCalendarDay(updatedAt, yesterday)) {
    return `${yesterdayLabel} ${time}`;
  }

  const date = updatedAt.toLocaleDateString(locale, {
    ...(updatedAt.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }),
    month: 'short',
    day: 'numeric',
  });
  return `${date} ${time}`;
}

function isSameCalendarDay(left: Date, right: Date) {
  return left.getFullYear() === right.getFullYear()
    && left.getMonth() === right.getMonth()
    && left.getDate() === right.getDate();
}

const styles = StyleSheet.create({
  screen: { backgroundColor: '#f8fafc', flex: 1 },
  header: { alignItems: 'flex-start', gap: 12, paddingHorizontal: 16, paddingBottom: 12, paddingTop: 16 },
  notice: { backgroundColor: '#fef3c7', borderRadius: 10, color: '#854d0e', fontSize: 13, lineHeight: 18, padding: 12 },
  loading: { flex: 1 },
  list: { paddingBottom: 112 },
  empty: { alignItems: 'center', justifyContent: 'center', minHeight: 240, padding: 24 },
  emptyText: { color: '#64748b', fontSize: 14 },
  statusFilters: { borderRadius: 999, flexDirection: 'row', padding: STATUS_FILTER_PADDING, position: 'relative', width: '100%' },
  statusFilterSelection: { borderRadius: 999, bottom: STATUS_FILTER_PADDING, left: STATUS_FILTER_PADDING, position: 'absolute', top: STATUS_FILTER_PADDING },
  statusFilter: { alignItems: 'center', borderRadius: 999, flex: 1, justifyContent: 'center', minHeight: 36, paddingHorizontal: 4, zIndex: 1 },
  statusFilterText: { fontSize: 13, fontWeight: '600', lineHeight: 18 },
  cardContainer: { borderRadius: 16, marginBottom: 12, marginHorizontal: 16 },
  cardContent: { borderRadius: 16, borderWidth: StyleSheet.hairlineWidth, gap: 10, padding: 16 },
  row: { alignItems: 'center', flexDirection: 'row', gap: 8 },
  rowWithUnread: { paddingRight: 18 },
  footerRow: { alignItems: 'center', flexDirection: 'row', gap: 12, justifyContent: 'flex-end', minHeight: 24 },
  footerActivity: { alignItems: 'center', flex: 1, flexDirection: 'row', gap: 8, minWidth: 0 },
  sessionIdentity: { alignItems: 'center', flex: 1, flexDirection: 'row', gap: 9, minWidth: 0 },
  sessionIdentityText: { flex: 1, gap: 1, minWidth: 0 },
  instanceName: { fontSize: 13, fontWeight: '700', lineHeight: 18 },
  cardTitle: { color: '#0f172a', flex: 1, fontSize: 16, fontWeight: '700' },
  promptPreview: { fontSize: 16, fontWeight: '600', lineHeight: 22 },
  responsePreview: { fontSize: 14, lineHeight: 20, minHeight: 60 },
  unread: { backgroundColor: '#2563eb', borderRadius: 5, height: 10, position: 'absolute', right: 16, top: 16, width: 10, zIndex: 1 },
  summary: { color: '#475569', fontSize: 13, lineHeight: 19 },
  meta: { color: '#475569', fontSize: 12, lineHeight: 17, textTransform: 'capitalize' },
  activity: { alignItems: 'center', alignSelf: 'stretch', flexDirection: 'row', gap: 8, minHeight: 24 },
  activityTextContainer: { flexShrink: 1 },
  activityText: { fontSize: 13, fontWeight: '500', lineHeight: 18 },
  time: { color: '#64748b', flexShrink: 0, fontSize: 12, lineHeight: 17 },
  error: { color: '#b91c1c', fontSize: 13, lineHeight: 18 },
});
