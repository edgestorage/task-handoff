import { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View } from 'react-native';
import {
  STORY_DEFAULT_MAX_IDLE_AI_SESSIONS,
  STORY_MAX_IDLE_AI_SESSIONS,
  STORY_MIN_IDLE_AI_SESSIONS,
  type Story,
} from '@task-handoff/protocol/stories';
import { DEFAULT_STORY_AGENT_TOOL_POLICY, type StoryAgentToolPolicy } from '@task-handoff/protocol/story-agent-tools';
import { nodeAgentCapabilitiesFromPublicNode, nodeStoryAgentToolCapabilities } from '@task-handoff/protocol/node-agent-capabilities';

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
  const [agentToolPolicy, setAgentToolPolicy] = useState<StoryAgentToolPolicy>({ ...DEFAULT_STORY_AGENT_TOOL_POLICY });
  const [savedAgentToolPolicy, setSavedAgentToolPolicy] = useState<StoryAgentToolPolicy>({ ...DEFAULT_STORY_AGENT_TOOL_POLICY });
  const [agentToolState, setAgentToolState] = useState<'hidden' | 'loading' | 'ready' | 'unsupported' | 'unavailable'>(storyId ? 'loading' : 'hidden');
  const [busy, setBusy] = useState(Boolean(storyId));
  const [error, setError] = useState<string>();
  const selectedOwnerNodeId = resolveStoryOwnerNodeId(ownerNodeId, nodes);
  const parsedMaxIdleAiSessions = parseStoryMaxIdleAiSessions(maxIdleAiSessions);

  useEffect(() => {
    if (!storyId || !nodeId || !runtime.api) return;
    const api = runtime.api;
    let cancelled = false;
    const ownerNode = directory.nodes.find((node) => node.id === nodeId);
    const nodeAvailable = Boolean(ownerNode && ownerNode.connectionPhase !== 'offline');
    const ownerNodeRequest = nodeAvailable
      ? api.resources.node(nodeId).then((value) => ({ ok: true as const, value }), () => ({ ok: false as const }))
      : Promise.resolve({ ok: false as const });
    setAgentToolState(nodeAvailable ? 'loading' : 'unavailable');
    void Promise.all([
      api.stories.get(storyId, nodeId),
      api.stories.retentionSettings(storyId, nodeId),
      ownerNodeRequest,
    ]).then(async ([value, settings, ownerNodeResult]) => {
      if (cancelled) return;
      setStory(value);
      setTitle(value.title);
      setDescription(value.description || '');
      setMaxIdleAiSessions(String(settings.maxIdleAiSessions));
      if (!ownerNodeResult.ok) {
        setAgentToolState('unavailable');
        return;
      }
      const toolsSupported = nodeStoryAgentToolCapabilities(
        nodeAgentCapabilitiesFromPublicNode(ownerNodeResult.value.capabilities),
      ).policy;
      if (!toolsSupported) {
        setAgentToolState('unsupported');
        return;
      }
      const toolSettings = await api.stories.agentToolSettings(storyId, nodeId).catch(() => undefined);
      if (cancelled) return;
      if (toolSettings) {
        setAgentToolPolicy({ ...toolSettings.policy });
        setSavedAgentToolPolicy({ ...toolSettings.policy });
        setAgentToolState('ready');
      } else {
        setAgentToolState('unavailable');
      }
    }).catch((cause) => {
      if (!cancelled) {
        setError(cause instanceof Error ? cause.message : String(cause));
        setAgentToolState('unavailable');
      }
    }).finally(() => {
      if (!cancelled) setBusy(false);
    });
    return () => { cancelled = true; };
  }, [directory.nodes, nodeId, runtime.api, storyId]);

  const setAgentTool = (category: keyof StoryAgentToolPolicy, value: boolean) => {
    setAgentToolPolicy((current) => ({ ...current, [category]: value }));
  };

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
      if (story && agentToolState === 'ready' && JSON.stringify(agentToolPolicy) !== JSON.stringify(savedAgentToolPolicy)) {
        const settings = await runtime.api.stories.updateAgentToolSettings(story.id, story.ownerNodeId, agentToolPolicy);
        setAgentToolPolicy({ ...settings.policy });
        setSavedAgentToolPolicy({ ...settings.policy });
      }
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
    {storyId ? <View style={[styles.toolSettings, { borderColor: colors.border, backgroundColor: colors.surface }]}>
      <Text style={[styles.sectionTitle, { color: colors.text }]}>{t('stories.agentTools')}</Text>
      {agentToolState === 'loading' ? <Text style={[styles.stateText, { color: colors.textMuted }]}>{t('stories.agentToolsLoading')}</Text> : null}
      {agentToolState === 'unsupported' ? <Text style={[styles.stateText, { color: colors.textMuted }]}>{t('stories.agentToolsUnsupported')}</Text> : null}
      {agentToolState === 'unavailable' ? <Text style={[styles.stateText, { color: colors.error }]}>{t('stories.agentToolsUnavailable')}</Text> : null}
      {agentToolState === 'ready' ? <>
        <ToolSwitch label={t('stories.agentToolContent')} value={agentToolPolicy.content} disabled={busy} onChange={(value) => setAgentTool('content', value)} colors={colors} />
        <ToolSwitch label={t('stories.agentToolActions')} value={agentToolPolicy.actions} disabled={busy} onChange={(value) => setAgentTool('actions', value)} colors={colors} />
        <ToolSwitch label={t('stories.agentToolAutomations')} value={agentToolPolicy.automations} disabled={busy} onChange={(value) => setAgentTool('automations', value)} colors={colors} />
        <ToolSwitch label={t('stories.agentToolAiSessions')} value={agentToolPolicy.aiSessions} disabled={busy} onChange={(value) => setAgentTool('aiSessions', value)} colors={colors} />
      </> : null}
    </View> : null}
    {error ? <Text style={[styles.error, { color: colors.error }]}>{error}</Text> : null}
    <Pressable disabled={saveDisabled} onPress={() => { void save(); }} style={[styles.primary, { backgroundColor: colors.primary }, saveDisabled && styles.disabled]}>
      <Text style={styles.primaryText}>{t('common.save')}</Text>
    </Pressable>
  </ScrollView>;
}

