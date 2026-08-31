import { fireEvent, render, waitFor } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';
import type { ControlPlaneInstanceResourceEntry } from '@task-handoff/control-plane-client';
import type { ControlPlaneNodeDirectoryEntry } from '@task-handoff/protocol/control-plane-directory';

import { NewAppSessionForm } from '../src/app-sessions/NewAppSessionForm';
import { appLaunchSystemIcon } from '../src/app-sessions/app-launch-icon';
import { newSessionMenuActions } from '../src/ai-sessions/NewSessionContextMenu.ios';
import { instanceSelectOptions } from '../src/directories/instance-select-options';

const instance = {
  id: 'instance-1',
  nodeId: 'node-1',
  name: 'Local workspace',
  runtime: { id: 'local', type: 'local' },
  workspace: { path: '/workspace/mobile' },
  availableApps: [{ id: 'terminal-tty', name: 'Terminal', kind: 'tty', supportsCwdSelection: true }],
} as ControlPlaneInstanceResourceEntry;
const node = { id: 'node-1', name: 'Mac Studio' } as ControlPlaneNodeDirectoryEntry;

test('new App session uses full-width anchored selectors for instance, App, and workspace', async () => {
  const screen = await render(<NewAppSessionForm
    busy={false}
    disabled={false}
    folders={[{ id: 'folder-1', nodeId: 'node-1', name: 'Mobile', path: '/workspace/mobile', labels: {}, createdAt: '2026-08-09T00:00:00.000Z', updatedAt: '2026-08-09T00:00:00.000Z' }]}
    instances={[instance]}
    nodes={[node]}
    selectedAppId="terminal-tty"
    selectedInstance={instance}
    onAppChange={jest.fn()}
    onCreate={jest.fn()}
    onFolderChange={jest.fn()}
    onInstanceChange={jest.fn()}
  />);

  await fireEvent(screen.getByTestId('new-app-session-selection-card'), 'layout', { nativeEvent: { layout: { height: 216, width: 362, x: 0, y: 0 } } });
  const instanceButton = screen.getByRole('button', { name: 'Instance: Local workspace' });
  const appButton = screen.getByRole('button', { name: 'App: Terminal' });
  const folderButton = screen.getByRole('button', { name: 'Folder: Default workspace' });
  await waitFor(() => {
    expect(StyleSheet.flatten(instanceButton.props.style).width).toBe(334);
    expect(StyleSheet.flatten(appButton.props.style).width).toBe(334);
    expect(StyleSheet.flatten(folderButton.props.style).width).toBe(334);
  });
  await screen.unmount();
});

test('new App session instance options carry node group labels without subtitles', () => {
  const options = instanceSelectOptions([instance, { ...instance, id: 'instance-2', nodeId: 'node-missing', name: 'Remote workspace' }], [node]);
  const actions = newSessionMenuActions(
    options,
    instance.id,
    { destructiveImage: '#ff6961', image: '#aeaeb2' },
  );

  expect(actions).toEqual([
    expect.objectContaining({ displayInline: true, title: 'Mac Studio', subactions: [expect.objectContaining({ title: 'Local workspace', subtitle: undefined })] }),
    expect.objectContaining({ displayInline: true, title: 'node-missing', subactions: [expect.objectContaining({ title: 'Remote workspace', subtitle: undefined })] }),
  ]);
  expect(options.find((option) => option.label === 'Local workspace')?.groupLabel).toBe('Mac Studio');
  expect(options.find((option) => option.label === 'Remote workspace')?.groupLabel).toBe('node-missing');
});

test('new App session icons follow the desktop App launch categories', () => {
  expect(appLaunchSystemIcon('codex')).toEqual({ android: 'auto_awesome', ios: 'sparkles' });
  expect(appLaunchSystemIcon('claude')).toEqual({ android: 'auto_awesome', ios: 'sparkles' });
  expect(appLaunchSystemIcon('terminal')).toEqual({ android: 'terminal', ios: 'terminal' });
  expect(appLaunchSystemIcon('terminal-tty')).toEqual({ android: 'terminal', ios: 'terminal' });
  expect(appLaunchSystemIcon('gui-terminal')).toEqual({ android: 'terminal', ios: 'terminal' });
  expect(appLaunchSystemIcon('embedded-browser')).toEqual({ android: 'language', ios: 'globe' });
  expect(appLaunchSystemIcon('opencode')).toEqual({ android: 'play_arrow', ios: 'play.fill' });
});
