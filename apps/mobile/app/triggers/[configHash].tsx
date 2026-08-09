import { useState } from 'react';
import { Alert, Pressable, StyleSheet, Text, View } from 'react-native';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import type { ControlPlaneTriggerTemplateInput } from '@task-handoff/protocol/triggers';

import { Screen } from '../../src/components/Screen';
import { SystemIcon } from '../../src/components/SystemIcon';
import { useMobileTheme } from '../../src/components/theme';
import { useActiveAiSessionsSnapshot } from '../../src/ai-sessions/use-active-sessions';
import { useI18n } from '../../src/i18n';
import { TriggerForm } from '../../src/triggers/TriggerForm';
import { triggerDraft, triggerSourceSummary } from '../../src/triggers/model';
import { useActiveTriggers } from '../../src/triggers/use-active-triggers';

export default function TriggerDetailRoute() {
  const { configHash } = useLocalSearchParams<{ configHash: string }>();
  const { colors } = useMobileTheme();
  const { t } = useI18n();
  const triggers = useActiveTriggers();
  const aiSessions = useActiveAiSessionsSnapshot();
  const [editing, setEditing] = useState(false);
  const [choosingTarget, setChoosingTarget] = useState(false);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const item = triggers.state.snapshot.triggers.find((candidate) => candidate.configHash === configHash);
  if (!item) return <><Stack.Screen options={{ title: t('triggers.title') }} /><Screen><Text style={{ color: colors.textMuted }}>{t('triggers.notFound')}</Text></Screen></>;
  const editable = triggers.state.canMutate && item.ownedByControlPlane;
  const boundTargets = new Set(item.deployments.map((entry) => `${entry.instanceId}:${entry.deployment.target.aiSessionId}`));
  const availableTargets = (aiSessions?.instances ?? []).flatMap((entry) => entry.aiSessions.sessions
    .filter((session) => !boundTargets.has(`${entry.instanceId}:${session.id}`))
    .map((session) => ({ instanceId: entry.instanceId, session })));
  const save = async (input: ControlPlaneTriggerTemplateInput) => { await triggers.update(item.configHash, input); setEditing(false); };
  const remove = () => Alert.alert(t('triggers.deleteTitle'), t('triggers.deleteDescription', { name: item.config.name }), [{ text: t('common.cancel'), style: 'cancel' }, { text: t('common.remove'), style: 'destructive', onPress: () => { setBusy('delete'); setError(''); void triggers.remove(item.configHash).then(() => router.back()).catch((cause) => setError(cause instanceof Error ? cause.message : String(cause))).finally(() => setBusy('')); } }]);
  if (editing) return <><Stack.Screen options={{ title: t('triggers.edit') }} /><TriggerForm initial={triggerDraft(item.config)} onSubmit={save} submitLabel={t('common.save')} /></>;
  return <>
    <Stack.Screen options={{ title: item.config.name }} />
    <Screen>
      <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}><Text style={[styles.title, { color: colors.text }]}>{item.config.name}</Text>{item.config.description ? <Text style={[styles.body, { color: colors.textMuted }]}>{item.config.description}</Text> : null}<Text style={[styles.body, { color: colors.text }]}>{triggerSourceSummary(item.config.source)}</Text><Text style={[styles.code, { color: colors.textMuted }]}>{item.configHash}</Text></View>
      {error ? <Text style={[styles.body, { color: colors.error }]}>{error}</Text> : null}
      <Text style={[styles.heading, { color: colors.textMuted }]}>{t('triggers.deployments')}</Text>
      {!item.deployments.length ? <Text style={[styles.empty, { color: colors.textMuted }]}>{t('triggers.noDeployments')}</Text> : item.deployments.map((entry) => <View key={`${entry.instanceId}:${entry.deployment.deploymentId || entry.deployment.configHash}`} style={[styles.deployment, { backgroundColor: colors.surface, borderColor: colors.border }]}><View style={styles.deploymentCopy}><Text style={[styles.deploymentTitle, { color: colors.text }]}>{entry.instanceName}</Text><Text numberOfLines={1} style={[styles.body, { color: colors.textMuted }]}>{entry.deployment.target.aiSessionId} · {entry.runtime?.status || (entry.deployment.enabled ? 'idle' : 'disabled')}</Text>{entry.runtime?.lastError ? <Text style={[styles.body, { color: colors.error }]}>{entry.runtime.lastError}</Text> : null}</View><Pressable disabled={Boolean(busy) || !triggers.state.canMutate} onPress={() => { setBusy(`run:${entry.instanceId}`); setError(''); void triggers.run(entry.instanceId, item.configHash, entry.deployment.deploymentId).catch((cause) => setError(cause instanceof Error ? cause.message : String(cause))).finally(() => setBusy('')); }}><SystemIcon android="play_circle" color={colors.primary} ios="play.circle" size={25} /></Pressable>{item.ownedByControlPlane && entry.deployment.origin === 'control-plane' ? <Pressable disabled={Boolean(busy) || !triggers.state.canMutate} onPress={() => { setBusy(`unbind:${entry.instanceId}`); setError(''); void triggers.unbindSession(entry.instanceId, entry.deployment.target.aiSessionId, item.configHash).catch((cause) => setError(cause instanceof Error ? cause.message : String(cause))).finally(() => setBusy('')); }}><SystemIcon android="link_off" color={colors.error} ios="link" size={23} /></Pressable> : null}</View>)}
      {editable && availableTargets.length ? <>
        <Action icon="link" label={choosingTarget ? t('triggers.hideSessions') : t('triggers.deployToSession')} onPress={() => setChoosingTarget((value) => !value)} />
        {choosingTarget ? availableTargets.map(({ instanceId, session }) => <Pressable key={`${instanceId}:${session.id}`} disabled={Boolean(busy)} onPress={() => { setBusy(`bind:${instanceId}:${session.id}`); setError(''); void triggers.bindSession(instanceId, session.id, item.configHash).then(() => setChoosingTarget(false)).catch((cause) => setError(cause instanceof Error ? cause.message : String(cause))).finally(() => setBusy('')); }} style={({ pressed }) => [styles.deployment, { backgroundColor: colors.surface, borderColor: colors.border }, pressed && styles.pressed]}><View style={styles.deploymentCopy}><Text numberOfLines={1} style={[styles.deploymentTitle, { color: colors.text }]}>{session.title?.trim() || t('sessions.untitled')}</Text><Text numberOfLines={1} style={[styles.body, { color: colors.textMuted }]}>{instanceId}</Text></View><SystemIcon android="add_link" color={colors.primary} ios="link.badge.plus" size={23} /></Pressable>) : null}
      </> : null}
      {item.recentRuns.length ? <><Text style={[styles.heading, { color: colors.textMuted }]}>{t('triggers.recentRuns')}</Text>{item.recentRuns.slice(0, 5).map((run) => <View key={run.id} style={styles.run}><Text style={[styles.body, { color: run.status === 'failed' ? colors.error : colors.text }]}>{run.status}</Text><Text style={[styles.body, { color: colors.textMuted }]}>{run.instanceName || run.instanceId} · {new Date(run.startedAt).toLocaleString()}</Text></View>)}</> : null}
      {editable ? <View style={styles.actions}><Action icon="edit" label={t('triggers.edit')} onPress={() => setEditing(true)} /><Action danger icon="delete" label={t('triggers.delete')} onPress={remove} /></View> : null}
    </Screen>
  </>;
}

