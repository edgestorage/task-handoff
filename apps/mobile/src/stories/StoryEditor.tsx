import { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View } from 'react-native';
import type { ControlPlaneNodeLocalFolder } from '@task-handoff/control-plane-client';
import {
  STORY_DEFAULT_MAX_IDLE_AI_SESSIONS,
  STORY_MAX_IDLE_AI_SESSIONS,
  STORY_MIN_IDLE_AI_SESSIONS,
  type Story,
} from '@task-handoff/protocol/stories';
import { DEFAULT_STORY_AGENT_TOOL_POLICY, type StoryAgentToolPolicy } from '@task-handoff/protocol/story-agent-tools';
import {
  STORY_CONTEXT_APPENDED_PROMPT_MAX_LENGTH,
  STORY_CONTEXT_MAX_PROJECTS,
  type StoryContextSettings,
} from '@task-handoff/protocol/story-context';
import {
  nodeAgentCapabilitiesFromPublicNode,
  nodeStoryAgentToolCapabilities,
  nodeStoryContextCapabilities,
} from '@task-handoff/protocol/node-agent-capabilities';

import { NewSessionContextMenu } from '../ai-sessions/NewSessionContextMenu';
import { ContextPill } from '../components/ContextPill';
import { Icon } from '../components/Icon';
import { useMobileTheme } from '../components/theme';
import { useMobileControlPlaneRuntime } from '../control-plane/use-mobile-control-plane-runtime';
import { useActiveDirectories } from '../directories/use-directories';
import { useI18n } from '../i18n';

