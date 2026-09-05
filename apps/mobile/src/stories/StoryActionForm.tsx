import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text } from 'react-native';
import { useMobileTheme } from '../components/theme';
import { useI18n } from '../i18n';
import { useMobileControlPlaneRuntime } from '../control-plane/use-mobile-control-plane-runtime';
import { useActiveDirectories } from '../directories/use-directories';
import type { Story } from '@task-handoff/protocol/stories';

export function StoryActionForm({ storyId, actionId, nodeId, onCreated }: { storyId?: string; actionId?: string; nodeId?: string; onCreated(instanceId: string, message: string): void }) {
  const { colors } = useMobileTheme(); const { t } = useI18n(); const runtime = useMobileControlPlaneRuntime(); const { state: directory } = useActiveDirectories();
  const [story, setStory] = useState<Story>(); const [error, setError] = useState<string>();
  useEffect(() => { if (!runtime.api || !storyId || !nodeId) return; void runtime.api.stories.get(storyId, nodeId).then(setStory).catch((cause) => setError(cause instanceof Error ? cause.message : String(cause))); }, [nodeId, runtime.api, storyId]);
  const action = story?.actions.find((item) => item.id === actionId); const instanceId = action?.targetInstanceId || directory.instances.find((item) => item.nodeId === story?.ownerNodeId && item.ready)?.id;
  const submit = () => { if (!action) return; if (!instanceId) { setError(t('stories.noAvailableInstance')); return; } onCreated(instanceId, action.promptTemplate); };
  if (!story && !error) return <ActivityIndicator accessibilityLabel={t('common.loading')} style={styles.loading} />;
  return <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerStyle={[styles.content, { backgroundColor: colors.background }]}><Text style={[styles.title, { color: colors.text }]}>{action?.title || t('stories.loadError')}</Text>{error ? <Text style={[styles.error, { color: colors.error }]}>{error}</Text> : null}<Pressable accessibilityRole="button" onPress={submit} style={[styles.submit, { backgroundColor: colors.primary }]}><Text style={styles.submitText}>{t('stories.startAction')}</Text></Pressable></ScrollView>;
}
const styles = StyleSheet.create({ loading: { flex: 1 }, content: { gap: 16, padding: 16 }, title: { fontSize: 22, fontWeight: '600' }, error: { fontSize: 14 }, submit: { alignItems: 'center', borderRadius: 10, minHeight: 46, justifyContent: 'center', marginTop: 4 }, submitText: { color: '#fff', fontSize: 15, fontWeight: '600' } });
