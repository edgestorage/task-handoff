import { fireEvent, render } from '@testing-library/react-native';
import type { ControlPlaneInstanceResourceEntry } from '@task-handoff/control-plane-client';
import type { ControlPlaneNodeDirectoryEntry } from '@task-handoff/protocol/control-plane-directory';

import { NewAppSessionForm } from '../src/app-sessions/NewAppSessionForm';
import { appLaunchIcon } from '../src/app-sessions/app-launch-icon';
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

const browser = { id: 'embedded-browser', name: 'Browser', kind: 'web' as const, supportsCwdSelection: false };
const formProps = () => ({
  busy: false, disabled: false, folders: [], instances: [instance], nodes: [node],
  apps: [...instance.availableApps, browser], selectedAppId: 'terminal-tty', selectedInstance: instance,
  onAppChange: jest.fn(), onCreate: jest.fn(), onFolderChange: jest.fn(), onInstanceChange: jest.fn(), onRetryFolders: jest.fn(),
});

test('apps are directly selectable and workspace is only shown for an App supporting it', async () => {
  const props = formProps();
  const screen = await render(<NewAppSessionForm {...props} />);
  expect(screen.getByRole('radio', { name: 'Terminal' }).props.accessibilityState.checked).toBe(true);
  expect(screen.getByText('Mac Studio')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Folder: Default workspace' })).toBeTruthy();
  expect(screen.getByText('/workspace/mobile')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Launch Terminal' })).toBeTruthy();
  await fireEvent.press(screen.getByRole('radio', { name: 'Browser' }));
  expect(props.onAppChange).toHaveBeenCalledWith('embedded-browser');
  await screen.rerender(<NewAppSessionForm {...props} selectedAppId="embedded-browser" />);
  expect(screen.queryByRole('button', { name: 'Folder: Default workspace' })).toBeNull();
  expect(screen.getByRole('radio', { name: 'Browser' }).props.accessibilityState.checked).toBe(true);
  expect(screen.getByRole('button', { name: 'Launch Browser' })).toBeTruthy();
});

test('launching locks every selector and the primary action even if disabled was not supplied', async () => {
  const props = formProps();
  const screen = await render(<NewAppSessionForm {...props} busy />);
  for (const button of [...screen.getAllByRole('button'), ...screen.getAllByRole('radio')]) {
    expect(button.props.accessibilityState.disabled).toBe(true);
    await fireEvent.press(button);
  }
  expect(props.onAppChange).not.toHaveBeenCalled();
  expect(props.onInstanceChange).not.toHaveBeenCalled();
  expect(props.onFolderChange).not.toHaveBeenCalled();
  expect(props.onCreate).not.toHaveBeenCalled();
});

test('workspace failures have an explicit retry and capability loading does not flash an empty state', async () => {
  const props = formProps();
  const screen = await render(<NewAppSessionForm {...props} foldersError />);
  expect(screen.getByText('Could not load workspaces. Retry or launch in the default workspace.')).toBeTruthy();
  await fireEvent.press(screen.getByRole('button', { name: 'Retry' }));
  expect(props.onRetryFolders).toHaveBeenCalledTimes(1);
  await screen.rerender(<NewAppSessionForm {...props} apps={[]} selectedAppId="" appsLoading />);
  expect(screen.getByText('Checking available apps')).toBeTruthy();
  expect(screen.queryByText('No apps are available on this instance')).toBeNull();
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
  expect(appLaunchIcon('codex')).toBe('sparkles');
  expect(appLaunchIcon('claude')).toBe('sparkles');
  expect(appLaunchIcon('terminal')).toBe('terminal-outline');
  expect(appLaunchIcon('terminal-tty')).toBe('terminal-outline');
  expect(appLaunchIcon('gui-terminal')).toBe('terminal-outline');
  expect(appLaunchIcon('embedded-browser')).toBe('globe-outline');
  expect(appLaunchIcon('opencode')).toBe('play');
});
