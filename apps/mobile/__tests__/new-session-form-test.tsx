import { fireEvent, render } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';
import type { ControlPlaneInstanceDirectoryEntry, ControlPlaneNodeDirectoryEntry } from '@task-handoff/protocol/control-plane-directory';

import { NewSessionForm, newSessionInstanceOptions, newSessionKeyboardAvoidingBehavior, newSessionVisualBalanceInset } from '../src/ai-sessions/NewSessionForm';
import { initialAiSessionFolderId, storyAiSessionCreationDefaults } from '../src/ai-sessions/new-session-types';
import { newSessionMenuActions } from '../src/ai-sessions/NewSessionContextMenu.ios';
import { modelSettingsMenuActions } from '../src/ai-sessions/SessionComposerMenus.ios';
import { modelGroupSubtitle } from '../src/ai-sessions/model-settings-menu';
import { SESSION_COMPOSER_ATTACHMENT_ICON_SIZE, SESSION_COMPOSER_COLLAPSED_INPUT_RIGHT, SESSION_COMPOSER_MODEL_MAX_WIDTH, SESSION_COMPOSER_PERMISSION_HEIGHT, SESSION_COMPOSER_PERMISSION_RADIUS, SESSION_COMPOSER_TOOL_SIZE, SESSION_COMPOSER_TOOLBAR_HEIGHT, SESSION_COMPOSER_TRAILING_TOOL_GAP, sessionComposerCollapsedInputRight, sessionComposerPermissionIconSize } from '../src/ai-sessions/composer-metrics';
import {
  ANCHORED_SELECT_MENU_CONTENT_WIDTH,
  ANCHORED_SELECT_MENU_HORIZONTAL_PADDING,
  ANCHORED_SELECT_MENU_WIDTH,
} from '../src/components/anchored-select-menu-layout';

const instance = {
  id: 'instance-1',
  nodeId: 'node-1',
  name: 'Local workspace',
  ready: true,
  connectionStatus: 'online',
  workspace: { path: '/workspace/mobile' },
  availableAgents: [{ id: 'codex', name: 'Codex' }],
} as ControlPlaneInstanceDirectoryEntry;
const node = { id: 'node-1', name: 'Mac Studio' } as ControlPlaneNodeDirectoryEntry;

