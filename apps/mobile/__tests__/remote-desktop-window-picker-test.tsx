import { act, fireEvent, render, waitFor } from '@testing-library/react-native';

import { unsupportedRemoteDesktopCapabilities, type DesktopWindow, type RemoteDesktopCapabilities } from '@task-handoff/protocol/remote-desktop';

import { RemoteDesktopWindowPicker } from '../src/remote-desktop/RemoteDesktopWindowPicker';

jest.mock('../src/i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));

const windows: DesktopWindow[] = [
  { windowRef: 'window-1', title: 'Editor', applicationName: 'Code', width: 1440, height: 900, capturable: true, reason: null },
  { windowRef: 'window-2', title: 'Locked app', applicationName: 'Fixture', width: 800, height: 600, capturable: false, reason: 'Window is minimized' },
];

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
}

async function show(screen: Awaited<ReturnType<typeof render>>) {
  const modal = screen.container.queryAll((node) => typeof node.props.onShow === 'function')[0];
  await act(async () => modal?.props.onShow());
}

function capability(available: boolean): RemoteDesktopCapabilities {
  return {
    ...unsupportedRemoteDesktopCapabilities(),
    available: true,
    status: 'available',
    captureTargets: available ? ['display', 'window'] : ['display'],
    windowCapture: { available, reason: available ? null : 'Unsupported' },
  };
}

test('does not request windows when the instance cannot capture a window', async () => {
  const loadWindows = jest.fn(async () => windows);
  const screen = await render(
    <RemoteDesktopWindowPicker
      capability={capability(false)}
      loadWindows={loadWindows}
      onClose={jest.fn()}
      onSelect={jest.fn()}
      target={{ kind: 'display' }}
      visible
    />,
  );

  await show(screen);
  expect(loadWindows).not.toHaveBeenCalled();
  expect(screen.getByText('remoteDesktop.windowCaptureUnavailable')).toBeTruthy();
});

test('loads selectable windows when opened and refreshes on demand', async () => {
  const firstLoad = deferred<DesktopWindow[]>();
  const loadWindows = jest.fn()
    .mockReturnValueOnce(firstLoad.promise)
    .mockResolvedValueOnce(windows);
  const onClose = jest.fn();
  const onSelect = jest.fn();
  const screen = await render(
    <RemoteDesktopWindowPicker
      capability={capability(true)}
      loadWindows={loadWindows}
      onClose={onClose}
      onSelect={onSelect}
      target={{ kind: 'display' }}
      visible
    />,
  );

  await show(screen);
  expect(loadWindows).toHaveBeenCalledTimes(1);
  await act(async () => {
    firstLoad.resolve(windows.slice(0, 1));
    await Promise.resolve();
  });
  await waitFor(() => expect(screen.getByText('Editor')).toBeTruthy());

  await act(async () => {
    fireEvent.press(screen.getByLabelText('remoteDesktop.refreshWindows'));
    await Promise.resolve();
  });
  await waitFor(() => expect(screen.getByText('Locked app')).toBeTruthy());
  expect(loadWindows).toHaveBeenCalledTimes(2);

  fireEvent.press(screen.getByText('Editor'));
  expect(onSelect).toHaveBeenCalledWith({
    kind: 'window',
    windowRef: 'window-1',
    title: 'Editor',
    applicationName: 'Code',
  });
  expect(onClose).toHaveBeenCalled();
});

test('does not select a window that the instance marks as uncapturable', async () => {
  const onSelect = jest.fn();
  const initialLoad = deferred<DesktopWindow[]>();
  const screen = await render(
    <RemoteDesktopWindowPicker
      capability={capability(true)}
      loadWindows={() => initialLoad.promise}
      onClose={jest.fn()}
      onSelect={onSelect}
      target={{ kind: 'display' }}
      visible
    />,
  );

  await show(screen);
  await act(async () => {
    initialLoad.resolve(windows);
    await Promise.resolve();
  });
  await waitFor(() => expect(screen.getByText('Locked app')).toBeTruthy());
  fireEvent.press(screen.getByText('Locked app'));

  expect(onSelect).not.toHaveBeenCalled();
  expect(screen.getByText(/Window is minimized/)).toBeTruthy();
});