type SettingsState = 'hidden' | 'loading' | 'ready' | 'unsupported' | 'unavailable';
type StoryContextCapabilities = { settings: boolean; projects: boolean; sessionPrompting: boolean };
const EMPTY_STORY_CONTEXT_CAPABILITIES: StoryContextCapabilities = { settings: false, projects: false, sessionPrompting: false };

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
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [maxIdleAiSessions, setMaxIdleAiSessions] = useState(String(STORY_DEFAULT_MAX_IDLE_AI_SESSIONS));
  const [ownerNodeId, setOwnerNodeId] = useState(() => resolveStoryOwnerNodeId(nodeId || '', nodes));
  const [story, setStory] = useState<Story>();
  const [agentToolPolicy, setAgentToolPolicy] = useState<StoryAgentToolPolicy>({ ...DEFAULT_STORY_AGENT_TOOL_POLICY });
  const [savedAgentToolPolicy, setSavedAgentToolPolicy] = useState<StoryAgentToolPolicy>({ ...DEFAULT_STORY_AGENT_TOOL_POLICY });
  const [agentToolState, setAgentToolState] = useState<SettingsState>(storyId ? 'loading' : 'hidden');
  const [decisionToolSupported, setDecisionToolSupported] = useState(false);
  const [contextCapabilities, setContextCapabilities] = useState<StoryContextCapabilities>(EMPTY_STORY_CONTEXT_CAPABILITIES);
  const [contextState, setContextState] = useState<SettingsState>('hidden');
  const [contextError, setContextError] = useState<string>();
  const [contextRevision, setContextRevision] = useState(0);
  const [contextRevisionLoaded, setContextRevisionLoaded] = useState(false);
  const [contextLoadedKey, setContextLoadedKey] = useState('');
  const [folders, setFolders] = useState<readonly ControlPlaneNodeLocalFolder[]>([]);
  const [projectFolderIds, setProjectFolderIds] = useState<string[]>([]);
  const [savedProjectFolderIds, setSavedProjectFolderIds] = useState<string[]>([]);
  const [storyContextPrompt, setStoryContextPrompt] = useState('');
  const [savedStoryContextPrompt, setSavedStoryContextPrompt] = useState('');
  const [busy, setBusy] = useState(Boolean(storyId));
  const [error, setError] = useState<string>();
  const selectedOwnerNodeId = resolveStoryOwnerNodeId(ownerNodeId, nodes);
  const parsedMaxIdleAiSessions = parseStoryMaxIdleAiSessions(maxIdleAiSessions);
  const contextVisible = contextCapabilities.settings
    && (contextCapabilities.projects || contextCapabilities.sessionPrompting);
  const contextDirty = storyContextPrompt !== savedStoryContextPrompt
    || JSON.stringify(projectFolderIds) !== JSON.stringify(savedProjectFolderIds);
  const contextKey = storyId ? `${storyId}\u0000${selectedOwnerNodeId}` : `create\u0000${selectedOwnerNodeId}`;

  useEffect(() => {
    if (!storyId || !nodeId || !runtime.api) return;
    const api = runtime.api;
    let cancelled = false;
    const ownerNode = directory.nodes.find((node) => node.id === nodeId);
    const nodeAvailable = Boolean(ownerNode && ownerNode.connectionPhase !== 'offline');
    const ownerNodeRequest = nodeAvailable
      ? api.resources.node(nodeId).then((value) => ({ ok: true as const, value }), () => ({ ok: false as const }))
      : Promise.resolve({ ok: false as const });
    queueMicrotask(() => {
      if (!cancelled) setAgentToolState(nodeAvailable ? 'loading' : 'unavailable');
    });
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
      const toolCapabilities = nodeStoryAgentToolCapabilities(
        nodeAgentCapabilitiesFromPublicNode(ownerNodeResult.value.capabilities),
      );
      if (!toolCapabilities.policy) {
        setAgentToolState('unsupported');
        return;
      }
      setDecisionToolSupported(toolCapabilities.decisions);
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

  useEffect(() => {
    if (!advancedOpen || !runtime.api || !selectedOwnerNodeId) return;
    if (storyId && contextLoadedKey === contextKey && contextState === 'ready') return;
    const api = runtime.api;
    const controller = new AbortController();
    let cancelled = false;
    setContextState('loading');
    setContextError(undefined);
    void Promise.all([
      api.resources.node(selectedOwnerNodeId),
      api.resources.nodeLocalFolders(selectedOwnerNodeId, controller.signal),
    ]).then(async ([ownerNode, nextFolders]) => {
      if (cancelled) return;
      setFolders(nextFolders);
      const capabilities = nodeStoryContextCapabilities(nodeAgentCapabilitiesFromPublicNode(ownerNode.capabilities));
      setContextCapabilities(capabilities);
      if (!capabilities.settings || (!capabilities.projects && !capabilities.sessionPrompting)) {
        setContextState('unsupported');
        return;
      }
      if (!storyId) {
        if (contextLoadedKey !== contextKey) {
          setProjectFolderIds([]);
          setSavedProjectFolderIds([]);
          setStoryContextPrompt('');
          setSavedStoryContextPrompt('');
          setContextRevision(0);
          setContextRevisionLoaded(false);
          setContextLoadedKey(contextKey);
        }
        const tools = nodeStoryAgentToolCapabilities(nodeAgentCapabilitiesFromPublicNode(ownerNode.capabilities));
        setDecisionToolSupported(tools.decisions);
        setAgentToolState(tools.policy ? 'ready' : 'unsupported');
        setContextState('ready');
        return;
      }
      const settings = await api.stories.contextSettings(storyId, selectedOwnerNodeId, controller.signal);
      if (cancelled) return;
      applyStoryContextSettings(settings);
    }).catch((cause) => {
      if (cancelled) return;
      setContextState('unavailable');
      setContextError(cause instanceof Error ? cause.message : String(cause));
    });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [advancedOpen, contextKey, runtime.api, selectedOwnerNodeId, storyId]);

  const setAgentTool = (category: keyof StoryAgentToolPolicy, value: boolean) => {
    setAgentToolPolicy((current) => ({ ...current, [category]: value }));
  };

  const applyStoryContextSettings = (settings: StoryContextSettings) => {
    setContextRevision(settings.revision);
    setContextRevisionLoaded(true);
    setProjectFolderIds([...settings.projectFolderIds]);
    setSavedProjectFolderIds([...settings.projectFolderIds]);
    setStoryContextPrompt(settings.appendedPrompt);
    setSavedStoryContextPrompt(settings.appendedPrompt);
    setContextLoadedKey(`${settings.storyId}\u0000${selectedOwnerNodeId}`);
    setContextState('ready');
    setContextError(undefined);
  };

  const addProject = (folderId: string) => {
    if (!folderId || projectFolderIds.includes(folderId) || projectFolderIds.length >= STORY_CONTEXT_MAX_PROJECTS) return;
    setProjectFolderIds((current) => [...current, folderId]);
  };
  const moveProject = (index: number, offset: -1 | 1) => {
    const target = index + offset;
    if (target < 0 || target >= projectFolderIds.length) return;
    setProjectFolderIds((current) => {
      const next = [...current];
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  };
  const removeProject = (folderId: string) => setProjectFolderIds((current) => current.filter((id) => id !== folderId));
  const folderById = (folderId: string) => folders.find((folder) => folder.id === folderId);
  const availableFolders = folders.filter((folder) => !projectFolderIds.includes(folder.id));

  const save = async () => {
    if (!runtime.api || !title.trim() || !selectedOwnerNodeId || parsedMaxIdleAiSessions === undefined) return;
    setBusy(true);
    setError(undefined);
    try {
      const savedStory = story
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
      if (!story) setStory(savedStory);
      if (contextVisible && contextDirty) {
        const expectedRevision = contextRevisionLoaded
          ? contextRevision
          : (await runtime.api.stories.contextSettings(savedStory.id, savedStory.ownerNodeId)).revision;
        const settings = await runtime.api.stories.updateContextSettings(savedStory.id, savedStory.ownerNodeId, {
          expectedRevision,
          projectFolderIds: [...projectFolderIds],
          appendedPrompt: storyContextPrompt,
        });
        applyStoryContextSettings(settings);
      }
      if (agentToolState === 'ready' && JSON.stringify(agentToolPolicy) !== JSON.stringify(savedAgentToolPolicy)) {
        const settings = await runtime.api.stories.updateAgentToolSettings(savedStory.id, savedStory.ownerNodeId, agentToolPolicy);
        setAgentToolPolicy({ ...settings.policy });
        setSavedAgentToolPolicy({ ...settings.policy });
      }
      onSaved(savedStory);
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
        {(onPress) => <ContextPill disabled={!nodes.length} icon="server-outline" label={nodes.find((node) => node.id === selectedOwnerNodeId)?.name || t('stories.selectNode')} onPress={onPress} />}
      </NewSessionContextMenu>
    </View> : null}

    <View style={[styles.advancedCard, { backgroundColor: colors.surface, borderColor: colors.border }]}>
      <Pressable
        accessibilityLabel={t('stories.advancedSettings')}
        accessibilityRole="button"
        accessibilityState={{ expanded: advancedOpen }}
        onPress={() => setAdvancedOpen((value) => !value)}
        style={({ pressed }) => [styles.advancedHeader, pressed && styles.pressed]}
      >
        <View style={[styles.advancedIcon, { backgroundColor: colors.background }]}><Icon color={colors.primary} name="options-outline" size={18} /></View>
        <View style={styles.advancedCopy}>
          <Text style={[styles.advancedTitle, { color: colors.text }]}>{t('stories.advancedSettings')}</Text>
          <Text style={[styles.advancedDescription, { color: colors.textMuted }]}>{t('stories.advancedSettingsDescription')}</Text>
        </View>
        <Icon color={colors.textMuted} name={advancedOpen ? 'chevron-up' : 'chevron-down'} size={14} />
      </Pressable>
      {advancedOpen ? <View style={[styles.advancedFields, { borderTopColor: colors.border }]}>
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

        {agentToolState !== 'hidden' ? <View style={[styles.toolSettings, { borderColor: colors.border }]}>
          <Text style={[styles.sectionTitle, { color: colors.text }]}>{t('stories.agentTools')}</Text>
          {agentToolState === 'loading' ? <Text style={[styles.stateText, { color: colors.textMuted }]}>{t('stories.agentToolsLoading')}</Text> : null}
          {agentToolState === 'unsupported' ? <Text style={[styles.stateText, { color: colors.textMuted }]}>{t('stories.agentToolsUnsupported')}</Text> : null}
          {agentToolState === 'unavailable' ? <Text style={[styles.stateText, { color: colors.error }]}>{t('stories.agentToolsUnavailable')}</Text> : null}
          {agentToolState === 'ready' ? <>
            <ToolSwitch label={t('stories.agentToolContent')} value={agentToolPolicy.content} disabled={busy} onChange={(value) => setAgentTool('content', value)} colors={colors} />
            {decisionToolSupported ? <ToolSwitch label={t('stories.agentToolDecisions')} value={agentToolPolicy.decisions} disabled={busy} onChange={(value) => setAgentTool('decisions', value)} colors={colors} /> : null}
            <ToolSwitch label={t('stories.agentToolActions')} value={agentToolPolicy.actions} disabled={busy} onChange={(value) => setAgentTool('actions', value)} colors={colors} />
            <ToolSwitch label={t('stories.agentToolAutomations')} value={agentToolPolicy.automations} disabled={busy} onChange={(value) => setAgentTool('automations', value)} colors={colors} />
            <ToolSwitch label={t('stories.agentToolAiSessions')} value={agentToolPolicy.aiSessions} disabled={busy} onChange={(value) => setAgentTool('aiSessions', value)} colors={colors} />
          </> : null}
        </View> : null}

        {contextVisible || contextState === 'loading' ? <View style={[styles.contextSettings, { borderColor: colors.border }]}>
          <Text style={[styles.sectionTitle, { color: colors.text }]}>{t('stories.storyContext')}</Text>
          {contextState === 'loading' ? <Text style={[styles.stateText, { color: colors.textMuted }]}>{t('stories.storyContextLoading')}</Text> : null}
          {contextState === 'unavailable' ? <Text style={[styles.stateText, { color: colors.error }]}>{contextError || t('stories.storyContextUnavailable')}</Text> : null}
          {contextState === 'ready' && contextVisible ? <View style={styles.contextBody}>
            {contextCapabilities.projects ? <View style={styles.contextSection}>
              <View style={styles.contextHeading}>
                <Text style={[styles.contextHeadingText, { color: colors.text }]}>{t('stories.storyContextProjects')}</Text>
                <Text style={[styles.contextCount, { color: colors.textMuted }]}>{projectFolderIds.length} / {STORY_CONTEXT_MAX_PROJECTS}</Text>
              </View>
              <Text style={[styles.contextNote, { color: colors.textMuted }]}>{t('stories.storyContextProjectsNote')}</Text>
              {projectFolderIds.length ? <View style={[styles.projectList, { borderColor: colors.border }]}>
                {projectFolderIds.map((folderId, index) => {
                  const folder = folderById(folderId);
                  const name = folder?.name || t('stories.storyContextProjectUnavailable');
                  return <View key={folderId} style={[styles.projectRow, index > 0 && { borderTopColor: colors.border, borderTopWidth: StyleSheet.hairlineWidth }]}>
                    <Text style={[styles.projectIndex, { color: colors.textMuted }]}>{index + 1}</Text>
                    <View style={styles.projectCopy}>
                      <Text numberOfLines={1} style={[styles.projectName, { color: colors.text }]}>{name}</Text>
                      <Text numberOfLines={1} style={[styles.projectPath, { color: colors.textMuted }]}>{folder?.path || folderId}</Text>
                    </View>
                    <Pressable accessibilityLabel={t('stories.storyContextMoveUp', { name })} accessibilityRole="button" accessibilityState={{ disabled: index === 0 || busy }} disabled={index === 0 || busy} onPress={() => moveProject(index, -1)} style={styles.projectAction}>
                      <Icon color={colors.textMuted} name="chevron-up" size={16} />
                    </Pressable>
                    <Pressable accessibilityLabel={t('stories.storyContextMoveDown', { name })} accessibilityRole="button" accessibilityState={{ disabled: index === projectFolderIds.length - 1 || busy }} disabled={index === projectFolderIds.length - 1 || busy} onPress={() => moveProject(index, 1)} style={styles.projectAction}>
                      <Icon color={colors.textMuted} name="chevron-down" size={16} />
                    </Pressable>
                    <Pressable accessibilityLabel={t('stories.storyContextRemoveProject', { name })} accessibilityRole="button" disabled={busy} onPress={() => removeProject(folderId)} style={styles.projectAction}>
                      <Icon color={colors.textMuted} name="close" size={16} />
                    </Pressable>
                  </View>;
                })}
              </View> : <Text style={[styles.stateText, { color: colors.textMuted }]}>{t('stories.storyContextProjectsEmpty')}</Text>}
              <NewSessionContextMenu
                cancelLabel={t('common.cancel')}
                disabled={!availableFolders.length || projectFolderIds.length >= STORY_CONTEXT_MAX_PROJECTS || busy}
                onSelect={addProject}
                options={availableFolders.map((folder) => ({ value: folder.id, label: folder.name, description: folder.path, systemImage: 'folder' }))}
                selectedValue=""
                title={t('stories.storyContextAddProject')}
              >
                {(onPress) => <ContextPill disabled={!availableFolders.length || projectFolderIds.length >= STORY_CONTEXT_MAX_PROJECTS || busy} icon="add-outline" label={availableFolders.length ? t('stories.storyContextAddProject') : t('stories.storyContextNoProjects')} onPress={onPress} />}
              </NewSessionContextMenu>
            </View> : null}
            {contextCapabilities.sessionPrompting ? <View style={[styles.contextSection, contextCapabilities.projects && { borderTopColor: colors.border, borderTopWidth: StyleSheet.hairlineWidth, paddingTop: 12 }]}>
              <Text style={[styles.contextHeadingText, { color: colors.text }]}>{t('stories.storyContextPrompt')}</Text>
              <TextInput
                accessibilityLabel={t('stories.storyContextPrompt')}
                maxLength={STORY_CONTEXT_APPENDED_PROMPT_MAX_LENGTH}
                multiline
                onChangeText={setStoryContextPrompt}
                placeholder={t('stories.storyContextPromptPlaceholder')}
                placeholderTextColor={colors.textMuted}
                style={[styles.input, styles.contextTextarea, { backgroundColor: colors.surface, borderColor: colors.border, color: colors.text }]}
                value={storyContextPrompt}
              />
              <Text style={[styles.contextCount, { color: colors.textMuted }]}>{storyContextPrompt.length} / {STORY_CONTEXT_APPENDED_PROMPT_MAX_LENGTH}</Text>
            </View> : null}
            <Text style={[styles.contextNote, { color: colors.textMuted }]}>{t('stories.storyContextOrder')}</Text>
          </View> : null}
        </View> : null}
      </View> : null}
    </View>

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
  advancedCard: { borderRadius: 16, borderWidth: StyleSheet.hairlineWidth, overflow: 'hidden' },
  advancedHeader: { alignItems: 'center', flexDirection: 'row', gap: 12, minHeight: 68, paddingHorizontal: 14 },
  advancedIcon: { alignItems: 'center', borderRadius: 10, height: 36, justifyContent: 'center', width: 36 },
  advancedCopy: { flex: 1, gap: 2 },
  advancedTitle: { fontSize: 15, fontWeight: '500', lineHeight: 20 },
  advancedDescription: { fontSize: 12, lineHeight: 17 },
  advancedFields: { borderTopWidth: StyleSheet.hairlineWidth, gap: 16, padding: 14 },
  toolSettings: { borderRadius: 8, borderWidth: StyleSheet.hairlineWidth, paddingHorizontal: 12 },
  contextSettings: { borderRadius: 8, borderWidth: StyleSheet.hairlineWidth, paddingHorizontal: 12, paddingBottom: 12 },
  sectionTitle: { fontSize: 14, fontWeight: '500', paddingVertical: 12 },
  stateText: { fontSize: 13, lineHeight: 19, paddingBottom: 12 },
  contextBody: { gap: 12 },
  contextSection: { gap: 8, minWidth: 0 },
  contextHeading: { alignItems: 'center', flexDirection: 'row', gap: 8, justifyContent: 'space-between' },
  contextHeadingText: { fontSize: 13, fontWeight: '500' },
  contextCount: { fontSize: 12, fontVariant: ['tabular-nums'] },
  contextNote: { fontSize: 12, lineHeight: 18, margin: 0 },
  projectList: { borderRadius: 7, borderWidth: StyleSheet.hairlineWidth, overflow: 'hidden' },
  projectRow: { alignItems: 'center', flexDirection: 'row', gap: 6, minHeight: 48, paddingHorizontal: 8, paddingVertical: 6 },
  projectIndex: { fontSize: 12, textAlign: 'right', width: 20 },
  projectCopy: { flex: 1, gap: 2, minWidth: 0 },
  projectName: { fontSize: 13 },
  projectPath: { fontSize: 12 },
  projectAction: { alignItems: 'center', height: 34, justifyContent: 'center', width: 30 },
  switchRow: { alignItems: 'center', borderTopWidth: StyleSheet.hairlineWidth, flexDirection: 'row', justifyContent: 'space-between', minHeight: 48 },
  switchLabel: { flex: 1, fontSize: 14, fontWeight: '400', paddingRight: 12 },
  input: { borderRadius: 10, borderWidth: StyleSheet.hairlineWidth, fontSize: 15, minHeight: 44, paddingHorizontal: 12 },
  textarea: { minHeight: 110, paddingTop: 11, textAlignVertical: 'top' },
  contextTextarea: { minHeight: 130, paddingTop: 11, textAlignVertical: 'top' },
  error: { fontSize: 14 },
  primary: { alignItems: 'center', borderRadius: 10, justifyContent: 'center', minHeight: 46 },
  primaryText: { color: '#fff', fontSize: 15, fontWeight: '600' },
  disabled: { opacity: 0.5 },
  pressed: { opacity: 0.72 },
});
