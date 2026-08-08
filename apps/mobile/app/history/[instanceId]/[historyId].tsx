import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import type { AiSessionHistoryDetail } from '@task-handoff/protocol/ai-sessions';

import { SafeMarkdown } from '../../../src/components/SafeMarkdown';
import { Screen } from '../../../src/components/Screen';
import { SystemIcon } from '../../../src/components/SystemIcon';
import { createDirectControlPlaneClient } from '../../../src/control-plane/client';
import { mobileProfileStore, mobileSecureStore } from '../../../src/control-plane/runtime';
import { lifecycleGuidance } from '../../../src/ai-sessions/session-lifecycle';
import { useMobileTheme } from '../../../src/components/theme';
import { NativePrimaryButton } from '../../../src/ai-sessions/NativeSessionControls';
import { useI18n } from '../../../src/i18n';

export default function HistoryDetailRoute() {
  const { colors } = useMobileTheme();
  const { locale, t } = useI18n();
  const { instanceId, historyId } = useLocalSearchParams<{ instanceId: string; historyId: string }>();
  const [detail, setDetail] = useState<AiSessionHistoryDetail>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    void withClient((api) => api.aiSessions.historyDetail(instanceId, historyId)).then((result) => { if (live) setDetail(result); }).catch((cause) => { if (live) setError(lifecycleGuidance(cause).message); });
    return () => { live = false; };
  }, [historyId, instanceId]);
  const resume = async () => {
    setBusy(true); setError(undefined);
    try {
      const result = await withClient((api) => api.aiSessions.resume(instanceId, historyId));
      router.replace({ pathname: '/sessions/[instanceId]/[sessionId]', params: { instanceId, sessionId: result.aiSessionId } });
    } catch (cause) { setError(lifecycleGuidance(cause).message); }
    finally { setBusy(false); }
  };
  return <>
  <Stack.Screen options={{ title: detail?.item.title || t('nav.sessionHistory') }} />
  <Screen>
    {detail ? <>
      <View style={styles.header}>
        <View style={[styles.historyIcon, { backgroundColor: colors.primarySoft }]}>
          <SystemIcon android="history" color={colors.primary} ios="clock.arrow.circlepath" size={22} />
        </View>
        <View style={styles.headerText}>
          <Text accessibilityRole="header" style={[styles.title, { color: colors.text }]}>{detail.item.title || detail.item.userPrompt || t('nav.sessionHistory')}</Text>
          <Text style={[styles.meta, { color: colors.textMuted }]}>{detail.item.agent} · {t('history.archivedAt', { date: new Date(detail.item.archivedAt).toLocaleString(locale) })}</Text>
        </View>
      </View>
      <View style={[styles.infoCard, { backgroundColor: colors.surface, borderColor: colors.border }]}> 
        <InfoRow icon="folder" label={t('history.workspace')} value={detail.item.cwd} />
        <View style={[styles.divider, { backgroundColor: colors.border }]} />
        <InfoRow icon="number" label={t('history.providerSession')} value={detail.item.providerSessionId} />
      </View>
      <View style={styles.sectionHeader}>
        <Text style={[styles.sectionTitle, { color: colors.text }]}>{t('history.conversation')}</Text>
        <Text style={[styles.count, { color: colors.textMuted }]}>{t('history.turnCount', { count: detail.turns.length })}</Text>
      </View>
      {detail.turns.length ? detail.turns.map((turn) => <View key={turn.id} style={styles.turn}>
        {turn.userPrompt ? <View style={styles.userMessage}><Text style={[styles.role, { color: colors.textMuted }]}>{t('history.you')}</Text><View style={[styles.bubble, styles.userBubble, { backgroundColor: colors.primarySoft }]}><SafeMarkdown trimEnd>{turn.userPrompt}</SafeMarkdown></View></View> : null}
        {turn.lastMessage || turn.summary ? <View style={styles.assistantRow}><View style={[styles.avatar, { backgroundColor: colors.surfaceMuted }]}><SystemIcon android="auto_awesome" color={colors.primary} ios="sparkles" size={15} /></View><View style={styles.assistantMessage}><Text style={[styles.role, { color: colors.textMuted }]}>{detail.item.agent}</Text><View style={[styles.bubble, styles.assistantBubble, { backgroundColor: colors.surface, borderColor: colors.border }]}><SafeMarkdown trimEnd>{turn.lastMessage || turn.summary!}</SafeMarkdown></View></View></View> : null}
      </View>) : <View style={styles.empty}><Text style={[styles.meta, { color: colors.textMuted }]}>{t('history.empty')}</Text></View>}
      <NativePrimaryButton busy={busy} disabled={busy} label={busy ? t('composer.resuming') : t('history.resume')} systemImage="play.fill" onPress={() => { void resume(); }} />
    </> : <View style={styles.loading}><ActivityIndicator /><Text style={[styles.meta, { color: colors.textMuted }]}>{error ? t('history.loadError') : t('history.loading')}</Text></View>}
    {error ? <View style={[styles.errorCard, { backgroundColor: colors.errorSoft }]}><SystemIcon android="error" color={colors.error} ios="exclamationmark.triangle.fill" size={17} /><Text accessibilityLiveRegion="polite" style={[styles.error, { color: colors.error }]}>{error}</Text></View> : null}
  </Screen>
  </>;
}

