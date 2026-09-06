import { useEffect, useMemo, useState } from 'react';
import * as Crypto from 'expo-crypto';
import { ActivityIndicator, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import type { Story } from '@task-handoff/protocol/stories';

import { NewSessionContextMenu } from '../ai-sessions/NewSessionContextMenu';
import { ContextPill } from '../components/ContextPill';
import { SystemIcon } from '../components/SystemIcon';
import { useMobileTheme } from '../components/theme';
import { useMobileControlPlaneRuntime } from '../control-plane/use-mobile-control-plane-runtime';
import { useActiveDirectories } from '../directories/use-directories';
import { useI18n } from '../i18n';

export function StoryActionEditor({ nodeId, onSaved, storyId }: { nodeId?: string; onSaved(): void; storyId?: string }) {
  const { colors } = useMobileTheme();
  const { t } = useI18n();
  const runtime = useMobileControlPlaneRuntime();
  const { state: directory } = useActiveDirectories();
  const [story, setStory] = useState<Story>();
  const [title, setTitle] = useState('');
  const [prompt, setPrompt] = useState('');
  const [targetInstanceId, setTargetInstanceId] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!runtime.api || !storyId || !nodeId) return;
    let live = true;
    void runtime.api.stories.get(storyId, nodeId).then((value) => {
      if (!live) return;
      setStory(value);
    }).catch((cause) => { if (live) setError(cause instanceof Error ? cause.message : String(cause)); }).finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [nodeId, runtime.api, storyId]);

  const instances = useMemo(() => story ? directory.instances.filter((instance) => instance.nodeId === story.ownerNodeId && instance.ready) : [], [directory.instances, story]);
  const selectedInstance = instances.find((instance) => instance.id === targetInstanceId) || instances[0];
  const selectedTargetInstanceId = targetInstanceId || selectedInstance?.id;
  const valid = Boolean(story && !story.archivedAt && title.trim() && prompt.trim());
  const save = async () => {
    if (!runtime.api || !story || !valid || saving) return;
    setSaving(true);
    setError('');
    try {
      await runtime.api.stories.update(story.id, story.ownerNodeId, {
        actions: [...story.actions, {
          id: `action-${Crypto.randomUUID()}`,
          title: title.trim(),
          promptTemplate: prompt.trim(),
          ...(selectedTargetInstanceId ? { targetInstanceId: selectedTargetInstanceId } : {}),
        }],
      });
      onSaved();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <ActivityIndicator accessibilityLabel={t('common.loading')} style={styles.loading} />;
  if (!story) return <View style={styles.state}><Text style={{ color: colors.error }}>{error || t('stories.loadError')}</Text></View>;
  return <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.fill}>
    <ScrollView automaticallyAdjustKeyboardInsets contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      <View style={styles.field}><Text style={[styles.label, { color: colors.text }]}>{t('stories.actionTitle')}</Text><TextInput accessibilityLabel={t('stories.actionTitle')} autoCapitalize="sentences" onChangeText={setTitle} placeholder={t('stories.actionTitle')} placeholderTextColor={colors.textMuted} style={[styles.input, { backgroundColor: colors.surfaceMuted, borderColor: colors.border, color: colors.text }]} value={title} /></View>
      <View style={styles.field}><Text style={[styles.label, { color: colors.text }]}>{t('stories.actionPrompt')}</Text><TextInput accessibilityLabel={t('stories.actionPrompt')} autoCapitalize="sentences" multiline onChangeText={setPrompt} placeholder={t('stories.actionPrompt')} placeholderTextColor={colors.textMuted} style={[styles.input, styles.textarea, { backgroundColor: colors.surfaceMuted, borderColor: colors.border, color: colors.text }]} textAlignVertical="top" value={prompt} /></View>
      <View style={styles.field}><Text style={[styles.label, { color: colors.text }]}>{t('stories.actionTarget')}</Text><NewSessionContextMenu cancelLabel={t('common.cancel')} disabled={saving || !instances.length} onSelect={setTargetInstanceId} options={instances.map((instance) => ({ value: instance.id, label: instance.name, description: instance.id, systemImage: 'server.rack' as const }))} selectedValue={targetInstanceId} title={t('stories.actionTarget')}>
          {(onPress) => <ContextPill disabled={saving || !instances.length} icon={{ android: 'dns', ios: 'server.rack' }} label={selectedInstance?.name || t('stories.noAvailableInstance')} onPress={onPress} />}
      </NewSessionContextMenu></View>
      {error ? <Text accessibilityLiveRegion="polite" style={[styles.error, { backgroundColor: colors.errorSoft, color: colors.error }]}>{error}</Text> : null}
      <Pressable accessibilityRole="button" accessibilityState={{ disabled: !valid || saving }} disabled={!valid || saving} onPress={() => { void save(); }} style={({ pressed }) => [styles.submit, { backgroundColor: colors.primaryButton }, (!valid || saving) && styles.disabled, pressed && styles.pressed]}>
        {saving ? <ActivityIndicator color="#fff" /> : <><SystemIcon android="save" color="#fff" ios="checkmark" size={18} /><Text style={styles.submitText}>{t('common.save')}</Text></>}
      </Pressable>
    </ScrollView>
  </KeyboardAvoidingView>;
}

const styles = StyleSheet.create({
  fill: { flex: 1 }, loading: { flex: 1 }, state: { alignItems: 'center', flex: 1, justifyContent: 'center', padding: 24 },
  content: { alignSelf: 'center', gap: 18, maxWidth: 640, padding: 16, paddingBottom: 44, width: '100%' },
  field: { gap: 7 }, label: { fontSize: 14, fontWeight: '600' }, input: { borderRadius: 10, borderWidth: StyleSheet.hairlineWidth, fontSize: 15, minHeight: 46, paddingHorizontal: 12 }, textarea: { minHeight: 140, paddingVertical: 12 },
  error: { borderRadius: 10, fontSize: 13, lineHeight: 18, padding: 11 }, submit: { alignItems: 'center', borderRadius: 12, flexDirection: 'row', gap: 8, justifyContent: 'center', minHeight: 50 }, submitText: { color: '#fff', fontSize: 15, fontWeight: '600' }, disabled: { opacity: 0.45 }, pressed: { opacity: 0.7 },
});
