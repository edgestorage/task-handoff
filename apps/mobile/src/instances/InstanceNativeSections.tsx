import type { AndroidSymbol, SFSymbol } from 'expo-symbols';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

import { SystemIcon } from '../components/SystemIcon';
import { useMobileTheme } from '../components/theme';
import { useI18n } from '../i18n';
import type { InstanceHistoryProps, InstanceOverviewProps } from './instance-section-types';

export function InstanceOverview(props: InstanceOverviewProps) {
  const { colors } = useMobileTheme();
  const { t } = useI18n();
  return <>
    <View style={[styles.group, { backgroundColor: colors.surface }]}>
      <InfoRow android="dns" ios="server.rack" label={t('nav.node')} value={props.nodeName} />
      <Separator />
      <InfoRow android="memory" ios="shippingbox" label={t('instance.runtime')} value={props.runtime} />
      <Separator />
      <InfoRow android="folder" ios="folder" label={t('instance.workspace')} value={props.workspace} monospace />
      <Separator />
      <InfoRow android="schedule" ios="clock" label={t('instance.heartbeat')} value={props.heartbeat} />
      <Separator />
      <InfoRow android={props.protocolCompatible ? 'check_circle' : 'warning'} ios={props.protocolCompatible ? 'checkmark.seal' : 'exclamationmark.triangle'} label={t('instance.protocol')} value={props.protocol} tone={props.protocolCompatible ? 'normal' : 'warning'} />
    </View>
    <Pressable accessibilityRole="button" onPress={props.onCreateSession} style={({ pressed }) => [styles.createLink, { backgroundColor: colors.surface }, pressed && styles.pressed]}>
      <SystemIcon android="edit_square" color={colors.primary} ios="square.and.pencil" size={20} />
      <Text style={[styles.createLinkText, { color: colors.primary }]}>{t('nav.newSession')}</Text>
      <SystemIcon android="chevron_right" color={colors.textMuted} ios="chevron.right" size={14} />
    </Pressable>
    <Pressable accessibilityRole="button" onPress={props.onShowSessions} style={({ pressed }) => [styles.sessionLink, { backgroundColor: colors.surface }, pressed && styles.pressed]}>
      <View style={[styles.linkIcon, { backgroundColor: colors.primarySoft }]}><SystemIcon android="chat" color={colors.primary} ios="bubble.left.and.bubble.right.fill" size={21} /></View>
      <View style={styles.linkText}>
        <Text style={[styles.linkTitle, { color: colors.text }]}>{t('nav.aiSessions')}</Text>
        <Text style={[styles.meta, { color: colors.textMuted }]}>{t('instance.sessionSummary', { active: props.activeSessionCount, problem: props.problemSessionCount })}</Text>
      </View>
      <SystemIcon android="chevron_right" color={colors.textMuted} ios="chevron.right" size={14} />
    </Pressable>
  </>;
}

export function InstanceHistory({ items, loading, onOpen }: InstanceHistoryProps) {
  const { colors } = useMobileTheme();
  const { locale, t } = useI18n();
  return <View style={[styles.group, { backgroundColor: colors.surface }]}>
    {loading ? <View style={styles.loadingRow}><ActivityIndicator color={colors.primary} /><Text style={[styles.meta, { color: colors.textMuted }]}>{t('history.loading')}</Text></View> : null}
    {!loading && items.map((item, index) => <View key={item.id}>
      {index ? <Separator /> : null}
      <Pressable accessibilityRole="button" onPress={() => onOpen(item)} style={({ pressed }) => [styles.history, pressed && styles.pressed]}>
        <View style={[styles.historyIcon, { backgroundColor: colors.surfaceMuted }]}><SystemIcon android="history" color={colors.textMuted} ios="clock.arrow.circlepath" size={18} /></View>
        <View style={styles.historyText}><Text numberOfLines={2} style={[styles.historyTitle, { color: colors.text }]}>{item.title || item.userPrompt || t('instance.archivedSession')}</Text><Text style={[styles.meta, { color: colors.textMuted }]}>{item.agent} · {new Date(item.lastActiveAt).toLocaleString(locale)}</Text></View>
        <SystemIcon android="chevron_right" color={colors.textMuted} ios="chevron.right" size={13} />
      </Pressable>
    </View>)}
    {!loading && !items.length ? <View style={styles.emptyHistory}><SystemIcon android="history" color={colors.textMuted} ios="clock.arrow.circlepath" size={25} /><Text style={[styles.meta, { color: colors.textMuted }]}>{t('instance.archivedEmpty')}</Text></View> : null}
  </View>;
}

function InfoRow({ android, ios, label, monospace, tone = 'normal', value }: { android: AndroidSymbol; ios: SFSymbol; label: string; monospace?: boolean; tone?: 'normal' | 'warning'; value: string }) {
  const { colors } = useMobileTheme();
  const color = tone === 'warning' ? colors.noticeText : colors.textMuted;
  return <View style={styles.infoRow}><SystemIcon android={android} color={color} ios={ios} size={18} /><Text style={[styles.infoLabel, { color: colors.text }]}>{label}</Text><Text numberOfLines={2} style={[styles.infoValue, monospace && styles.monospace, { color }]}>{value}</Text></View>;
}

function Separator() {
  const { colors } = useMobileTheme();
  return <View style={[styles.separator, { backgroundColor: colors.border }]} />;
}

const styles = StyleSheet.create({
  group: { borderRadius: 14, overflow: 'hidden', paddingHorizontal: 14 },
  infoRow: { alignItems: 'center', flexDirection: 'row', gap: 10, minHeight: 47, paddingVertical: 8 }, infoLabel: { fontSize: 14, fontWeight: '600', width: 80 }, infoValue: { flex: 1, fontSize: 13, lineHeight: 18, textAlign: 'right' }, monospace: { fontFamily: 'monospace' }, separator: { height: StyleSheet.hairlineWidth, marginLeft: 28, opacity: 0.7 },
  sessionLink: { alignItems: 'center', borderRadius: 14, flexDirection: 'row', gap: 11, minHeight: 67, padding: 12 }, linkIcon: { alignItems: 'center', borderRadius: 11, height: 42, justifyContent: 'center', width: 42 }, linkText: { flex: 1, gap: 2 }, linkTitle: { fontSize: 16, fontWeight: '700' },
  createLink: { alignItems: 'center', borderRadius: 14, flexDirection: 'row', gap: 11, minHeight: 54, paddingHorizontal: 14 }, createLinkText: { flex: 1, fontSize: 16, fontWeight: '600' },
  pressed: { opacity: 0.68 }, meta: { fontSize: 12, lineHeight: 17 }, loadingRow: { alignItems: 'center', flexDirection: 'row', gap: 9, minHeight: 58 }, history: { alignItems: 'center', flexDirection: 'row', gap: 10, minHeight: 66, paddingVertical: 10 }, historyIcon: { alignItems: 'center', borderRadius: 9, height: 36, justifyContent: 'center', width: 36 }, historyText: { flex: 1, gap: 3 }, historyTitle: { fontSize: 14, fontWeight: '600', lineHeight: 19 }, emptyHistory: { alignItems: 'center', gap: 7, justifyContent: 'center', minHeight: 92 },
});