function ToolSwitch({ label, value, disabled, onChange, colors }: {
  label: string;
  value: boolean;
  disabled: boolean;
  onChange(value: boolean): void;
  colors: ReturnType<typeof useMobileTheme>['colors'];
}) {
  return <View style={[styles.switchRow, { borderTopColor: colors.border }]}>
    <Text style={[styles.switchLabel, { color: colors.text }]}>{label}</Text>
    <Switch accessibilityLabel={label} disabled={disabled} onValueChange={onChange} trackColor={{ false: colors.border, true: colors.primary }} value={value} />
  </View>;
}

const styles = StyleSheet.create({
  loading: { flex: 1 },
  content: { gap: 18, padding: 16 },
  field: { gap: 7 },
  label: { fontSize: 14, fontWeight: '500' },
  toolSettings: { borderRadius: 8, borderWidth: StyleSheet.hairlineWidth, paddingHorizontal: 12 },
  sectionTitle: { fontSize: 14, fontWeight: '500', paddingVertical: 12 },
  stateText: { fontSize: 13, lineHeight: 19, paddingBottom: 12 },
  switchRow: { alignItems: 'center', borderTopWidth: StyleSheet.hairlineWidth, flexDirection: 'row', justifyContent: 'space-between', minHeight: 48 },
  switchLabel: { flex: 1, fontSize: 14, fontWeight: '400', paddingRight: 12 },
  input: { borderRadius: 10, borderWidth: StyleSheet.hairlineWidth, fontSize: 15, minHeight: 44, paddingHorizontal: 12 },
  textarea: { minHeight: 110, paddingTop: 11, textAlignVertical: 'top' },
  error: { fontSize: 14 },
  primary: { alignItems: 'center', borderRadius: 10, justifyContent: 'center', minHeight: 46 },
  primaryText: { color: '#fff', fontSize: 15, fontWeight: '600' },
  disabled: { opacity: 0.5 },
});
