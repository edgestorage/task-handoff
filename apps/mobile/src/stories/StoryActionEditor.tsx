import { useEffect, useMemo, useState } from 'react';
import * as Crypto from 'expo-crypto';
import { ActivityIndicator, Platform, StyleSheet, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { defaultAiSessionModelSelection, deriveAiSessionModelGroups, type AiSessionCatalogModelEntity } from '@task-handoff/control-plane-client';
import { normalizeAiSessionReasoningEffortCapabilities } from '@task-handoff/protocol/ai-session-provider-capabilities';
import { directoryAiSessionProviderCapability } from '@task-handoff/protocol/control-plane-directory';
import { AI_SESSION_DEFAULT_REASONING_EFFORT, type AiSessionGitSelection, type AiSessionModelSelection, type AiSessionPermissionMode, type AiSessionReasoningEffort } from '@task-handoff/protocol/ai-sessions';
import type { RepositoryAiSessionWorkspace } from '@task-handoff/protocol/repository';
import type { Story, StoryAction, StorySessionPreset } from '@task-handoff/protocol/stories';

import { NewSessionForm, newSessionVisualBalanceInset } from '../ai-sessions/NewSessionForm';
import { aiSessionFolderOptions, defaultAiSessionFolderId, initialInstanceId, instanceCreateGuidance, type AiSessionFolderOption } from '../ai-sessions/new-session-types';
import { useMobileTheme } from '../components/theme';
import { useMobileControlPlaneRuntime } from '../control-plane/use-mobile-control-plane-runtime';
import { useActiveDirectories } from '../directories/use-directories';
import { useI18n } from '../i18n';

export function StoryActionEditor({ nodeId, onSaved, storyId }: { nodeId?: string; onSaved(): void; storyId?: string }) {
  const insets = useSafeAreaInsets();
  const { colors } = useMobileTheme();
  const { t } = useI18n();
  const runtime = useMobileControlPlaneRuntime();
  const [story, setStory] = useState<Story>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!runtime.api || !storyId || !nodeId) return;
    let live = true;
    void runtime.api.stories.get(storyId, nodeId).then((value) => {
      if (live) setStory(value);
    }).catch((cause) => {
      if (live) setError(cause instanceof Error ? cause.message : String(cause));
    }).finally(() => {
      if (live) setLoading(false);
    });
    return () => { live = false; };
  }, [nodeId, runtime.api, storyId]);
  if (loading) return <ActivityIndicator accessibilityLabel={t('common.loading')} style={styles.loading} />;
  if (!story) return <View style={styles.state}><Text style={{ color: colors.error }}>{error || t('stories.loadError')}</Text></View>;
  return <StoryActionComposer
    onSubmit={async (action) => {
      if (!runtime.api) return;
      const existing = story.actions.map((item) => {
        if (!item.targetInstanceId) throw new Error(t('stories.noAvailableInstance'));
        return { ...item, targetInstanceId: item.targetInstanceId };
      });
      if (!action.targetInstanceId) throw new Error(t('stories.noAvailableInstance'));
      await runtime.api.stories.update(story.id, story.ownerNodeId, {
        actions: [...existing, { ...action, targetInstanceId: action.targetInstanceId }],
      });
      onSaved();
    }}
    story={story}
    visualBalanceInset={newSessionVisualBalanceInset(Platform.OS, insets.top)}
  />;
}

