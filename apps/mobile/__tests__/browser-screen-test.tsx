import { act, fireEvent, render } from '@testing-library/react-native';

const mockLoadUrl = jest.fn(async () => undefined);
const mockGoBack = jest.fn(async () => undefined);
jest.mock('expo-router', () => ({ Stack: { Screen: () => null }, useRouter: () => ({ setParams: jest.fn(), back: jest.fn() }), useFocusEffect: () => undefined }));
jest.mock('expo-router/react-navigation', () => ({ useIsFocused: () => true }));
jest.mock('../src/control-plane/use-mobile-control-plane-runtime', () => ({ useMobileControlPlaneRuntime: () => ({ controlPlaneId: 'cp', api: {}, profile: {} }) }));
jest.mock('../src/browser/controller', () => ({ mobileBrowserController: { contextId: () => 'context', subscribe: () => () => undefined, activate: jest.fn(), suspend: jest.fn(), create: jest.fn(), close: jest.fn() } }));
jest.mock('../src/components/EmbeddedPaneHeader', () => ({ EmbeddedPaneHeaderOptions: () => null }));
jest.mock('../src/ai-sessions/NewSessionContextMenu', () => ({ NewSessionContextMenu: ({ children, onSelect, title }: any) => {
  const { View } = require('react-native');
  return <View onSelect={onSelect} testID={`menu:${title}`}>{children()}</View>;
} }));
jest.mock('../modules/task-handoff-browser/src', () => ({ TaskHandoffBrowserView: ({ ref, ...props }: any) => {
  const React = require('react');
  const { View } = require('react-native');
  React.useImperativeHandle(ref, () => ({ loadUrl: mockLoadUrl, goBack: mockGoBack, goForward: jest.fn(), reload: jest.fn(), stopLoading: jest.fn() }));
  return <View {...props} testID="native-browser" />;
} }));
jest.mock('../src/browser/start-page-runtime', () => {
  const { BrowserStartPageStore } = require('../src/browser/start-page-store');
  return { mobileBrowserStartPages: new BrowserStartPageStore({ get: async () => undefined, set: async () => undefined }) };
});

import { BrowserTabScreen } from '../src/browser/BrowserTabScreen';
import { mobileBrowserController } from '../src/browser/controller';
import { mobileBrowserTabStore } from '../src/browser/store';
import { mobileBrowserStartPages } from '../src/browser/start-page-runtime';

beforeEach(async () => { jest.clearAllMocks(); mobileBrowserTabStore.clearProfile('cp'); await mobileBrowserStartPages.clearProfile('cp'); });

test('native navigation controls history buttons and progress; events do not overwrite an address draft', async () => {
  const tab = mobileBrowserTabStore.create('cp', 'instance', 'https://app.test/');
  const view = await render(<BrowserTabScreen browserTabId={tab.id} instanceId="instance" />);
  expect(view.getByLabelText('Back').props.accessibilityState.disabled).toBe(true);
  await act(async () => { await fireEvent(view.getByTestId('native-browser', { includeHiddenElements: true }), 'navigationStateChange', { nativeEvent: { url: 'https://app.test/page', title: 'App', canGoBack: true, canGoForward: false } }); });
  expect(view.getByLabelText('Back').props.accessibilityState.disabled).toBe(false);
  await act(async () => { await fireEvent(view.getByTestId('native-browser', { includeHiddenElements: true }), 'loadingChange', { nativeEvent: { loading: true, progress: 0.72 } }); });
  expect(view.getByRole('progressbar').props.accessibilityValue.now).toBe(72);
  await act(async () => { await fireEvent(view.getByLabelText('Address'), 'focus'); await fireEvent.changeText(view.getByLabelText('Address'), 'http://localhost:3000'); });
  await act(async () => { await fireEvent(view.getByTestId('native-browser', { includeHiddenElements: true }), 'navigationStateChange', { nativeEvent: { url: 'https://app.test/redirect', title: 'Redirect', canGoBack: true, canGoForward: false } }); });
  expect(view.getByLabelText('Address').props.value).toBe('http://localhost:3000');
  await act(async () => { await fireEvent.press(view.getByLabelText('Go to address')); });
  expect(mockLoadUrl).toHaveBeenCalledWith('http://127-0-0-1.internal:3000/');
  await view.unmount();
});

