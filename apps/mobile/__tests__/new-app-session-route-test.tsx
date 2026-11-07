import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import NewAppSessionRoute from '../app/app-sessions/new';
import { clearAppLaunchPreferences, rememberAppLaunchChoice } from '../src/app-sessions/launch-preferences';

const mockReplace = jest.fn();
const mockBack = jest.fn();
const mockBrowserCapability = jest.fn();
const mockLaunch = jest.fn();
const mockFolders = jest.fn();
const mockShowToast = jest.fn();
const mockApi = { resources: { nodeLocalFolders: mockFolders }, appSessions: { launch: mockLaunch, refresh: jest.fn(async () => undefined) } };
const mockProfile = { identity: { controlPlaneId: 'cp' } };
const mockTerminal = { id: 'terminal', name: 'Terminal', kind: 'tty', supportsCwdSelection: true };
const mockInstance = { id: 'instance', nodeId: 'node', name: 'Workspace', ready: true, connectionStatus: 'online', capabilities: {}, runtime: { type: 'local' }, availableApps: [mockTerminal] };
let mockDirectory: any;

jest.mock('expo-router', () => ({ router: { replace: (...args: unknown[]) => mockReplace(...args), back: () => mockBack() }, useLocalSearchParams: () => ({}) }));
jest.mock('../src/directories/use-directories', () => ({ useActiveDirectories: () => mockDirectory }));
jest.mock('../src/instance-scope/use-instance-scope', () => ({ useInstanceScope: () => ({ scope: { kind: 'all' } }) }));
jest.mock('../src/components/MobileToast', () => ({ useMobileToast: () => ({ show: mockShowToast }) }));
jest.mock('../src/control-plane/use-mobile-control-plane-runtime', () => ({ useMobileControlPlaneRuntime: () => ({ controlPlaneId: 'cp', profile: mockProfile, api: mockApi }) }));
jest.mock('../src/control-plane/browser-context', () => ({ mobileBrowserCapability: (...args: unknown[]) => mockBrowserCapability(...args) }));
jest.mock('../src/control-plane/client', () => ({ createMobileControlPlaneClient: () => ({ api: mockApi }) }));
jest.mock('../src/control-plane/runtime', () => ({ mobileProfileStore: { active: async () => mockProfile }, mobileSecureStore: {} }));
jest.mock('../src/browser/controller', () => ({ mobileBrowserController: { create: jest.fn() } }));
jest.mock('../src/app-sessions/NewAppSessionForm', () => ({ NewAppSessionForm: (props: any) => {
  const { View } = require('react-native');
  return <View {...props} testID="launch-form" />;
} }));

beforeEach(() => {
  jest.clearAllMocks();
  clearAppLaunchPreferences('cp');
  clearAppLaunchPreferences('other-cp');
  mockDirectory = { controlPlaneId: 'cp', state: { instances: [mockInstance], nodes: [] } };
  mockBrowserCapability.mockImplementation(() => new Promise(() => undefined));
  mockFolders.mockResolvedValue([]);
  mockLaunch.mockResolvedValue({ id: 'session', kind: 'tty', status: 'running' });
});

test('late browser capability adds a visible choice without changing the selected launch target', async () => {
  let finishCapability!: (value: { supported: boolean }) => void;
  mockBrowserCapability.mockImplementation(() => new Promise((resolve) => { finishCapability = resolve; }));
  const screen = await render(<NewAppSessionRoute />);
  expect(screen.getByTestId('launch-form').props.selectedAppId).toBe('terminal');
  await act(async () => { finishCapability({ supported: true }); });
  expect(screen.getByTestId('launch-form').props.apps.map((app: any) => app.id)).toEqual(['embedded-browser', 'terminal']);
  expect(screen.getByTestId('launch-form').props.selectedAppId).toBe('terminal');
  await fireEvent(screen.getByTestId('launch-form'), 'appChange', 'embedded-browser');
  expect(screen.getByTestId('launch-form').props.selectedAppId).toBe('embedded-browser');
  expect(screen.getByTestId('launch-form').props.appsLoading).toBe(false);
});

test('the displayed workspace is submitted once and launch locks subsequent selection changes', async () => {
  mockFolders.mockResolvedValue([{ id: 'folder', nodeId: 'node', name: 'Project', path: '/project' }]);
  let finishLaunch!: (value: unknown) => void;
  mockLaunch.mockImplementation(() => new Promise((resolve) => { finishLaunch = resolve; }));
  const screen = await render(<NewAppSessionRoute />);
  await waitFor(() => expect(screen.getByTestId('launch-form').props.foldersLoading).toBe(false));
  await fireEvent(screen.getByTestId('launch-form'), 'folderChange', 'folder');
  expect(screen.getByTestId('launch-form').props.selectedFolderId).toBe('folder');
  await fireEvent(screen.getByTestId('launch-form'), 'appChange', 'terminal');
  await fireEvent(screen.getByTestId('launch-form'), 'instanceChange', 'instance');
  expect(screen.getByTestId('launch-form').props.selectedFolderId).toBe('folder');
  await act(async () => {
    const form = screen.getByTestId('launch-form');
    await fireEvent(form, 'create');
    await fireEvent(form, 'create');
    await fireEvent(form, 'appChange', 'embedded-browser');
    await fireEvent(form, 'instanceChange', 'other');
  });
  expect(mockLaunch).toHaveBeenCalledTimes(1);
  expect(mockLaunch).toHaveBeenCalledWith('instance', { appId: 'terminal', cwdFolderId: 'folder' });
  expect(screen.getByTestId('launch-form').props.selectedAppId).toBe('terminal');
  expect(screen.getByTestId('launch-form').props.selectedInstance.id).toBe('instance');
  expect(screen.getByTestId('launch-form').props.busy).toBe(true);
  await act(async () => { finishLaunch({ id: 'session', kind: 'tty', status: 'running' }); });
  expect(screen.getByTestId('launch-form').props.busy).toBe(false);
});