export function StoryActionComposer({ disabled = false, embedded = false, onSubmit, story, submitLabel, visualBalanceInset }: {
  disabled?: boolean;
  embedded?: boolean;
  onSubmit(action: StoryAction): Promise<void>;
  story: Story;
  submitLabel?: string;
  visualBalanceInset?: number;
}) {
  const { colors } = useMobileTheme();
  const { t } = useI18n();
  const runtime = useMobileControlPlaneRuntime();
  const { state: directory } = useActiveDirectories();
  const [title, setTitle] = useState('');
  const [prompt, setPrompt] = useState('');
  const [selection, setSelection] = useState<{ instanceId?: string; agent?: string; folderId?: string }>({});
  const [permissionSelection, setPermissionSelection] = useState<{ instanceId: string; agent: string; value: AiSessionPermissionMode }>();
  const [modelEntities, setModelEntities] = useState<AiSessionCatalogModelEntity[]>([]);
  const [modelSelectionDraft, setModelSelectionDraft] = useState<{ instanceId: string; agent: string; value: AiSessionModelSelection }>();
  const [reasoningSelection, setReasoningSelection] = useState<{ instanceId: string; agent: string; value: AiSessionReasoningEffort }>();
  const [folderState, setFolderState] = useState<{ nodeId: string; folders: AiSessionFolderOption[] }>({ nodeId: '', folders: [] });
  const [workspaceState, setWorkspaceState] = useState<{
    instanceId?: string;
    folderId?: string;
    workspace?: RepositoryAiSessionWorkspace;
    mode: 'current-folder' | 'worktree';
    branch?: string;
  }>({ mode: 'current-folder' });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const instances = useMemo(
    () => directory.instances.filter((instance) => instance.nodeId === story.ownerNodeId),
    [directory.instances, story],
  );
  const selectedInstanceId = instances.some((instance) => instance.id === selection.instanceId)
    ? selection.instanceId!
    : initialInstanceId(instances);
  const selectedInstance = instances.find((instance) => instance.id === selectedInstanceId);
  const agent = selectedInstance?.availableAgents.some((candidate) => candidate.id === selection.agent)
    ? selection.agent!
    : selectedInstance?.availableAgents[0]?.id ?? '';
  const folderId = selection.instanceId === selectedInstanceId ? selection.folderId : undefined;
  const folders = folderState.nodeId === selectedInstance?.nodeId ? folderState.folders : [];
  const selectedFolder = folders.find((folder) => folder.id === folderId);
  const providerCapability = directoryAiSessionProviderCapability(selectedInstance?.capabilities, agent);
  const permissionModes = providerCapability?.permissionModes || [];
  const requestedPermissionMode = permissionSelection?.instanceId === selectedInstanceId && permissionSelection.agent === agent
    ? permissionSelection.value
    : selectedInstance?.config.defaultCodexPermissionMode ?? 'ask';
  const permissionMode = permissionModes.includes(requestedPermissionMode) ? requestedPermissionMode : permissionModes[0] ?? requestedPermissionMode;
  const modelGroups = selectedInstance ? deriveAiSessionModelGroups({
    entities: modelEntities,
    assignment: selectedInstance.modelSelection,
    agent,
    nodeId: selectedInstance.nodeId,
    mode: 'create',
    capability: providerCapability?.modelSelection,
  }) : [];
  const modelSelection = modelSelectionDraft?.instanceId === selectedInstanceId && modelSelectionDraft.agent === agent
    ? modelSelectionDraft.value
    : defaultAiSessionModelSelection(modelGroups);
  const reasoningCapability = normalizeAiSessionReasoningEffortCapabilities(providerCapability);
  const reasoningEffort = reasoningCapability.selectAtCreate
    ? reasoningSelection?.instanceId === selectedInstanceId && reasoningSelection.agent === agent
      ? reasoningSelection.value
      : agent === 'codex' ? AI_SESSION_DEFAULT_REASONING_EFFORT : undefined
    : undefined;

  useEffect(() => {
    if (!runtime.api || !selectedInstance) return;
    const abort = new AbortController();
    void Promise.all([
      runtime.api.resources.nodeLocalFolders(selectedInstance.nodeId, abort.signal),
      runtime.api.resources.instanceWorkspaceSource(selectedInstance.id, abort.signal).catch(() => undefined),
    ]).then(([nodeFolders, source]) => {
      if (abort.signal.aborted) return;
      const options = aiSessionFolderOptions(source, selectedInstance.workspace.path, nodeFolders);
      const defaultFolder = defaultAiSessionFolderId(source, selectedInstance.workspace.path, nodeFolders);
      setFolderState({ nodeId: selectedInstance.nodeId, folders: options });
      setSelection((current) => ({
        instanceId: selectedInstance.id,
        agent: current.instanceId === selectedInstance.id ? current.agent : undefined,
        folderId: current.instanceId === selectedInstance.id && options.some((folder) => folder.id === current.folderId)
          ? current.folderId
          : defaultFolder,
      }));
    }).catch((cause) => {
      if (!abort.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause));
    });
    return () => abort.abort();
  }, [runtime.api, selectedInstance]);

  useEffect(() => {
    if (!runtime.api) return;
    const abort = new AbortController();
    void runtime.api.resources.models(abort.signal).then((registry) => {
      if (!abort.signal.aborted) setModelEntities(registry.models.map((group) => ({ ...group.model, locations: group.locations })));
    }).catch(() => {
      if (!abort.signal.aborted) setModelEntities([]);
    });
    return () => abort.abort();
  }, [runtime.api]);

  useEffect(() => {
    if (!runtime.api || !selectedInstanceId || !selectedFolder) return;
    const abort = new AbortController();
    void runtime.api.aiSessions.workspace(selectedInstanceId, selectedFolder.cwdFolderId, abort.signal).then((workspace) => {
      if (abort.signal.aborted) return;
      setWorkspaceState({
        instanceId: selectedInstanceId,
        folderId,
        workspace,
        mode: 'current-folder',
        branch: workspace.currentBranch
          || workspace.branches.find((candidate) => candidate.current)?.name
          || workspace.branches.find((candidate) => candidate.currentFolderSelectable)?.name,
      });
    }).catch(() => {
      // Compatibility for v0.0.21: an older Control Plane keeps the cwd-only creation flow.
      if (!abort.signal.aborted) setWorkspaceState({ instanceId: selectedInstanceId, folderId, mode: 'current-folder' });
    });
    return () => abort.abort();
  }, [folderId, runtime.api, selectedFolder, selectedInstanceId]);

  const workspaceMatchesSelection = workspaceState.instanceId === selectedInstanceId && workspaceState.folderId === folderId;
  const workspaceLoading = Boolean(selectedInstanceId && folderId && !workspaceMatchesSelection);
  const gitSelection: AiSessionGitSelection | undefined = workspaceMatchesSelection
    && workspaceState.workspace?.availability === 'available'
    && workspaceState.branch
    ? { mode: workspaceState.mode, branch: workspaceState.branch }
    : undefined;
  const guidance = instanceCreateGuidance(selectedInstance);
  const valid = Boolean(!disabled && !story.archivedAt && title.trim() && prompt.trim() && selectedInstance && selectedFolder && agent && !guidance && !workspaceLoading);

  const save = async () => {
    if (!selectedInstance || !valid || saving) return;
    setSaving(true);
    setError('');
    const sessionPreset: StorySessionPreset = {
      agent,
      ...(selectedFolder?.cwdFolderId ? { cwdFolderId: selectedFolder.cwdFolderId } : {}),
      ...(gitSelection ? { gitSelection } : {}),
      ...(permissionModes.includes(permissionMode) ? { permissionMode } : {}),
      ...(modelSelection ? { modelSelection } : {}),
      ...(reasoningEffort ? { reasoningEffort } : {}),
    };
    try {
      await onSubmit({
        id: `action-${Crypto.randomUUID()}`,
        title: title.trim(),
        promptTemplate: prompt.trim(),
        targetInstanceId: selectedInstance.id,
        sessionPreset,
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };

  return <NewSessionForm
    key={selectedInstance?.id || 'no-instance'}
    attachments={[]}
    attachmentsDisabled
    busy={saving || workspaceLoading}
    disabled={!valid || saving}
    embedded={embedded}
    error={error || guidance}
    folders={folders}
    header={<View style={styles.titleField}>
      <Text style={[styles.label, { color: colors.text }]}>{t('stories.actionTitle')}</Text>
      <TextInput
        accessibilityLabel={t('stories.actionTitle')}
        autoCapitalize="sentences"
        editable={!saving}
        maxLength={120}
        onChangeText={setTitle}
        placeholder={t('stories.actionTitle')}
        placeholderTextColor={colors.textMuted}
        style={[styles.titleInput, { backgroundColor: colors.surface, borderColor: colors.border, color: colors.text }]}
        value={title}
      />
    </View>}
    instances={instances}
    message={prompt}
    modelGroups={modelGroups}
    modelSelection={modelSelection}
    nodes={directory.nodes}
    permissionMode={permissionMode}
    permissionModes={permissionModes}
    reasoningEffort={reasoningEffort}
    reasoningEffortEnabled={reasoningCapability.selectAtCreate}
    selectedAgent={agent}
    selectedBranch={workspaceMatchesSelection ? workspaceState.branch : undefined}
    selectedFolderId={folderId}
    selectedInstance={selectedInstance}
    selectedInstanceId={selectedInstanceId}
    submitLabel={submitLabel || t('stories.createAction')}
    submittingLabel={submitLabel || t('stories.createAction')}
    visualBalanceInset={embedded ? undefined : visualBalanceInset}
    workspace={workspaceMatchesSelection ? workspaceState.workspace : undefined}
    workspaceLoading={workspaceLoading}
    workspaceMode={workspaceMatchesSelection ? workspaceState.mode : 'current-folder'}
    onAddFile={() => undefined}
    onAddImage={() => undefined}
    onAgentChange={(nextAgent) => {
      setSelection({ instanceId: selectedInstanceId, agent: nextAgent, folderId });
      setModelSelectionDraft(undefined);
      setReasoningSelection(undefined);
    }}
    onBranchChange={(branch) => setWorkspaceState((current) => ({ ...current, branch }))}
    onCreate={() => { void save(); }}
    onFolderChange={(nextFolderId) => setSelection({ instanceId: selectedInstanceId, agent, folderId: nextFolderId })}
    onInstanceChange={(instanceId) => {
      const instance = instances.find((candidate) => candidate.id === instanceId);
      setSelection({ instanceId, agent: instance?.availableAgents[0]?.id });
      setModelSelectionDraft(undefined);
      setReasoningSelection(undefined);
    }}
    onMessageChange={setPrompt}
    onModelSelectionChange={(value) => setModelSelectionDraft({ instanceId: selectedInstanceId, agent, value })}
    onPermissionModeChange={(value) => setPermissionSelection({ instanceId: selectedInstanceId, agent, value })}
    onReasoningEffortChange={(value) => setReasoningSelection({ instanceId: selectedInstanceId, agent, value })}
    onRemoveAttachment={() => undefined}
    onWorkspaceModeChange={(mode) => {
      const workspace = workspaceState.workspace;
      const selected = workspace?.branches.find((candidate) => candidate.name === workspaceState.branch);
      const selectable = selected && (mode === 'worktree' ? selected.worktreeSelectable : selected.currentFolderSelectable);
      const branch = selectable
        ? selected.name
        : workspace?.branches.find((candidate) => mode === 'worktree' ? candidate.worktreeSelectable : candidate.currentFolderSelectable)?.name;
      setWorkspaceState((current) => ({ ...current, mode, branch }));
    }}
  />;
}

const styles = StyleSheet.create({
  loading: { flex: 1 },
  state: { alignItems: 'center', flex: 1, justifyContent: 'center', padding: 24 },
  titleField: { gap: 7, paddingHorizontal: 4 },
  label: { fontSize: 14, fontWeight: '500' },
  titleInput: { borderRadius: 10, borderWidth: StyleSheet.hairlineWidth, fontSize: 15, minHeight: 46, paddingHorizontal: 12 },
});
