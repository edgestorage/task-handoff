import { useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { Stack, useLocalSearchParams } from 'expo-router';

import { Screen } from '../../../../src/components/Screen';
import { SystemIcon } from '../../../../src/components/SystemIcon';
import { useMobileTheme } from '../../../../src/components/theme';
import { useI18n } from '../../../../src/i18n';
import { triggerSourceSummary } from '../../../../src/triggers/model';
import { useActiveTriggers } from '../../../../src/triggers/use-active-triggers';

export default function SessionTriggersRoute() {
  const { instanceId, sessionId } = useLocalSearchParams<{ instanceId: string; sessionId: string }>();
  const { colors } = useMobileTheme();
  const { t } = useI18n();
  const triggers = useActiveTriggers();
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const bound = (configHash: string) => triggers.state.snapshot.triggers.find((item) => item.configHash === configHash)?.deployments.some((entry) => entry.instanceId === instanceId && entry.deployment.target.aiSessionId === sessionId) === true;
  const toggle = (configHash: string) => {
    setBusy(configHash);
    const action = bound(configHash) ? triggers.unbindSession(instanceId, sessionId, configHash) : triggers.bindSession(instanceId, sessionId, configHash);
    setError('');
    void action.catch((cause) => setError(cause instanceof Error ? cause.message : String(cause))).finally(() => setBusy(''));
  };
  return <><Stack.Screen options={{ title: t('triggers.sessionTitle') }} /><Screen>
    {!triggers.state.snapshot.triggers.length ? <Text style={[styles.empty, { color: colors.textMuted }]}>{t('triggers.empty')}</Text> : null}
    {error ? <Text style={[styles.empty, { color: colors.error }]}>{error}</Text> : null}
    {triggers.state.snapshot.triggers.map((item) => { const checked = bound(item.configHash); const enabled = triggers.state.canMutate && item.ownedByControlPlane && !busy; return <Pressable accessibilityRole="checkbox" accessibilityState={{ checked, disabled: !enabled }} disabled={!enabled} key={item.configHash} onPress={() => toggle(item.configHash)} style={({ pressed }) => [styles.row, { backgroundColor: colors.surface, borderColor: colors.border }, pressed && styles.pressed]}><View style={styles.copy}><Text style={[styles.title, { color: colors.text }]}>{item.config.name}</Text><Text numberOfLines={2} style={[styles.summary, { color: colors.textMuted }]}>{triggerSourceSummary(item.config.source)}</Text></View>{busy === item.configHash ? <ActivityIndicator color={colors.primary} /> : <SystemIcon android={checked ? 'check_box' : 'check_box_outline_blank'} color={checked ? colors.primary : colors.textMuted} ios={checked ? 'checkmark.circle.fill' : 'circle'} size={24} />}</Pressable>; })}
  </Screen></>;
}
const styles = StyleSheet.create({ row: { alignItems: 'center', borderRadius: 13, borderWidth: StyleSheet.hairlineWidth, flexDirection: 'row', gap: 12, minHeight: 68, padding: 13 }, copy: { flex: 1, gap: 4 }, title: { fontSize: 16, fontWeight: '600' }, summary: { fontSize: 13, lineHeight: 18 }, empty: { fontSize: 14, padding: 20, textAlign: 'center' }, pressed: { opacity: 0.62 } });