test('an instance disappearing cannot send its old workspace to the fallback instance', async () => {
  mockFolders.mockResolvedValue([{ id: 'folder', nodeId: 'node', name: 'Project', path: '/project' }]);
  const screen = await render(<NewAppSessionRoute />);
  await waitFor(() => expect(screen.getByTestId('launch-form').props.foldersLoading).toBe(false));
  await fireEvent(screen.getByTestId('launch-form'), 'folderChange', 'folder');
  mockDirectory = { ...mockDirectory, state: { instances: [{ ...mockInstance, id: 'replacement' }], nodes: [] } };
  await screen.rerender(<NewAppSessionRoute />);
  expect(screen.getByTestId('launch-form').props.selectedFolderId).toBeUndefined();
  await fireEvent(screen.getByTestId('launch-form'), 'create');
  await waitFor(() => expect(mockLaunch).toHaveBeenCalledWith('replacement', { appId: 'terminal' }));
});

test('failed workspace reads are explicit and can be retried', async () => {
  mockFolders.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce([]);
  const screen = await render(<NewAppSessionRoute />);
  await waitFor(() => expect(screen.getByTestId('launch-form').props.foldersError).toBe(true));
  await fireEvent(screen.getByTestId('launch-form'), 'retryFolders');
  await waitFor(() => expect(screen.getByTestId('launch-form').props.foldersError).toBe(false));
  await waitFor(() => expect(screen.getByTestId('launch-form').props.foldersLoading).toBe(false));
  expect(mockFolders).toHaveBeenCalledTimes(2);
});

test('remembers an explicit App choice after reopening the launcher', async () => {
  mockDirectory.state.instances = [{ ...mockInstance, availableApps: [mockTerminal, { ...mockTerminal, id: 'editor', name: 'Editor' }] }];
  const screen = await render(<NewAppSessionRoute />);
  await fireEvent(screen.getByTestId('launch-form'), 'appChange', 'editor');
  await screen.unmount();
  const reopened = await render(<NewAppSessionRoute />);
  expect(reopened.getByTestId('launch-form').props.selectedAppId).toBe('editor');
});

test('restores each instance choice independently and ignores unavailable Apps', async () => {
  const editor = { ...mockTerminal, id: 'editor', name: 'Editor' };
  mockDirectory.state.instances = [
    { ...mockInstance, availableApps: [mockTerminal, editor] },
    { ...mockInstance, id: 'other', availableApps: [mockTerminal, editor] },
  ];
  rememberAppLaunchChoice('cp', 'instance', 'editor');
  rememberAppLaunchChoice('cp', 'other', 'terminal');
  const screen = await render(<NewAppSessionRoute />);
  expect(screen.getByTestId('launch-form').props.selectedAppId).toBe('editor');
  await fireEvent(screen.getByTestId('launch-form'), 'instanceChange', 'other');
  expect(screen.getByTestId('launch-form').props.selectedAppId).toBe('terminal');
  await fireEvent(screen.getByTestId('launch-form'), 'instanceChange', 'instance');
  expect(screen.getByTestId('launch-form').props.selectedAppId).toBe('editor');
  mockDirectory.state.instances = [mockInstance];
  await screen.rerender(<NewAppSessionRoute />);
  expect(screen.getByTestId('launch-form').props.selectedAppId).toBe('terminal');
});

test('waits for a remembered browser capability before allowing a launch', async () => {
  rememberAppLaunchChoice('cp', 'instance', 'embedded-browser');
  let finishCapability!: (value: { supported: boolean }) => void;
  mockBrowserCapability.mockImplementation(() => new Promise((resolve) => { finishCapability = resolve; }));
  const screen = await render(<NewAppSessionRoute />);
  expect(screen.getByTestId('launch-form').props.disabled).toBe(true);
  await fireEvent(screen.getByTestId('launch-form'), 'create');
  expect(mockLaunch).not.toHaveBeenCalled();
  await act(async () => { finishCapability({ supported: true }); });
  expect(screen.getByTestId('launch-form').props.selectedAppId).toBe('embedded-browser');
  expect(screen.getByTestId('launch-form').props.disabled).toBe(false);
});