function Action({ danger, icon, label, onPress }: { danger?: boolean; icon: 'edit' | 'delete' | 'link'; label: string; onPress(): void }) { const { colors } = useMobileTheme(); return <Pressable onPress={onPress} style={({ pressed }) => [styles.action, { backgroundColor: danger ? colors.errorSoft : colors.primarySoft }, pressed && styles.pressed]}><SystemIcon android={icon} color={danger ? colors.error : colors.primary} ios={icon === 'edit' ? 'pencil' : icon === 'link' ? 'link.badge.plus' : 'trash'} size={18} /><Text style={[styles.actionText, { color: danger ? colors.error : colors.primary }]}>{label}</Text></Pressable>; }
const styles = StyleSheet.create({ card: { borderRadius: 14, borderWidth: StyleSheet.hairlineWidth, gap: 8, padding: 15 }, title: { fontSize: 20, fontWeight: '700' }, body: { fontSize: 13, lineHeight: 18 }, code: { fontFamily: 'monospace', fontSize: 12 }, heading: { fontSize: 13, fontWeight: '600', paddingHorizontal: 4, textTransform: 'uppercase' }, deployment: { alignItems: 'center', borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, flexDirection: 'row', gap: 12, padding: 13 }, deploymentCopy: { flex: 1, gap: 3 }, deploymentTitle: { fontSize: 15, fontWeight: '600' }, empty: { fontSize: 14, padding: 16, textAlign: 'center' }, run: { flexDirection: 'row', justifyContent: 'space-between', gap: 12, paddingHorizontal: 5 }, actions: { flexDirection: 'row', gap: 10 }, action: { alignItems: 'center', borderRadius: 11, flex: 1, flexDirection: 'row', gap: 7, justifyContent: 'center', minHeight: 44 }, actionText: { fontSize: 15, fontWeight: '600' }, pressed: { opacity: 0.62 } });
