import { fireEvent, render } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';
import type { ControlPlaneInstanceDirectoryEntry, ControlPlaneNodeDirectoryEntry } from '@task-handoff/protocol/control-plane-directory';

import { NewSessionForm, newSessionInstanceOptions, newSessionKeyboardAvoidingBehavior, newSessionVisualBalanceInset } from '../src/ai-sessions/NewSessionForm';
import { newSessionMenuActions } from '../src/ai-sessions/NewSessionContextMenu.ios';
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
  test('uses one mobile composer for context, prompt, permission, and send', async () => {
    const onCreate = jest.fn();
    const screen = await render(<NewSessionForm
      instances={[instance]}
      nodes={[node]}
      selectedInstance={instance}
      folders={[{ id: 'folder-1', nodeId: 'node-1', name: 'Mobile', path: '/workspace/mobile', labels: {}, createdAt: '2026-08-06T00:00:00.000Z', updatedAt: '2026-08-06T00:00:00.000Z' }]}
      selectedInstanceId={instance.id}
      selectedAgent="codex"
      selectedFolderId="folder-1"
      message="Build the mobile flow"
      permissionMode="auto-review"
      busy={false}
      disabled={false}
      visualBalanceInset={103}
      onInstanceChange={jest.fn()}
      onAgentChange={jest.fn()}
      onFolderChange={jest.fn()}
      onMessageChange={jest.fn()}
      onPermissionModeChange={jest.fn()}
      onCreate={onCreate}
    />);

    expect(screen.getByText('Start with an idea')).toBeTruthy();
    expect(screen.getByText('Local workspace')).toBeTruthy();
    expect(screen.getByText('Codex')).toBeTruthy();
    expect(screen.getByText('Mobile')).toBeTruthy();
    expect(screen.getByDisplayValue('Build the mobile flow')).toBeTruthy();
    expect(screen.getByText('Approve for me')).toBeTruthy();
    const nativeActions = newSessionMenuActions([
      ...newSessionInstanceOptions([instance], [node]),
      { label: 'Mobile', description: '/workspace/mobile', systemImage: 'folder', value: 'folder-1' },
      { label: 'Codex', systemImage: 'sparkles', value: 'codex' },
      { danger: true, label: 'Full access', systemImage: 'exclamationmark.shield', value: 'full-access' },
    ], instance.id, { destructiveImage: '#ff6961', image: '#aeaeb2' });
    expect(nativeActions).toEqual(expect.arrayContaining([
      expect.objectContaining({ image: 'server.rack', imageColor: '#aeaeb2', title: 'Local workspace', subtitle: 'Mac Studio' }),
      expect.objectContaining({ image: 'folder', imageColor: '#aeaeb2', title: 'Mobile', subtitle: '/workspace/mobile' }),
      expect.objectContaining({ image: 'sparkles', imageColor: '#aeaeb2', title: 'Codex', subtitle: undefined }),
      expect.objectContaining({ image: 'exclamationmark.shield', imageColor: '#ff6961', title: 'Full access' }),
    ]));
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

    fireEvent.press(screen.getByRole('button', { name: 'Create session' }));
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
      error="Choose an instance to continue."
      onInstanceChange={jest.fn()}
      onAgentChange={jest.fn()}
      onFolderChange={jest.fn()}
      onMessageChange={jest.fn()}
      onPermissionModeChange={jest.fn()}
      onCreate={jest.fn()}
    />);

    expect(screen.getByRole('button', { name: 'Create session' })).toBeDisabled();
    expect(screen.getByText('Choose an instance to continue.')).toBeTruthy();
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
      onInstanceChange={jest.fn()}
      onAgentChange={jest.fn()}
      onFolderChange={jest.fn()}
      onMessageChange={jest.fn()}
      onPermissionModeChange={jest.fn()}
      onCreate={jest.fn()}
    />);

    expect(screen.queryByText('Full access')).toBeNull();
  });
});
