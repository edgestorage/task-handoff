import { useMemo, useState } from 'react';
import { router, Stack } from 'expo-router';
import { ActivityIndicator, Pressable, RefreshControl, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { SystemIcon } from '../../src/components/SystemIcon';
import { useMobileTheme } from '../../src/components/theme';
import { useI18n } from '../../src/i18n';
import { triggerSourceSummary } from '../../src/triggers/model';
import { useActiveTriggers } from '../../src/triggers/use-active-triggers';

export default function TriggerListRoute() {
  const { colors } = useMobileTheme();
  const { t } = useI18n();
  const triggers = useActiveTriggers();
  const [filter, setFilter] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const items = useMemo(() => {
    const query = filter.trim().toLowerCase();
    return triggers.state.snapshot.triggers.filter((item) => !query || `${item.config.name} ${item.configHash} ${item.config.source.type} ${triggerSourceSummary(item.config.source)}`.toLowerCase().includes(query));
  }, [filter, triggers.state.snapshot.triggers]);
  const refresh = () => { setRefreshing(true); void triggers.refresh().catch(() => undefined).finally(() => setRefreshing(false)); };
  return <>
    <Stack.Screen options={{
      title: t('triggers.title'),
      headerRight: triggers.state.canMutate ? () => <Pressable accessibilityLabel={t('triggers.create')} hitSlop={10} onPress={() => router.push('/triggers/new' as never)}><SystemIcon android="add_circle" color={colors.primary} ios="plus.circle" size={23} /></Pressable> : undefined,
    }} />
    <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerStyle={styles.screen} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={colors.primary} />} style={{ backgroundColor: colors.background }}>
      <View style={styles.stats}>
        <Stat label={t('triggers.templates')} value={triggers.state.snapshot.triggers.length} />
        <Stat label={t('triggers.deployments')} value={triggers.state.snapshot.triggers.reduce((sum, item) => sum + item.deploymentCount, 0)} />
        <Stat label={t('triggers.running')} value={triggers.state.snapshot.triggers.reduce((sum, item) => sum + item.runningCount, 0)} />
        <Stat error label={t('triggers.errors')} value={triggers.state.snapshot.triggers.reduce((sum, item) => sum + item.errorCount, 0)} />
      </View>
      <TextInput onChangeText={setFilter} placeholder={t('triggers.filter')} placeholderTextColor={colors.textMuted} style={[styles.search, { backgroundColor: colors.surface, borderColor: colors.border, color: colors.text }]} value={filter} />
      {triggers.state.phase === 'loading' ? <ActivityIndicator color={colors.primary} /> : null}
      {triggers.state.error ? <Text style={[styles.message, { color: colors.error }]}>{triggers.state.error}</Text> : null}
      {!items.length && triggers.state.phase !== 'loading' ? <Text style={[styles.message, { color: colors.textMuted }]}>{t('triggers.empty')}</Text> : null}
      {items.map((item) => <Pressable key={item.configHash} onPress={() => router.push({ pathname: '/triggers/[configHash]' as never, params: { configHash: item.configHash } })} style={({ pressed }) => [styles.card, { backgroundColor: colors.surface, borderColor: colors.border }, pressed && styles.pressed]}>
        <View style={styles.cardHead}><View style={styles.cardCopy}><Text numberOfLines={1} style={[styles.cardTitle, { color: colors.text }]}>{item.config.name}</Text>{item.config.description ? <Text numberOfLines={2} style={[styles.description, { color: colors.textMuted }]}>{item.config.description}</Text> : null}</View><StatusBadge error={item.errorCount > 0} label={item.errorCount ? t('triggers.statusError') : item.runningCount ? t('triggers.statusRunning') : item.deploymentCount ? t('triggers.statusActive') : t('triggers.statusUndeployed')} /></View>
        <View style={styles.source}><SystemIcon android={item.config.source.type === 'schedule' ? 'schedule' : item.config.source.type === 'file-change' ? 'folder' : 'auto_awesome'} color={colors.textMuted} ios={item.config.source.type === 'schedule' ? 'clock' : item.config.source.type === 'file-change' ? 'folder.badge.gearshape' : 'sparkles'} size={15} /><Text numberOfLines={2} style={[styles.sourceText, { color: colors.textMuted }]}>{triggerSourceSummary(item.config.source)}</Text></View>
        <Text style={[styles.meta, { color: colors.textMuted }]}>{t('triggers.bindingSummary', { deployments: item.deploymentCount, enabled: item.enabledCount })}</Text>
      </Pressable>)}
    </ScrollView>
  </>;
}

function Stat({ error, label, value }: { error?: boolean; label: string; value: number }) { const { colors } = useMobileTheme(); return <View style={[styles.stat, { backgroundColor: colors.surface }]}><Text style={[styles.statValue, { color: error && value ? colors.error : colors.text }]}>{value}</Text><Text style={[styles.statLabel, { color: colors.textMuted }]}>{label}</Text></View>; }
function StatusBadge({ error, label }: { error?: boolean; label: string }) { const { colors } = useMobileTheme(); return <View style={[styles.badge, { backgroundColor: error ? colors.errorSoft : colors.surfaceMuted }]}><Text style={[styles.badgeText, { color: error ? colors.error : colors.textMuted }]}>{label}</Text></View>; }
const styles = StyleSheet.create({ screen: { gap: 12, padding: 16, paddingBottom: 40 }, stats: { flexDirection: 'row', gap: 8 }, stat: { alignItems: 'center', borderRadius: 12, flex: 1, gap: 2, paddingHorizontal: 4, paddingVertical: 10 }, statValue: { fontSize: 20, fontWeight: '700' }, statLabel: { fontSize: 12 }, search: { borderRadius: 11, borderWidth: StyleSheet.hairlineWidth, fontSize: 16, minHeight: 42, paddingHorizontal: 12 }, card: { borderRadius: 14, borderWidth: StyleSheet.hairlineWidth, gap: 10, padding: 14 }, cardHead: { alignItems: 'flex-start', flexDirection: 'row', gap: 10 }, cardCopy: { flex: 1, gap: 3 }, cardTitle: { fontSize: 17, fontWeight: '700' }, description: { fontSize: 13, lineHeight: 18 }, badge: { borderRadius: 999, paddingHorizontal: 8, paddingVertical: 4 }, badgeText: { fontSize: 12, fontWeight: '600' }, source: { alignItems: 'flex-start', flexDirection: 'row', gap: 7 }, sourceText: { flex: 1, fontSize: 13, lineHeight: 18 }, meta: { fontSize: 12 }, message: { fontSize: 14, padding: 20, textAlign: 'center' }, pressed: { opacity: 0.62 } });