test('completed pages enter recent visits, failed pages do not, and history links navigate without remounting the tab', async () => {
  const tab = mobileBrowserTabStore.create('cp', 'instance', 'https://app.test/');
  const view = await render(<BrowserTabScreen browserTabId={tab.id} instanceId="instance" />);
  await act(async () => { await fireEvent(view.getByTestId('native-browser', { includeHiddenElements: true }), 'navigationStateChange', { nativeEvent: { url: 'https://app.test/', title: 'My App', canGoBack: false, canGoForward: false } }); });
  await act(async () => { await fireEvent(view.getByTestId('native-browser', { includeHiddenElements: true }), 'loadingChange', { nativeEvent: { loading: false, progress: 1 } }); });
  expect(mobileBrowserStartPages.page('cp', 'instance').recent[0].title).toBe('My App');
  await act(async () => {
    await fireEvent(view.getByTestId('native-browser', { includeHiddenElements: true }), 'loadingChange', { nativeEvent: { loading: true, progress: 0 } });
    await fireEvent(view.getByTestId('native-browser', { includeHiddenElements: true }), 'navigationStateChange', { nativeEvent: { url: 'https://failed.test/', title: '', canGoBack: true, canGoForward: false } });
    await fireEvent(view.getByTestId('native-browser', { includeHiddenElements: true }), 'error', { nativeEvent: { code: 'NETWORK_ERROR', description: 'Network failed' } });
    await fireEvent(view.getByTestId('native-browser', { includeHiddenElements: true }), 'loadingChange', { nativeEvent: { loading: false, progress: 1 } });
  });
  expect(mobileBrowserStartPages.page('cp', 'instance').recent).toHaveLength(1);
  await act(async () => { await fireEvent(view.getByTestId('menu:Browser'), 'select', 'history'); });
  expect(view.getByText('My App')).toBeTruthy();
  await act(async () => { await fireEvent.press(view.getByText('My App')); });
  expect(mockLoadUrl).toHaveBeenCalledWith('https://app.test/');
  expect(view.getAllByTestId('native-browser')).toHaveLength(1);
  await view.unmount();
});

test('iOS native menu triggers stay enabled without a JS callback and switch tabs in the same instance', async () => {
  const tab = mobileBrowserTabStore.create('cp', 'instance', 'https://app.test/');
  const other = mobileBrowserTabStore.create('cp', 'instance', 'https://other.test/');
  mobileBrowserTabStore.create('cp', 'another-instance', 'https://unrelated.test/');
  const onSelectTab = jest.fn();
  const view = await render(<BrowserTabScreen browserTabId={tab.id} instanceId="instance" onSelectTab={onSelectTab} />);
  // MenuView handles the native gesture; the mock intentionally supplies no onPress.
  expect(view.getByLabelText('2 tabs').props.accessibilityState.disabled).toBe(false);
  expect(view.getByLabelText('More browser actions').props.accessibilityState.disabled).toBe(false);
  await fireEvent(view.getByTestId('menu:Tabs'), 'select', other.id);
  expect(onSelectTab).toHaveBeenCalledWith(expect.objectContaining({ id: other.id }));
  await view.rerender(<BrowserTabScreen browserTabId={other.id} instanceId="instance" onSelectTab={onSelectTab} />);
  expect(view.getAllByTestId('native-browser', { includeHiddenElements: true })).toHaveLength(2);
  await view.unmount();
});

test('history opens from more and back returns a blank tab to its start page', async () => {
  const tab = mobileBrowserTabStore.create('cp', 'instance');
  const view = await render(<BrowserTabScreen browserTabId={tab.id} instanceId="instance" />);
  expect(view.getByText('Your browsing space')).toBeTruthy();
  await fireEvent(view.getByTestId('menu:Browser'), 'select', 'history');
  expect(view.queryByText('Your browsing space')).toBeNull();
  expect(view.getByLabelText('Back').props.accessibilityState.disabled).toBe(false);
  await fireEvent.press(view.getByLabelText('Back'));
  expect(view.getByText('Your browsing space')).toBeTruthy();
  expect(mockGoBack).not.toHaveBeenCalled();
  await view.unmount();
});

test('new tab shows pending state, rejects double taps and restores controls after failure', async () => {
  const tab = mobileBrowserTabStore.create('cp', 'instance');
  let fail!: (error: Error) => void;
  jest.mocked(mobileBrowserController.create).mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject; }));
  const view = await render(<BrowserTabScreen browserTabId={tab.id} instanceId="instance" />);
  await act(async () => {
    const button = view.getByLabelText('New tab');
    await fireEvent.press(button);
    await fireEvent.press(button);
  });
  expect(mobileBrowserController.create).toHaveBeenCalledTimes(1);
  expect(view.getByLabelText('New tab').props.accessibilityState).toMatchObject({ disabled: true, busy: true });
  expect(view.getByLabelText('More browser actions').props.accessibilityState.disabled).toBe(true);
  await act(async () => { fail(new Error('Cannot create tab')); });
  expect(view.getByText('Cannot create tab')).toBeTruthy();
  expect(view.getByLabelText('New tab').props.accessibilityState).toMatchObject({ disabled: false, busy: false });
  expect(view.getByLabelText('More browser actions').props.accessibilityState.disabled).toBe(false);
  await view.unmount();
});