function InfoRow({ icon, label, value }: { icon: 'folder' | 'number'; label: string; value: string }) {
  const { colors } = useMobileTheme();
  return <View style={styles.infoRow}>
    <SystemIcon android={icon === 'folder' ? 'folder' : 'tag'} color={colors.textMuted} ios={icon} size={17} />
    <View style={styles.infoText}><Text style={[styles.infoLabel, { color: colors.textMuted }]}>{label}</Text><Text numberOfLines={2} selectable style={[styles.infoValue, { color: colors.text }]}>{value}</Text></View>
  </View>;
}

async function withClient<T>(operation: (client: ReturnType<typeof createDirectControlPlaneClient>['api']) => Promise<T>) {
  const profile = await mobileProfileStore.active();
  if (!profile) throw new Error('No active Control Plane.');
  return operation(createDirectControlPlaneClient(profile, mobileSecureStore).api);
}

const styles = StyleSheet.create({
  header: { alignItems: 'flex-start', flexDirection: 'row', gap: 12 },
  historyIcon: { alignItems: 'center', borderRadius: 12, height: 44, justifyContent: 'center', width: 44 },
  headerText: { flex: 1, gap: 6 },
  title: { fontSize: 22, fontWeight: '700', letterSpacing: -0.3, lineHeight: 28 },
  meta: { fontSize: 13, lineHeight: 19, textTransform: 'capitalize' },
  infoCard: { borderRadius: 14, borderWidth: StyleSheet.hairlineWidth, paddingHorizontal: 14 },
  infoRow: { alignItems: 'center', flexDirection: 'row', gap: 12, minHeight: 58 },
  infoText: { flex: 1, gap: 3 },
  infoLabel: { fontSize: 12, lineHeight: 17 },
  infoValue: { fontSize: 14, lineHeight: 20 },
  divider: { height: StyleSheet.hairlineWidth, marginLeft: 27 },
  sectionHeader: { alignItems: 'baseline', flexDirection: 'row', justifyContent: 'space-between', marginTop: 8 },
  sectionTitle: { fontSize: 18, fontWeight: '700', lineHeight: 24 },
  count: { fontSize: 13, lineHeight: 18 },
  turn: { gap: 16 },
  userMessage: { alignSelf: 'flex-end', gap: 6, maxWidth: '90%' },
  assistantRow: { alignItems: 'flex-start', flexDirection: 'row', gap: 10, maxWidth: '100%' },
  assistantMessage: { flexShrink: 1, gap: 6 },
  avatar: { alignItems: 'center', borderRadius: 10, height: 28, justifyContent: 'center', width: 28 },
  role: { fontSize: 13, fontWeight: '600', lineHeight: 18, textTransform: 'capitalize' },
  bubble: { borderRadius: 18, paddingHorizontal: 14, paddingVertical: 12 },
  userBubble: { borderTopRightRadius: 6 },
  assistantBubble: { borderTopLeftRadius: 6, borderWidth: StyleSheet.hairlineWidth },
  empty: { alignItems: 'center', paddingVertical: 28 },
  loading: { alignItems: 'center', flex: 1, gap: 12, justifyContent: 'center', minHeight: 240 },
  errorCard: { alignItems: 'flex-start', borderRadius: 12, flexDirection: 'row', gap: 8, padding: 12 },
  error: { flex: 1, fontSize: 13, lineHeight: 19 },
});
