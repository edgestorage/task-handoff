import { fireEvent, render, waitFor } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';
import type { ControlPlaneInstanceResourceEntry } from '@task-handoff/control-plane-client';

import { NewAppSessionForm } from '../src/app-sessions/NewAppSessionForm';

const instance = {
  id: 'instance-1',
  name: 'Local workspace',
  runtime: { id: 'local', type: 'local' },
  workspace: { path: '/workspace/mobile' },
  availableApps: [{ id: 'terminal-tty', name: 'Terminal', kind: 'tty', supportsCwdSelection: true }],
} as ControlPlaneInstanceResourceEntry;

test('new App session uses full-width anchored selectors for instance, App, and workspace', async () => {
  const screen = await render(<NewAppSessionForm
    busy={false}
    disabled={false}
    folders={[{ id: 'folder-1', nodeId: 'node-1', name: 'Mobile', path: '/workspace/mobile', labels: {}, createdAt: '2026-08-09T00:00:00.000Z', updatedAt: '2026-08-09T00:00:00.000Z' }]}
    instances={[instance]}
    selectedAppId="terminal-tty"
    selectedInstance={instance}
    onAppChange={jest.fn()}
    onCreate={jest.fn()}
    onFolderChange={jest.fn()}
    onInstanceChange={jest.fn()}
  />);

  fireEvent(screen.getByTestId('new-app-session-selection-card'), 'layout', { nativeEvent: { layout: { height: 216, width: 362, x: 0, y: 0 } } });
  const instanceButton = screen.getByRole('button', { name: 'Instance: Local workspace' });
  const appButton = screen.getByRole('button', { name: 'App: Terminal' });
  const folderButton = screen.getByRole('button', { name: 'Folder: Default workspace' });
  await waitFor(() => {
    expect(StyleSheet.flatten(instanceButton.props.style).width).toBe(334);
    expect(StyleSheet.flatten(appButton.props.style).width).toBe(334);
    expect(StyleSheet.flatten(folderButton.props.style).width).toBe(334);
  });
  screen.unmount();
});
