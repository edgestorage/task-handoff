import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { Icon, type IconName } from '../components/Icon';
import { useMobileTheme } from '../components/theme';
import {
  adaptiveContentContainerStyle,
  useAdaptiveContentLayout,
} from '../components/adaptive-layout';
import { useI18n } from '../i18n';
import type { InstanceHistoryProps, InstanceOverviewProps } from './instance-section-types';

export function InstanceOverview(props: InstanceOverviewProps) {
  const { colors } = useMobileTheme();
  const { t } = useI18n();
  return <>
    <View style={[styles.group, { backgroundColor: colors.surface }]}>
      <InfoRow label={t('nav.node')} name="server-outline" value={props.nodeName} />
      <Separator />
      <InfoRow label={t('instance.runtime')} name="hardware-chip-outline" value={props.runtime} />
      <Separator />
      <InfoRow label={t('instance.workspace')} monospace name="folder-outline" value={props.workspace} />
      <Separator />
      <InfoRow label={t('instance.heartbeat')} name="time-outline" value={props.heartbeat} />
      <Separator />
      <InfoRow label={t('instance.protocol')} name={props.protocolCompatible ? 'checkmark-circle-outline' : 'warning-outline'} tone={props.protocolCompatible ? 'normal' : 'warning'} value={props.protocol} />
    </View>
    <Pressable accessibilityRole="button" onPress={props.onCreateSession} style={({ pressed }) => [styles.createLink, { backgroundColor: colors.surface }, pressed && styles.pressed]}>
      <Icon color={colors.primary} name="create-outline" size={20} />
      <Text style={[styles.createLinkText, { color: colors.primary }]}>{t('nav.newSession')}</Text>
      <Icon color={colors.textMuted} name="chevron-forward" size={14} />
    </Pressable>
    <Pressable accessibilityRole="button" onPress={props.onShowSessions} style={({ pressed }) => [styles.sessionLink, { backgroundColor: colors.surface }, pressed && styles.pressed]}>
      <View style={[styles.linkIcon, { backgroundColor: colors.primarySoft }]}><Icon color={colors.primary} name="chatbubbles" size={21} /></View>
      <View style={styles.linkText}>
        <Text style={[styles.linkTitle, { color: colors.text }]}>{t('nav.aiSessions')}</Text>
        <Text style={[styles.meta, { color: colors.textMuted }]}>{t('instance.sessionSummary', { active: props.activeSessionCount, problem: props.problemSessionCount })}</Text>
      </View>
      <Icon color={colors.textMuted} name="chevron-forward" size={14} />
    </Pressable>
    <Pressable accessibilityRole="button" onPress={props.onShowHistory} style={({ pressed }) => [styles.createLink, { backgroundColor: colors.surface }, pressed && styles.pressed]}>
      <Icon color={colors.primary} name="time-outline" size={20} />
      <Text style={[styles.createLinkText, { color: colors.primary }]}>{t('nav.history')}</Text>
      <Icon color={colors.textMuted} name="chevron-forward" size={14} />
    </Pressable>
  </>;
}

export function InstanceHistory({ items, loading, onOpen, standalone = false }: InstanceHistoryProps) {
  const { colors } = useMobileTheme();
  const { locale, t } = useI18n();
  const adaptive = useAdaptiveContentLayout();
  const content = <View style={[styles.group, { backgroundColor: colors.surface }]}>
    {loading ? <View style={styles.loadingRow}><ActivityIndicator color={colors.primary} /><Text style={[styles.meta, { color: colors.textMuted }]}>{t('history.loading')}</Text></View> : null}
    {!loading && items.map((item, index) => <View key={item.id}>
      {index ? <Separator /> : null}
      <Pressable accessibilityRole="button" onPress={() => onOpen(item)} style={({ pressed }) => [styles.history, pressed && styles.pressed]}>
        <View style={[styles.historyIcon, { backgroundColor: colors.surface }]}><Icon color={colors.textMuted} name="time-outline" size={18} /></View>
        <View style={styles.historyText}><Text numberOfLines={2} style={[styles.historyTitle, { color: colors.text }]}>{item.title || item.userPrompt || t('instance.archivedSession')}</Text><Text style={[styles.meta, { color: colors.textMuted }]}>{item.agent} · {new Date(item.lastActiveAt).toLocaleString(locale)}</Text></View>
        <Icon color={colors.textMuted} name="chevron-forward" size={13} />
      </Pressable>
    </View>)}
    {!loading && !items.length ? <View style={styles.emptyHistory}><Icon color={colors.textMuted} name="time-outline" size={25} /><Text style={[styles.meta, { color: colors.textMuted }]}>{t('instance.archivedEmpty')}</Text></View> : null}
  </View>;
  return standalone ? <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerStyle={adaptiveContentContainerStyle(styles.historyPage, adaptive.contentInsets)} scrollIndicatorInsets={adaptive.scrollIndicatorInsets} style={[styles.historyScroll, { backgroundColor: colors.background }]}>{content}</ScrollView> : content;
}

function InfoRow({ label, monospace, name, tone = 'normal', value }: { label: string; monospace?: boolean; name: IconName; tone?: 'normal' | 'warning'; value: string }) {
  const { colors } = useMobileTheme();
  const color = tone === 'warning' ? colors.noticeText : colors.textMuted;
  return <View style={styles.infoRow}><Icon color={color} name={name} size={18} /><Text style={[styles.infoLabel, { color: colors.text }]}>{label}</Text><Text numberOfLines={2} style={[styles.infoValue, monospace && styles.monospace, { color }]}>{value}</Text></View>;
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
  historyPage: { padding: 16 }, historyScroll: { flex: 1 },
});
