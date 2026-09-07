import { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import {
  STORY_DEFAULT_MAX_IDLE_AI_SESSIONS,
  STORY_MAX_IDLE_AI_SESSIONS,
  STORY_MIN_IDLE_AI_SESSIONS,
  type Story,
} from '@task-handoff/protocol/stories';

import { NewSessionContextMenu } from '../ai-sessions/NewSessionContextMenu';
import { ContextPill } from '../components/ContextPill';
import { useMobileTheme } from '../components/theme';
import { useMobileControlPlaneRuntime } from '../control-plane/use-mobile-control-plane-runtime';
import { useActiveDirectories } from '../directories/use-directories';
import { useI18n } from '../i18n';

export function resolveStoryOwnerNodeId(current: string, nodes: readonly { id: string }[]) {
  return current || nodes[0]?.id || '';
}

export function parseStoryMaxIdleAiSessions(value: string) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= STORY_MIN_IDLE_AI_SESSIONS && parsed <= STORY_MAX_IDLE_AI_SESSIONS
    ? parsed
    : undefined;
}

export function StoryEditor({ storyId, nodeId, onSaved }: { storyId?: string; nodeId?: string; onSaved(story: Story): void }) {
  const { colors } = useMobileTheme();
  const { t } = useI18n();
  const runtime = useMobileControlPlaneRuntime();
  const { state: directory } = useActiveDirectories();
  const nodes = useMemo(() => directory.nodes.filter((node) => node.connectionPhase !== 'offline'), [directory.nodes]);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [maxIdleAiSessions, setMaxIdleAiSessions] = useState(String(STORY_DEFAULT_MAX_IDLE_AI_SESSIONS));
  const [ownerNodeId, setOwnerNodeId] = useState(() => resolveStoryOwnerNodeId(nodeId || '', nodes));
  const [story, setStory] = useState<Story>();
  const [busy, setBusy] = useState(Boolean(storyId));
  const [error, setError] = useState<string>();
  const selectedOwnerNodeId = resolveStoryOwnerNodeId(ownerNodeId, nodes);
  const parsedMaxIdleAiSessions = parseStoryMaxIdleAiSessions(maxIdleAiSessions);

  useEffect(() => {
    if (!storyId || !nodeId || !runtime.api) return;
    let cancelled = false;
    void Promise.all([
      runtime.api.stories.get(storyId, nodeId),
      runtime.api.stories.retentionSettings(storyId, nodeId),
    ]).then(([value, settings]) => {
      if (cancelled) return;
      setStory(value);
      setTitle(value.title);
      setDescription(value.description || '');
      setMaxIdleAiSessions(String(settings.maxIdleAiSessions));
    }).catch((cause) => {
      if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
    }).finally(() => {
      if (!cancelled) setBusy(false);
    });
    return () => { cancelled = true; };
  }, [nodeId, runtime.api, storyId]);

  const save = async () => {
    if (!runtime.api || !title.trim() || !selectedOwnerNodeId || parsedMaxIdleAiSessions === undefined) return;
    setBusy(true);
    setError(undefined);
    try {
      const saved = story
        ? await runtime.api.stories.update(story.id, story.ownerNodeId, {
          title: title.trim(),
          description: description.trim() || null,
          maxIdleAiSessions: parsedMaxIdleAiSessions,
        })
        : await runtime.api.stories.create(selectedOwnerNodeId, {
          title: title.trim(),
          description: description.trim() || undefined,
          maxIdleAiSessions: parsedMaxIdleAiSessions,
        });
      onSaved(saved);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  if (busy && storyId && !story) return <ActivityIndicator accessibilityLabel={t('common.loading')} style={styles.loading} />;
  const saveDisabled = busy || !title.trim() || !selectedOwnerNodeId || parsedMaxIdleAiSessions === undefined;
  return <ScrollView automaticallyAdjustKeyboardInsets contentInsetAdjustmentBehavior="automatic" contentContainerStyle={[styles.content, { backgroundColor: colors.background }]} keyboardShouldPersistTaps="handled">
    <View style={styles.field}>
      <Text style={[styles.label, { color: colors.text }]}>{t('stories.title')}</Text>
      <TextInput accessibilityLabel={t('stories.title')} autoFocus={!storyId} maxLength={240} onChangeText={setTitle} value={title} style={[styles.input, { backgroundColor: colors.surface, borderColor: colors.border, color: colors.text }]} />
    </View>
    <View style={styles.field}>
      <Text style={[styles.label, { color: colors.text }]}>{t('stories.description')}</Text>
      <TextInput accessibilityLabel={t('stories.description')} maxLength={4000} multiline onChangeText={setDescription} value={description} style={[styles.input, styles.textarea, { backgroundColor: colors.surface, borderColor: colors.border, color: colors.text }]} />
    </View>
    {!storyId ? <View style={styles.field}>
      <Text style={[styles.label, { color: colors.text }]}>{t('stories.ownerNode')}</Text>
      <NewSessionContextMenu cancelLabel={t('common.cancel')} disabled={!nodes.length} onSelect={setOwnerNodeId} options={nodes.map((node) => ({ value: node.id, label: node.name, description: node.id, systemImage: 'server.rack' }))} selectedValue={selectedOwnerNodeId} title={t('stories.ownerNode')}>
        {(onPress) => <ContextPill disabled={!nodes.length} icon={{ android: 'dns', ios: 'server.rack' }} label={nodes.find((node) => node.id === selectedOwnerNodeId)?.name || t('stories.selectNode')} onPress={onPress} />}
      </NewSessionContextMenu>
    </View> : null}
    <View style={styles.field}>
      <Text style={[styles.label, { color: colors.text }]}>{t('stories.maxIdleAiSessions')}</Text>
      <TextInput
        accessibilityLabel={t('stories.maxIdleAiSessions')}
        inputMode="numeric"
        keyboardType="number-pad"
        maxLength={2}
        onChangeText={setMaxIdleAiSessions}
        value={maxIdleAiSessions}
        style={[styles.input, { backgroundColor: colors.surface, borderColor: parsedMaxIdleAiSessions === undefined ? colors.error : colors.border, color: colors.text }]}
      />
    </View>
    {error ? <Text style={[styles.error, { color: colors.error }]}>{error}</Text> : null}
    <Pressable disabled={saveDisabled} onPress={() => { void save(); }} style={[styles.primary, { backgroundColor: colors.primary }, saveDisabled && styles.disabled]}>
      <Text style={styles.primaryText}>{t('common.save')}</Text>
    </Pressable>
  </ScrollView>;
}

const styles = StyleSheet.create({
  loading: { flex: 1 },
  content: { gap: 18, padding: 16 },
  field: { gap: 7 },
  label: { fontSize: 14, fontWeight: '500' },
  input: { borderRadius: 10, borderWidth: StyleSheet.hairlineWidth, fontSize: 15, minHeight: 44, paddingHorizontal: 12 },
  textarea: { minHeight: 110, paddingTop: 11, textAlignVertical: 'top' },
  error: { fontSize: 14 },
  primary: { alignItems: 'center', borderRadius: 10, justifyContent: 'center', minHeight: 46 },
  primaryText: { color: '#fff', fontSize: 15, fontWeight: '600' },
  disabled: { opacity: 0.5 },
});
