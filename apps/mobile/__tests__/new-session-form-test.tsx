import { fireEvent, render } from '@testing-library/react-native';
import type { ControlPlaneInstanceDirectoryEntry } from '@task-handoff/protocol/control-plane-directory';

import { NewSessionForm } from '../src/ai-sessions/NewSessionForm';

const instance = {
  id: 'instance-1',
  name: 'Local workspace',
  ready: true,
  connectionStatus: 'online',
  workspace: { path: '/workspace/mobile' },
  availableAgents: [{ id: 'codex', name: 'Codex' }],
} as ControlPlaneInstanceDirectoryEntry;

describe('<NewSessionForm />', () => {
  test('uses one mobile composer for context, prompt, permission, and send', async () => {
    const onCreate = jest.fn();
    const screen = await render(<NewSessionForm
      instances={[instance]}
      selectedInstance={instance}
      folders={[{ id: 'folder-1', nodeId: 'node-1', name: 'Mobile', path: '/workspace/mobile', labels: {}, createdAt: '2026-08-06T00:00:00.000Z', updatedAt: '2026-08-06T00:00:00.000Z' }]}
      selectedInstanceId={instance.id}
      selectedAgent="codex"
      cwd="/workspace/mobile"
      message="Build the mobile flow"
      permissionMode="auto-review"
      busy={false}
      disabled={false}
      onInstanceChange={jest.fn()}
      onAgentChange={jest.fn()}
      onCwdChange={jest.fn()}
      onMessageChange={jest.fn()}
      onPermissionModeChange={jest.fn()}
      onCreate={onCreate}
    />);

    expect(screen.getByText('Start with an idea')).toBeTruthy();
    expect(screen.getByText('Local workspace')).toBeTruthy();
    expect(screen.getByText('Codex')).toBeTruthy();
    expect(screen.getByText('Mobile')).toBeTruthy();
    expect(screen.getByDisplayValue('Build the mobile flow')).toBeTruthy();
    expect(screen.getByText('Auto review')).toBeTruthy();

    fireEvent.press(screen.getByRole('button', { name: 'Create session' }));
    expect(onCreate).toHaveBeenCalledTimes(1);
  });

  test('disables send while the session cannot be created', async () => {
    const screen = await render(<NewSessionForm
      instances={[]}
      folders={[]}
      selectedInstanceId=""
      selectedAgent=""
      cwd=""
      message=""
      permissionMode="ask"
      busy={false}
      disabled
      error="Choose an instance to continue."
      onInstanceChange={jest.fn()}
      onAgentChange={jest.fn()}
      onCwdChange={jest.fn()}
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
      selectedInstance={claudeInstance}
      folders={[]}
      selectedInstanceId={claudeInstance.id}
      selectedAgent="claude"
      cwd="/workspace/mobile"
      message="Build it"
      permissionMode="full-access"
      busy={false}
      disabled={false}
      onInstanceChange={jest.fn()}
      onAgentChange={jest.fn()}
      onCwdChange={jest.fn()}
      onMessageChange={jest.fn()}
      onPermissionModeChange={jest.fn()}
      onCreate={jest.fn()}
    />);

    expect(screen.queryByText('Full access')).toBeNull();
  });
});
