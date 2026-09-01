import { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useMobileTheme } from '../components/theme';
import { useI18n } from '../i18n';
import { useMobileControlPlaneRuntime } from '../control-plane/use-mobile-control-plane-runtime';
import { useActiveDirectories } from '../directories/use-directories';
import type { Story } from '@task-handoff/protocol/stories';

export function renderStoryActionPrompt(template: string, parameters: readonly { name: string; defaultValue?: string }[], values: Readonly<Record<string, string>>) {
  return template.replace(/\{\{\s*([A-Za-z0-9_-]+)\s*\}\}/g, (_, name: string) => values[name] ?? parameters.find((parameter) => parameter.name === name)?.defaultValue ?? '');
}

export function StoryActionForm({ storyId, actionId, nodeId, onCreated }: { storyId?: string; actionId?: string; nodeId?: string; onCreated(instanceId: string, message: string): void }) {
  const { colors } = useMobileTheme(); const { t } = useI18n(); const runtime = useMobileControlPlaneRuntime(); const { state: directory } = useActiveDirectories();
  const [story, setStory] = useState<Story>(); const [values, setValues] = useState<Record<string, string>>({}); const [error, setError] = useState<string>();
  useEffect(() => { if (!runtime.api || !storyId || !nodeId) return; void runtime.api.stories.get(storyId, nodeId).then(setStory).catch((cause) => setError(cause instanceof Error ? cause.message : String(cause))); }, [nodeId, runtime.api, storyId]);
  const action = story?.actions.find((item) => item.id === actionId); const instanceId = action?.targetInstanceId || directory.instances.find((item) => item.nodeId === story?.ownerNodeId && item.ready)?.id;
  const submit = () => { if (!action) return; if (!instanceId) { setError(t('stories.noAvailableInstance')); return; } const missing = action.parameters.find((parameter) => parameter.required && !(values[parameter.name] || parameter.defaultValue || '').trim()); if (missing) { setError(t('stories.parameterRequired', { name: missing.label })); return; } onCreated(instanceId, renderStoryActionPrompt(action.promptTemplate, action.parameters, values)); };
  if (!story && !error) return <ActivityIndicator accessibilityLabel={t('common.loading')} style={styles.loading} />;
  return <ScrollView contentContainerStyle={[styles.content, { backgroundColor: colors.background }]}><Text style={[styles.title, { color: colors.text }]}>{action?.title || t('stories.loadError')}</Text>{action?.parameters.map((parameter) => <View key={parameter.name} style={styles.field}><Text style={[styles.label, { color: colors.text }]}>{parameter.label}{parameter.required ? ' *' : ''}</Text><TextInput value={values[parameter.name] ?? ''} onChangeText={(value) => setValues((current) => ({ ...current, [parameter.name]: value }))} placeholder={parameter.defaultValue} placeholderTextColor={colors.textMuted} style={[styles.input, { backgroundColor: colors.surface, borderColor: colors.border, color: colors.text }]} /></View>)}{error ? <Text style={[styles.error, { color: colors.error }]}>{error}</Text> : null}<Pressable accessibilityRole="button" onPress={submit} style={[styles.submit, { backgroundColor: colors.primary }]}><Text style={styles.submitText}>{t('stories.startAction')}</Text></Pressable></ScrollView>;
}
const styles = StyleSheet.create({ loading: { flex: 1 }, content: { gap: 16, padding: 16 }, title: { fontSize: 22, fontWeight: '600' }, field: { gap: 7 }, label: { fontSize: 14 }, input: { borderRadius: 10, borderWidth: StyleSheet.hairlineWidth, fontSize: 15, minHeight: 44, paddingHorizontal: 12 }, error: { fontSize: 14 }, submit: { alignItems: 'center', borderRadius: 10, minHeight: 46, justifyContent: 'center', marginTop: 4 }, submitText: { color: '#fff', fontSize: 15, fontWeight: '600' } });
