import { act, render } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';

import { RemoteDesktopToolbar } from '../src/remote-desktop/RemoteDesktopToolbar';
import { emptyRemoteDesktopSnapshot } from '../src/remote-desktop/types';

jest.mock('../src/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
jest.mock('../src/components/AnchoredSelectMenu', () => ({
  AnchoredSelectMenu: ({ children }: { children(open: () => void): React.ReactElement }) => children(() => undefined),
}));
jest.mock('react-native-reanimated', () => {
  const reanimated = jest.requireActual('react-native-reanimated/mock');
  const React = jest.requireActual<typeof import('react')>('react');
  return {
    ...reanimated,
    interpolate: (_value: number, _input: number[], output: number[]) => output.at(-1),
    useSharedValue: <Value,>(initial: Value) => {
      const value = React.useRef(initial);
      return {
        get value() { return value.current; },
        set value(next: Value) { value.current = next; },
        get() { return value.current; },
        set(next: Value) { value.current = next; },
      };
    },
  };
});

function toolbarWidth(screen: Awaited<ReturnType<typeof render>>) {
  return StyleSheet.flatten(screen.getByTestId('remote-desktop-toolbar').props.style).width;
}

test('reflows the capsule whenever the control action is added or removed', async () => {
  const common = {
    bottomInset: 0,
    keyboardVisible: false,
    mouseMode: 'direct' as const,
    onInput: jest.fn(),
    onKeyboard: jest.fn(),
    onMouseMode: jest.fn(),
  };
  const snapshot = {
    ...emptyRemoteDesktopSnapshot,
    phase: 'connected' as const,
    inputEnabled: true,
    isController: false,
  };
  const screen = await render(<RemoteDesktopToolbar {...common} snapshot={snapshot} />);
  await act(async () => {
    screen.getByTestId('remote-desktop-toolbar-actions').props.onLayout({
      nativeEvent: { layout: { height: 48, width: 220 } },
    });
  });
  await screen.rerender(<RemoteDesktopToolbar {...common} snapshot={snapshot} />);
  const threeActionsWidth = toolbarWidth(screen);
  expect(threeActionsWidth).toBeGreaterThan(220);

  await screen.rerender(<RemoteDesktopToolbar {...common} snapshot={{ ...snapshot, isController: true }} />);
  await act(async () => {
    screen.getByTestId('remote-desktop-toolbar-actions').props.onLayout({
      nativeEvent: { layout: { height: 48, width: 148 } },
    });
  });
  await screen.rerender(<RemoteDesktopToolbar {...common} snapshot={{ ...snapshot, isController: true }} />);
  const twoActionsWidth = toolbarWidth(screen);
  expect(twoActionsWidth).toBeLessThan(threeActionsWidth);
  expect(twoActionsWidth).toBeGreaterThan(148);
  screen.unmount();
});

test('hides the floating capsule while either keyboard is visible', async () => {
  const screen = await render(<RemoteDesktopToolbar
    bottomInset={0}
    hidden
    keyboardVisible
    mouseMode="direct"
    onInput={jest.fn()}
    onKeyboard={jest.fn()}
    onMouseMode={jest.fn()}
    snapshot={{ ...emptyRemoteDesktopSnapshot, phase: 'connected', inputEnabled: true, isController: true }}
  />);
  const toolbar = screen.getByTestId('remote-desktop-toolbar', { includeHiddenElements: true });
  expect(StyleSheet.flatten(toolbar.props.style).display).toBe('none');
  expect(toolbar.props.pointerEvents).toBe('none');
  expect(toolbar.props.accessibilityElementsHidden).toBe(true);
  screen.unmount();
});
