import { act, fireEvent, render, waitFor, within } from '@testing-library/react-native';

import { unsupportedRemoteDesktopCapabilities, type DesktopSource, type RemoteDesktopCapabilities } from '@task-handoff/protocol/remote-desktop';

import { RemoteDesktopSourcePicker } from '../src/remote-desktop/RemoteDesktopSourcePicker';

jest.mock('../src/i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));

const sources: DesktopSource[] = [
  { sourceRef: 'display-1', kind: 'display', title: 'Primary display', subtitle: null, width: 1920, height: 1080, capturable: true, reason: null },
  { sourceRef: 'window-1', kind: 'window', title: 'Editor', subtitle: 'Code', width: 1440, height: 900, capturable: true, reason: null },
  { sourceRef: 'window-2', kind: 'window', title: 'Locked app', subtitle: 'Fixture', width: 800, height: 600, capturable: false, reason: 'Window is minimized' },
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
    sourceProviders: [
      { kind: 'display', available, reason: available ? null : 'Unsupported' },
      { kind: 'window', available, reason: available ? null : 'Unsupported' },
    ],
  };
}

test('does not request sources when no provider is available', async () => {
  const loadSources = jest.fn(async () => sources);
  const screen = await render(
    <RemoteDesktopSourcePicker
      capability={capability(false)}
      loadSources={loadSources}
      onClose={jest.fn()}
      onSelect={jest.fn()}
      target={{ kind: 'display' }}
      visible
    />,
  );

  await show(screen);
  expect(loadSources).not.toHaveBeenCalled();
  expect(screen.getByText('remoteDesktop.sourceCaptureUnavailable')).toBeTruthy();
});

test('loads selectable sources when opened and refreshes on demand', async () => {
  const firstLoad = deferred<DesktopSource[]>();
  const loadSources = jest.fn()
    .mockReturnValueOnce(firstLoad.promise)
    .mockResolvedValueOnce(sources);
  const onClose = jest.fn();
  const onSelect = jest.fn();
  const screen = await render(
    <RemoteDesktopSourcePicker
      capability={capability(true)}
      loadSources={loadSources}
      onClose={onClose}
      onSelect={onSelect}
      target={{ kind: 'display' }}
      visible
    />,
  );

  await show(screen);
  expect(loadSources).toHaveBeenCalledTimes(1);
  await act(async () => {
    firstLoad.resolve(sources.slice(0, 2));
    await Promise.resolve();
  });
  await waitFor(() => expect(screen.getByText('Editor')).toBeTruthy());

  await act(async () => {
    fireEvent.press(screen.getByLabelText('remoteDesktop.refreshSources'));
    await Promise.resolve();
  });
  await waitFor(() => expect(screen.getByText(/Locked app/)).toBeTruthy());
  expect(loadSources).toHaveBeenCalledTimes(2);
  const displayGroup = within(screen.getByTestId('remote-desktop-source-group-display'));
  expect(displayGroup.getByText('remoteDesktop.entireDesktop')).toBeTruthy();
  expect(displayGroup.getByText('1')).toBeTruthy();
  const windowGroup = within(screen.getByTestId('remote-desktop-source-group-window'));
  expect(windowGroup.getByText('remoteDesktop.singleWindow')).toBeTruthy();
  expect(windowGroup.getByText('2')).toBeTruthy();

  fireEvent.press(screen.getByText('Editor'));
  expect(onSelect).toHaveBeenCalledWith({
    kind: 'window',
    sourceRef: 'window-1',
    title: 'Editor',
    subtitle: 'Code',
    width: 1440,
    height: 900,
  });
  expect(onClose).toHaveBeenCalled();
});

test('does not select a source that the instance marks as uncapturable', async () => {
  const onSelect = jest.fn();
  const initialLoad = deferred<DesktopSource[]>();
  const screen = await render(
    <RemoteDesktopSourcePicker
      capability={capability(true)}
      loadSources={() => initialLoad.promise}
      onClose={jest.fn()}
      onSelect={onSelect}
      target={{ kind: 'display' }}
      visible
    />,
  );

  await show(screen);
  await act(async () => {
    initialLoad.resolve(sources);
    await Promise.resolve();
  });
  await waitFor(() => expect(screen.getByText(/Locked app/)).toBeTruthy());
  fireEvent.press(screen.getByText(/Locked app/));

  expect(onSelect).not.toHaveBeenCalled();
  expect(screen.getByText(/Window is minimized/)).toBeTruthy();
});