describe('<NewSessionForm />', () => {
  test('inherits the latest Story session instance and folder like Web', () => {
    const instances = [instance, { ...instance, id: 'instance-2' }];
    const defaults = storyAiSessionCreationDefaults(instances, {
      updatedAt: '2026-09-04T00:03:00.000Z',
      instances: [{
        instanceId: 'instance-2', streamId: 'stream-2', aiSessions: { updatedAt: '2026-09-04T00:03:00.000Z', sessions: [
          { id: 'older', agent: 'codex', storyId: 'story-1', status: 'idle', cwd: '/workspace/old', cwdFolderId: 'folder-old', startedAt: '2026-09-04T00:00:00.000Z', updatedAt: '2026-09-04T00:01:00.000Z', unread: false },
          { id: 'latest', agent: 'codex', storyId: 'story-1', status: 'idle', cwd: '/workspace/mobile', cwdFolderId: 'folder-mobile', startedAt: '2026-09-04T00:00:00.000Z', updatedAt: '2026-09-04T00:02:00.000Z', unread: false },
        ] },
      }],
    }, 'story-1', 'node-1');

    expect(defaults).toEqual({ instanceId: 'instance-2', cwd: '/workspace/mobile', cwdFolderId: 'folder-mobile' });
    expect(initialAiSessionFolderId([
      { id: 'folder-mobile', cwdFolderId: 'folder-mobile', name: 'Mobile', path: '/host/projects/mobile' },
    ], { ...defaults, runtimeType: 'docker', source: { type: 'local-folder', path: '/host/projects' }, workspacePath: '/workspace' })).toBe('folder-mobile');
    expect(initialAiSessionFolderId([
      { id: 'folder-mobile', cwdFolderId: 'folder-mobile', name: 'Mobile', path: '/host/projects/mobile' },
    ], { cwd: '/workspace/mobile', runtimeType: 'docker', source: { type: 'local-folder', path: '/host/projects' }, workspacePath: '/workspace' })).toBe('folder-mobile');
  });

  test('uses one mobile composer for context, prompt, permission, and send', async () => {
    const onCreate = jest.fn();
    const screen = await render(<NewSessionForm
      instances={[instance]}
      nodes={[node]}
      selectedInstance={instance}
      folders={[{ id: 'folder-1', cwdFolderId: 'folder-1', name: 'Mobile', path: '/workspace/mobile' }]}
      selectedInstanceId={instance.id}
      selectedAgent="codex"
      selectedFolderId="folder-1"
      workspace={{
        availability: 'available',
        currentBranch: 'main',
        dirty: false,
        branches: [
          { name: 'main', kind: 'branch', current: true, currentFolderSelectable: true, worktreeSelectable: false, worktreeCheckout: 'attached', worktreeReason: 'current-branch' },
          { name: 'feature/cwd', kind: 'branch', current: false, currentFolderSelectable: true, worktreeSelectable: true, worktreeCheckout: 'attached' },
        ],
      }}
      workspaceMode="current-folder"
      selectedBranch="main"
      message="Build the mobile flow"
      permissionMode="auto-review"
      busy={false}
      disabled={false}
      attachments={[]}
      visualBalanceInset={103}
      onInstanceChange={jest.fn()}
      onAgentChange={jest.fn()}
      onFolderChange={jest.fn()}
      onWorkspaceModeChange={jest.fn()}
      onBranchChange={jest.fn()}
      onMessageChange={jest.fn()}
      onAddImage={jest.fn()}
      onAddFile={jest.fn()}
      onRemoveAttachment={jest.fn()}
      onPermissionModeChange={jest.fn()}
      onCreate={onCreate}
    />);

    expect(screen.getByText('Start with an idea')).toBeTruthy();
    expect(screen.getByText('Local workspace')).toBeTruthy();
    expect(screen.getByText('Codex')).toBeTruthy();
    expect(screen.getByText('Mobile')).toBeTruthy();
    expect(screen.queryByText('Default workspace')).toBeNull();
    expect(screen.getByText('Current folder')).toBeTruthy();
    expect(screen.getByText('main')).toBeTruthy();
    expect(screen.getByDisplayValue('Build the mobile flow')).toBeTruthy();
    expect(screen.getByText('Approve for me')).toBeTruthy();
    const attachmentButton = screen.getByRole('button', { name: 'Add attachment' });
    expect(StyleSheet.flatten(attachmentButton.props.style)).toEqual(expect.objectContaining({ height: SESSION_COMPOSER_TOOL_SIZE, width: SESSION_COMPOSER_TOOL_SIZE }));
    expect(SESSION_COMPOSER_ATTACHMENT_ICON_SIZE).toBe(25);
    expect(sessionComposerPermissionIconSize('auto-review')).toBe(22);
    expect(StyleSheet.flatten(screen.getByTestId('new-session-composer-toolbar').props.style).height).toBe(SESSION_COMPOSER_TOOLBAR_HEIGHT);
    expect(StyleSheet.flatten(screen.getByTestId('new-session-permission-button').props.style)).toEqual(expect.objectContaining({
      borderRadius: SESSION_COMPOSER_PERMISSION_RADIUS,
      height: SESSION_COMPOSER_PERMISSION_HEIGHT,
    }));
    expect(sessionComposerCollapsedInputRight(false)).toBe(SESSION_COMPOSER_COLLAPSED_INPUT_RIGHT);
    expect(sessionComposerCollapsedInputRight(true)).toBe(SESSION_COMPOSER_COLLAPSED_INPUT_RIGHT + SESSION_COMPOSER_MODEL_MAX_WIDTH + SESSION_COMPOSER_TRAILING_TOOL_GAP);
    const nativeActions = newSessionMenuActions([
      ...newSessionInstanceOptions([instance], [node]),
      { label: 'Mobile', description: '/workspace/mobile', systemImage: 'folder', value: 'folder-1' },
      { label: 'Codex', systemImage: 'sparkles', value: 'codex' },
      { danger: true, label: 'Full access', systemImage: 'exclamationmark.shield', value: 'full-access' },
    ], instance.id, { destructiveImage: '#ff6961', image: '#aeaeb2' });
    const flattenedNativeActions = nativeActions.flatMap((action) => action.subactions || [action]);
    expect(flattenedNativeActions).toEqual(expect.arrayContaining([
      expect.objectContaining({ image: 'server.rack', imageColor: '#aeaeb2', title: 'Local workspace', subtitle: undefined }),
      expect.objectContaining({ image: 'folder', imageColor: '#aeaeb2', title: 'Mobile', subtitle: '/workspace/mobile' }),
      expect.objectContaining({ image: 'sparkles', imageColor: '#aeaeb2', title: 'Codex', subtitle: undefined }),
      expect.objectContaining({ image: 'exclamationmark.shield', imageColor: '#ff6961', title: 'Full access' }),
    ]));
    const modelGroups = [{
      modelEntityId: 'provider-one',
      providerName: 'Provider One',
      models: [
        { modelEntityId: 'provider-one', modelName: 'small', providerName: 'Provider One' },
        { modelEntityId: 'provider-one', modelName: 'large', providerName: 'Provider One' },
      ],
    }, {
      modelEntityId: 'provider-two',
      providerName: 'Provider Two',
      models: [{ modelEntityId: 'provider-two', modelName: 'only', providerName: 'Provider Two' }],
    }];
    const formatModelGroupSummary = (model: string, count: number) => `${model} and ${count} models`;
    expect(modelGroupSubtitle(modelGroups[0], { modelEntityId: 'provider-one', modelName: 'large' }, formatModelGroupSummary)).toBe('large');
    expect(modelGroupSubtitle(modelGroups[0], undefined, formatModelGroupSummary)).toBe('small and 2 models');
    expect(modelGroupSubtitle(modelGroups[1], undefined, formatModelGroupSummary)).toBe('only');
    const settingsActions = modelSettingsMenuActions({
      formatModelGroupSummary,
      imageColor: '#aeaeb2',
      selectedImageColor: '#0a84ff',
      modelGroups,
      modelSelection: { modelEntityId: 'provider-one', modelName: 'large' },
      provider: 'codex',
      reasoningEffort: 'high',
      reasoningEnabled: true,
      reasoningTitle: 'Reasoning effort',
    });
    expect(settingsActions[0]).toEqual(expect.objectContaining({
      image: 'checkmark',
      imageColor: '#0a84ff',
      subtitle: 'large',
      subactions: expect.arrayContaining([expect.objectContaining({ state: 'on', title: 'large' })]),
      title: 'Provider One',
    }));
    expect(settingsActions[2]).toEqual(expect.objectContaining({
      displayInline: true,
      subactions: [expect.objectContaining({
        subtitle: 'high',
        subactions: expect.arrayContaining([expect.objectContaining({ id: 'reasoning:high', state: 'on', title: 'high' })]),
        title: 'Reasoning effort',
      })],
      title: '',
    }));
    expect(settingsActions[1]).toEqual(expect.objectContaining({
      image: 'sparkles',
      imageColor: '#aeaeb2',
      state: 'off',
      title: 'Provider Two',
    }));
    expect(newSessionKeyboardAvoidingBehavior('ios')).toBe('padding');
    expect(newSessionKeyboardAvoidingBehavior('android')).toBeUndefined();
    const scroll = screen.getByTestId('new-session-scroll');
    expect(scroll.props.alwaysBounceVertical).toBe(false);
    expect(scroll.props.automaticallyAdjustKeyboardInsets).toBe(false);
    expect(StyleSheet.flatten(scroll.props.contentContainerStyle)).toEqual(expect.objectContaining({
      alignSelf: 'center',
      justifyContent: 'center',
      maxWidth: 640,
      paddingBottom: 127,
      width: '100%',
    }));
    expect(newSessionVisualBalanceInset('ios', 59)).toBe(103);
    expect(newSessionVisualBalanceInset('android', 24)).toBe(80);
    expect(ANCHORED_SELECT_MENU_CONTENT_WIDTH + (ANCHORED_SELECT_MENU_HORIZONTAL_PADDING * 2)).toBe(ANCHORED_SELECT_MENU_WIDTH);

    await fireEvent.press(screen.getByRole('button', { name: 'Create session' }));
    expect(onCreate).toHaveBeenCalledTimes(1);
  });

  test('disables send while the session cannot be created', async () => {
    const screen = await render(<NewSessionForm
      instances={[]}
      nodes={[]}
      folders={[]}
      selectedInstanceId=""
      selectedAgent=""
      selectedFolderId={undefined}
      message=""
      permissionMode="ask"
      busy={false}
      disabled
      attachments={[]}
      error="Choose an instance to continue."
      onInstanceChange={jest.fn()}
      onAgentChange={jest.fn()}
      onFolderChange={jest.fn()}
      onMessageChange={jest.fn()}
      onAddImage={jest.fn()}
      onAddFile={jest.fn()}
      onRemoveAttachment={jest.fn()}
      onPermissionModeChange={jest.fn()}
      onCreate={jest.fn()}
    />);

    expect(screen.getByRole('button', { name: 'Create session' })).toBeDisabled();
    expect(screen.getByText('Choose an instance to continue.')).toBeTruthy();
  });

  test('freezes request inputs and attachment removal while creation is busy', async () => {
    const onRemoveAttachment = jest.fn();
    const screen = await render(<NewSessionForm
      instances={[instance]}
      nodes={[node]}
      selectedInstance={instance}
      folders={[{ id: 'folder-1', cwdFolderId: 'folder-1', name: 'Mobile', path: '/workspace/mobile' }]}
      selectedInstanceId={instance.id}
      selectedAgent="codex"
      selectedFolderId="folder-1"
      message="Uploading"
      permissionMode="ask"
      busy
      disabled
      attachments={[{ id: 'attachment-1', kind: 'file', name: 'private.txt' }]}
      onInstanceChange={jest.fn()}
      onAgentChange={jest.fn()}
      onFolderChange={jest.fn()}
      onMessageChange={jest.fn()}
      onAddImage={jest.fn()}
      onAddFile={jest.fn()}
      onRemoveAttachment={onRemoveAttachment}
      onPermissionModeChange={jest.fn()}
      onCreate={jest.fn()}
    />);

    expect(screen.getByLabelText('Prompt').props.editable).toBe(false);
    expect(screen.getByRole('button', { name: 'Local workspace' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Mobile' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Codex' })).toBeDisabled();
    const remove = screen.getByRole('button', { name: 'Remove private.txt' });
    expect(remove).toBeDisabled();
    await fireEvent.press(remove);
    expect(onRemoveAttachment).not.toHaveBeenCalled();
  });

  test('hides Codex permission controls for Claude sessions', async () => {
    const claudeInstance = { ...instance, availableAgents: [{ id: 'claude', name: 'Claude', kind: 'tty' as const, supportsCwdSelection: true }] };
    const screen = await render(<NewSessionForm
      instances={[claudeInstance]}
      nodes={[node]}
      selectedInstance={claudeInstance}
      folders={[]}
      selectedInstanceId={claudeInstance.id}
      selectedAgent="claude"
      selectedFolderId={undefined}
      message="Build it"
      permissionMode="full-access"
      busy={false}
      disabled={false}
      attachments={[]}
      onInstanceChange={jest.fn()}
      onAgentChange={jest.fn()}
      onFolderChange={jest.fn()}
      onMessageChange={jest.fn()}
      onAddImage={jest.fn()}
      onAddFile={jest.fn()}
      onRemoveAttachment={jest.fn()}
      onPermissionModeChange={jest.fn()}
      onCreate={jest.fn()}
    />);

    expect(screen.queryByText('Full access')).toBeNull();
  });
});
