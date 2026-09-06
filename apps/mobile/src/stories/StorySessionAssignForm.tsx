import { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import type { Story } from '@task-handoff/protocol/stories';

import { NewSessionContextMenu } from '../ai-sessions/NewSessionContextMenu';
import { useActiveAiSessionsSnapshot } from '../ai-sessions/use-active-sessions';
import { ContextPill } from '../components/ContextPill';
import { SystemIcon } from '../components/SystemIcon';
import { useMobileTheme } from '../components/theme';
import { useMobileControlPlaneRuntime } from '../control-plane/use-mobile-control-plane-runtime';
import { useActiveDirectories } from '../directories/use-directories';
import { useI18n } from '../i18n';

type SessionCandidate = { value: string; instanceId: string; sessionId: string; label: string; instanceName: string };

export function StorySessionAssignForm({ nodeId, onSaved, storyId }: { nodeId?: string; onSaved(): void; storyId?: string }) {
  const { colors } = useMobileTheme();
  const { t } = useI18n();
  const runtime = useMobileControlPlaneRuntime();
  const { state: directory } = useActiveDirectories();
  const sessions = useActiveAiSessionsSnapshot();
  const [story, setStory] = useState<Story>();
  const [selectedValue, setSelectedValue] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!runtime.api || !storyId || !nodeId) return;
    let live = true;
    void runtime.api.stories.get(storyId, nodeId).then((value) => { if (live) setStory(value); }).catch((cause) => { if (live) setError(cause instanceof Error ? cause.message : String(cause)); }).finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [nodeId, runtime.api, storyId]);

  const candidates = useMemo<SessionCandidate[]>(() => {
    if (!story) return [];
    const instances = new Map(directory.instances.filter((instance) => instance.nodeId === story.ownerNodeId).map((instance) => [instance.id, instance]));
    return (sessions?.instances ?? []).flatMap((entry) => {
      const instance = instances.get(entry.instanceId);
      if (!instance) return [];
      return entry.aiSessions.sessions.filter((session) => !session.storyId).map((session) => ({
        value: `${entry.instanceId}:${session.id}`,
        instanceId: entry.instanceId,
        sessionId: session.id,
        label: session.title || session.userPrompt || session.summary || session.lastMessage || t('sessions.untitled'),
        instanceName: instance.name,
      }));
    });
  }, [directory.instances, sessions, story, t]);
  const selected = candidates.find((candidate) => candidate.value === selectedValue) || candidates[0];
  const save = async () => {
    if (!runtime.api || !story || !selected || story.archivedAt || saving) return;
    setSaving(true);
    setError('');
    try {
      await runtime.api.stories.setSessionStory(selected.instanceId, selected.sessionId, story.id);
      onSaved();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <ActivityIndicator accessibilityLabel={t('common.loading')} style={styles.loading} />;
  if (!story) return <View style={styles.state}><Text style={{ color: colors.error }}>{error || t('stories.loadError')}</Text></View>;
  return <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerStyle={styles.content}>
    <View style={styles.field}><Text style={[styles.label, { color: colors.text }]}>{t('stories.assignSession')}</Text>{!candidates.length ? <Text style={[styles.help, { color: colors.textMuted }]}>{t('stories.noUnassignedSessions')}</Text> : null}
      <NewSessionContextMenu cancelLabel={t('common.cancel')} disabled={saving || !candidates.length} onSelect={setSelectedValue} options={candidates.map((candidate) => ({ value: candidate.value, label: candidate.label, description: candidate.instanceName, systemImage: 'terminal' as const }))} selectedValue={selected?.value || ''} title={t('stories.assignSession')}>
        {(onPress) => <ContextPill disabled={saving || !candidates.length} icon={{ android: 'chat_bubble_outline', ios: 'bubble.left' }} label={selected ? `${selected.label} · ${selected.instanceName}` : t('stories.noUnassignedSessions')} onPress={onPress} />}
      </NewSessionContextMenu>
    </View>
    {error ? <Text accessibilityLiveRegion="polite" style={[styles.error, { backgroundColor: colors.errorSoft, color: colors.error }]}>{error}</Text> : null}
    <Pressable accessibilityRole="button" accessibilityState={{ disabled: !selected || Boolean(story.archivedAt) || saving }} disabled={!selected || Boolean(story.archivedAt) || saving} onPress={() => { void save(); }} style={({ pressed }) => [styles.submit, { backgroundColor: colors.primaryButton }, (!selected || story.archivedAt || saving) && styles.disabled, pressed && styles.pressed]}>
      {saving ? <ActivityIndicator color="#fff" /> : <><SystemIcon android="link" color="#fff" ios="link" size={18} /><Text style={styles.submitText}>{t('stories.assignSession')}</Text></>}
    </Pressable>
  </ScrollView>;
}

const styles = StyleSheet.create({
  loading: { flex: 1 }, state: { alignItems: 'center', flex: 1, justifyContent: 'center', padding: 24 }, content: { alignSelf: 'center', gap: 18, maxWidth: 640, padding: 16, paddingBottom: 44, width: '100%' },
  field: { gap: 8 }, label: { fontSize: 16, fontWeight: '600' }, help: { fontSize: 14, lineHeight: 20 }, error: { borderRadius: 10, fontSize: 13, lineHeight: 18, padding: 11 }, submit: { alignItems: 'center', borderRadius: 12, flexDirection: 'row', gap: 8, justifyContent: 'center', minHeight: 50 }, submitText: { color: '#fff', fontSize: 15, fontWeight: '600' }, disabled: { opacity: 0.45 }, pressed: { opacity: 0.7 },
});
