import { useMemo, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import type { AppSessionRecord } from '@task-handoff/protocol/app-sessions';

import { useMobileTheme } from '../components/theme';
import { SwipeActionList } from '../components/SwipeActionList';
import type { MobileDirectoryProfileState } from '../directories/store';
import type { AiSessionScope } from '../ai-sessions/store';
import { useI18n } from '../i18n';
import type { MobileAppSessionProfileState } from './store';
import { canCloseAppSession, canOpenAppSession } from './status';
import { formatSessionUpdatedTime } from '../session-time';

type Entry = { instanceId: string; instanceName: string; session: AppSessionRecord };
type Props = {
  directory: MobileDirectoryProfileState;
  onCloseSession(instanceId: string, sessionId: string): Promise<void>;
  scope: Extract<AiSessionScope, { kind: 'all' | 'instance' }>;
  state: MobileAppSessionProfileState;
};

export function AppSessionList({ state, directory, onCloseSession, scope }: Props) {
  const { colors } = useMobileTheme();
  const { locale, t } = useI18n();
  const router = useRouter();
  const [closingKey, setClosingKey] = useState('');
  const entries = useMemo(() => {
    const names = new Map(directory.instances.map((instance) => [instance.id, instance.name]));
    return (state.snapshot?.instances ?? []).flatMap((entry) => scope.kind === 'instance' && scope.instanceId !== entry.instanceId ? [] : entry.appSessions.sessions.map((session) => ({ instanceId: entry.instanceId, instanceName: names.get(entry.instanceId) || entry.instanceId, session })))
      .sort((left, right) => (right.session.updatedAt || right.session.createdAt || '').localeCompare(left.session.updatedAt || left.session.createdAt || ''));
  }, [directory.instances, scope, state.snapshot]);
  const requestClose = (entry: Entry) => {
    const title = entry.session.title || entry.session.appId || entry.session.id;
    Alert.alert(t('appSessions.closeConfirmTitle', { name: title }), t('appSessions.closeConfirmDescription'), [
      { text: t('common.cancel'), style: 'cancel' },
      {
        text: t('appSessions.close'),
        style: 'destructive',
        onPress: () => {
          const key = `${entry.instanceId}:${entry.session.id}`;
          setClosingKey(key);
          void onCloseSession(entry.instanceId, entry.session.id)
            .catch((cause) => Alert.alert(t('appSessions.closeFailed'), cause instanceof Error ? cause.message : undefined))
            .finally(() => setClosingKey((current) => current === key ? '' : current));
        },
      },
    ]);
  };
  if (state.sync.phase === 'loading' && !state.snapshot) return <ActivityIndicator style={styles.loading} />;
  const statusMessage = state.sync.phase === 'offline' || state.sync.phase === 'stale'
    ? t('appSessions.cached')
    : state.sync.error;
  return <SwipeActionList
    contentContainerStyle={styles.list}
    data={entries}
    itemContainerStyle={styles.cardContainer}
    keyExtractor={(entry) => `${entry.instanceId}:${entry.session.id}`}
    ListHeaderComponent={statusMessage ? <Text accessibilityLiveRegion="polite" style={[styles.notice, { backgroundColor: colors.notice, color: colors.noticeText }]}>{statusMessage}</Text> : null}
    ListEmptyComponent={<View style={styles.empty}><Text style={[styles.emptyText, { color: colors.textMuted }]}>{state.sync.phase === 'error' ? t('appSessions.loadError') : t('appSessions.empty')}</Text></View>}
    swipeAction={(item) => canCloseAppSession(item.session.status) ? {
      disabled: state.sync.phase !== 'ready' || Boolean(closingKey) || item.session.status === 'stopping',
      label: closingKey === `${item.instanceId}:${item.session.id}` || item.session.status === 'stopping' ? t('appSessions.closing') : t('appSessions.close'),
      onPress: () => requestClose(item),
    } : null}
    renderItem={({ item }) => <AppSessionCard
      entry={item}
      locale={locale}
      onPress={canOpenAppSession(item.session) ? () => router.push({ pathname: '/app-sessions/[instanceId]/[sessionId]', params: { instanceId: item.instanceId, sessionId: item.session.id } }) : undefined}
    />}
    style={{ backgroundColor: colors.background }}
  />;
}

function AppSessionCard({ entry, locale, onPress }: { entry: Entry; locale: string; onPress?: () => void }) {
  const { colors, dark } = useMobileTheme();
  const { t } = useI18n();
  const value = entry.session.updatedAt || entry.session.createdAt;
  const title = entry.session.title || entry.session.appId || entry.session.id;
  const statusColor = entry.session.status === 'failed' ? colors.error : entry.session.status === 'running' ? colors.primary : colors.textMuted;
  return <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border, borderWidth: dark ? StyleSheet.hairlineWidth : 0 }]}>
    <Pressable accessibilityRole={onPress ? 'button' : undefined} disabled={!onPress} onPress={onPress} style={({ pressed }) => [styles.cardContent, pressed && styles.pressed]}>
      <View style={styles.heading}>
        <Text numberOfLines={1} style={[styles.title, { color: colors.text }]}>{title}</Text>
        <View style={[styles.badge, { backgroundColor: colors.surfaceMuted }]}><View style={[styles.dot, { backgroundColor: statusColor }]} /><Text style={[styles.status, { color: statusColor }]}>{entry.session.status}</Text></View>
      </View>
      <Text numberOfLines={1} style={[styles.meta, { color: colors.textMuted }]}>{entry.session.appId || t('appSessions.unknownApp')} · {entry.instanceName}</Text>
      {entry.session.workspace?.cwd || value ? <View style={styles.footer}>
        {entry.session.workspace?.cwd ? <Text numberOfLines={1} style={[styles.cwd, { color: colors.textMuted }]}>{entry.session.workspace.cwd}</Text> : null}
        {value ? <Text style={[styles.time, { color: colors.textMuted }]}>{formatSessionUpdatedTime(value, locale, t('sessions.yesterday'))}</Text> : null}
      </View> : null}
    </Pressable>
  </View>;
}

const styles = StyleSheet.create({
  loading: { flex: 1 }, list: { paddingBottom: 112, paddingTop: 16 }, cardContainer: { marginBottom: 12, marginHorizontal: 20 }, empty: { alignItems: 'center', justifyContent: 'center', minHeight: 240, padding: 24 }, emptyText: { fontSize: 15 }, notice: { borderRadius: 10, fontSize: 13, lineHeight: 18, marginBottom: 12, marginHorizontal: 20, padding: 12 }, card: { borderRadius: 16, borderWidth: StyleSheet.hairlineWidth, overflow: 'hidden' }, cardContent: { gap: 8, paddingHorizontal: 16, paddingVertical: 12 }, pressed: { opacity: 0.6 }, heading: { alignItems: 'center', flexDirection: 'row', gap: 10 }, title: { flex: 1, fontSize: 17, fontWeight: '700', lineHeight: 22 }, badge: { alignItems: 'center', borderRadius: 999, flexDirection: 'row', gap: 5, paddingHorizontal: 7, paddingVertical: 4 }, dot: { borderRadius: 4, height: 7, width: 7 }, status: { fontSize: 12, fontWeight: '600', lineHeight: 17, textTransform: 'capitalize' }, meta: { fontSize: 14, lineHeight: 19 }, footer: { alignItems: 'center', flexDirection: 'row', gap: 12, minHeight: 19 }, cwd: { flex: 1, fontFamily: 'monospace', fontSize: 14, lineHeight: 19, minWidth: 0 }, time: { flexShrink: 0, fontSize: 12, lineHeight: 17, marginLeft: 'auto' },
});
